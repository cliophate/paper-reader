#!/bin/sh
set -eu
# --ai-worker-secret preserves settings and prints the socket upgrade guidance.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then
    exec node scripts/init-config.mjs "$@"
fi
exec docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 node scripts/init-config.mjs "$@"
