import { stripVTControlCharacters } from "node:util";

export class InstallerTaskError extends Error {
  constructor(
    readonly code: "missing_binary" | "installer_failed",
    readonly detail: string,
  ) {
    super(code);
    this.name = "InstallerTaskError";
  }
}

// Warnings an installer prints before carrying on, which say nothing about why
// it then failed.
const HARMLESS_WARNINGS = [/^WARNING: proceeding, even though we could not create PATH aliases\b/];

const harmless = (line: string) => HARMLESS_WARNINGS.some((pattern) => pattern.test(line));

export function boundedInstallerDetail(value: string): string {
  const redacted = stripVTControlCharacters(value)
    .replace(/\bbearer\s+[^\s,;]+/gi, "bearer <redacted>")
    .replace(
      /\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=<redacted>",
    )
    .trim();
  const bounded = redacted.length <= 512 ? redacted : redacted.slice(-512);
  // A detail is read from its start, so a harmless warning moves after the error.
  const lines = bounded.split("\n");
  const warnings = lines.filter(harmless);
  const rest = lines.filter((line) => !harmless(line));
  return warnings.length === 0 || rest.every((line) => line.trim() === "")
    ? bounded
    : [...rest, ...warnings].join("\n");
}
