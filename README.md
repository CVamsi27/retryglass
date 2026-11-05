# Retryglass

Find where a BullMQ retry duplicates, loses or leaves incomplete declared business effects in a disposable synthetic rehearsal.

[![CI](https://github.com/CVamsi27/retryglass/actions/workflows/ci.yml/badge.svg)](https://github.com/CVamsi27/retryglass/actions/workflows/ci.yml)

Public alpha for synthetic/local testing. Use Node 24.22.1 (`.node-version`). Installation from source and local tarballs is supported; the scoped package names are not published to npm. [GitHub releases](https://github.com/CVamsi27/retryglass/releases) provide verified alpha tarballs when a release is available.

## Clone and run

```sh
git clone https://github.com/CVamsi27/retryglass.git
cd retryglass
npm install --global pnpm@11.23.0
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
node dist/src/cli.js init --target ./my-rehearsal
node dist/src/cli.js validate --scenario ./my-rehearsal/scenario.json
```

The example target must be new. Container-backed commands below require OrbStack and explicit local image preparation. They use the Docker-compatible CLI connected to OrbStack; Docker Desktop is not required. Missing engine, browser, image, collector or cleanup evidence remains a failure.

To use a tarball in another project, download this project's `.tgz` from its release and run `npm install --save-dev /absolute/path/to/the-downloaded.tgz`. Install `vitest@5.0.5` explicitly in the consumer project when running exported tests.

See [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), [changes](CHANGELOG.md) and [verification](docs/verification.md). Platform and adoption claims remain limited to recorded observations. These are ESM packages; the verified type-consumer profile is ESM/NodeNext. CommonJS compatibility is not promised; use dynamic import where needed.

Find duplicate or missing effects in a BullMQ worker retry using synthetic PostgreSQL, Redis and an HTTP simulator. A crash sweep discovers settled `pg` queries, `fetch` calls and BullMQ `Queue.add` operations, kills the worker at each observed point, and retries the same persisted job in a fresh worker.

The report preserves before, partial and final row projections, HTTP attempts, simulator-applied operations, output jobs and job identity. These are observations of declared surfaces, not a production safety verdict. Other transports and direct IP sockets are outside the coverage promise; detected unsupported operations make coverage partial.

## Start locally with OrbStack

Requires Node 24.22.1, pnpm 11.23.0 and a running OrbStack engine with its Docker-compatible CLI. Docker Desktop and Compose are not required. Service images are local and synthetic.

```sh
pnpm install --frozen-lockfile
pnpm check
orb start
# These commands use the Docker-compatible client connected to OrbStack.
docker pull postgres:17-bookworm
docker pull redis:7-bookworm
docker pull node:24-bookworm-slim
node dist/src/cli.js --help
```

When developing this checkout, invoke the compiled CLI directly:

```sh
node dist/src/cli.js init --target ./my-rehearsal
node dist/src/cli.js validate --scenario ./my-rehearsal/scenario.json
node dist/src/cli.js doctor --scenario ./my-rehearsal/scenario.json
node dist/src/cli.js sweep --scenario ./my-rehearsal/scenario.json
node dist/src/cli.js sweep --scenario ./my-rehearsal/scenario-buggy.json
```

`doctor` inventories prerequisites without pulling images, building or running application code. The first bundled sweep builds the trusted tool image from shipped artifacts and the installed runtime dependency closure. A missing local tool image before that first build is expected. `init` refuses existing directories; `validate` reads JSON and contained synthetic SQL without importing a processor.

The corrected example exits 0. The buggy example uses a fresh provider key on retry and exits 1 with `one-provider-action` failing at and after the provider boundary. Exit 2 means setup or cleanup failed; exit 3 means evidence is incomplete. Evaluated violations remain visible even when another sweep point is incomplete.

For an explicit client/endpoint, set these variables on the supervisor:

```sh
export RETRYGLASS_CONTAINER_CLI=/absolute/path/to/docker
export RETRYGLASS_CONTAINER_HOST="unix://$HOME/.orbstack/run/docker.sock"
```

They select the OrbStack endpoint without changing global context and are never passed into a worker. The compatibility client is still named `docker`; container execution is provided by OrbStack.

## Keep a finding as a test

```sh
node dist/src/cli.js inspect --report .retryglass/runs/<run-id>/report.json
node dist/src/cli.js export --run <run-id> --crash-point cp-03 --target ./regression/invoice
```

The exported fixture includes the preserved scenario and SQL, a manifest, and a normal Vitest test importing `retryglass`. Install the local tarball and Vitest in its consumer project. The test fails for the buggy worker and passes after the worker is corrected. It requires stable discovery, the same selected seam, verified kill/recovery, all declared assertions and completed cleanup. An intentionally selected point does not establish coverage for omitted points.

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
