# Contributing

Read the scope and compatibility notes in [README](README.md). Fork the repository, clone your fork and use a branch such as `fix/short-description`. Use Node 24.22.1 and the checked-in lockfile.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test:integration
node scripts/verify-package.mjs --manager all --containers
```

Prepare the three base images explicitly through OrbStack as documented in the README. Record exactly which checks passed, failed or were blocked. Missing prerequisites and incomplete evidence must remain nonzero.

For a bug, provide a minimal synthetic fixture, exact command, versions, expected behavior and observed result. Add a regression that fails before a behavior fix and passes after it. Keep application execution within the documented boundary. Do not include production data, credentials, raw environment dumps or application boot files.

A pull request should explain the resulting behavior, why it is needed, validation and compatibility limits. Preserve cleanup ownership and evidence distinctions. No automatic external probing, production connectors or global cleanup.

Use [issues](https://github.com/CVamsi27/retryglass/issues) for non-sensitive reports and [private security reporting](SECURITY.md) for sensitive findings. Actual integration and retained-use evidence is useful; stars and synthetic examples do not establish adoption.
