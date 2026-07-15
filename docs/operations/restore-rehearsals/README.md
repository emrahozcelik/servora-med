# Restore rehearsal records

Add one markdown file per rehearsal, e.g. `2026-07-15-pre-pilot.md`.

## Template

```markdown
# Restore rehearsal

- date/time (UTC):
- operator:
- application SHA:
- backup timestamp / filename:
- checksum:
- safe target database name:
- duration:
- result: pass | fail
- follow-up:

Notes:

(Do not record passwords, full DATABASE_URL values, or host credentials.)
```

Until a real rehearsal is performed against a disposable database, do not claim restore verification is complete for a live VPS.
