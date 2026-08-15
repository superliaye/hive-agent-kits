# Universe Hive-Arca Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conformant personal Universe kit plus a one-command Mac adapter that connects Hive to the persistent Arca Daemon through the generic external seam.

**Architecture:** Universe owns all Arca CLI, artifact, systemd, tunnel, and Mac bootstrap behavior. A versioned POSIX launcher delegates Arca lifecycle to a remote helper; the new personal kit uses Hive's existing capabilities/presets format and remains independent from `my-devloop` and Appa.

**Tech Stack:** Bash, systemd user units, Arca Eternal Terminal, SSH fallback, shasum, Universe shell tests, Hive capability schema

**Spec:** `/home/leon.ye/hive-agent-kits/docs/superpowers/specs/2026-08-14-arca-remote-capability-control-design.md`

## Global Constraints

- Hive contains no Arca hostname, SSH command, systemd lifecycle, or Arca filesystem assumption.
- Daily launch never pulls source or replaces the Daemon; install/upgrade are explicit.
- Linux Daemon artifacts are immutable and digest-verified for the remote architecture.
- Session JSON streams directly from the remote command into a `0600` descriptor; no token is placed in argv, environment, URL, config, or logs.
- Canonical adapter source is `experimental/leon-ye_data/hive-arca/`; canonical repo-specific kit source is `experimental/leon-ye_data/agent-kits/`.

---

### Task 1: Conformant personal capability-kit root

**Files:**
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/agent-kits/README.md`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/agent-kits/capabilities/@leon/skills/arca-smoke/SKILL.md`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/agent-kits/presets/day-zero.yaml`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/agent-kits/BUILD`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/agent-kits/agent_kits_test.sh`

**Interfaces:**
- Produces: conformant `arca-smoke` skill and `day-zero` preset for Claude and Codex.

- [ ] **Step 1: Write the failing conformance test**

```bash
AGENT_KIT_TEST_HOST=1 /home/leon.ye/my-agent-kits/bin/agent-kit \
  --root "$TEST_TMPDIR/home" \
  --kit-root "$PWD" \
  deploy day-zero
test -f "$TEST_TMPDIR/home/.claude/skills/arca-smoke/SKILL.md"
test -f "$TEST_TMPDIR/home/.codex/skills/arca-smoke/SKILL.md"
```

- [ ] **Step 2: Run from the new root**

Run: `cd /home/leon.ye/universe/experimental/leon-ye_data/agent-kits && bash agent_kits_test.sh`

Expected: FAIL because the preset and skill are absent.

- [ ] **Step 3: Add the harmless skill and exact preset**

```md
---
name: arca-smoke
description: Report which machine and repository the current agent is operating in when the user asks to verify the Arca skill deployment.
added_in: 0.1.0
---

Report the machine hostname, current working directory, and whether the directory is inside a Git worktree. Do not modify files.
```

```yaml
name: day-zero
description: Safe capability used to verify Hive deployment from Mac to Arca.
default_agents: [claude, codex]
capabilities:
  skills: [arca-smoke]
```

- [ ] **Step 4: Run the test and Universe presubmit**

Run: `bash agent_kits_test.sh && runtests --quiet experimental/leon-ye_data/agent-kits`

Expected: PASS.

- [ ] **Step 5: Commit the personal kit in Universe**

```bash
git add experimental/leon-ye_data/agent-kits
git commit -m "Add Leon personal capability kit"
```

### Task 2: Remote lifecycle helper and owned systemd unit

**Files:**
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/remote/hive-arca-remote`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/systemd/hive-arca-daemon.service.in`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/test/remote_test.sh`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/BUILD`

**Interfaces:**
- Produces remote verbs `install`, `ensure`, `session-mint`, `session-revoke`, `status`.
- `session-mint` writes only descriptor-ready JSON to stdout.

- [ ] **Step 1: Write failing fake-systemctl/curl tests**

```bash
run_remote ensure
assert_called systemctl --user start hive-arca-daemon.service
run_remote session-mint >"$result"
jq -e '.session.sessionToken and .expected.daemonInstanceId and .expected.runtimeRootId' "$result"
assert_not_contains "$STDERR" "sessionToken"
```

- [ ] **Step 2: Run the remote helper test**

Run: `bash experimental/leon-ye_data/hive-arca/test/remote_test.sh`

Expected: FAIL because the helper is missing.

- [ ] **Step 3: Implement immutable install and lingering verification**

`install` selects the manifest entry matching `uname -m`, downloads or copies the exact version, verifies SHA-256, installs below `~/.local/share/hive-arca/daemon/<version>/`, renders the user unit with `HIVE_PACKAGED=1`, runs `systemctl --user daemon-reload --now`, and verifies `loginctl show-user "$USER" -p Linger --value` is `yes`. When it is not, run the explicitly configured privileged lingering command and verify again.

- [ ] **Step 4: Implement exact unit/instance reuse and local session minting**

`ensure` starts only `hive-arca-daemon.service`, reads `/api/ready`, and compares protocol/build/runtime identity. `session-mint` reads `~/.hive/.token` locally, calls `POST http://127.0.0.1:3117/api/external-sessions`, then combines that result with `/api/ready`; durable token bytes are never printed.

