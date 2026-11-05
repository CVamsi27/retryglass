# CI and real-container gates

Hosted CI runs source/package checks on Ubuntu 24.04 with Node 24.22.1. A green unit/package job does not establish container-profile compatibility. Local container evidence uses OrbStack on macOS arm64.

The manual OrbStack workflow requires a dedicated runner labelled `self-hosted`, `macOS`, `ARM64`, `orbstack`, a working compatible client/endpoint, and the explicit base/fixture images in the README. It accepts only owner-triggered workflow dispatch and never runs automatically for public pull requests. No runner is provisioned or registered by this repository. Without one, the remote manual gate is unexecuted; local real-container tests are separate evidence.

Configure only the supervisor's `CONTAINER_CLI`/`CONTAINER_HOST` variables (or `RETRYGLASS_CONTAINER_CLI`/`RETRYGLASS_CONTAINER_HOST` for Retryglass) in that dedicated runner. Do not give application containers a host socket, source mount or inherited environment. Keep logs synthetic and inspect exact run labels after an interrupted supervisor. No global cleanup.

Actions are pinned to inspected full commit SHAs and use a read-only repository token with persisted checkout credentials disabled. The workflow definitions follow [GitHub syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use). Registry publication and deployment are not part of CI.
