#!/usr/bin/env bash
set -euo pipefail
umask 077

PROGRAM="${0##*/}"
REPOSITORY=''
MANIFEST=''
EXPECTED_MAIN=''
ASSETS=''
ASSET_BASE_URL=''
WORK_DIR=''

die() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

cleanup() {
  local status="${1:-$?}"
  trap - EXIT HUP INT TERM
  [[ -z "$WORK_DIR" || ! -d "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
  exit "$status"
}

trap 'cleanup $?' EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

usage() {
  printf 'usage: %s --repository <git-remote-or-url> --manifest <stable.json> --expected-main <commit> --assets <directory> --asset-base-url <url>\n' "$PROGRAM" >&2
  exit 2
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --repository)
      [[ "$#" -ge 2 && -z "$REPOSITORY" ]] || usage
      REPOSITORY="$2"
      shift 2
      ;;
    --manifest)
      [[ "$#" -ge 2 && -z "$MANIFEST" ]] || usage
      MANIFEST="$2"
      shift 2
      ;;
    --expected-main)
      [[ "$#" -ge 2 && -z "$EXPECTED_MAIN" ]] || usage
      EXPECTED_MAIN="$2"
      shift 2
      ;;
    --assets)
      [[ "$#" -ge 2 && -z "$ASSETS" ]] || usage
      ASSETS="$2"
      shift 2
      ;;
    --asset-base-url)
      [[ "$#" -ge 2 && -z "$ASSET_BASE_URL" ]] || usage
      ASSET_BASE_URL="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$REPOSITORY" && -n "$MANIFEST" && -n "$EXPECTED_MAIN" && -n "$ASSETS" && -n "$ASSET_BASE_URL" ]] || usage
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || die 'expected main must be a full commit ID'
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || die 'manifest must be a regular file'
[[ -d "$ASSETS" ]] || die 'assets directory is unavailable'
bun run "${BASH_SOURCE[0]%/*}/validate-release-manifest.ts" \
  "$MANIFEST" "$EXPECTED_MAIN" "$ASSETS" "$ASSET_BASE_URL" >/dev/null

if resolved_repository="$(git remote get-url "$REPOSITORY" 2>/dev/null)"; then
  REPOSITORY="$resolved_repository"
fi

remote_main="$(git ls-remote "$REPOSITORY" refs/heads/main | awk 'NR == 1 { print $1 }')"
[[ "$remote_main" = "$EXPECTED_MAIN" ]] || die 'main no longer matches the verified commit'

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hive-stable-channel.XXXXXX")"
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" config core.hooksPath /dev/null
git -C "$WORK_DIR" config user.name 'Hive release automation'
git -C "$WORK_DIR" config user.email 'hive-release@users.noreply.github.com'
git -C "$WORK_DIR" remote add origin "$REPOSITORY"

if git -C "$WORK_DIR" fetch -q --depth=1 origin refs/heads/release-channel 2>/dev/null; then
  git -C "$WORK_DIR" checkout -q -b release-channel FETCH_HEAD
else
  git -C "$WORK_DIR" checkout -q --orphan release-channel
fi

install -d -m 700 "$WORK_DIR/channels"
install -m 600 "$MANIFEST" "$WORK_DIR/channels/stable.json"
git -C "$WORK_DIR" add channels/stable.json
if git -C "$WORK_DIR" diff --cached --quiet; then
  exit 0
fi
git -C "$WORK_DIR" commit -qm "Advance Hive stable to g$EXPECTED_MAIN"

remote_main="$(git ls-remote "$REPOSITORY" refs/heads/main | awk 'NR == 1 { print $1 }')"
[[ "$remote_main" = "$EXPECTED_MAIN" ]] || die 'main no longer matches the verified commit'
git -C "$WORK_DIR" push -q origin HEAD:refs/heads/release-channel
