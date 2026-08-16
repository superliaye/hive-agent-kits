#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUBLISHER="$ROOT/scripts/publish-stable-channel.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hive-stable-channel-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

origin="$TEST_ROOT/origin.git"
seed="$TEST_ROOT/seed"
manifest="$TEST_ROOT/stable.json"
assets="$TEST_ROOT/assets"
git init -q --bare "$origin"
git init -q "$seed"
git -C "$seed" config core.hooksPath /dev/null
git -C "$seed" config user.name test
git -C "$seed" config user.email test@example.invalid
printf 'first\n' >"$seed/source"
git -C "$seed" add source
git -C "$seed" commit -qm first
git -C "$seed" branch -M main
git -C "$seed" remote add origin "$origin"
git -C "$seed" push -q origin main
first_commit="$(git -C "$seed" rev-parse HEAD)"
asset_base_url="https://github.com/superliaye/hive-agent-kits/releases/download/hive-g$first_commit/"
mkdir -p "$assets"
for name in Hive-darwin-arm64.tar.gz Hive-darwin-x64.tar.gz hive-daemon-linux-x64; do
  printf 'verified-%s\n' "$name" >"$assets/$name"
done

bun run "$ROOT/scripts/build-release-manifest.ts" \
  --assets "$assets" \
  --output "$manifest" \
  --repository https://github.com/superliaye/hive-agent-kits.git \
  --commit "$first_commit" \
  --build-version "0.0.0-g${first_commit:0:12}" \
  --published-at 2026-08-15T12:00:00Z \
  --asset-base-url "$asset_base_url"

"$PUBLISHER" \
  --repository "$origin" \
  --manifest "$manifest" \
  --expected-main "$first_commit" \
  --assets "$assets" \
  --asset-base-url "$asset_base_url"
published="$(git --git-dir="$origin" show refs/heads/release-channel:channels/stable.json)"
[[ "$published" = "$(cat "$manifest")" ]] || fail 'publisher changed the stable manifest bytes'

printf 'second\n' >>"$seed/source"
git -C "$seed" add source
git -C "$seed" commit -qm second
git -C "$seed" push -q origin main
if "$PUBLISHER" \
  --repository "$origin" \
  --manifest "$manifest" \
  --expected-main "$first_commit" \
  --assets "$assets" \
  --asset-base-url "$asset_base_url" \
  >"$TEST_ROOT/stale.out" 2>"$TEST_ROOT/stale.err"; then
  fail 'publisher advanced the channel for a stale main commit'
fi
grep -F 'main no longer matches the verified commit' "$TEST_ROOT/stale.err" >/dev/null ||
  fail 'stale-main failure was not actionable'

printf 'PASS: stable channel publication\n'
