#!/usr/bin/env bash
# Measures what the runtime image would carry, without needing a Docker daemon.
#
# It reproduces the Dockerfile's prune exactly: a production install with optional peers excluded,
# then TypeScript removed. Run it when you change a dependency, so a surprise in the image size
# shows up here rather than in a registry push.
set -euo pipefail

target="${1:-$(mktemp -d)}"
root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$root"
pnpm --filter @payguard/cli --legacy --config.auto-install-peers=false deploy --prod "$target" >/dev/null
rm -rf "$target"/node_modules/.pnpm/typescript@* "$target"/node_modules/typescript
rm -rf "$target"/node_modules/.pnpm/*/node_modules/typescript

echo "runtime payload: $(du -sh "$target" | cut -f1)"
echo ""
echo "largest packages:"
du -sh "$target"/node_modules/.pnpm/* 2>/dev/null | sort -rh | head -8

echo ""
echo "smoke test:"
node "$target/dist/bin.js" simulate | tail -2
