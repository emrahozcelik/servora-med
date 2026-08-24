# Real R2 DR acceptance evidence

This directory accepts only safe, machine-readable output from the explicit
real Cloudflare R2 DR harness.

Current result:

```text
REAL_R2_DR_ACCEPTANCE = NOT EXECUTED
reason: dedicated disposable Cloudflare R2 acceptance credentials unavailable
```

[`not-executed.json`](./not-executed.json) records the observed pre-execution
gate without claiming any R2 operation passed. No real R2 request, synthetic
database creation, age identity generation, restore, production host check,
worker enablement, or production cutover occurred.

[`production-readiness.json`](./production-readiness.json) records the
read-only repository/host matrix. Repository artifacts may be PASS while all
uninspected production-host fields remain `NOT_VERIFIED`; the aggregate result
is therefore `BLOCKED`, not an optimistic authorization.

A real invocation writes a unique `acceptance-*.json` file atomically with
mode 0600. Such a file may be committed only after review confirms it contains
no R2 secret/token, session token, private age identity, database URL,
`PGPASSWORD`, connection string, signed URL, raw request headers, SDK dump, or
raw domain data.

See the operator contract:
[`real-r2-dr-acceptance.md`](../../operations/backup-recovery/real-r2-dr-acceptance.md).
