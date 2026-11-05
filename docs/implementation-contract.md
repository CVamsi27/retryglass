# Alpha implementation boundaries

> Current verification: see [current alpha verification](verification.md). Current source contracts and runtime limits are documented below.


Working product: **Retryglass — Rehearse the retry. Inspect the effects.**

This repository's first deliverable is an executable local alpha. Code authored here is not by itself evidence of independent operator or contributor proficiency.

## Shared contracts

`src/contracts.ts` owns `Scenario`, `RunReport`, `Evidence`, `Projection`, `HttpAttempt`, `AppliedOperation`, `OutputJob`, `JobAttempt`, `Rule`, `RuleResult`, `Cell` and `StopResult`. Data-only schema and field definitions match the approved design; initial `Scenario` is the golden invoice JSON. The alpha supports `experiment: failed-retry` and `experiment: crash-sweep`.

Runtime interface agreed before parallel implementation:

- `src/docker/lifecycle.ts`: `prepareImages(): Promise<void>` builds the local trusted tool image. `createCell(scenario: Scenario, fixtureRoot: string, runDir: string, runId: string): Promise<Cell>` creates services, copies bounded fixture files into disposable state, seeds and grants a unique app role, and returns resource identities. It starts no application worker.
- Cell fields: `runId`, `projectName`, `runDir`, `collectorContainerId`, `postgresContainerId`, `redisContainerId`, `simulatorContainerId`, `networkId`, `applicationRole`, `applicationPassword`, `redisPassword`, optional `workerContainerId`, `toolImage`. All credentials are synthetic and excluded from reports.
- `execCollector(cell, command: string, argument?: unknown): Promise<unknown>` invokes the fixed trusted `dist/src/runtime/collector-entry.js`, with JSON on stdin and JSON on stdout. Supported commands: `snapshot`, `quiesce`, `job-add`, `job-state`, `job-retry`, `outputs`, `resume-db`. No user-supplied command string is passed through a shell.
- `startWorker(cell, scenario): Promise<string>` starts one constrained application container with the selected processor; `stopWorker(cell): Promise<StopResult>` bounds termination and removes only that worker. It grants no host mounts/socket/network.
- `simulatorControl(cell, action: 'seal' | 'resume' | 'read'): Promise<unknown>` uses the container-local Unix control socket, never an administrative network endpoint.
- `destroyCell(cell): Promise<void>` checks run ownership and removes only labelled run resources. `inspectPrerequisites(options)` makes bounded read-only prerequisite checks and returns a structured `DoctorReport`. Public orphan recovery is not implemented.
- `collector-entry.ts snapshot` input `{tables, expectedRows?}`, output `Projection[]`. It queries internal services with trusted credentials, validates catalog/key/column scope and caps bytes/rows.
- `quiesce` disables application login, terminates its remaining backends, waits for none, and returns `{terminatedActive:boolean, remaining:number}`. `resume-db` re-enables only this run's application role.
- `job-add` receives scenario/job, writes input queue `input` under prefix `retryglass-<runId>`, attempts1, retained jobs. `job-state` returns `{state, jobId, operationKey, attemptsMade, attemptsStarted}`. `job-retry` reprocesses that same persisted failed job.
- `outputs` receives queue names and returns `OutputJob[]`. No consumers exist for those queues. Engine bookkeeping is excluded.
- Simulator listens port4010 only for `/effects/email`; supports idempotency/profile and response loss. Control socket `/tmp/retryglass-control.sock`; `read` returns `{httpAttempts,appliedOperations,issues}`. Preserves its ledger between attempts; rejects mismatched/oversized input.
- Worker image includes source build, dependencies and example processors. Runtime entrypoint loads `scenario.worker.processor` only inside container `/app`; it starts a BullMQ Worker on `input`, processes one job, records terminal state in Redis and exits after the job reaches a terminal state. No automatic retries.

## Safety and result boundaries

One private internal network, no published ports, no host gateway, no Docker socket, no writable host mount, read-only non-root worker, dropped capabilities and explicit CPU/memory/PID/tmp limits. Root supervisor calls Docker through argument arrays. Trusted collectors have no network listener.

Take snapshots only after worker termination, database role/backend barrier and simulator sealing/draining. Persist draft evidence; cleanup; then finalize report atomically with observed cleanup status.

JSON/Markdown result has independent execution, coverage, assertion and cleanup dimensions. Coverage means declared surfaces only. Same-worker second-attempt early failure, zero-work, zero accepted operations, missing follow-up and unavailable collectors must not false-pass the golden fixture.

## Implementation notes (2026-10-30)

- The cell is created with `docker` argument arrays (no Compose file); `templates/collector.Dockerfile` builds `retryglass-tool:0.1.0-alpha.1` from the shipped `dist`, synthetic `examples` and a staged closure of resolved production dependencies, with internal links and no external pnpm store links. It never installs packages.
- `collector-entry` gained a `probe` command: a TCP connect from the trusted collector to a cell service, used for readiness without touching the simulator ledger.
- The collector connects as `retryglass_collector` (CREATEROLE, `pg_signal_backend`, `SELECT` only), not as the worker role; the worker role is unique per run and granted `SELECT` on all fixture tables plus `INSERT`/`UPDATE` (no DDL).
- `runScenario` rebuilds the local tool image when the scenario uses it, using the shipped `dist`; source development must build first. `isWorkerRunning` lets job-state polling fail fast when the worker container exited without a terminal state.
- Attempt 2 ending in `failed` is recorded as evidence and judged by the `job-state` rule, instead of aborting collection; this is what makes the retry-crash fixture an assertion failure rather than a coverage error.
- `StopResult.remainingDatabaseBackends` is `-1` until the coordinator merges the measured barrier result; reports never contain the sentinel for a completed attempt.
