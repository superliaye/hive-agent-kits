import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import starterExplorer from "../../../agent-kit-starter-template/capabilities/agents/starter-explorer/AGENT.md" with {
  type: "text",
};
import starterConduct from "../../../agent-kit-starter-template/capabilities/instructions/starter-conduct.instructions.md" with {
  type: "text",
};
import reviewDiff from "../../../agent-kit-starter-template/capabilities/skills/review-diff/SKILL.md" with {
  type: "text",
};
import summarizeChanges from "../../../agent-kit-starter-template/capabilities/skills/summarize-changes/SKILL.md" with {
  type: "text",
};
import starterPreset from "../../../agent-kit-starter-template/presets/starter.yaml" with {
  type: "text",
};

const files = [
  ["capabilities/agents/starter-explorer/AGENT.md", starterExplorer],
  ["capabilities/instructions/starter-conduct.instructions.md", starterConduct],
  ["capabilities/skills/review-diff/SKILL.md", reviewDiff],
  ["capabilities/skills/summarize-changes/SKILL.md", summarizeChanges],
  ["presets/starter.yaml", starterPreset],
] as const;

const identity = createHash("sha256")
  .update(files.map(([path, content]) => `${path}\0${content}`).join("\0"))
  .digest("hex");

function complete(root: string): boolean {
  return files.every(([path, content]) => {
    const target = join(root, path);
    if (!existsSync(target)) return false;
    const stat = lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink() && readFileSync(target, "utf8") === content;
  });
}

export function bundledStarterRoot(runtimeRoot: string): string {
  const parent = join(runtimeRoot, "bundled");
  const root = join(parent, `starter-${identity}`);
  if (complete(root)) return root;

  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, `.starter-${identity}.`));
  try {
    for (const [path, content] of files) {
      const target = join(stage, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { encoding: "utf8", mode: 0o644 });
    }
    renameSync(stage, root);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (!complete(root)) throw error;
  }
  return root;
}
