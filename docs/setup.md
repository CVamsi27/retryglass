# Setup and CI use

Use Node 24.22.1. Source contributors use pnpm 11.23.0; real rehearsals need OrbStack with a working Docker-compatible client. The installed CLI needs no pnpm installation. The verified real-container profile is macOS arm64; native Linux/amd64 integration remains unverified. See [measured gates](verification.md) and [operations](operations.md) for limits and cleanup.

## From this checkout

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
node dist/src/cli.js init --target ./my-rehearsal
node dist/src/cli.js validate --scenario ./my-rehearsal/scenario.json
```

Prepare OrbStack and its local images with the README's explicit client/endpoint commands before running a sweep:

```sh
node dist/src/cli.js doctor --scenario ./my-rehearsal/scenario.json
node dist/src/cli.js sweep --scenario ./my-rehearsal/scenario.json
```

The `docker` commands use the compatible client connected to OrbStack. If needed, set `RETRYGLASS_CONTAINER_CLI` to its absolute executable path and `RETRYGLASS_CONTAINER_HOST` to the OrbStack socket endpoint. These overrides affect the supervisor client only. `doctor --scenario <path>` inventories local images and can report the trusted tool image missing before the first sweep builds it. It never prepares infrastructure itself.

## Install into an independent test project

GitHub release packages are the supported path; npm registry publishing is deferred by the owner. Node 24.22.1 is required. No clone or pnpm installation is needed for the installed CLI:

```sh
npm install --save-dev --ignore-scripts https://github.com/CVamsi27/retryglass/releases/download/v0.1.0-alpha.2/retryglass-0.1.0-alpha.2.tgz vitest@5.0.5
npx --no-install retryglass --help
npx --no-install retryglass init --target ./my-rehearsal
npx --no-install retryglass validate --scenario ./my-rehearsal/scenario.json
```

`init` refuses an existing target. It writes synthetic fixture files; `validate` reads JSON and contained SQL. Neither command imports the processor or runs a container. Use `--no-install` to ensure npx selects the package you installed. The release includes `SHA256SUMS.txt`; source developers can still run `pnpm check` and `npm pack` to create their own local tarball.

Before a real sweep, prepare OrbStack and its three base images using the README's explicit client/endpoint commands. Then run:

```sh
npx --no-install retryglass doctor --scenario ./my-rehearsal/scenario.json
npx --no-install retryglass sweep --scenario ./my-rehearsal/scenario.json
npx --no-install retryglass sweep --scenario ./my-rehearsal/scenario-buggy.json
```

The generated starter includes a synthetic corrected/buggy pair, SQL, a normal Vitest test and a pure-processor image recipe. Select compiled modules explicitly; keep application boot files, production services, credentials and customer records out of the rehearsal. `doctor` may report the trusted tool image missing before the first sweep builds it. This is a prerequisite observation, not a failed application test. The separate HTTP-only `demo` intentionally reports partial evidence and exits 3.

## Ordinary CI commands

When upgrading to alpha.2, build the current trusted image with a bundled starter sweep. Earlier exported scenarios retain their original worker image references. Keep that image available or run the export with its original package pin.

On a runner with the verified OrbStack profile, provision the three base images explicitly before running integration. Keep application execution in disposable cells, even when the test runner is on the host.

```sh
pnpm check
pnpm test:integration
node scripts/verify-package.mjs --manager all --containers
```

For a consumer, run the starter or exported Vitest test as part of its existing test command. Required images must already exist. Retain synthetic reports under `.retryglass/` as local/CI evidence without committing them. Preserve the test process's exit status: 0 is a complete passing result, 1 an observed violation, 2 setup/cleanup failure, and 3 incomplete evidence. A selected exported point uses its own evidence guard and does not claim that omitted points passed.

Do not replace a failed engine, collector, cleanup or event source with a skipped passing check. After supervisor termination inspect the exact run labels and resource manifest before manual removal; there is no global cleanup command. Compatibility, developer setup-time savings and retained use require their own evidence.