- [ ] **Step 5: Run tests and commit the remote slice**

Run: `bash experimental/leon-ye_data/hive-arca/test/remote_test.sh && runtests --quiet experimental/leon-ye_data/hive-arca`

```bash
git add experimental/leon-ye_data/hive-arca/remote experimental/leon-ye_data/hive-arca/systemd experimental/leon-ye_data/hive-arca/test/remote_test.sh experimental/leon-ye_data/hive-arca/BUILD
git commit -m "Add Hive Arca remote daemon lifecycle"
```

### Task 3: Mac launcher, tunnel supervision, and bootstrap

**Files:**
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/mac/hive-arca`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/mac/install-hive-arca`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/test/mac_launcher_test.sh`
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/README.md`

**Interfaces:**
- Produces one daily command `hive-arca` plus explicit `hive-arca install` and `hive-arca upgrade`.
- Uses only descriptor path argument `--hive-external-descriptor=<path>` when starting Hive.

- [ ] **Step 1: Write failing fake Arca CLI/app tests**

```bash
run_launcher
assert_called arca ssh '$HOME/.local/bin/hive-arca-remote ensure'
assert_configured_forward 'Host arca*' 'LocalForward 127.0.0.1:33117 127.0.0.1:3117'
assert_called open -n -W -a Hive --args "--hive-external-descriptor=${DESCRIPTOR}"
test ! -e "$DESCRIPTOR"
assert_called arca ssh '$HOME/.local/bin/hive-arca-remote session-revoke ...'
```

- [ ] **Step 2: Run launcher tests**

Run: `bash experimental/leon-ye_data/hive-arca/test/mac_launcher_test.sh`

Expected: FAIL because the Mac scripts are missing.

- [ ] **Step 3: Implement safe launch and cleanup traps**

Create a `mktemp -d` directory, `chmod 700` it, run remote ensure, reuse an existing dedicated Eternal Terminal forward or start an owned one, stream session JSON through stdin to a `0600` descriptor, launch a fresh app with `open -n -W`, and wait. A single idempotent trap kills only an owned tunnel process, removes the temp directory, and best-effort revokes the recorded session id.

- [ ] **Step 4: Supervise tunnel while the app remains open**

If the tunnel exits while the app pid remains alive, retry with bounded exponential delays `1, 2, 4, 8, 15` seconds and the same local port. Do not mint a new session during tunnel restart. Exit with a stage-specific error after the bounded retries.

- [ ] **Step 5: Implement versioned Mac bootstrap**

Install the adapter payload under `~/.local/share/hive-arca/<version>/` and atomically update `~/.local/bin/hive-arca`. Use `arca ssh` for request/response commands and `arca et` for the long-lived forward, add the marked `Host arca*` forward to the Mac SSH config, retain explicit `--transport ssh --ssh-target <host>` fallback, and symlink only for the explicit local checkout mode.

- [ ] **Step 6: Run all adapter tests and commit**

Run: `bash experimental/leon-ye_data/hive-arca/test/mac_launcher_test.sh && bash experimental/leon-ye_data/hive-arca/test/remote_test.sh && runtests --quiet experimental/leon-ye_data/hive-arca`

```bash
git add experimental/leon-ye_data/hive-arca
git commit -m "Add one-command Hive Arca launcher"
```

### Task 4: Arca-local redirected-home validation and Mac gate

**Files:**
- Create: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/test/arca_e2e.sh`
- Modify: `/home/leon.ye/universe/experimental/leon-ye_data/hive-arca/README.md`

**Interfaces:**
- Consumes the shipped Daemon, both initial Source Locators, Overview, Selection mutation, and accepted Deploy operation.
- Produces a repeatable non-real-home validation report before human testing.

- [ ] **Step 1: Write the redirected-home e2e script**

The script creates an isolated runtime root and Claude/Codex homes, starts the Daemon on a free loopback port with real-deploy explicitly redirected to those homes, registers `my-agent-kits` git and the Universe working-tree subpath, syncs, selects `arca-smoke`, obtains the Overview plan token, accepts Deploy, polls the operation, verifies both deployed files, restarts the Daemon, and verifies Overview persistence.

- [ ] **Step 2: Run Hive and Universe verification**

Run: `cd /home/leon.ye/hive-agent-kits && bun run verify && bash /home/leon.ye/universe/experimental/leon-ye_data/hive-arca/test/arca_e2e.sh && cd /home/leon.ye/universe && runtests --quiet experimental/leon-ye_data/hive-arca experimental/leon-ye_data/agent-kits`

Expected: PASS with no writes to real `~/.claude`, `~/.codex`, or `~/.agents`.

- [ ] **Step 3: Commit validation and stop at the human gate**

```bash
git add experimental/leon-ye_data/hive-arca/test/arca_e2e.sh experimental/leon-ye_data/hive-arca/README.md
git commit -m "Validate Hive Arca end to end"
```

Ask the user to run `hive-arca` on the Mac and verify the seven approved smoke-test steps. Do not deploy into the real Arca CLI home before this explicit human action.
