#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" == 0 && "$(hostname)" == lima-servora-r4-20261012 ]]
source /usr/local/libexec/servora-med/deploy-production-host
SHA=8888888888888888888888888888888888888888
sealed="/var/lib/servora-med/deploy/artifacts/$SHA.tar.gz"
upload="$(mktemp /var/tmp/servora-r4-upload.XXXXXX.tar.gz)"
trap 'rm -f -- "$upload"' EXIT
cp "$sealed" "$upload"
chown servora-deploy:servora-deploy "$upload";chmod 0600 "$upload"
ARTIFACT="$upload"
ARTIFACT_SHA="$(sha256sum "$sealed" | cut -d' ' -f1)"
r4_retain_artifact
[[ "$ARTIFACT" == "$sealed" ]]
# Deterministic adversarial interleaving: the upload owner replaces bytes
# after checksum/sealing. All subsequent tar reads must use the root copy.
sudo -u servora-deploy /bin/bash -c 'printf "changed upload bytes\n" >"$1"' fixture "$upload"
verify_archive_entries
[[ "$(sha256sum "$ARTIFACT" | cut -d' ' -f1)" == "$ARTIFACT_SHA" ]]
echo ROOT_SEALED_ARTIFACT_UPLOAD_REPLACEMENT=PASS
