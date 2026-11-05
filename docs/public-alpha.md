# Public alpha readiness

The initial source revision `9683ac96393dbe4d88280551cb1d44a5fcf1df06` passed [hosted CI](https://github.com/CVamsi27/retryglass/actions/runs/42038619026) on Ubuntu 24.04 with Node 24.22.1. Source checks and independent package consumers passed. This hosted job does not run a Linux container engine. Real container compatibility remains the local macOS arm64 OrbStack profile.

Local source and package gates passed before publication. Retryglass additionally passed 161 unit tests, 11 real-container cases and 20/20 same-job crash/retry repetitions. The other tools passed 22 Deployproof, 20 Rolloutproof and 19 Revokeproof behavior tests, their package consumers and real integration. Rolloutproof's extra real worker isolation probe passed all five assertions.

The current workflow badge reports current-head CI; the linked run is immutable evidence for the initial source code. Documentation updates do not turn unexecuted platforms or manual workflows into verified integration profiles. The optional remote OrbStack workflow requires a dedicated runner and was not dispatched or provisioned here.

GitHub alpha releases contain local-install tarballs and `SHA256SUMS.txt`. Verify the checksum, then install the tarball in a separate project. Scoped package names are not published to npm. These packages are ESM; the typed packages were additionally checked with ATTW's ESM-only profile. Read the README, verification, contributing and security notes before adapting fixtures.

Independent developer trials, retained use, setup-time savings and production behavior remain unvalidated. A public repository and green synthetic tests do not establish demand. No outreach, production access or global cleanup occurred.
