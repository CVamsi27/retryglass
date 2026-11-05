# Capture boundaries

A rehearsal reports declared surfaces only. Each surface below has a different meaning and none of
them is a complete audit trail.

## PostgreSQL: net committed projection

A projection is `SELECT <declared columns> FROM <declared table> ORDER BY <declared key>`, bounded to
10,000 rows and 10 MiB. It is the net row state visible at the snapshot instant, not every write:

- an insert followed by a delete is invisible,
- an update is visible only as its final value,
- uncommitted work is not visible,
- tables not declared in the scenario are not read at all.

Snapshots are taken only after the worker container is stopped *and* the application role is
`NOLOGIN` *and* its remaining backends are terminated and counted. A server-side statement that
outlives its client would otherwise still be writing during the snapshot; when the barrier cannot
reach zero backends the run records an incomplete result instead of a clean snapshot.

Catalog validation happens before the query: the table and every declared column must exist in
`information_schema`, keys must be part of the selected columns, and only deterministic scalar types
are accepted (`int*`, `numeric`, `bool`, `text`, `varchar`, `uuid`, dates/times, `interval`).
`json`, `jsonb`, arrays, `bytea` and user-defined types make a projection unsupported rather than
silently stringified. Timestamps are normalized to ISO-8601 strings, bigints to decimal strings.

Duplicate projected keys make an observation ambiguous and are rejected. Truncation by rows or bytes
sets `truncated: true`, and policy evaluation refuses to draw a count from a truncated projection.

## HTTP: attempts and applied operations are different facts

The simulator journals two separate lists:

- `httpAttempts` — one entry per request the simulator actually received, including the first
  accepted request whose response is deliberately dropped. The worker's own logs are never used to
  infer this count.
- `appliedOperations` — one entry per effect the simulator actually applied. A replay with the same
  `Idempotency-Key` and the same payload fingerprint returns the retained operation; a different
  payload under the same key is rejected with `409` and applies nothing.

For the golden profile the correct evidence is two attempts and one applied operation. A provider
that ignores the header shows two applied operations, and the report must not claim exactly-once:
the scenario's `applied_count` rule fails.

Intake is sealed and drained through a Unix control socket inside the simulator container before the
ledger is read; the worker has no administrative HTTP route. Re-opening intake for the retry keeps
the ledger. A failed drain is recorded as an incomplete observation.

## BullMQ: job state versus queue bookkeeping

`jobAttempts` records the terminal state BullMQ reported for the persisted job (`jobId`,
`operationKey`, `attemptsMade`, `attemptsStarted`) after each worker process ended. The same physical
job ID is required across the retry; a changed ID or business key makes the evidence incomplete.
BullMQ lock and event keys are not business effects and are excluded from output observations.

## Output queues: declared business jobs only

`outputJobs` lists jobs found in the scenario's `outputQueues` after the final writer stopped, with no
consumers running. Entries without a string `operationKey` in their payload are skipped, so engine
bookkeeping cannot be counted as a business job. The reserved `input` queue can never be observed as
an output queue.

## Not observed

- network destinations the worker attempted but the cell blocked,
- side channels such as host files, the Docker socket, DNS or metadata services,
- queues, topics, files or sockets that the scenario does not declare,
- writes that were rolled back or overwritten before the snapshot,
- provider behaviour beyond the simulator's declared idempotency model,
- production semantics: the simulator is not a real provider and none of these results generalize to
  an external system.

## Crash-seam observation

`pg.Client.query` and `pg.Pool.query` settle once per public operation, including callback style; a pool's internal client call is not another seam. A callback is observed before application callback code resumes. `fetch` settles on response headers or rejection, not full body consumption. Queue.add settles when its returned promise settles. Explicit transaction statements remain separate boundaries; a statement inside a transaction does not imply that transaction committed.

Undeclared DNS lookups and asynchronous spawn/exec/execFile operations are diagnostic observations in both the crash and retry worker logs. Such observations make a point partial. This is not complete network or subprocess mediation: direct IP sockets, synchronous child-process calls, DNS promises APIs, SDK transports, native addons and file operations remain outside the coverage promise. The isolated cell separately prevents accidental external routing on its tested profile.

Three matching discovery runs are required. The crash marker, stopped/non-OOM/non-forced worker state, unchanged job identity and stall-specific failure reason are all required before retry evidence can be treated as a verified crash point.
