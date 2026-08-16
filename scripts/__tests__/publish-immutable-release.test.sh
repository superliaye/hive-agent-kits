#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROGRAM="$REPO_ROOT/scripts/publish-immutable-release.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hive-immutable-release-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

COMMIT='0123456789abcdef0123456789abcdef01234567'
ASSET_BASE_URL="https://github.com/superliaye/hive-agent-kits/releases/download/hive-g$COMMIT/"
ASSETS="$TEST_ROOT/assets"
EXISTING="$TEST_ROOT/existing"
BIN="$TEST_ROOT/bin"
LOG="$TEST_ROOT/gh.log"
STATE="$TEST_ROOT/release-present"
mkdir -p "$ASSETS" "$EXISTING" "$BIN"

for name in Hive-darwin-arm64.tar.gz Hive-darwin-x64.tar.gz hive-daemon-linux-x64; do
  printf 'verified-%s\n' "$name" >"$ASSETS/$name"
done
(
  cd "$REPO_ROOT"
  bun run release:manifest -- \
    --assets "$ASSETS" \
    --output "$TEST_ROOT/stable.json" \
    --repository https://github.com/superliaye/hive-agent-kits.git \
    --commit "$COMMIT" \
    --build-version "0.0.0-g${COMMIT:0:12}" \
    --published-at 2026-08-15T12:00:00Z \
    --asset-base-url "$ASSET_BASE_URL"
)

cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" = 'release view' ]]; then
  [[ -f "$FAKE_RELEASE_STATE" ]] || exit 1
  names=()
  for path in "$FAKE_EXISTING_DIR"/*; do
    [[ ! -f "$path" ]] || names+=("${path##*/}")
  done
  jq -cn --arg commit "$FAKE_TARGET_COMMIT" \
    --argjson draft "${FAKE_IS_DRAFT:-false}" \
    --argjson prerelease "${FAKE_IS_PRERELEASE:-false}" --args \
    '$ARGS.positional as $names | {targetCommitish: $commit, isDraft: $draft, isPrerelease: $prerelease, assets: ($names | map({name: .}))}' \
    "${names[@]}"
  exit 0
fi
if [[ "$1 $2" = 'release download' ]]; then
  destination=''
  while (($#)); do
    if [[ "$1" = --dir ]]; then destination="$2"; break; fi
    shift
  done
  cp "$FAKE_EXISTING_DIR"/* "$destination/" 2>/dev/null || true
  exit 0
fi
if [[ "$1 $2" = 'release create' ]]; then
  touch "$FAKE_RELEASE_STATE"
  printf '%s\n' "$*" >>"$FAKE_GH_LOG"
  exit 0
fi
if [[ "$1 $2" = 'release upload' ]]; then
  printf '%s\n' "$*" >>"$FAKE_GH_LOG"
  shift 3
  for source in "$@"; do
    cp "$source" "$FAKE_EXISTING_DIR/${source##*/}"
  done
  exit 0
fi
exit 97
EOF
chmod 755 "$BIN/gh"

run_program() {
  local manifest="${1:-$TEST_ROOT/stable.json}"
  PATH="$BIN:$PATH" \
    FAKE_RELEASE_STATE="$STATE" \
    FAKE_EXISTING_DIR="$EXISTING" \
    FAKE_TARGET_COMMIT="$COMMIT" \
    FAKE_IS_DRAFT="${FAKE_IS_DRAFT:-false}" \
    FAKE_IS_PRERELEASE="${FAKE_IS_PRERELEASE:-false}" \
    FAKE_GH_LOG="$LOG" \
    "$PROGRAM" \
      --source-commit "$COMMIT" \
      --assets "$ASSETS" \
      --manifest "$manifest" \
      --asset-base-url "$ASSET_BASE_URL"
}

run_program
grep -q '^release create ' "$LOG"
grep -q '^release upload ' "$LOG"
for name in Hive-darwin-arm64.tar.gz Hive-darwin-x64.tar.gz hive-daemon-linux-x64; do
  cmp -s "$ASSETS/$name" "$EXISTING/$name"
done
cmp -s "$TEST_ROOT/stable.json" "$EXISTING/stable.json"

for field in sha256 sizeBytes url; do
  jq --arg field "$field" '
    .release.artifacts[0] |=
      if $field == "sha256" then .sha256 = ("0" * 64)
      elif $field == "sizeBytes" then .sizeBytes += 1
      else .url = "https://github.com/superliaye/hive-agent-kits/releases/download/hive-g0123456789abcdef0123456789abcdef01234567/wrong"
      end
  ' "$TEST_ROOT/stable.json" >"$TEST_ROOT/invalid-$field.json"
  if run_program "$TEST_ROOT/invalid-$field.json"; then
    echo "expected a mismatched manifest $field to fail" >&2
    exit 1
  fi
done

: >"$LOG"
run_program
[[ ! -s "$LOG" ]]

if FAKE_IS_DRAFT=true run_program; then
  echo 'expected a draft release to fail publication' >&2
  exit 1
fi
if FAKE_IS_PRERELEASE=true run_program; then
  echo 'expected a prerelease to fail publication' >&2
  exit 1
fi

rm "$EXISTING/Hive-darwin-x64.tar.gz" "$EXISTING/stable.json"
run_program
grep -q '^release upload ' "$LOG"
cmp -s "$ASSETS/Hive-darwin-x64.tar.gz" "$EXISTING/Hive-darwin-x64.tar.gz"
cmp -s "$TEST_ROOT/stable.json" "$EXISTING/stable.json"

printf 'corrupt\n' >"$EXISTING/hive-daemon-linux-x64"
if run_program; then
  echo 'expected a mismatched existing release to fail' >&2
  exit 1
fi

printf '%s\n' 'PASS: immutable release publication repairs and verifies partial releases'
