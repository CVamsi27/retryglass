# Your first Retryglass rehearsal

These fixtures are synthetic. They exercise one BullMQ processor, PostgreSQL, the fake provider, and a follow-up queue. A passing result covers only the declared effects and observed crash points.

## Run the corrected and buggy workers

Install the local Retryglass package/tarball and Vitest in your own project first. `init` does not install dependencies or execute any processor. Start OrbStack and use its Docker-compatible client against the OrbStack engine; Docker Desktop is not required. If the client is not on PATH, set `RETRYGLASS_CONTAINER_CLI` to its executable path. `RETRYGLASS_CONTAINER_HOST` selects the client endpoint without changing global Docker context.

From this starter directory:

```sh
retryglass validate --scenario scenario.json
retryglass doctor

# Prepare service/base images explicitly in OrbStack if they are not present.
docker pull postgres:17-bookworm
docker pull redis:7-bookworm
docker pull node:24-bookworm-slim

retryglass sweep --scenario scenario.json
retryglass sweep --scenario scenario-buggy.json
```

The corrected sweep must exit `0` with complete execution, declared coverage, assertions and cleanup. The buggy sweep must exit `1` with an observed duplicate provider action after the provider boundary. Missing infrastructure, unverified crashes, partial discovery, unavailable collectors and failed cleanup are not passing results.

The first sweep builds the local trusted image from the installed package's shipped artifacts and runtime dependencies. `doctor --scenario scenario.json` is a read-only inventory and may report that image missing before this first build; it never pulls or builds anything itself. Static `validate` reads JSON and contained SQL only, and does not establish that a processor is supported or runtime effects will pass.

Keep an observed failing point as a normal test:

```sh
retryglass inspect --report .retryglass/runs/<run-id>/report.json
retryglass export --run <run-id> --crash-point cp-03 --target ./invoice-regression
npx vitest run invoice-regression/retry.test.ts
```

Use the crash point actually reported by the buggy sweep; `cp-03` is an example identity. Inspect the exported scenario and run its generated test in your own suite. Assertions failing is useful evidence; incomplete evidence is a separate failure.

## Adapt a pure processor in a fixture image

After the bundled sweep has built `retryglass-tool:0.1.0-alpha.1`:

```sh
docker build --file Dockerfile.worker --tag retryglass-fixture:local .
```

Copy explicitly selected compiled modules into `processor/`, keeping their normal supported driver dependencies in the local tool base. The included `processor/example.js` delegates to the bundled corrected synthetic worker. Change `worker.image` to `retryglass-fixture:local` and `worker.processor` to `processor/example.js` in a copy of the scenario, then validate and sweep that copy.

The image recipe copies data at build time. No host source directory, Docker socket or host environment is mounted into a worker. Never import an application boot file, production queue/database dump, credentials or customer records. Update the synthetic schema, seed, business key, projections and rules together. SDK/ORM transports outside `pg`, `fetch` and BullMQ `Queue.add` are not a supported coverage promise.
