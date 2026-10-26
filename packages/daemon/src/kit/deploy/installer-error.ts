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

export function boundedInstallerDetail(value: string): string {
  const redacted = stripVTControlCharacters(value)
    .replace(/\bbearer\s+[^\s,;]+/gi, "bearer <redacted>")
    .replace(
      /\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=<redacted>",
    )
    .trim();
  return redacted.length <= 512 ? redacted : redacted.slice(-512);
}
