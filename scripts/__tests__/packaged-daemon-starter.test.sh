#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_PARENT="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$TEST_PARENT"
TEST_ROOT="$(mktemp -d "$TEST_PARENT/hive-packaged-starter-test.XXXXXX")"
DAEMON_PID=''

cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

binary="$TEST_ROOT/hive-daemon"
runtime="$TEST_ROOT/runtime"
home="$TEST_ROOT/home"
port="$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')"
mkdir -p "$runtime" "$home"

bun build --compile \
  --define 'process.env.HIVE_BUILD_VERSION="packaged-starter-test"' \
  "$ROOT/packages/daemon/src/server/start.ts" \
  --outfile "$binary" >/dev/null

HOME="$home" HIVE_RUNTIME_ROOT="$runtime" HIVE_PACKAGED=1 HIVE_PORT="$port" \
  "$binary" >"$TEST_ROOT/daemon.log" 2>&1 &
DAEMON_PID=$!

for _ in $(seq 1 100); do
  [[ -f "$runtime/.token" ]] || {
    sleep 0.1
    continue
  }
  token="$(cat "$runtime/.token")"
  state="$(curl -fsS -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$port/api/kit/state" 2>/dev/null || true)"
  [[ -n "$state" ]] || {
    sleep 0.1
    continue
  }
  starter_state="$(jq -r '.sync[] | select(.sourceId == "starter") | .state' <<<"$state")"
  [[ "$starter_state" = local ]] && break
  [[ "$starter_state" != check_failed ]] || break
  sleep 0.1
done

[[ "${starter_state:-}" = local ]] || {
  printf 'packaged Starter Source did not become ready: %s\n' "${starter_state:-missing}" >&2
  printf '%s\n' "${state:-no state response}" >&2
  sed -n '1,160p' "$TEST_ROOT/daemon.log" >&2
  exit 1
}
test -f "$runtime/kit/mirrors/starter/presets/starter.yaml"
test -f "$runtime/kit/mirrors/starter/capabilities/skills/review-diff/SKILL.md"
catalog="$(curl -fsS -H "Authorization: Bearer $token" \
  "http://127.0.0.1:$port/api/kit/catalog")"
jq -e '
  any(.entries[]; .kind == "skill" and .name == "review-diff") and
  any(.entries[]; .kind == "agent" and .name == "starter-explorer") and
  any(.entries[]; .kind == "instruction" and .name == "starter-conduct")
' <<<"$catalog" >/dev/null
printf 'PASS: packaged Daemon materializes and syncs the Starter Source\n'
