# Scenario reference

> Current verification: see [current alpha verification](verification.md). Current source contracts and runtime limits are documented below.


A scenario is data-only JSON. Retryglass never imports an application boot module or reads
environment configuration to discover settings; the file is validated before any container starts.

## Shape

```json
{
  "schemaVersion": 1,
  "scenarioId": "invoice-ack-loss-stable",
  "experiment": "failed-retry",
  "worker": { "image": "retryglass-tool:0.1.0-alpha.2", "processor": "dist/examples/invoice/corrected.js", "revision": "example-invoice-v1" },
  "fixture": { "schema": "schema.sql", "seed": "seed.sql", "expectedRows": { "public.operations": 1, "public.invoices": 0 } },
  "job": { "name": "invoice", "id": "job-17", "operationKey": "op-17", "data": { "operationKey": "op-17", "recipient": "synthetic@example.invalid" } },
  "tables": [
    { "table": "public.operations", "key": ["operation_key"], "columns": ["operation_key", "total_cents"] },
    { "table": "public.invoices", "key": ["operation_key"], "columns": ["operation_key", "status"] }
  ],
  "outputQueues": ["reminders"],
  "provider": { "idempotent": true, "loseFirstAcknowledgement": true },
  "rules": []
}
```

Unknown fields are rejected. The scenario is limited to 1 MiB, fixtures to 1 MiB each, paths must be
relative and contained (`..`, absolute paths, drive letters, backslashes and symlink escapes are
refused). Two experiments are supported:

| `experiment` | Command | Meaning |
| --- | --- | --- |
| `failed-retry` | `retryglass run` | one failed attempt, barrier, then a retry of the same persisted job |
| `crash-sweep` | `retryglass sweep` | enumerate the seams the processor reached and rehearse each crash point in a fresh cell |

`retryglass sweep` refuses a `failed-retry` scenario, because a crash sweep needs a rule set that
holds at every crash point. A rule about the failed first attempt (for example "two HTTP attempts")
is only true at crash points after the provider call, so the crash-sweep fixtures bound requests
instead of asserting an exact attempt count and leave `job_state` to prove the retry completed.

Crash points come from a discovery run's own stdout. Only the three declared seams are enumerated
(`db.query`, `http.request`, `queue.add`); a DNS lookup for a host outside the cell or any
subprocess spawn is reported as undeclared I/O and degrades coverage instead of being guessed at.

`worker.processor` is a compiled JavaScript path inside the worker image. `worker.revision` is a
fixture version label, not a Git commit; the supervisor records the resolved image ID separately.
`fixture.expectedRows` is verified at the baseline snapshot, so an unexpectedly empty or duplicated
seed fails the run instead of quietly producing zero counts.

## Rules

| Kind | Proves |
| --- | --- |
| `row_count` | exact row count in a declared projection |
| `row_value` | one column of the row selected by the complete projected key |
| `applied_count` / `applied_max` | exact / bounded simulator-applied operations |
| `required_http` / `http_attempts_max` | at least / at most this many observed requests |
| `output_count` / `output_max` | exact / bounded jobs in a declared output queue |
| `job_state` | terminal state of attempt 1 or 2 |

Validation requires exactly one `job_state` rule per attempt, the first attempt to expect `failed`,
and at least one positive required-presence rule (`required_http`, `applied_count`, `output_count` or
`row_count` with a positive value) so a do-nothing worker cannot pass. Maximum-only rules never prove
that anything happened.

A rule that cannot be evaluated — missing or ambiguous projection, unsupported observation,
truncated evidence, missing terminal state — makes coverage partial and assertions `not_evaluated`.
It is never recorded as a passing zero.

## Invoice fixtures in this repository

| File | Behaviour | Expected result |
| --- | --- | --- |
| `examples/invoice/scenario.json` | stable provider key, first acknowledgement lost | all rules pass, exit 0 |
| `examples/invoice/scenario-buggy.json` | a fresh provider key per attempt | two applied operations, `one-provider-action` fails, exit 1 |
| `examples/invoice/scenario-ignored-key.json` | stable key but a provider that ignores it | two applied operations, `one-provider-action` fails, exit 1 |
| `examples/invoice/scenario-retry-crash.json` | the retry crashes before useful work | `retry-completes` fails, exit 1 |
| `examples/invoice/scenario-sweep.json` | crash sweep, corrected processor | every crash point verified and passing, exit 0 |
| `examples/invoice/scenario-sweep-buggy.json` | crash sweep, fresh provider key per attempt | `one-provider-action` fails at crash points where the provider already applied, exit 1 |

All six use the same seed and the same declared surfaces, so their reports are directly comparable.

The two sweep fixtures set `loseFirstAcknowledgement: false`. The simulator loses the **first
acknowledgement in its ledger's lifetime**, not the first acknowledgement of a failed attempt, so at
a crash point before the provider the retry would itself be that first request and would fail for a
reason unrelated to the crash. In a sweep the crash is the modelled failure; acknowledgement loss
stays covered by the `failed-retry` fixtures.

A completed run can be turned into a normal Vitest regression with `retryglass export --run <run-id>
--target <dir>`. The exported directory contains the exact scenario, its declared fixtures, a
manifest and `retry.test.ts`; see [Exporting a regression fixture](operations.md#exporting-a-regression-fixture).
A single observed crash point from a sweep is exported with `--crash-point <id>`; the generated test
rehearses exactly that point, so it fails while the worker still violates an invariant there.
