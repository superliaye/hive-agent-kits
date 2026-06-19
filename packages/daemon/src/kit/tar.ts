// Minimal POSIX (ustar / GNU longname) tar reader for codeload tarballs.
//
// codeload.github.com serves a gzip'd ustar archive whose single top-level
// entry is `<repo>-<sha>/`. We parse the blocks ourselves (no tar dependency)
// so the top-folder strip is CONTENT-DERIVED — read the first path component of
// the first entry, never hard-code `my-agent-kits-<sha>/`.

export type TarEntry = {
  path: string;
  type: "file" | "dir";
  data: Uint8Array;
};

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

// Parse a decompressed tar buffer into entries. Handles GNU long-name ('L')
// extension headers. Ignores PAX/global headers and other non-file typeflags.
export function parseTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;

  while (offset + BLOCK <= buf.length) {
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
    const size = readOctal(buf, offset + 124, 12);
    const typeflag = String.fromCharCode(buf[offset + 156] || 0);
    const prefix = readString(buf, offset + 345, 155);

    offset += BLOCK;
    const dataStart = offset;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    offset += padded;

    if (typeflag === "L") {
      // GNU long name: the next header's real name is this block's data.
      longName = readString(buf, dataStart, size).replace(/\0+$/, "");
      continue;
    }

    let fullPath = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    fullPath = fullPath.replace(/\\/g, "/");

    if (typeflag === "5" || fullPath.endsWith("/")) {
      entries.push({ path: fullPath.replace(/\/+$/, ""), type: "dir", data: new Uint8Array(0) });
      continue;
    }
    // Only regular files ('0' or '\0'); skip symlinks/hardlinks/devices.
    if (typeflag !== "0" && typeflag !== "\0") continue;

    entries.push({ path: fullPath, type: "file", data: buf.subarray(dataStart, dataStart + size) });
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
