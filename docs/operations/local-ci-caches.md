# Local CI download caches — Phase 1

Scope: reusable Playwright browser/system dependencies and npm downloads.
Migration execution, canonical server preflight, test selection, file parallelism,
server/web sequencing, production and the 27 required gates are unchanged.

## Environment and lifetime

Use the [resource recovery runbook](local-ci-resource-recovery.md) §1 and §9
before starting. The authorized optimization environment is a new `true`
profile: native ARM64 VZ VM, Docker, 3 CPUs, 4 GiB RAM, 40 GiB Docker data disk,
Kubernetes disabled, installed Rosetta for existing linux/amd64 server checks.
The native web platform remains unchanged. Colima also has a separate default
20 GiB root disk; the 40 GiB setting is its Docker data disk.

For a missing profile/context only, after verifying that neither name nor disk
exists and that there is no competing CI/test/build/deploy/recovery process:

```bash
colima start --profile true --template=false --activate=false --ssh-config=false \
  --arch aarch64 --cpus 3 --memory 4 --disk 40 --runtime docker \
  --kubernetes=false --vm-type vz --vz-rosetta
```

Check the installed CLI's help before provisioning. Do not overwrite or resize
an existing profile. Keep the operator's active Docker context; select this
daemon per invocation with `DOCKER_CONTEXT=colima-true`, `DOCKER_HOST` unset,
and host Node 22 on PATH. Verify host/guest daemon IDs, same-path shared files,
guest Linux Node 22, capacity, empty containers and CI lock ownership first.
Do not start local CI while another workload uses the VM.

The Phase 1 profile, data disk, browser images, builder cache and npm volumes
are intentionally retained for later runs. Normal CI still removes its own
PostgreSQL container/anonymous volume, network and source export and finalizes
cleanup evidence. Persistent caches are never attached to PostgreSQL. Stopping
the VM is allowed when idle; deleting it or its data disk discards the benefit.
No global prune or automatic stale-cache retirement is part of this change.

## Browser image

`ops/local-ci/images/web.Dockerfile` keeps Node 22 on Debian Bookworm. Its
multiarch base is pinned by version and digest. The existing native daemon
architecture determines the web platform; the server remains linux/amd64.

The image key hashes the platform and exact bytes of:

- `web/package.json` and `web/package-lock.json`;
- the Dockerfile (including the pinned base and installation recipe);
- `ops/local-ci/browser-availability.mjs`.

Each key has a separate `servora-med/local-ci-web:<arch>-<key>` tag. A missing
image is built on the pinned Colima daemon using its existing guest Buildx.
The host needs no new Docker plugin or configuration. The build receives only
the four exact-export inputs over stdin. The guest daemon must match the
pinned host daemon before the build. Failed or ambiguous image inspection,
build, metadata or architecture validation stops CI; an existing mismatched
image is refused rather than overwritten. Execution uses an immutable image ID.

Image preparation runs `npm ci` against the full web lockfile and installs
Chromium, its headless shell, WebKit and their OS dependencies with the locked
Playwright CLI. It records Node/npm/Playwright/core versions, lockfile digest,
architecture, Debian release and the resolved dpkg package inventory. Bootstrap
`node_modules` and npm downloads are removed from the image. Each CI run still
does its own fresh `npm ci`; no application dependencies or build output are
restored from the image.

The existing **`web-playwright-install` gate ID is retained**. Its command now
verifies installed packages against the current lockfile, compares the image's
runtime and OS package inventory, then actually launches and renders a page in
headless-shell Chromium, full Chromium and WebKit. Missing browsers/libraries,
wrong versions/architecture, launch or rendering failures return nonzero.
`BROWSER_AVAILABILITY_PASS` is printed only after all three probes succeed.
The normal production-dist, responsive and geometry checks still run in full.

