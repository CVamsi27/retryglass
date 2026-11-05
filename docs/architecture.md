# Architecture

Retryglass is a local Node/BullMQ rehearsal supervisor. Application code is loaded only inside a disposable worker image. Configuration is data-only JSON with contained, bounded synthetic SQL files. It never imports an application boot module on the host.

## Components

| Component | Responsibility |
| --- | --- |
| `contracts.ts`, `scenario.ts` | Versioned contracts, semantic references and preserved fixture contents |
| `docker/lifecycle.ts` | Trusted image staging, constrained cells, fixed collector commands and ownership-verified cleanup |
| `runtime/worker-entry.ts` | Install wrappers, dynamically import a pure processor and execute one BullMQ job |
| `runtime/instrument.ts` | Count settled pg/fetch/Queue.add seams, plus narrow unsupported-I/O observations |
| `runtime/collector-entry.ts` | Observe PostgreSQL projections, input job state and declared output queues |
| `http/simulator.ts` | Synthetic provider attempts, applied operations, idempotency profile and private seal/drain controls |
| `run.ts` | One failed attempt followed by an explicit retry of the same persisted job |
| `sweep/` | Three-run discovery, per-point SIGKILL/recovery/retry and aggregation |
| `export.ts`, `regression.ts` | Preserved fixture export and strict selected-point test guard |
| `init.ts`, `preflight.ts`, `cli.ts` | Synthetic onboarding, static validation, read-only prerequisite checks and command exits |

## One crash point

1. Build/resolve trusted images and freeze the selected worker identity before execution.
2. Create a unique internal isolated bridge, disposable PostgreSQL/Redis, simulator and trusted collector. Apply the preserved synthetic schema/seed and take baseline projections.
3. Admit a retained BullMQ job. Run the worker with a selected settled-seam counter.
4. Require a unique matching marker, stopped exit 137, no OOM/supervisor-forced termination and unchanged persisted job/business key.
5. Recover only through BullMQ's stalled-specific failure, then stop writers, block application DB logins, terminate/count remaining backends and seal/drain the simulator.
6. Collect partial state, resume the cell and retry that same failed job in a fresh worker without injected crash.
7. Stop/quiesce/seal, collect final effects, judge declared rules and clean only verified run-owned resources.

Each point gets fresh state. Discovery requires three identical ordered descriptor sequences. A scoped exported test assesses its selected point while omitted points remain unassessed.

## Isolation and trust

Workers use init, UID 10001, read-only root, dropped capabilities, no-new-privileges, CPU/memory/PID limits and bounded tmpfs. They receive synthetic connection settings, no host environment, source/socket mounts or published ports. The internal bridge requires isolated IPv4 gateway mode. The host uses a compatible client connected to OrbStack; client overrides never enter workers.

The collector has fixed commands and separate observer credentials; application code never supplies a shell program to it. The provider's administrative control socket is not an application-visible HTTP route. All resource deletion verifies ownership/run labels and attempts remaining removals after failures. An interrupted supervisor can leave labelled resources; there is no global cleanup or public orphan-recovery command.

This is owner-controlled local testing, not a hostile-code execution service. Application code intentionally reaches its disposable DB, queue and simulator. Declared observations and resource controls do not prove complete mediation of arbitrary native code or side channels.

## Result semantics

Execution, declared coverage, assertions and cleanup remain independent. Cleanup failure cannot erase a fully observed violation or become a passing result. Missing collector/ledger/projection evidence is not an empty successful observation. Required terminal states and positive business effects prevent a zero-work false pass.

Exit precedence is setup/cleanup failure (2), observed violation (1), incomplete evidence (3), then complete pass (0). PostgreSQL is net row state, not a write audit. HTTP attempts and simulator-applied operations are separate facts. See [capture boundaries](capture-boundaries.md), [scenario contract](scenarios.md), [operations](operations.md), [CI](ci.md) and [verification](verification.md).
