#!/usr/bin/env bash
set -euo pipefail
umask 077

PROGRAM="${0##*/}"
SOURCE_COMMIT=''
ASSETS=''
MANIFEST=''
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
  printf 'usage: %s --source-commit <commit> --assets <directory> --manifest <stable.json>\n' \
    "$PROGRAM" >&2
  exit 2
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --source-commit)
      [[ "$#" -ge 2 && -z "$SOURCE_COMMIT" ]] || usage
      SOURCE_COMMIT="$2"
      shift 2
      ;;
    --assets)
      [[ "$#" -ge 2 && -z "$ASSETS" ]] || usage
      ASSETS="$2"
      shift 2
      ;;
    --manifest)
      [[ "$#" -ge 2 && -z "$MANIFEST" ]] || usage
      MANIFEST="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die 'source commit must be a full commit ID'
[[ -d "$ASSETS" ]] || die 'assets directory is unavailable'
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || die 'manifest must be a regular file'

readonly TAG="hive-g$SOURCE_COMMIT"
readonly RELEASE_FILES=(
  Hive-darwin-arm64.tar.gz
  Hive-darwin-x64.tar.gz
  hive-daemon-linux-x64
  stable.json
)
for name in "${RELEASE_FILES[@]:0:3}"; do
  [[ -f "$ASSETS/$name" && ! -L "$ASSETS/$name" ]] || die "release asset is unavailable: $name"
done

if release_json="$(gh release view "$TAG" --json targetCommitish,assets 2>/dev/null)"; then
  jq -e --arg commit "$SOURCE_COMMIT" '
    .targetCommitish == $commit and
    ([.assets[].name] | sort) == [
      "Hive-darwin-arm64.tar.gz",
      "Hive-darwin-x64.tar.gz",
      "hive-daemon-linux-x64",
      "stable.json"
    ]
  ' <<<"$release_json" >/dev/null || die "existing release identity is incompatible: $TAG"

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hive-existing-release.XXXXXX")"
  gh release download "$TAG" --dir "$WORK_DIR"
  for name in "${RELEASE_FILES[@]:0:3}"; do
    cmp -s "$ASSETS/$name" "$WORK_DIR/$name" || die "existing release asset differs: $name"
  done
  cmp -s "$MANIFEST" "$WORK_DIR/stable.json" || die 'existing release manifest differs'
  exit 0
fi

gh release create "$TAG" \
  "$ASSETS/Hive-darwin-arm64.tar.gz" \
  "$ASSETS/Hive-darwin-x64.tar.gz" \
  "$ASSETS/hive-daemon-linux-x64" \
  "$MANIFEST" \
  --target "$SOURCE_COMMIT" \
  --title "Hive g${SOURCE_COMMIT:0:12}" \
  --notes "Verified matched Hive Shell and Daemon release from $SOURCE_COMMIT." \
  --latest=false
