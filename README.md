# Retryglass

Find where a BullMQ retry duplicates, loses or leaves incomplete declared business effects in a disposable synthetic rehearsal.

[![CI](https://github.com/CVamsi27/retryglass/actions/workflows/ci.yml/badge.svg)](https://github.com/CVamsi27/retryglass/actions/workflows/ci.yml)

Public alpha for synthetic/local testing. Use Node 24.22.1. GitHub release packages are the supported installation path; npm registry publication is deferred. Independent adoption remains unvalidated.

## Try the starter without cloning

From your own test project:

```sh
npm install --save-dev --ignore-scripts https://github.com/CVamsi27/retryglass/releases/download/v0.1.0-alpha.2/retryglass-0.1.0-alpha.2.tgz
npx --no-install retryglass init --target ./my-rehearsal
npx --no-install retryglass validate --scenario ./my-rehearsal/scenario.json
```

The target must be new. These commands create and validate synthetic fixtures; they do not run a processor, connect to production services or require a container engine. No source checkout or pnpm installation is needed to use the installed CLI. The [release](https://github.com/CVamsi27/retryglass/releases/tag/v0.1.0-alpha.2) includes a tarball checksum.

## Run a real rehearsal through OrbStack

Start OrbStack, select its compatible client and explicitly prepare local images:

```sh
orbctl start docker
export RETRYGLASS_CONTAINER_CLI=/absolute/path/to/docker
export RETRYGLASS_CONTAINER_HOST="unix://${HOME}/.orbstack/run/docker.sock"
env -u DOCKER_CONTEXT DOCKER_HOST="$RETRYGLASS_CONTAINER_HOST" "$RETRYGLASS_CONTAINER_CLI" pull postgres:17-bookworm
env -u DOCKER_CONTEXT DOCKER_HOST="$RETRYGLASS_CONTAINER_HOST" "$RETRYGLASS_CONTAINER_CLI" pull redis:7-bookworm
env -u DOCKER_CONTEXT DOCKER_HOST="$RETRYGLASS_CONTAINER_HOST" "$RETRYGLASS_CONTAINER_CLI" pull node:24-bookworm-slim
npx --no-install retryglass doctor --scenario ./my-rehearsal/scenario.json
npx --no-install retryglass sweep --scenario ./my-rehearsal/scenario.json
npx --no-install retryglass sweep --scenario ./my-rehearsal/scenario-buggy.json
```

Use a real compatible executable path in the export. `doctor` only inventories prerequisites and can report the trusted tool image missing before the first sweep builds it. It never pulls or builds an image. The corrected sweep exits 0; the buggy sweep exits 1 for an observed duplicate provider effect. Setup/cleanup failures exit 2; incomplete evidence exits 3. The standalone `demo` covers only a synthetic HTTP simulator and intentionally exits 3; it is not a complete crash/retry rehearsal.

Application code executes only in constrained disposable cells. Docker Desktop and Compose are not required. Keep source mounts, sockets, host environment values, production data and application boot files out of workers.

Read [setup and CI use](docs/setup.md) to retain an observed finding as a normal Vitest test; install `vitest@5.0.5` explicitly in that consumer. [Contributing](CONTRIBUTING.md) covers source setup. [Security reporting](SECURITY.md) · [Changelog](CHANGELOG.md) · [Verification](docs/verification.md). The package is ESM with the verified ESM/NodeNext type-consumer profile; CommonJS compatibility is not promised.

Find duplicate or missing effects in a BullMQ worker retry using synthetic PostgreSQL, Redis and an HTTP simulator. A crash sweep discovers settled `pg` queries, `fetch` calls and BullMQ `Queue.add` operations, kills the worker at each observed point, and retries the same persisted job in a fresh worker.

The report preserves before, partial and final row projections, HTTP attempts, simulator-applied operations, output jobs and job identity. These are observations of declared surfaces, not a production safety verdict. Other transports and direct IP sockets are outside the coverage promise; detected unsupported operations make coverage partial.

## Work from source

Contributor work uses Node 24.22.1 and pnpm 11.23.0:

```sh
git clone https://github.com/CVamsi27/retryglass.git
cd retryglass
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
node dist/src/cli.js --help
```

Use `node dist/src/cli.js` in place of `npx --no-install retryglass` for the starter/rehearsal commands above. The compiled CLI and installed CLI expose the same commands. Store local run reports in the ignored `.retryglass/` directory. See [contributing](CONTRIBUTING.md) for the complete source/package gates.

## Keep a finding as a test

For the [first integration trial](docs/pilot.md), adapt one pure BullMQ processor, declare a business effect, and keep a single verified crash point in the normal Vitest suite. Use a full sweep to discover points. Use the exported test to rehearse the selected point on a later change.

```sh
npx --no-install retryglass inspect --report .retryglass/runs/<run-id>/report.json
npx --no-install retryglass export --run <run-id> --crash-point cp-03 --target ./regression/invoice
npm install --save-dev --ignore-scripts vitest@5.0.5
npx --no-install vitest run ./regression/invoice/retry.test.ts
```

Replace `<run-id>` and `cp-03` with the run and point you observed. Commit the reviewed synthetic regression fixture with your normal tests. Its scenario, SQL, manifest and Vitest test preserve the selected seam and business assertions. A pass requires stable discovery, verified recovery and completed cleanup for that selected point.

## Verify the implementation

```sh
pnpm check
pnpm test:integration
RETRYGLASS_CRASH_REPEAT=20 pnpm exec vitest run --config vitest.integration.config.ts tests/crash-recovery.integration.test.ts
node scripts/verify-package.mjs --manager all --containers
```

The package verifier installs a tarball into independent npm and pnpm projects, checks the real installed CLI/API/starter, and optionally runs the synthetic duplicate sweep plus buggy/corrected exported tests. Nothing is published. Local reports and verification artifacts stay under ignored `.retryglass/`.

See [setup and CI use](docs/setup.md), [current measured gates](docs/verification.md), [scenario reference](docs/scenarios.md), [operations](docs/operations.md), [capture boundaries](docs/capture-boundaries.md), [architecture](docs/architecture.md). Independent adoption and retained use are unvalidated. Related implementations are separate projects: [Deployproof](https://github.com/CVamsi27/deployproof), [Rolloutproof](https://github.com/CVamsi27/rolloutproof) and [Revokeproof](https://github.com/CVamsi27/revokeproof). The optional [developer pain lab](https://github.com/CVamsi27/developer-pain-lab) holds research, historical evidence and aggregate commands.

## Verified alpha profiles

| Profile | Verified scope |
| --- | --- |
| Ubuntu 24.04, Node 24.22.1, hosted GitHub CI | Source checks and independent packed consumers |
| macOS arm64, Node 24.22.1, OrbStack | Local declared container/browser integration described in verification |

This hosted job does not run a Linux container engine. Real container compatibility remains the local macOS arm64 OrbStack profile. See [public alpha readiness](docs/public-alpha.md) for immutable CI evidence, distribution and remaining gates. Other runtime/OS/engine combinations remain unverified.
