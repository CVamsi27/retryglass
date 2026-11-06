# Rehearsal operations

> Current verification: see [current alpha verification](verification.md). Current source contracts and runtime limits are documented below.


Everything here describes the local alpha. No production system, credential or host service is
contacted, and no Docker resource outside a run's own labels is touched.

## Prerequisites

| Requirement | This alpha |
| --- | --- |
| Node | 24.22.1 (`.node-version`); `pnpm check` enforces the engine |
| pnpm | 11.23.0 with a frozen lockfile |
| OrbStack engine | Reachable through its Docker-compatible client; `retryglass doctor` reports the server version |
| Images | `postgres:17-bookworm`, `redis:7-bookworm`, `node:24-bookworm-slim` and the locally built `retryglass-tool:0.1.0-alpha.2` |

Docker Compose is not required: the cell is created with `docker` argument arrays only.

## Cell composition

One run creates one internal bridge with IPv4 gateway mode `isolated` and four long-lived containers, each labelled
`com.retryglass.owner=retryglass` and `com.retryglass.run=<runId>`:

| Resource | Purpose | Limits |
| --- | --- | --- |
| `retryglass-<runId>-postgres` | disposable PostgreSQL 17 with the fixture schema and seed | 512m, 1 CPU, 128 PIDs |
| `retryglass-<runId>-redis` | BullMQ state, password protected, persistence off | 128m, 0.5 CPU |
| `retryglass-<runId>-simulator` | deterministic effect endpoint and in-memory ledger | read-only root, 256m, tmpfs `/tmp` |
| `retryglass-<runId>-collector` | trusted observer entrypoint; never listens | read-only root, 256m, tmpfs `/tmp` |
| `retryglass-<runId>-worker` | one attempt at a time, started and stopped by the supervisor | read-only, all capabilities dropped, 256m, 0.5 CPU, 64 PIDs |

No container publishes a port, joins the host network, mounts the Docker socket or receives a host
source mount. The worker receives only `DATABASE_URL`, `REDIS_*`, `QUEUE_PREFIX`, `PROVIDER_URL`,
`PROCESSOR_PATH`, `RUN_ID`, `DECLARED_HOSTS` and `CRASH_AFTER`. Credentials are generated per run, held in memory and never written
into a report.

The worker's database role is created per run (`retryglass_app_<run-hash>`). The collector uses a
separate role with `CREATEROLE`, `pg_signal_backend` and `SELECT` only, so the observer can build a
login barrier without holding the worker's write grants.

## Phases

`retryglass run` executes the declared phases in this order:

1. validate the data-only scenario and fixture containment
2. (re)build the local tool image from `dist` when the scenario uses it
3. create the cell, wait for PostgreSQL/Redis/simulator readiness, create roles, apply schema and seed
4. baseline projection snapshots, including the declared `expectedRows`
5. admit the input job (`attempts: 1`, retained on failure and completion)
6. attempt 1 on a fresh worker → terminal state → stop worker → database login barrier → simulator
   seal and drain → partial snapshot
7. resume the application role and simulator intake, then `job.retry('failed')` on the same job ID
8. attempt 2 on a fresh worker → terminal state → stop worker → barrier → final collectors
9. collect observations, destroy only this run's resources, then evaluate and finalize the report atomically

A worker container that exits without a terminal job state fails the phase immediately; the run does
not wait out the deadline. A slow attempt is bounded by a 90 s deadline and becomes `timed_out`.

## Crash sweeps

The CLI treats SIGINT and SIGTERM on `run` and `sweep` as cooperative interruption. It stops scheduling cells, retains completed observations, and attempts ownership-checked cleanup. In-flight engine commands retain their existing deadlines. An interrupted run with successful cleanup exits 3 unless it already observed a violation, in which case it exits 1. Cleanup failure takes precedence with exit 2. A forced kill can leave labelled resources. Inspect the exact run labels and recorded resource manifest before manual removal.

`retryglass sweep --scenario <path>` runs the same cell and barrier machinery, once per enumerated
crash point:

1. **Discovery** (three runs): a fresh cell per run, `job-add`, one
   unchrashed worker, terminal state, bounded stdout. Each run's `crash-points.json` source is kept as
   `discovery-<n>.log`. The runs must agree on the identical ordered descriptor list; a gap, a
   repeated index, a malformed line or a different order refuses the sweep instead of guessing.
2. **Enumeration**: descriptors are the settled seams the processor actually reached. Crash point
   `cp-NN` means `CRASH_AFTER=NN`, i.e. the process is killed after the NN-th settled seam. The
   ordered list is written to `crash-points.json`, capped at 64, with the cap recorded as missing.
3. **Per point**: fresh cell from the same seed → `job-add` → worker with `CRASH_AFTER=k` → crash
   verification → stall-path recovery of the same job → barrier (quiesce, seal, ledger) → `partial`
   snapshot → resume → `job.retry('failed')` → unchrashed retry to a terminal state → barrier →
   `after` snapshot and declared output queues. Evidence, rules and reasons are kept under
   `crash-points/<id>/`.
