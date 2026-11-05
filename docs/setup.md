# Setup and CI use

Use Node 24.22.1, pnpm 11.23.0 and OrbStack with a working Docker-compatible client. The verified local profile is macOS arm64; native Linux/amd64 CI remains unverified. See [measured gates](verification.md) and [operations](operations.md) for limits and cleanup.

## From this checkout

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
orb start
docker pull postgres:17-bookworm
docker pull redis:7-bookworm
docker pull node:24-bookworm-slim
node dist/src/cli.js init --target ./my-rehearsal
node dist/src/cli.js validate --scenario ./my-rehearsal/scenario.json
node dist/src/cli.js sweep --scenario ./my-rehearsal/scenario.json
```

The `docker` commands use the compatible client connected to OrbStack. If needed, set `RETRYGLASS_CONTAINER_CLI` to its absolute executable path and `RETRYGLASS_CONTAINER_HOST` to the OrbStack socket endpoint. These overrides affect the supervisor client only. `doctor --scenario <path>` inventories local images and can report the trusted tool image missing before the first sweep builds it. It never prepares infrastructure itself.

## Install into an independent test project

No registry publication is required. Pack this repository after `pnpm check`, then install that tarball in a separate project:

```sh
# In the Retryglass checkout; prepack builds the shipped JavaScript.
npm pack

# In your separate test project, using the actual tarball path:
npm install --save-dev /absolute/path/retryglass-0.1.0-alpha.1.tgz vitest@5.0.5
npx retryglass --help
npx retryglass init --target ./my-rehearsal
npx retryglass validate --scenario ./my-rehearsal/scenario.json
npx retryglass sweep --scenario ./my-rehearsal/scenario.json
```

The generated starter includes a synthetic corrected/buggy pair, SQL, a normal Vitest test and a pure-processor image recipe. Select compiled modules explicitly; keep application boot files, production services, credentials and customer records out of the rehearsal.

## Ordinary CI commands

On a runner with the verified OrbStack profile, provision the three base images explicitly before running integration. Keep application execution in disposable cells, even when the test runner is on the host.

```sh
pnpm check
pnpm test:integration
node scripts/verify-package.mjs --manager all --containers
```

For a consumer, run the starter or exported Vitest test as part of its existing test command. Required images must already exist. Retain synthetic reports under `.retryglass/` as local/CI evidence without committing them. Preserve the test process's exit status: 0 is a complete passing result, 1 an observed violation, 2 setup/cleanup failure, and 3 incomplete evidence. A selected exported point uses its own evidence guard and does not claim that omitted points passed.

Do not replace a failed engine, collector, cleanup or event source with a skipped passing check. After supervisor termination inspect the exact run labels and resource manifest before manual removal; there is no global cleanup command. Compatibility, developer setup-time savings and retained use require their own evidence.
