# Retryglass operating rules

- Use synthetic fixtures. Never import production databases, queues, credentials or application boot files to run a rehearsal.
- Run application code only in the constrained disposable cell. Keep the Docker socket, host environment and host source mounts out of worker containers.
- Observations cover declared surfaces. PostgreSQL snapshots are net row state; HTTP attempts and simulator-applied operations are separate facts.
- Preserve the same persisted BullMQ job and business key across retry. Keep before, partial and after evidence.
- A failed collector, failed cleanup, missing required effect or unexpected terminal job state must never become a complete passing result.
- Do not commit local run artifacts or secrets. Public examples must remain synthetic and self-contained.
- Before commit: `pnpm check`; run relevant real-container integration tests and record skipped/blocked gates honestly.
- No automatic publication, production retry, hosted service or global Docker cleanup.

Public GitHub creation and pushes for this alpha are explicitly authorized by the user on 5 November 2026 after readiness checks. Registry publication, outreach, production actions and global cleanup still require their own authorization.
