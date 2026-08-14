// Minimal POSIX (ustar / GNU longname) tar reader for codeload tarballs.
//
// codeload.github.com serves a gzip'd ustar archive whose single top-level
// entry is `<repo>-<sha>/`. We parse the blocks ourselves (no tar dependency)
// so the top-folder strip is CONTENT-DERIVED — read the first path component of
// the first entry, never hard-code `my-agent-kits-<sha>/`.

export type TarEntry =
  | { path: string; type: "file"; data: Uint8Array; mode: number }
  | { path: string; type: "dir"; data: Uint8Array; mode: number }
  | { path: string; type: "symlink"; data: Uint8Array; mode: number; linkTarget: string }
  | { path: string; type: "special"; data: Uint8Array; mode: number };

const BLOCK = 512;

function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(offset, end));
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  // GNU base-256: a numeric field whose first byte has the high bit set encodes
  // a big-endian integer in the remaining bytes (used for sizes that overflow
  // the octal field). Decode it rather than mis-parsing as octal — a wrong size
  // would desync dataStart/offset for every later entry.
  const first = buf[offset] ?? 0;
  if (first & 0x80) {
    let value = 0;
    for (let i = 1; i < length; i++) {
      value = value * 256 + (buf[offset + i] ?? 0);
    }
    return value;
  }
  const s = readString(buf, offset, length).trim();
  if (!s) return 0;
  return parseInt(s, 8) || 0;
}

function parsePax(data: Uint8Array): Map<string, string> {
  const attributes = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) space++;
    if (space === data.length) break;
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset ||
      offset + length > data.length
    ) {
      throw new Error("invalid PAX header");
    }
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) attributes.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return attributes;
}

// Parse a decompressed tar buffer into entries. PAX/global and GNU long-name/
// long-link metadata is consumed without materializing it; filesystem special
// entries remain visible to the guarded extractor.
export function parseTar(buf: Uint8Array, checkDeadline?: () => void): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let globalPax = new Map<string, string>();
  let nextPax = new Map<string, string>();

  while (offset + BLOCK <= buf.length) {
    checkDeadline?.();
    // Two consecutive zero blocks mark end-of-archive.
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (buf[offset + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readString(buf, offset, 100);
    const mode = readOctal(buf, offset + 100, 8);
    const size = readOctal(buf, offset + 124, 12);
    const typeflag = String.fromCharCode(buf[offset + 156] || 0);
    const linkTarget = readString(buf, offset + 157, 100);
    const prefix = readString(buf, offset + 345, 155);

    offset += BLOCK;
    const dataStart = offset;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    offset += padded;
    if (offset > buf.length) throw new Error("truncated tar archive");

    if (typeflag === "g") {
      globalPax = new Map([...globalPax, ...parsePax(buf.subarray(dataStart, dataStart + size))]);
      continue;
    }
    if (typeflag === "x") {
      nextPax = parsePax(buf.subarray(dataStart, dataStart + size));
      continue;
    }

    if (typeflag === "L") {
      // GNU long name: the next header's real name is this block's data.
      longName = readString(buf, dataStart, size).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "K") {
      longLink = readString(buf, dataStart, size).replace(/\0+$/, "");
      continue;
    }

    const pax = new Map([...globalPax, ...nextPax]);
    const fullPath = longName ?? pax.get("path") ?? (prefix ? `${prefix}/${name}` : name);
    const fullLink = longLink ?? pax.get("linkpath") ?? linkTarget;
    longName = null;
    longLink = null;
    nextPax = new Map();

    if (typeflag === "5" || fullPath.endsWith("/")) {
      entries.push({
        path: fullPath.replace(/\/+$/, ""),
        type: "dir",
        data: new Uint8Array(0),
        mode,
      });
      continue;
    }
    if (typeflag === "2") {
      entries.push({
        path: fullPath,
        type: "symlink",
        data: new Uint8Array(0),
        mode,
        linkTarget: fullLink,
      });
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      entries.push({
        path: fullPath,
        type: "special",
        data: new Uint8Array(0),
        mode,
      });
      continue;
    }

    entries.push({
      path: fullPath,
      type: "file",
      data: buf.subarray(dataStart, dataStart + size),
      mode,
    });
  }

  return entries;
}

// The single top-level archive entry's first path component (content-derived).
// Returns "" if entries don't share a common first segment.
export function topFolder(entries: TarEntry[]): string {
  const head = entries[0];
  if (!head) return "";
  const first = head.path.split("/")[0];
  if (!first) return "";
  for (const e of entries) {
    if (e.path.split("/")[0] !== first) return "";
  }
  return first;
}