4. **Aggregation**: every point is judged by the scenario's rules. A violation at any evaluated point
   keeps the sweep `assertions: failed`; `passed` requires every discovered point to be executed,
   verified, recovered, evaluated and passing. A point with a missing marker, a surviving worker, a
   job that was not recovered, or undeclared I/O is `partial`, never a pass.

A crash point is verified only when all three hold: the worker exits 137 without OOM or supervisor-forced termination, the log carries a marker
whose `completed` equals that point, and the same `jobId`/`operationKey` is still present. Recovery
uses `lockDuration: 2000`, `stalledInterval: 1000` and `maxStalledCount: 0`; the measured wait is
recorded and a job is never forced into `failed` by any other means.

A sweep is sequential and bounded; there is no parallel cell execution. Each point uses a unique
queue prefix, so points never share queue state.

## Result dimensions and exit codes

| Dimension | Values |
| --- | --- |
| Execution | `completed`, `setup_failed`, `timed_out`, `interrupted` |
| Coverage | `complete_for_declared_surfaces`, `partial`, `unsupported` |
| Assertions | `passed`, `failed`, `not_evaluated` |
| Cleanup | `completed`, `failed` |

| Exit | Meaning |
| --- | --- |
| 0 | completed, complete declared coverage, assertions passed, cleanup completed |
| 1 | the rehearsal completed but a required assertion failed |
| 2 | setup failed or scoped cleanup failed |
| 3 | incomplete evidence (timeout, interruption, missing/ambiguous observation) |

For a sweep, an evaluated violation outranks incompleteness: a sweep with one failing and one
incomplete point reports `coverage: partial`, `assertions: failed` and exits `1`, so a real finding is
never hidden behind a partial sweep. Setup or cleanup failure still exits `2` first.

`--json` writes the same report as JSON to stdout; diagnostics go to stderr. The report is written to
`.retryglass/runs/<runId>/report.json` (override with `--output-root`). Per-attempt worker logs are
retained beside it as `worker-attempt-<n>.log`.

## Cleanup and recovery

`destroyCell` inspects every resource's labels and refuses to remove anything whose run label does
not match, then removes the worker, collector, PostgreSQL, Redis, simulator and the network. There is
no global prune command. If a supervisor is killed, `docker ps -a --filter
label=com.retryglass.owner=retryglass` lists the owned leftovers for explicit, per-run removal;
automatic `recover`/`cleanup` subcommands are not implemented yet.

## Exporting a regression fixture

```sh
retryglass export --run <run-id> --target ./regression/invoice [--output-root <dir>] [--json]
```

Export copies **only** reviewed content from the run directory:

| File | Source |
| --- | --- |
| `scenario.json` | the exact validated scenario preserved in `<run-dir>/inputs/` |
| declared fixtures (`schema.sql`, `seed.sql`) | preserved inputs, verified against the digests in the report |
| `retry.test.ts` | `templates/regression.test.ts`, a normal Vitest test that calls `runScenario` |
| `manifest.json` | source run, scenario id, four result dimensions, worker/image identity, digests, file list |

It refuses to export when the run did not complete, when coverage is not complete for the declared
surfaces, when a preserved fixture no longer matches the report digest, when the run ID is unsafe, or
when cleanup failed, or when the target path already exists. The directory is staged and renamed, so a failed export leaves
no partial fixture. Reports, drafts and worker logs are never copied.

### One crash point

```sh
retryglass export --run <sweep-run-id> --crash-point cp-03 --target ./regression/invoice-dup
```

A crash-point export reads a `schemaVersion: 2` report and refuses an unverified point, an unknown
point, a point that did not complete under complete coverage, an unsafe identity, and an existing
target, and any failed cleanup. The manifest records the crash point (`index`, `seam`, `label`, `crashAfter`), the point's
four dimensions, and every rule result with its observed value, so the fixture documents the bug it
was cut from. `retry.test.ts` comes from `templates/sweep-regression.test.ts`, rehearses exactly that
crash point through `runSweep(..., { crashPoints: [id] })` and asserts the declared invariants, so it
fails while the bug is present and passes once the worker is corrected.

A run whose evidence is complete but whose assertions failed is exportable: the manifest records
`assertions: "failed"`, so a known bug becomes a red test rather than a silent pass. The generated
test imports the `retryglass` package and therefore needs it installed (packaged-distribution gate).

## Verified profile

Current supported local evidence uses OrbStack on macOS arm64, Node 24.22.1 and the PostgreSQL 17 / Redis 7 bookworm image profiles. The Docker-compatible CLI targets OrbStack; it does not require Docker Desktop. See [current gate results and exact commands](verification.md).

Set `RETRYGLASS_CONTAINER_CLI` and `RETRYGLASS_CONTAINER_HOST` when the client is not on PATH or an explicit endpoint is needed. Host overrides remove a conflicting `DOCKER_CONTEXT` only from the child client environment. Older engines without isolated bridge gateway mode are unsupported. Native Linux/amd64 CI remains unverified; macOS emulation is not a substitute.
