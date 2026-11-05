# Security reporting

Only the current alpha is maintained. Its supported scope and tested platforms are in the README. This is owner-controlled synthetic/local testing, not a hosted arbitrary-code sandbox or production safety certificate.

Use this repository's [private vulnerability reporting](https://github.com/CVamsi27/retryglass/security/advisories/new). If unavailable, use the maintainer contact options on the [GitHub profile](https://github.com/CVamsi27) without posting sensitive details publicly. Include the affected commit, synthetic reproduction, observed impact and tested environment. No response-time guarantee is implied.

Important boundaries include keeping host credentials, application boot files and engine sockets out of workers; containing artifact reads and fixture paths; preserving incomplete observations and cleanup failures; and deleting only verified run-owned resources. Browser examples must use their explicitly started loopback fixture. This is not complete mediation against hostile code.

Do not probe third-party or production services to produce a report. Never attach live credentials, private application data or environment dumps. Local run artifacts, dependency folders, private attachments and environment files are excluded from source and package distribution.
