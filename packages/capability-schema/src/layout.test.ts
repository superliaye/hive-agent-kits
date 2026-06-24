import { describe, expect, test } from "bun:test";
import { type CapabilityKind, capabilityLayout } from "@hive/capability-schema";

describe("capabilityLayout", () => {
  test("has exactly the five kind entries", () => {
    const kinds: CapabilityKind[] = ["instruction", "skill", "agent", "plugin", "bundle"];
    expect(new Set(Object.keys(capabilityLayout))).toEqual(new Set(kinds));
  });

  test("folder kinds carry a marker; file kinds carry a suffix", () => {
    const skill = capabilityLayout.skill;
    expect(skill.style).toBe("folder");
    if (skill.style === "folder") {
      expect(skill.dir).toBe("skills");
      expect(skill.marker).toBe("SKILL.md");
    }

    const agent = capabilityLayout.agent;
    expect(agent.style).toBe("folder");
    if (agent.style === "folder") expect(agent.marker).toBe("AGENT.md");

    const instruction = capabilityLayout.instruction;
    expect(instruction.style).toBe("file");
    if (instruction.style === "file") {
      expect(instruction.dir).toBe("instructions");
      expect(instruction.suffix).toBe(".instructions.md");
    }

    const plugin = capabilityLayout.plugin;
    expect(plugin.style).toBe("file");
    if (plugin.style === "file") expect(plugin.suffix).toBe(".plugin.md");

    const bundle = capabilityLayout.bundle;
    expect(bundle.style).toBe("file");
    if (bundle.style === "file") expect(bundle.suffix).toBe(".bundle.md");
  });

  test("each entry's style discriminates folder vs file shape", () => {
    const folderKinds = Object.values(capabilityLayout).filter((l) => l.style === "folder");
    const fileKinds = Object.values(capabilityLayout).filter((l) => l.style === "file");
    expect(folderKinds.length).toBe(2);
    expect(fileKinds.length).toBe(3);
  });
});
