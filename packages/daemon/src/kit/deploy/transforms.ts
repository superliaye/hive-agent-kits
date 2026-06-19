// Pure deploy transforms (Plan A4) — no I/O, unit-testable. Each takes the
// Mirror source content as data and returns the bytes/files to write. Mirrors
// the upstream agent-kit contract (lib/deploy.js) verified against the pinned
// my-agent-kits SHA in AGENTS.md.

// ---- snippet include expansion ----

const INCLUDE_RE = /^[ \t]*<!--\s*include:\s*([A-Za-z0-9_-]+)\s*-->[ \t]*$/gm;

// Replace each standalone `<!-- include: NAME -->` with the named snippet body.
// `strict` (SKILL.md): an unknown snippet throws — a bug in an authored
// entrypoint. Non-strict (other .md): leave the marker verbatim.
export function expandIncludes(
  content: string,
  snippets: Map<string, string>,
  strict: boolean,
  label: string,
): string {
  return content.replace(INCLUDE_RE, (marker, name: string) => {
    if (snippets.has(name)) return snippets.get(name) as string;
    if (strict) throw new Error(`${label}: include '${name}' not found in snippets`);
    return marker;
  });
}

// ---- skill transform ----

// One file destined for a skill's deployed folder, path relative to the skill root.
export type SkillFile = { rel: string; content: string };

export type SkillSource = {
  name: string;
  // All shipped files under the skill folder (already filtered for the maintainer
  // assets the caller knows about, OR raw — `transformSkill` applies the filter).
  files: SkillFile[];
  // disable-model-invocation from SKILL.md frontmatter (drives the Codex sidecar).
  disableModelInvocation: boolean;
};

export type SkillTransformOutput = {
  files: SkillFile[];
  // The Codex manual-only sidecar, when disableModelInvocation is set. Path is
  // relative to the skill root: agents/openai.yaml.
  sidecar?: SkillFile;
};

// Filter maintainer-only assets (_unshipped/ dirs, SOURCE.md), expand includes
// in every .md (SKILL.md strict, others lenient).
export function transformSkill(
  src: SkillSource,
  snippets: Map<string, string>,
): SkillTransformOutput {
  const shipped: SkillFile[] = [];
  for (const f of src.files) {
    const parts = f.rel.split("/");
    if (parts.includes("_unshipped")) continue;
    if (f.rel === "SOURCE.md") continue;
    if (f.rel.endsWith(".md") && f.content.includes("<!--")) {
      const strict = parts[parts.length - 1] === "SKILL.md";
      shipped.push({
        rel: f.rel,
        content: expandIncludes(f.content, snippets, strict, `Skill '${src.name}' (${f.rel})`),
      });
    } else {
      shipped.push(f);
    }
  }
  const out: SkillTransformOutput = { files: shipped };
  if (src.disableModelInvocation) {
    out.sidecar = {
      rel: "agents/openai.yaml",
      content: "policy:\n  allow_implicit_invocation: false\n",
    };
  }
  return out;
}

// ---- agent transform ----

export type AgentSource = {
  name: string;
  // Raw AGENT.md content (frontmatter + body).
  raw: string;
};

export type AgentTransformOutput = {
  // Claude target: AGENT.md verbatim with includes expanded → <name>.md.
  claudeMd: string;
  // Codex target: translated TOML (name/description/developer_instructions;
  // model + tools dropped) → <name>.toml.
  codexToml: string;
};

function stripFrontmatter(s: string): string {
  if (!s.startsWith("---")) return s;
  const end = s.indexOf("\n---", 3);
  if (end < 0) return s;
  return s.slice(end + 4).replace(/^\n+/, "");
}

function parseFrontmatterObject(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const lines = content.slice(3, end).trim().split(/\r?\n/);
  const out: Record<string, unknown> = {};
  for (const line of lines) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

// Strip the control characters TOML forbids unescaped (everything below U+0020
// except the already-collapsed \r\n). Done by code-point scan rather than a
// control-char regex literal (which biome flags as suspicious).
function stripTomlControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

function tomlBasicString(s: string): string {
  const esc = stripTomlControlChars(
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, " "),
  ).trim();
  return `"${esc}"`;
}

function tomlMultilineString(s: string): string {
  const v = String(s);
  if (!v.includes("'''")) return `'''\n${v}\n'''`;
  const esc = v.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
  return `"""\n${esc}\n"""`;
}

export function transformAgent(
  src: AgentSource,
  snippets: Map<string, string>,
): AgentTransformOutput {
  const claudeMd = expandIncludes(src.raw, snippets, true, `Agent '${src.name}'`);
  const fm = parseFrontmatterObject(src.raw);
  const body = expandIncludes(
    stripFrontmatter(src.raw),
    snippets,
    true,
    `Agent '${src.name}'`,
  ).trim();
  const nm = typeof fm.name === "string" && fm.name ? fm.name : src.name;
  const desc = typeof fm.description === "string" ? fm.description : "";
  const codexToml = [
    `name = ${tomlBasicString(nm)}`,
    `description = ${tomlBasicString(desc)}`,
    `developer_instructions = ${tomlMultilineString(body)}`,
    "",
  ].join("\n");
  return { claudeMd, codexToml };
}

// ---- instruction transform ----

// Concatenate selected instruction bodies (frontmatter stripped), \n\n-joined,
// trailing newline. Used for both CLAUDE.md and AGENTS.md.
export function transformInstructions(bodies: string[]): string {
  return `${bodies.map((b) => stripFrontmatter(b).trim()).join("\n\n")}\n`;
}
