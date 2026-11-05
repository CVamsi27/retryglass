# Public alpha verification

## GitHub installation first — 5 November 2026

The README/setup guide now start from the existing immutable alpha.1 GitHub tarball. This is a documentation change; runtime behavior, package version, tag and release assets are unchanged. npm registry publication is deferred by owner choice.

Current verification passed: `pnpm check` (161 tests across 20 files, typecheck and build), and `pnpm test:integration` (11 real tests across five files on macOS arm64 through OrbStack; zero skipped). An unrelated npm consumer anonymously downloaded the public tarball and checksum, verified SHA-256, and installed with lifecycle scripts disabled. With no source checkout or pnpm on its PATH, its installed `init`, `validate` and `doctor` commands worked. The HTTP-only `demo` returned partial evidence/exit 3 as documented.

The same public consumer ran the generated corrected and buggy scenarios through OrbStack: five crash points each, exits 0 and 1 respectively, complete declared-surface coverage, expected assertion states and completed cleanup. These maintainer checks do not count as independent adoption. Local proof JSON stays ignored under `.retryglass/verification/`; no run artifact or credentials are committed. The source CI badge reports current-head checks separately from the existing alpha.1 release revision below.

Date: 5 November 2026. Local profile: Node 24.22.1, pnpm 11.23.0, macOS arm64, OrbStack 2.2.5 / compatible engine 29.8.2. The selected profile uses PostgreSQL 17/bookworm, Redis 7/bookworm and a Node 24/bookworm trusted image. Base images/caches were warm.

## Required commands

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
RETRYGLASS_CRASH_REPEAT=20 pnpm test:integration
node scripts/verify-package.mjs --manager all --containers
```

The current source check passed 161 tests in 20 files, strict typecheck and production build. The new regressions first reproduced invalid API bounds, mutable worker tags and observed findings lost after failed cleanup; all now pass. The public-alpha real integration gate passed all 11 tests across five files in 427.88 seconds. It included 20/20 verified crashes followed by same-job retry, corrected/buggy sweeps, exports and negative isolation/I/O cases. Independent installed npm and pnpm consumers both reproduced the duplicate, exported it, failed for the buggy worker and passed after correction. Cleanup completed.

Previous implementation evidence exercised five observed invoice crash points and 20/20 verified same-job crash/retry repetitions. Historical timing samples are not promises. Current run artifacts remain local and ignored; package consumers and temporary source copies are disposable. A report describes only the supplied synthetic fixture, declared surfaces and observed points.

Hosted [CI](https://github.com/CVamsi27/retryglass/actions/workflows/ci.yml) is separate from the real OrbStack gate. The [manual maintainer workflow](ci.md) needs a separately configured dedicated runner; none is provisioned here. Native Linux container integration and broader engine/runtime profiles remain unverified. Peak memory, developer setup savings, independent integrations and retained use remain unvalidated. No production service is contacted.

Package inspection also passed publint 0.3.25 and ATTW 0.18.5 with the intentional `esm-only` profile. That profile does not promise synchronous CommonJS require support. All workflow files passed Actionlint 1.7.12. Hosted CI status is available through the workflow link; a local green check does not assert an unexecuted hosted result.
