# R2B Demo Data UI Runtime Evidence

This directory contains reproducible runtime evidence for the destructive Demo Data Admin UI.

Run from the repository root:

```bash
cd web
npm run acceptance:r2b-demo-data
```

The acceptance harness starts a private PostgreSQL cluster under `/private/tmp`, creates a disposable database, runs migrations 001–035, and starts the real Fastify and Vite applications. Playwright then exercises the destructive flow through the browser. The harness never uses the repository's ordinary `DATABASE_URL`; the disposable database and private cluster are removed during cleanup.

The scenario verifies:

- safe preview and confirmation count snapshot;
- initial dialog focus and pending-state interaction lock;
- exactly one purge POST with no automatic mutation retry;
- lost-response ambiguity followed by GET reconciliation;
- verified success and persisted `PURGED` tombstone behavior;
- preservation of BUSINESS sentinel records in PostgreSQL;
- responsive mobile reflow and absence of uncaught browser errors.

`runtime-results.json` is the machine-readable assertion report. The numbered files in `screenshots/` capture the corresponding UI states. A `failure.png` file is produced only when a run fails and is cleared at the start of the next run.

## Known product debt

The current preview contract is not actor-aware. An Admin account that belongs to the selected DEMO dataset can therefore receive a safe preview before the purge POST is rejected with `PURGE_ACTOR_IN_DATASET`. The UI hides the action after that authoritative rejection, but a reload can expose it again. A future backend slice should make preview eligibility actor-aware; R2B deliberately leaves the R2A contract unchanged.