Dependency or recipe changes get a new key and a fresh image automatically;
old images remain intact. Apt repositories are resolved at image-build time,
not from a snapshot. The resulting immutable image records the actual package
versions. Refresh OS packages deliberately by updating the Dockerfile/base;
an upstream apt update alone does not mutate an already cached image.

## npm downloads

Main server/web chains retain `npm ci`, lockfile integrity validation and fresh
`node_modules`. Only npm's content-addressed download cache is persistent.
There is no offline-only installation, lockfile bypass, cached test result,
build cache or change to registry audit commands.

Volumes are named `servora-localci-npm-<server|web>-<key>`. The key includes both
package manifests, platform and the exact container Node/npm versions. Server
and web have separate scopes: server uses UID/GID 1000 and web uses root, as
before. Before mounting, the runner requires the local volume driver and exact
`com.servora.local-ci.cache` / `com.servora.local-ci.cache-key` labels. It changes
only that verified mount root's ownership. A foreign or uninspectable volume
fails closed, without changing its ownership or deleting it.

An empty/missing cache is filled by ordinary `npm ci`. npm verifies cached
content against integrity metadata and refetches damaged/missing downloads.
This remains a download optimization; all builds, tests, audits, schema and
evidence checks execute. The host dependency scan and separate linux/amd64
compatibility install keep their existing isolated install behavior.

## Measurement and acceptance

Use separate evidence roots for cold and warm runs of the **same exact SHA**;
never delete or alter old evidence to manufacture a cold run. First-use image
build time is included in cold CI's manifest window and separately reported by
`LOCAL_CI_BROWSER_IMAGE_READY ... seconds=...` in
`logs/aux/cache-preparation.log`. Report VM/base-image/guest-tool provisioning
separately. A warm run must show the image hit and reused cache names.

```bash
DOCKER_CONTEXT=colima-true ops/local-ci/run.sh --sha <exact-sha> --evidence-root <cold-root>
DOCKER_CONTEXT=colima-true ops/local-ci/run.sh --sha <same-exact-sha> --evidence-root <warm-root>
ops/local-ci/verify-evidence.sh --evidence-root <cold-root> --sha <exact-sha> --tree <tree>
ops/local-ci/verify-evidence.sh --evidence-root <warm-root> --sha <same-exact-sha> --tree <tree>
node --test ops/tests/ci-resource-cleanup.test.mjs ops/tests/ci-resource-lifecycle.test.mjs
```

Acceptance requires 27/27 gates, explicit finalized cleanup PASS, both exact
SHA/tree verifiers, unchanged product test/skip counts, real missing-browser
rejection, and cold/warm/corrupt-download installation checks. The cache tests
are imported by the existing resource-cleanup Node suite in `server-tests`;
they add assertions without replacing any existing test. Per-gate log birth
and exit-file modification times give approximate historical comparisons;
Vitest's own duration is a different measurement from the whole server gate.

The retained `d6bb6483f983fbacaff2141355d2dfc04c5d1161` schema-2 bundle verifies
as 27/27 PASS with cleanup PASS. Its manifest window is 1,844 seconds. Historical
file times give server-tests 1,045.0 s, browser install 223.0 s, responsive smoke
225.2 s and web tests 206.1 s. Server Vitest itself reports 976.79 s, 4,331
passed / 8 skipped; web reports 204.65 s and 2,724 passed. These are historical
measurements, not a new run on the Phase 1 VM. Current cold/warm results and
bundle identities belong in the PR's verification record.

Migration profiling is measurement-only and is kept outside the implementation
checkout. Always enter Vitest through `npm test` so the canonical read-only
preflight runs. Do not infer migration wall time by multiplying log lines by
an assumed duration. Template databases and migration helper changes require
a separate Phase 2 PR: they must preserve actual migration/upgrade tests,
schema/search-path isolation, extensions, constraints, history, locking and
test permissions. SQL-query totals, transaction totals and concurrent elapsed
time are different quantities; any estimate of template benefit must identify
which it uses. Phase 1 introduces no template database or migration change.
