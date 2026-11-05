# Project overview

Retryglass helps a Node/BullMQ developer reproduce duplicate, lost or incomplete declared effects after a worker fails. It uses synthetic PostgreSQL, Redis, a provider simulator and prebuilt processor images, preserving the same physical job and business key across retry.

A crash sweep discovers supported settled seams, verifies a real kill at each observed point, recovers the job through the stalled path and retries it in a fresh worker. A corrected invoice fixture preserves its declared effects; a fixture that changes the provider key exposes duplicate simulator operations. A simulator configured to ignore the key still produces duplicates.

The CLI, versioned reports, normal Vitest exports, synthetic starter and independent package consumers are implemented. This is an alpha with declared boundaries, not a production safety verdict. SDK transports, direct IP sockets, synchronous subprocesses, broad platform compatibility and hostile-code mediation are outside the supported promise.

Read [setup](setup.md), [scenarios](scenarios.md), [capture boundaries](capture-boundaries.md), [operations](operations.md), [architecture](architecture.md) and [verification](verification.md). Independent developer integration, retained use and setup-time savings remain unvalidated. Research and other independent tools are in the [public research index](https://github.com/CVamsi27/developer-pain-lab).
