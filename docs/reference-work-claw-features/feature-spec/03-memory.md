# Feature Spec 03 — Persistent Memory System

## 1. Overview

The persistent memory system gives the agent durable, self-curating memory that survives across sessions. It is organized into four tiers: (1) **working memory** (the LLM's in-session context, managed by the SDK — out of scope here), (2) **long-term prose memory** (`SOUL.md`, `USER.md`, `MEMORY.md`, and per-day daily logs), (3) **structured queryable memory** (`structured.json` holding people, projects, preferences, and key/value facts), and (4) **skill memory** (per-agent files, out of scope). The system enforces hard byte-size limits per file, deduplicates writes at line and section granularity, supports fuzzy section-targeted updates, ranks search results across all tiers with synonym expansion, compacts daily logs into weekly then monthly archives (logarithmic compression), allocates a fixed per-section token budget when assembling the system prompt (with a "smart table-of-contents" mode for oversized long-term memory), and runs a weekly garbage-collection pass that flags stale, duplicated, conflicting, oversized, and empty content. All long-term prose lives as Markdown with `##` sections; sections may carry an HTML-comment metadata header encoding importance and dates, which drives priority scoring used everywhere truncation or compaction must choose what to keep.

---

## 2. Feature Inventory (checklist)

- [ ] **F1 — On-disk file layout & data directory** (which files/dirs exist and where)
- [ ] **F2 — Long-term prose file formats** (`SOUL.md`, `USER.md`, `MEMORY.md`)
- [ ] **F3 — Daily log format** (`YYYY-MM-DD.md`, channel tagging, entry caps)
- [ ] **F4 — Weekly & monthly archive formats** (`<year>-W<week>.md`, `<year>-<month>.md`)
- [ ] **F5 — Overflow sidecar file format** (`<file>.overflow`)
- [ ] **F6 — `structured.json` schema** (people, projects, preferences, facts)
- [ ] **F7 — Section importance metadata comment format** (`<!-- importance: … -->`)
- [ ] **F8 — Importance / section scoring algorithm**
- [ ] **F9 — `memory_read` tool**
- [ ] **F10 — `memory_write` tool** (append / replace / section_update / compact modes)
- [ ] **F11 — Dedup-aware append** (fingerprint + line-overlap detection)
- [ ] **F12 — Fuzzy section matching for `section_update`**
- [ ] **F13 — In-file compaction** (`mode="compact"`: dedup, merge, supersede, prune)
- [ ] **F14 — Hard size enforcement** (per-file byte limits, truncate-to-fit, overflow archival)
- [ ] **F15 — Smart memory TOC** (`generateMemoryTOC` — expand top sections, list rest)
- [ ] **F16 — Context-budget allocation for the system prompt** (per-section token limits + truncation strategies)
- [ ] **F17 — System prompt assembly** (how memory is woven into the prompt)
- [ ] **F18 — Daily-log noise filtering & coalescing** (scheduled-task noise, verbose truncation)
- [ ] **F19 — Quality filtering / agent-filler stripping** (`cleanAgentOutput`)
- [ ] **F20 — Relevance-ranked search** (`searchMemory`: synonym expansion, section-aware scoring, all tiers)
- [ ] **F21 — Tiered compaction: daily → MEMORY.md** (`compactMemory`)
- [ ] **F22 — Tiered compaction: daily → weekly** (`compactWeekly`)
- [ ] **F23 — Tiered compaction: weekly → monthly** (`compactMonthly`)
- [ ] **F24 — Heartbeat memory maintenance** (LLM-driven daily-log consolidation, cadence)
- [ ] **F25 — Memory garbage collection** (weekly; 7 issue detectors + backup prune + zero-fact deletion)
- [ ] **F26 — `structured_memory` tool** (query / upsert_person / upsert_project / upsert_preference / set_fact / summary)
- [ ] **F27 — Structured-memory write serialization** (mutex queue + concurrency guarantees)
- [ ] **F28 — Structured-memory freshness sync** (`touchPersonLastMentioned`, stale-people detection)
- [ ] **F29 — `manage_memory` tool** (topic deletion — adjacent surface)

---

## 3. Detailed Feature Entries

> Convention used below: byte sizes use `Buffer.byteLength(text,"utf-8")`; "char length" means JS string `.length`. Token estimate = `Math.ceil(text.length / 4)` (≈4 chars per token). Dates are ISO `YYYY-MM-DD` unless noted; timestamps are full ISO `YYYY-MM-DDTHH:mm:ss.sssZ`.

---

### F1 — On-disk file layout & data directory

**Purpose:** Define every path a re-implementer must create/read.
**Trigger:** Initialization and all memory operations.
**Inputs:** A single "data directory" root (cloud-syncable; e.g. `~/.claw/`). All paths below are relative to it.
**Behavior (layout):**

```
<dataDir>/
  SOUL.md                     # agent identity/persona (prose)
  AGENTS.md                   # operating rules (prose; loaded as "operating_rules")
  USER.md                     # facts about the human (prose)
  MEMORY.md                   # long-term curated memory (prose, ## sections)
  TASKS.md                    # DEPRECATED — reads/writes redirect to task system
  structured.json             # structured memory (people/projects/preferences/facts)
  memory/
    YYYY-MM-DD.md             # daily logs (one per calendar day)
    index.md                  # topic-graph index (rendered)
    index.db                  # topic keyword index (SQLite-like store)
    topics/<topic-id>.md      # topic-graph files (adjacent subsystem)
    inbox/                    # (adjacent subsystem)
    archive/
      YYYY-MM-DD.md           # archived (processed) daily logs
      weeks/<year>-W<ww>.md   # weekly summaries
      months/<year>-<mm>.md   # monthly summaries
      backups/                # safe-write backups (GC-pruned)
  MEMORY.md.overflow          # sidecar for sections evicted by size enforcement
  USER.md.overflow            # (created on demand, same rule)
```

**Output-effect:** Stable, predictable file locations.
**Edge-cases:** `structured.json` has a one-time legacy migration: if a `structured.json` exists in a separate "runtime dir" with non-empty data and the data-dir copy does not exist, it is copied atomically (`flag: "wx"`) and the legacy file blanked (`{...,_migrated:true}`). `memory/` directories are created with mode `0o700` (POSIX owner-only; Windows uses ACLs).
**Configuration:** Per-file byte limits overridable via config (`memory_limits`, see F14).
**Dependencies:** none.

---

### F2 — Long-term prose file formats (`SOUL.md`, `USER.md`, `MEMORY.md`)

**Purpose:** Human-and-agent-editable Markdown stores for identity, the human, and curated long-term knowledge.
**Inputs:** Free-form Markdown.
**Behavior / format rules a re-implementer must match:**
- Files are UTF-8 Markdown. Sections are delimited by lines beginning with `## ` (exactly two hashes + space). A "section" = the `## ` header line plus all lines until the next `## ` or EOF. Content before the first `## ` is the **preamble** and is preserved as-is.
- `### ` and `# ` lines are **not** section delimiters for parsing purposes (only `## `). They are scored more highly in search (see F20).
- Sections may carry a metadata HTML comment (see F7) anywhere in their content; by convention it sits on the first content line.
- The maintenance prompt's *preferred* `MEMORY.md` organization (not enforced by code, but the canonical layout): sections named **Decisions & Context**, **Patterns & Lessons**, **Operational Knowledge**, **Open Items** (with dates), **Platform Stats**. Compaction summaries are written as `## Compacted: <start> to <end>` sections (see F21).
**Output-effect:** These files feed the `<soul>`, `<my_human>`, and `<long_term_memory>` prompt blocks respectively (F17).
**Edge-cases:** Empty/missing file → treated as empty string. `USER.md` placeholder content like `(Nothing yet — I'll learn as we go.)` is recognized as "trivial" by GC (F25).
**Configuration:** Byte limits — `MEMORY.md` 20 000, `USER.md` 8 000, `SOUL.md` 6 000 (see F14).

---

### F3 — Daily log format (`memory/YYYY-MM-DD.md`)

**Purpose:** Append-only running log of what happened on a given day.
**Trigger:** Any `memory_write file="daily"`; today's date by default. `memory_read file="daily" date="…"` reads a specific day.
**Inputs:** Markdown entries; each entry conventionally a `## <Header>` block.
**Behavior / format:**
- Filename is `<YYYY-MM-DD>.md` using **local time** (`getFullYear`/`getMonth`+1/`getDate`, zero-padded), placed in `memory/`.
- **Channel tagging:** On append, if a `channelId` is in scope, every section header that is not already tagged is rewritten from `## Header` → `## [channelId] Header` (regex `^(## )(?!\[.*?\])` per line). The read/prompt side filters by these tags so each channel sees only its own (or untagged) entries.
- **Per-entry hard cap (2 KB):** On `append`, if `content.length > 2000`, it is truncated to 2000 chars + `"\n\n*[entry truncated to stay within daily log budget]*"`.
- **Verbose sub-agent/scheduled truncation (500 chars):** On `append`, if content's first header matches `^## (?:\[.*?\] )?(?:Sub-agent:|Scheduled:)` **and** `content.length > 500`, keep the header line + first 500 chars of the body + `"\n\n*[verbose output truncated — use session logs for full detail]*"`.
- Daily logs are subject to a **30 KB** hard size limit (`DAILY_LOG_MAX = 30000`); unlike the prose memory files, daily logs *can* be hard-truncated to fit (see F14).
**Output-effect:** Feeds the `<today>` prompt block (channel-filtered, then char-truncated to 3000 chars — see F17).
**Edge-cases:** Noise/coalescing rules in F18 can reduce an append to empty (no-op).
**Configuration:** `DAILY_LOG_MAX=30000`, per-entry cap `2000`, verbose cap `500`.

---

### F4 — Weekly & monthly archive formats

**Purpose:** Logarithmically compressed historical summaries.
**Behavior / format:**
- **Weekly:** `memory/archive/weeks/<year>-W<ww>.md` where `<ww>` is a zero-padded ISO week number. File body:
  ```
  # Week Summary: <year>-W<ww>
  *Covers: <firstDay> to <lastDay>*

  <LLM summary text>
  ```
- **Monthly:** `memory/archive/months/<year>-<mm>.md` (`<mm>` zero-padded month). File body:
  ```
  # Month Summary: <year>-<mm>

  <LLM summary text>
  ```
- ISO-week key is computed by the standard "Thursday of the week" algorithm (UTC). The month a week belongs to is the month of that week's Thursday.
**Dependencies:** F22, F23 produce these. F20 search reads them.

---

### F5 — Overflow sidecar file format (`<file>.overflow`)

**Purpose:** Non-destructive archival of sections evicted by hard size enforcement (so curated memory is never permanently lost).
**Trigger:** F14 truncate-to-fit drops sections from a file.
**Behavior / format:** Path is `<originalPath>.overflow`. Each evicted section is appended as:
```
<!-- archived: <ISO timestamp> | from: <fileName> | reason: size-limit -->
## <Header>
<content>

---
```
Multiple entries are separated by the `\n---\n` boundary. The overflow file itself is capped at **50 000 bytes** (`OVERFLOW_MAX_SIZE`); when exceeded, oldest entries (from the top) are dropped until it fits.
**Edge-cases:** Archiving is best-effort — failures are logged (warn) but never crash the main write.

---

### F6 — `structured.json` schema

**Purpose:** Queryable JSON store for data that benefits from structure over prose.
**Format:** A single JSON object, pretty-printed with 2-space indent. Full schema:

```jsonc
{
  "people": [
    {
      "name": "string",              // required; case-insensitive unique key
      "aliases": ["string"],         // optional
      "role": "string",              // optional
      "team": "string",              // optional
      "relationship": "string",      // required; e.g. direct_report|manager|peer|collaborator|stakeholder
      "notes": "string",             // optional
      "lastMentioned": "ISO-8601"    // set/refreshed automatically on upsert
    }
  ],
  "projects": [
    {
      "name": "string",                                   // required; case-insensitive unique key
      "status": "active|completed|on_hold|planning",      // required
      "description": "string",                            // optional
      "repo": "string",                                   // optional
      "tags": ["string"],                                 // optional
      "owner": "string",                                  // optional
      "lastUpdated": "ISO-8601"                           // set automatically on upsert
    }
  ],
  "preferences": [
    {
      "key": "string",                       // e.g. communication_style
      "value": "string",
      "source": "explicit|observed|inferred",
      "confidence": "high|medium|low",
      "learnedAt": "ISO-8601"
    }
  ],
  "facts": { "key": "value" }   // flat string→string map for quick lookup
}
```

**Behavior:** Missing file → load returns `{people:[],projects:[],preferences:[],facts:{}}`. Parse error → same empty default (corruption tolerated, not thrown). Saves are pretty-printed with 2 spaces.
**Edge-cases:** Legacy migration (F1). All writes serialized (F27).

---

### F7 — Section importance metadata comment format

**Purpose:** Per-section metadata that drives priority scoring.
**Format (verbatim):**
```
<!-- importance: high | created: 2026-02-22 | last-referenced: 2026-02-23 -->
```
- The comment is the **first** `<!-- … -->` found in a section's content (`/<!--\s*(.*?)\s*-->/`).
- Recognized fields (parsed independently, order-independent, `|`-separated by convention but parsing is regex-per-field):
  - `importance:` one of `critical | high | medium | low` (case-insensitive); default `medium`.
  - `created:` a `YYYY-MM-DD` date; default `null`.
  - `last-referenced:` a `YYYY-MM-DD` date; default `null`.
- Builder emits only the present fields, joined by ` | `, wrapped in `<!-- … -->`. If no fields, emits empty string.
- Other comment forms appear in the codebase and are **not** parsed as importance metadata but are stripped during display/search: `<!-- updated: YYYY-MM-DD -->` (maintenance convention), `<!-- archived: … | from: … | reason: … -->` (overflow), `<!-- ... go here -->` placeholders, and `[EXPIRES:YYYY-MM-DD]` inline markers (topic GC, F25).
**Dependencies:** F8 consumes it.

---

### F8 — Importance / section scoring algorithm

**Purpose:** Single deterministic score used by truncation (F14), compaction (F13), smart TOC (F15), and budget section-truncation (F16).
**Inputs:** A section `header` string and its `content` string.
**Behavior (exact formula):**
1. Parse metadata (F7). `score = IMPORTANCE_WEIGHT[importance] * 10` where weights are `critical=4, high=3, medium=2, low=1` (so 40/30/20/10).
2. **Recency bonus:** Let `refDate = lastReferenced || created`.
   - If present: `daysSince = max(0, (now - refDate)/86_400_000)`; add `max(0, 10 - floor(daysSince/7))` (i.e. lose 1 point per full week, floored at 0, capped at +10).
   - If absent: add `5`.
3. **Header keyword boosts (case-insensitive substring):**
   - contains `"decision"` or `"critical"` → `+5`
   - contains `"lesson"` or `"pattern"` → `+3`
   - contains `"compacted"` → `−3` (summaries are lower priority)
4. Return the numeric score. Higher = keep.
**Output-effect:** Higher-scored sections are expanded/kept; lower-scored ones are listed-only or evicted.
**Example:** Section `## Critical Decision` with `<!-- importance: high | last-referenced: <today> -->` → `30 (high) + 10 (today) + 5 (decision/critical) = 45`.

---

### F9 — `memory_read` tool

**Purpose:** Read a memory file or search across all memory.
**Tool name:** `memory_read`. **Permission:** skipped (auto-approved).
**Parameters:**
- `file: string` (≤200 chars) — one of: `MEMORY.md`, `USER.md`, `SOUL.md`, `daily`, `memory_index`, `topics`, `topic:<id>`, `audit`, `all`. (`TASKS.md` accepted but redirected.)
- `query?: string` (≤2000) — required when `file="all"`.
- `date?: string` (≤32) — optional, for `file="daily"` (any `Date`-parseable string).
**Behavior by `file` value:**
- `MEMORY.md` / `USER.md` / `SOUL.md` → raw file contents, or `File "<file>" not found.`
- `daily` → contents of `memory/<date|today>.md`, or `No daily log for <date|today>.`
- `memory_index` → contents of `memory/index.md`, or an "index not yet initialized" message.
- `topics` → `## All Topics (N total)` then a list of `- **<id>** (<n> facts, updated <date>): <summary>`, sorted by fact count desc.
- `topic:<id>` → that topic file's raw content (adjacent subsystem; `<id>` resolved fuzzily).
- `audit` → last 100 audit-log lines.
- `all` (requires `query`) → `searchAllMemory(query)` (see below).
- `TASKS.md` → a redirect message pointing to the `task_manage` tool (never reads the file).
**`searchAllMemory(query)` behavior (distinct from F20 `searchMemory`):**
1. If a keyword index is available (non-test): run keyword search; if ≥1 hit, return top 20 formatted as `N. [sourceType:sourceId] score=<4dp>\n<≤260-char snippet>`.
2. Otherwise fall back to substring scan. Query matches a text if it contains the full lowercased query, **or** (when the query has >1 word with each word length >2) every word is present. Searched in order: topic files (preview = up to 5 matching lines), `structured.json` (formatted Person/Project/Fact lines), main files (`MEMORY/USER/SOUL/TASKS`), then every `memory/*.md` daily log. Output `**<source>**:\n<matching lines>` blocks joined by blank lines. If total >8000 chars, truncate + `*(truncated — N total sources matched)*`. No matches → `No results found for "<query>".`
**Output-effect:** Returns a string (tool result).
**Edge-cases:** Unknown `file` → `File "<file>" not found.`

---

### F10 — `memory_write` tool

**Purpose:** Write to a memory file in one of four modes.
**Tool name:** `memory_write`. **Permission:** required (not skipped).
**Parameters:**
- `file: string` (≤200) — `MEMORY.md`, `USER.md`, `SOUL.md`, `daily`, or `topic:<id>`. (`TASKS.md` accepted but redirected/blocked.)
- `content: string` (≤1 MiB, i.e. `1024*1024`).
- `mode: "append" | "replace" | "section_update" | "compact"`.
- `section?: string` (≤200) — required for `section_update`.
- (channelId is injected from ambient context, not a tool param.)
**Behavior by mode:**
- **`append`** — dedup-checked append (F11). Daily-log noise/coalescing + caps applied first (F3, F18). Returns `Appended to <file>.<sizeWarning>` or a skip message.
- **`replace`** — back up, overwrite. Daily logs truncated to 30 KB if needed; prose memory files written in full (no truncation here). Returns `Replaced contents of <file>.<sizeWarning>`.
- **`section_update`** — fuzzy section-targeted replace/insert (F12). Returns `Updated/Added/Created section "<name>" in <file>.<sizeWarning>` or skip.
- **`compact`** — in-file dedup/merge/prune (F13). Returns the compaction report string.
**`sizeWarning`** is appended to most success messages: if the written content exceeds the file's byte limit, ` ⚠️ WARNING: <file> is <KB>KB (limit: <KB>KB). <advice>` where advice differs for append vs other modes.
**`topic:<id>` writes:** validated against `^[a-z0-9][a-z0-9_-]*$`; only `replace`/`append` supported; routed to the topic store (adjacent subsystem).
**`TASKS.md` writes:** never saved; returns a deprecation message directing to `task_manage`.
**Edge-cases:** Unknown `file` → `Unknown file: <file>`. No matching mode branch → `No changes made.`

---

### F11 — Dedup-aware append

**Purpose:** Prevent bloat from re-appending substantially-similar content.
**Trigger:** `mode="append"` (and the "add new section" path of `section_update`).
**Inputs:** existing file content, new content, threshold (default `0.7`).
**Behavior (`isDuplicate(existing,new,threshold=0.7)`):**
1. **Fingerprint:** normalize a string by lowercasing, removing all non-`[a-z0-9\s]`, collapsing whitespace, trimming, and slicing to first **500** chars.
2. If the new content's fingerprint is **< 40 chars**, return `false` (too short to judge).
3. If the existing fingerprint **includes** the new fingerprint's first **200** chars → duplicate (`true`).
4. **Line-level overlap:** build sets of trimmed, lowercased lines **longer than 20 chars** from both texts. If the new set is empty → `false`. Compute `overlap = |newLines ∩ existingLines| / |newLines|`. If `overlap >= threshold` → duplicate.
**Output-effect:** On duplicate, the append is **skipped** and the tool returns `⚠️ Skipped append to <file> — substantially similar content already exists. Use mode="section_update"… or mode="replace"…`. Nothing is written.
**Edge-cases:** Compaction's "superseded" detection (F13) reuses `isDuplicate` with threshold `0.6`.

---

### F12 — Fuzzy section matching for `section_update`

**Purpose:** Update a named `## ` section in place, matching headers loosely.
**Trigger:** `mode="section_update"` with `section`.
**Inputs:** target file, `section` name, `content`.
**Behavior (deterministic rules):**
1. **Sanitize section name:** strip newlines (`[\r\n]+`→space), strip a leading `#`-run + spaces, trim. Empty after sanitize → skip with `⚠️ Skipped section update — section name is empty after sanitization.` Length capped at **200** chars.
2. **Strip redundant header from content:** if `content`'s first non-blank line is a `## ` header that fuzzy-matches the target section, that line is removed (prevents duplicate `## ` lines).
3. **Empty file:** write `## <sectionName>\n<content>\n` → `Created <file> with section "<name>".`
4. **Match rule (`sectionHeaderMatch`):** normalize each header by lowercasing, removing all non-`[\w\s]` (strips emoji/punctuation), collapsing whitespace, trimming; two headers match iff normalized strings are **equal** (case-insensitive, emoji/punctuation-insensitive — but **not** substring/typo-tolerant).
5. **Duplicate-header guard:** if >1 existing section matches, keep the first and physically delete the later duplicate blocks first (then collapse 3+ blank lines to 2).
6. **On match:** replace the matched section's body (lines between its header and the next section) with `content`. Daily logs re-checked against 30 KB after.
7. **No match:** treat as adding a new section — but first run F11 dedup; if duplicate, skip with `⚠️ Skipped adding section "<name>"…`. Otherwise append `\n## <sectionName>\n<content>\n`.
**Output-effect:** `Updated section "<name>" in <file>.` / `Added new section "<name>" to <file>.` (+ sizeWarning).

---

### F13 — In-file compaction (`mode="compact"`)

**Purpose:** Dedup, merge, and prune a single prose file in place.
**Trigger:** `memory_write mode="compact"`; also auto-invoked by size enforcement (F14) and heartbeat (F24).
**Inputs:** the file path + name.
**Behavior (ordered steps):**
1. Back up first (unless caller already did). Empty/missing → `<file> is empty, nothing to compact.` No `## ` sections → `<file> has no sections to compact.`
2. **Group by normalized header** (lowercase, strip non-`[\w\s]`, collapse spaces, trim).
3. **Dedup groups:** for each group with >1 member, sort by `scoreSection` desc (tiebreak: longer content), keep the best header, and **merge unique content** across duplicates: start from the longest version, append any line >10 chars not already seen (case-insensitive). Count removed.
4. **Merge `Compacted:` history:** if >2 sections whose header (lowercased) starts with `compacted:`, keep the 2 most recent (by original position), merge the rest into one `## Historical Summary (<oldestRange> to <newestRange>)` section.
5. **Supersede detection:** for each pair `(i<j)`, if section *i*'s content ≥200 chars and `isDuplicate(j.content, i.content, 0.6)` is true, drop the earlier section *i*.
6. **Rebuild:** preamble (content before first section) preserved, then each kept section as `## <header>\n<content>\n\n`, in **original order**, with 3+ blank lines collapsed to 2 and a trailing newline.
7. Write atomically.
**Output-effect:** Report string: `Compacted <file>: removed <details>. Size: <old> → <new> bytes (<pct>% reduction).` where details list `N duplicate(s)`, `N compacted section(s) merged`, `N superseded section(s)` (or `0 sections`).

---

### F14 — Hard size enforcement

**Purpose:** Keep on-disk files bounded; never lose curated content permanently.
**Trigger:** Every `append` / `replace` / `section_update` checks the resulting byte size; a daily wall-clock heartbeat check (F24) also fires.
**Per-file byte limits (`DEFAULT_FILE_SIZES`, overridable):** `MEMORY.md`=20 000, `USER.md`=8 000, `SOUL.md`=6 000, `TASKS.md`=10 000. Daily logs: `DAILY_LOG_MAX`=30 000. Overflow sidecar: `OVERFLOW_MAX_SIZE`=50 000. Monitoring default when a file isn't in the table: 10 000.
**Behavior (deterministic):**
- **Daily logs** *can* be hard-truncated: when an append/replace/section_update would exceed 30 KB, back up then `truncateToFit` to 30 KB.
- **Prose memory files are NEVER truncated by the write path.** Instead, when an `append` would exceed the file's limit, the path: backs up once, runs in-file compaction (F13, `skipBackup=true`), re-reads, and appends the new content to the compacted result (which may still exceed the limit — only a `sizeWarning` is emitted; prompt-side budget (F16) handles display). `replace` writes prose files in full with only a warning.
- **`truncateToFit(content, maxBytes, filePath)`** (used for daily logs and by overflow archival of any file): if no sections, hard-tail-truncate to the last `floor(maxBytes*0.9)` chars. Otherwise: score all sections (F8); repeatedly drop the **lowest-scored** section (keeping ≥1) until the rebuilt content fits; rebuilt content keeps original section order with preamble. **Dropped sections are archived to the `.overflow` sidecar** (F5), and a warning is logged.
- **Heartbeat daily size check (F24):** once per local day; for any non-`daily` file over its limit, run `mode="compact"`.
**Edge-cases:** Section scoring ties handled by score then implicit order. Overflow archival never throws.
**Configuration:** `config.memory_limits` (object) is merged over `DEFAULT_FILE_SIZES` (per-file keys like `"MEMORY.md"`).

---

### F15 — Smart memory TOC (`generateMemoryTOC`)

**Purpose:** When `MEMORY.md` is too big for its prompt budget, expand the highest-value sections and list the rest as a table of contents.
**Trigger:** Called by the budget allocator for the `memory` section when over budget (F16).
**Inputs:** `content`, `maxChars` (default 6000; called with `budget.maxTokens*4` = 10 000 for memory).
**Behavior:**
1. If `content.length <= maxChars` → return content unchanged. No sections → return first `maxChars` chars.
2. Preamble preserved and counts against budget.
3. Score all sections (F8); sort desc.
4. **Expand budget = floor(remainingBudget * 0.6).** Walk sections in score order; each whose size (`header.length + content.length + 10`) fits the running expand budget goes to **expanded**, the rest to **TOC-only**.
5. **TOC block** (placed before expanded sections), titled `### Memory Index (use memory_read to access full content)`, each entry: `- **<Header>** [<importance>]? — <≤80-char preview>…` (importance tag shown only if not `medium`; preview = content with comments stripped, first 80 chars, newlines→spaces). TOC entries sorted by original position.
6. Expanded sections (sorted by original position) appended verbatim as `## <Header>\n<content>`.
**Output-effect:** A compact string mixing a TOC and the top sections, joined by blank lines.

---

### F16 — Context-budget allocation for the system prompt

**Purpose:** Guarantee the memory injected into the system prompt never exceeds a fixed token budget regardless of disk size.
**Trigger:** `applyBudget(sectionName, content)` called per section during prompt assembly (F17).
**Per-section budgets (`SECTION_BUDGETS`):**

| section | maxTokens | priority | truncation |
|---|---|---|---|
| `soul` | 1500 | 1 | tail |
| `agents` | 2500 | 1 | tail |
| `user` | 1500 | 2 | sections |
| `memory` | 2500 | 3 | sections (→ smart TOC) |
| `structured` | 1800 | 2 | tail |
| `daily` | 1000 | 3 | head |
| `tasks` | 800 | 2 | tail |
| `schedules` | 150 | 4 | tail |

Total = **11 750 tokens** (source comment: "~11.7K tokens (~46KB)"; README rounds to "~10K"). Priority field (1=must-include … 4=low) is declared but not currently used to drop whole sections — each section is independently truncated.
**Behavior:**
- Token estimate via `Math.ceil(len/4)`. If `tokens <= maxTokens`, return content unchanged.
- For `memory`: call `generateMemoryTOC(content, maxTokens*4)` (= 10 000 chars) → F15.
- Else dispatch on truncation strategy (`maxChars = maxTokens*4`):
  - **tail** — keep the beginning: `content[0 .. maxChars-60] + "\n\n*[truncated — use memory_read for full content]*"`.
  - **head** — keep the end: `"*[older content omitted — use memory_read for full content]*\n\n" + content[len-maxChars+80 ..]`.
  - **sections** — split on `^## `, keep an optional leading non-`## ` header block, score each block (F8), keep highest-scored blocks until the next would overflow `maxChars` (always keep ≥1), re-sort kept blocks to original order, prefix `*[N lower-priority section(s) omitted — use memory_read for full content]*` when any omitted.
  - **middle** — currently falls back to **tail**.
  - unknown section name → pass through unchanged.
**Output-effect:** A bounded string per section.
**Other inline caps applied during assembly (F17):** daily log pre-truncated to **3000 chars** by recency before `applyBudget("daily",…)`; skills summary capped at **20 lines / 2000 chars**.

---

### F17 — System prompt assembly

**Purpose:** Weave all memory tiers into one system prompt with budgets applied.
**Trigger:** `assembleSystemPrompt(channelId?, userMessage?)` per turn.
**Behavior (ordered):**
1. Load raw `SOUL.md`, `AGENTS.md`, `USER.md`. For memory: if the topic graph is ready, build a retrieval-augmented memory context from `userMessage`; otherwise read `MEMORY.md` raw.
2. Compute **staleness hints** (F-note below). Build active-tasks summary from the task store. Read schedules. Read today's daily log; if `channelId`, filter by channel tag, then truncate to 3000 chars by recency.
3. Build `structured` content: if a knowledge base is configured, use it for people/projects and only the `### Preferences` slice of structured memory (preferences placed first so tail-truncation preserves them); else use the full `getStructuredSummary()`.
4. Apply budgets (F16) to each named section.
5. Emit the prompt with these XML-fenced blocks in order: `<security_rules>`, outbound-safety block, `<identity>`, optional `<runtime_engine>`, `<soul>`, `<operating_rules>`, `<my_human>`, `<long_term_memory>`, optional `<memory_freshness>`, optional `<structured_knowledge>`, `<today>` (with Date/Day/Time), `<active_tasks>`, `<scheduled_jobs>`, optional `<available_skills>`, optional `<available_tools>`.
**Security contract:** content inside `<structured_knowledge>`, `<structured_memory>`, `<external_content>`, etc. is declared DATA-only and must never be executed as instructions.
**Staleness hints (`detectStaleSections`):** scans `USER.md` "Current Context" and `MEMORY.md` sections (`Open Items`, `Work-Claw Platform Stats`, `Known Incidents`, `Last Known S360 State`) for ISO or `Mon DD[, YYYY]` dates; if **all** dates in a section are >7 days old, emits `⚠️ STALE SECTIONS (update during reflection): …`.
**`getStructuredSummary()` format:** `### People` grouped by relationship (`**rel**: Name (role), …`), `### Active Projects` (only `active` status), `### Preferences` (`- **key**: value (confidence, source)`), `### Quick Facts` (first **20** facts as `- **key**: value`).

---

### F18 — Daily-log noise filtering & coalescing

**Purpose:** Suppress low-signal repeated scheduled-task entries.
**Trigger:** `mode="append"` to `daily`, before dedup.
**Behavior:**
- **`coalesceDailyEntry(new, existing)`**: extract the scheduled-task source from a header matching `^## Scheduled:\s*(.+?)(?:\s*\[.*?\])?\s*\(` . If the new entry is a "noise" entry **and** an entry from that same source already exists today, return `""` (the append becomes a no-op).
- **`isNoiseEntry`**: strip the header line + comments; only entries with body **< 150 chars** that match a noise pattern count as noise. Noise patterns (case-insensitive): `no new (items|emails|issues|findings|results)`, `nothing (new|to report|notable|significant)`, `no (changes|updates|action items) (found|detected|needed)`, `all (clear|quiet|stable)`, `^(completed|finished|done)\.?\s*$` (multiline).
**Output-effect:** Reduces daily-log churn; a non-noise entry from the same source is still allowed.

---

### F19 — Quality filtering / agent-filler stripping (`cleanAgentOutput`)

**Purpose:** Strip conversational filler from sub-agent output before it is stored.
**Behavior:** Remove lines matching `^(Perfect!|Great!|Now let me|Let me|I'll|I will|Alright|OK,|Okay,)\s.{0,80}$` and standalone `---` rules, then collapse 3+ blank lines to 2 and trim.
**Output-effect:** Cleaner stored memory; exported for callers that ingest agent transcripts.

---

### F20 — Relevance-ranked search (`searchMemory`)

**Purpose:** Structured, scored search across all prose tiers + structured memory + topic graph + weekly/monthly archives.
**Trigger:** Programmatic (`/search` CLI, daemon API, heartbeat); returns `SearchResult[]`.
**`SearchResult` shape:** `{ file: string; line: number; text: string; score: number; section?: string }`.
**Behavior:**
1. Tokenize query into `originalTerms` (lowercased, `'s` stripped, non-alphanumeric removed, length >2, stop-words removed). Empty → return `[]`.
2. **Synonym expansion** → `queryTerms`: union of original terms plus, for each term, its synonym list, plus any group key whose list contains the term. Synonym map (`SYNONYMS`): bug, error, fix, deploy, test, perf, auth, ui, api, db, config, memory, task, meeting, decision (full lists in appendix).
3. **Scan order & sources:** `MEMORY.md`, `SOUL.md`, `USER.md`, `TASKS.md`; every `memory/*.md` daily log; `memory/topics/*.md` (frontmatter stripped); `memory/archive/weeks/*` and `memory/archive/months/*`; and `structured.json` (people & projects). Each file is split into `## ` chunks (preamble = `(preamble)`); each line is scored.
4. **`scoreLine`** per line: strip placeholder/comment noise; for each query term present (substring): `+3` if it's an original term else `+1`; `+1` extra for a whole-word (`\b…\b`) match. Then multipliers: line starting `## ` or `### ` → `×1.5`; line containing `**` → `×1.2`. Topic-graph results get an additional `×1.2` boost. Lines scoring 0 are dropped.
5. **Rank & dedup:** sort by score desc; dedup by key `<file>:<first 80 chars of text>`; return **top 50**.
**Output-effect:** Ranked list; topic-graph and structured rows include a `section` label.
**Edge-cases:** structured.json parse errors ignored; archive dirs absent → skipped.

*Note: `searchAllMemory` (the `memory_read file="all"` path, F9) is a separate, simpler substring search with different output shape.*

---

### F21 — Tiered compaction: daily → MEMORY.md (`compactMemory`)

**Purpose:** Summarize daily logs older than a week into a `MEMORY.md` history section and archive the originals.
**Trigger:** Exported for callers; an LLM `sendMessage(role,content)` callback is injected.
**Behavior:**
1. List `memory/*.md` files matching `^\d{4}-\d{2}-\d{2}\.md$`, sorted. Cutoff = today − 7 days (ISO). Select logs whose date < cutoff. None → `No logs older than 7 days to compact.`
2. Concatenate selected logs (each prefixed `--- <file> ---`). Ask the LLM: "Summarize these daily logs into key facts, decisions, and lessons. Be concise — aim for ~500 words max."
3. Back up `MEMORY.md`, append `\n## Compacted: <firstDate> to <lastDate>\n<summary>\n`.
4. **Archive originals:** move each processed log to `memory/archive/<file>` (skip if already archived).
**Output-effect:** `Compacted N daily logs (<range>) into MEMORY.md and archived originals.`

---

### F22 — Tiered compaction: daily → weekly (`compactWeekly`)

**Trigger:** Heartbeat memory maintenance (F24), via LLM callback.
**Behavior:**
1. Read `memory/archive/*.md` matching the daily pattern, sorted. **<7 archived days → abort** (`Not enough archived daily logs…`).
2. Group days by ISO-week key (F4). Skip the current week. **Require ≥5 days** in a week to summarize it. Skip weeks already summarized (file exists).
3. LLM prompt: "Summarize this week's daily logs into a concise weekly summary (~300 words max). Focus on: key accomplishments, decisions made, patterns observed, lessons learned, and open items."
4. Write `memory/archive/weeks/<year>-W<ww>.md` with the F4 header.
**Output-effect:** `Created N weekly summary(ies).` or `No complete weeks ready…`.

---

### F23 — Tiered compaction: weekly → monthly (`compactMonthly`)

**Trigger:** Heartbeat memory maintenance (F24), via LLM callback.
**Behavior:**
1. Read `memory/archive/weeks/*.md`, sorted. **<4 week files → abort.**
2. Group weeks by month (month of the week's Thursday, F4). Skip current month (`YYYY-MM`). **Require ≥3 weeks** per month. Skip months already summarized.
3. LLM prompt: "Summarize these weekly summaries into a concise monthly summary (~200 words max). Focus on: major themes, key outcomes, evolving patterns, and strategic insights."
4. Write `memory/archive/months/<year>-<mm>.md` with the F4 header.
**Output-effect:** `Created N monthly summary(ies).` or `No complete months ready…`.

---

### F24 — Heartbeat memory maintenance (cadence & triggers)

**Purpose:** Periodic background curation.
**Cadence / triggers:**
- **Memory maintenance** — once per **local calendar day** (guarded by `lastMemoryMaint === today`). Runs only when there are **≥7** daily-log files. It keeps the last 3 days intact, processes up to the 5 oldest via an LLM session that: reads `MEMORY.md`/`USER.md`/old daily logs + structured snapshot, extracts/consolidates facts, prunes stale content (resolved incidents >14 days, cleared compliance, stale stats, resolved open items, duplicate `Compacted:` sections, cross-store duplicates), enforces the preferred section layout, and checks file sizes (compacting any over 20/8/6 KB). It then **archives** the processed logs (last 5) to `memory/archive/`, runs `compactWeekly` then `compactMonthly` (F22/F23), and runs a **people-freshness refresh** (≤3 stale `direct_report|manager|peer|collaborator` people with topic activity, updating their structured notes).
- **Memory size check** — once per local day; compacts any non-daily file over its limit (F14).
- **Memory GC** — once per ISO week (F25).
**Note:** The standalone `compactMemory` (F21) exists but the heartbeat path performs its own LLM-driven consolidation + archival rather than calling it.

---

### F25 — Memory garbage collection (`runMemoryGC`)

**Purpose:** Weekly detection (and limited auto-cleanup) of low-quality memory.
**Cadence:** Once per ISO week (heartbeat guards on `lastGC === weekKey`). Default `staleDays=30`.
**Detectors (run in parallel), each yielding `GCIssue { type, file, section?, description, suggestion, severity }`:**
1. **stale sections** (`MEMORY.md`): section metadata `refDate = lastReferenced||created`; if `daysSince > staleDays` **and** importance ∈ {low, medium} → issue (severity `high` if low, else `medium`).
2. **cross-store duplicates**: for each structured person/project whose name appears **≥3 times** in `MEMORY.md` (lowercased) → low-severity issue; for each fact whose value (>20 chars) appears in `MEMORY.md` → low-severity issue.
3. **conflicting preferences**: structured preferences sharing a key (case-insensitive) but with >1 distinct value → medium-severity issue.
4. **empty/trivial sections** (`MEMORY.md`, `USER.md`): section body (comments stripped) <10 chars, or equals `(none)` or `(Nothing yet — I'll learn as we go.)` → low-severity.
5. **sparse structured people**: person with no role, no notes, and `lastMentioned` >**60** days (or never) → low-severity.
6. **expired facts**: topic lines matching `[EXPIRES:YYYY-MM-DD]` with a past date → severity `high` if >7 days past else `medium`.
7. **thin topics**: topics with ≤1 fact not updated in ≥14 days → low-severity.
**Also:** prunes safe-write backups (age >7 days, hard cap 20); if >20 backups remain, emits an `oversized` issue. **Auto-deletes** topics with 0 facts in both file and DB (returns count). Issues sorted high→medium→low.
**Output:** `GCReport { issues, summary, timestamp }`. Summary either "Memory is clean — no issues found." (+ prune/delete counts) or `Found N issue(s): X stale, Y cross-store duplicates, …` (+ counts). `formatGCReport` renders with 🔴/🟡/🔵 severity icons.
**Edge-cases:** All sub-steps are best-effort; individual failures are swallowed.

---

### F26 — `structured_memory` tool

**Purpose:** CRUD over `structured.json`.
**Tool name:** `structured_memory`.
**Parameters:** `action: query | upsert_person | upsert_project | upsert_preference | set_fact | summary`, plus action-specific fields (`query_type`/`query_value`; person fields `name`,`aliases`,`role`,`team`,`relationship`,`notes`; project fields `project_name`,`project_status`,`description`,`repo`,`tags`; preference fields `pref_key`,`pref_value`,`pref_source`,`pref_confidence`; fact fields `fact_key`,`fact_value`).
**Behavior by action:**
- **summary** → `getStructuredSummary()` (F17 format) or `No structured memory stored yet.`
- **query** → `query_type`:
  - `person` (+`query_value`) → first person whose name or alias substring-matches (case-insensitive), as pretty JSON, or `No person found…`.
  - `people_by_relationship` (+value) → people with exact-matching `relationship`, as `Name (role) — notes` lines.
  - `all` → whole store as pretty JSON; `project` → `projects` array as pretty JSON.
- **upsert_person** (requires `name`) → upsert by case-insensitive name (F27). New person requires at least one of role/notes/relationship else skipped. Default `relationship="collaborator"`. Always refreshes `lastMentioned` to now on update.
- **upsert_project** (requires `project_name`) → upsert by case-insensitive name; default `status="active"`; refreshes `lastUpdated`.
- **upsert_preference** (requires `pref_key`+`pref_value`) → upsert by exact key; defaults `source="observed"`, `confidence="medium"`; sets `learnedAt=now`.
- **set_fact** (requires `fact_key`+`fact_value`) → `facts[key]=value`.
**Output-effect:** Short status string per action (e.g. `Added person: <name>`).

---

### F27 — Structured-memory write serialization

**Purpose:** Prevent lost updates when concurrent sub-agents mutate `structured.json`.
**Behavior:** All read-modify-write operations (`upsertPerson/Project/Preference`, `setFact`, `touchPersonLastMentioned`) run through a promise-chain mutex (`_withWriteQueue`) that serializes them globally. Each operation reloads the full store, mutates, and saves. **Constraint:** queued functions must not call other queued functions (would deadlock).
**Output-effect:** No interleaved writes; last-writer-by-queue-order wins per field (merge via `{...existing, ...new}` for person/project).

---

### F28 — Structured-memory freshness sync

**Purpose:** Keep `lastMentioned` current and surface people whose structured notes lag their topic activity.
**Behavior:**
- **`touchPersonLastMentioned(topicId)`**: derive each person's slug (`name`→lowercase, non-alphanumeric→`-`, trim dashes); if `topicId === slug` or starts with `<slug>-`, and their `lastMentioned` is older than today, set it to now. Serialized (F27); never throws.
- **`findStalePeople(staleDays=14)`** / **`findStaleStructuredPeople(staleDays=14)`**: people whose `lastMentioned` is older than the cutoff; the latter also gathers related topic IDs (slug-prefix match) and `daysSinceUpdate`. Used by heartbeat people-refresh (F24).
**Output-effect:** Drives the heartbeat people-refresh and avoids noisy same-day writes.

---

### F29 — `manage_memory` tool (adjacent)

**Purpose:** Direct topic management.
**Parameters:** `action: "delete_topic"`, `topic_id`.
**Behavior:** Validates `topic_id` against `^[a-z0-9][a-z0-9_-]*$`; deletes the topic file + index entry, writes an audit record. **Permission required.**
**Output-effect:** `✅ Topic "<id>" deleted (<n> facts removed).` (Topic graph is an adjacent subsystem; included for completeness.)

---

## 4. Data & Formats Appendix

### 4.1 Byte/size constants (contracts)

| Constant | Value | Applies to |
|---|---|---|
| `MEMORY.md` limit | 20 000 B | size enforcement, warnings |
| `USER.md` limit | 8 000 B | size enforcement, warnings |
| `SOUL.md` limit | 6 000 B | size enforcement, warnings |
| `TASKS.md` limit | 10 000 B | (deprecated file) |
| default file limit | 10 000 B | monitoring fallback |
| `DAILY_LOG_MAX` | 30 000 B | daily logs (hard-truncatable) |
| `OVERFLOW_MAX_SIZE` | 50 000 B | `.overflow` sidecar |
| daily per-entry cap | 2 000 chars | append to daily |
| verbose entry cap | 500 chars | sub-agent/scheduled daily entries |
| daily prompt pre-trunc | 3 000 chars | `<today>` block |
| search result cap | 50 | `searchMemory` |
| `searchAllMemory` output cap | 8 000 chars | `file="all"` |
| Quick Facts in summary | 20 | `getStructuredSummary` |
| token estimate | `ceil(len/4)` | budget governance |

### 4.2 Token budgets (`SECTION_BUDGETS`)

`soul`=1500/p1/tail · `agents`=2500/p1/tail · `user`=1500/p2/sections · `memory`=2500/p3/sections(→TOC) · `structured`=1800/p2/tail · `daily`=1000/p3/head · `tasks`=800/p2/tail · `schedules`=150/p4/tail. **Sum = 11 750 tokens** (`maxChars = maxTokens × 4`).

### 4.3 Importance scoring (`scoreSection`)

```
score = IMPORTANCE_WEIGHT[importance] * 10        // critical=40, high=30, medium=20, low=10
refDate = lastReferenced || created
if refDate: score += max(0, 10 - floor(daysSince/7))
else:       score += 5
if header ~ /decision|critical/i: score += 5
if header ~ /lesson|pattern/i:    score += 3
if header ~ /compacted/i:         score -= 3
```

### 4.4 Dedup (`isDuplicate`, default threshold 0.7)

```
fingerprint(t) = lowercase → strip /[^a-z0-9\s]/ → collapse spaces → trim → slice(0,500)
newFp < 40 chars                          → not duplicate
existingFp.includes(newFp.slice(0,200))   → duplicate
lineOverlap = |newLines ∩ existingLines| / |newLines|   // lines trimmed/lowercased, length>20
lineOverlap >= threshold                  → duplicate
```
Compaction "supersede" uses threshold 0.6 (with the earlier section ≥200 chars).

### 4.5 Section header fuzzy match (`sectionHeaderMatch`)

```
normalize(s) = lowercase → strip /[^\w\s]/ → collapse spaces → trim
match iff normalize(a) === normalize(b)    // case- & emoji/punctuation-insensitive; exact otherwise
```

### 4.6 Synonym map (`SYNONYMS`) — full lists

```
bug      → error, fix, crash, issue, broken, regression, debug
error    → bug, fix, crash, exception, fail, broken
fix      → bug, error, patch, resolve, repair
deploy   → deployment, release, ship, publish, ci, cd
test     → testing, spec, assert, qa, validate, check
perf     → performance, slow, fast, optimize, latency, speed, cache
auth     → authentication, login, token, jwt, session, oauth, credential
ui       → frontend, component, layout, css, styling, display, render
api      → endpoint, route, rest, graphql, request, response
db       → database, query, sql, table, schema, migration
config   → configuration, settings, env, environment, option
memory   → remember, recall, forget, store, persist
task     → todo, ticket, issue, work, assignment
meeting  → standup, sync, 1:1, review, retro
decision → decided, chose, picked, approach, strategy
```
Expansion also adds a group **key** when a query term appears in that group's list. Stop-words removed before expansion: a, an, the, is, are, was, were, what, who, how, where, when, why, do, does, did, has, have, had, be, been, being, in, on, at, to, for, of, with, by, from, as, it, its, my, me, his, her, their, our, your, this, that, and, or, not, but, about, can, will, would, should, tell, show, give, find, search, please, pls.

### 4.7 File format templates

**Daily log entry (channel-tagged):**
```markdown
## [work-claw] Sub-agent: Email Triage (08:43 AM)
Reviewed inbox; 2 items need follow-up …
```

**`MEMORY.md` compaction summary section:**
```markdown
## Compacted: 2026-02-10 to 2026-02-16
<~500-word LLM summary of those days>
```

**Section with importance metadata:**
```markdown
## Patterns & Lessons
<!-- importance: high | created: 2026-02-22 | last-referenced: 2026-02-23 -->
- Always reproduce a bug with a failing test before fixing.
```

**Weekly summary file (`archive/weeks/2026-W08.md`):**
```markdown
# Week Summary: 2026-W08
*Covers: 2026-02-16 to 2026-02-22*

<~300-word LLM summary>
```

**Monthly summary file (`archive/months/2026-02.md`):**
```markdown
# Month Summary: 2026-02

<~200-word LLM summary>
```

**Overflow sidecar entry (`MEMORY.md.overflow`):**
```markdown
<!-- archived: 2026-02-23T11:04:55.123Z | from: MEMORY.md | reason: size-limit -->
## Old Low-Priority Section
<content>

---
```

### 4.8 `structured.json` — minimal example

```json
{
  "people": [
    { "name": "Alice Example", "role": "PM", "relationship": "manager",
      "notes": "Owns roadmap.", "lastMentioned": "2026-02-23T09:00:00.000Z" }
  ],
  "projects": [
    { "name": "Phoenix", "status": "active", "description": "Rewrite of billing",
      "repo": "org/phoenix", "lastUpdated": "2026-02-23T09:00:00.000Z" }
  ],
  "preferences": [
    { "key": "communication_style", "value": "concise bullet points",
      "source": "explicit", "confidence": "high", "learnedAt": "2026-02-20T12:00:00.000Z" }
  ],
  "facts": { "timezone": "America/Los_Angeles" }
}
```

---

## 5. Coverage Notes

**Fully specified from source (verified at HEAD):** file layout & paths; all byte-size constants; `SECTION_BUDGETS` and truncation strategies; importance metadata format and `scoreSection`; dedup (`isDuplicate`) and fuzzy section match; `memory_write` all four modes; in-file compaction; truncate-to-fit + overflow sidecar; smart TOC; system-prompt assembly and block ordering; daily-log channel tagging, caps, noise filtering; `cleanAgentOutput`; `searchMemory` scoring/expansion/sources and the distinct `searchAllMemory`; `compactMemory`/`compactWeekly`/`compactMonthly` thresholds; heartbeat cadences; `runMemoryGC` detectors & thresholds; `structured.json` schema; `structured_memory` tool; write-queue serialization; freshness sync.

**Discrepancies found (documented above):**
- README says "~10K tokens total" for the context budget; the actual `SECTION_BUDGETS` sum is **11 750 tokens** (source comment says "~11.7K / ~46KB"). Treat **11 750** as the contract.
- README implies `memory_compact` / `memory_search` are tools. They are **not** standalone tools: compaction is `memory_write mode="compact"`; relevance search (`searchMemory`) is invoked via CLI/daemon/heartbeat, and `memory_read file="all"` exposes the simpler `searchAllMemory`. No `defineTool("memory_compact"…)` or `defineTool("memory_search"…)` exists.

**Intentionally out of scope / treated as adjacent subsystems (referenced but not specified in depth):** the **topic graph** (`memory/topics/*.md`, `topic-store`, `topic-index`, keyword/FTS index, `index.md`/`index.db`, `manage_memory`), the **retrieval-augmented memory context** (`retriever.ts buildMemoryContext`, used in prompt assembly when the graph is ready), the **knowledge base** (`buildKnowledgeBaseSummary`), the **task system** (`task_manage`, `tasks.json` — `TASKS.md` is deprecated and redirected), **skill memory** (tier 4), the **audit log**, and **safe-fs** backup mechanics (only their GC interaction is covered). A re-implementer reproducing the four-tier prose+structured memory described in the scope does not need these; where they affect the specced behavior (e.g. prompt assembly may substitute graph-retrieval for raw `MEMORY.md`), that branch is noted.

**Potential ambiguities a re-implementer should know:**
- "char length" vs UTF-8 bytes is used inconsistently in the source: caps like the 2 KB daily-entry cap and TOC budgets use JS `.length` (char count), while size *limits* use `Buffer.byteLength`. Match per-feature as documented.
- The budget `priority` field is declared but does not currently drop whole sections; each section is truncated independently.
- `compactMemory` (daily→MEMORY.md) is exported and self-contained, but the live heartbeat path performs an LLM-driven equivalent inline and archives logs itself; both produce `## Compacted:` sections, so the file format is identical regardless of path.
