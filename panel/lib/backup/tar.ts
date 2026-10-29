// A minimal ustar writer for the panel's own backup (a few small files).
// The panel can't run GNU tar: its sandbox (RestrictSUIDSGID) blocks the
// openat2() call tar needs on Ubuntu 26.04.
import { readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

const BLOCK = 512;

function header(name: string, size: number, mtime: number, mode: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar: name too long: ${name}`);
  const h = Buffer.alloc(BLOCK);
  const field = (value: string, offset: number, length: number) => h.write(value, offset, length, "ascii");
  const octal = (value: number, offset: number, length: number) => field(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
  h.write(name, 0, 100, "utf8");
  octal(mode & 0o7777, 100, 8);
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(size, 124, 12);
  octal(Math.floor(mtime / 1000), 136, 12);
  field("        ", 148, 8); // checksum placeholder: spaces while summing
  field("0", 156, 1); // regular file
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  field(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

/** A gzipped tar of the given files, each stored under its `name`. */
export function tarGz(files: { name: string; path: string }[]): Readable {
  const parts: Buffer[] = [];
  for (const f of files) {
    const data = readFileSync(f.path);
    const st = statSync(f.path);
    parts.push(header(f.name, data.length, st.mtimeMs, st.mode), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Readable.from([Buffer.concat(parts)]).pipe(createGzip());
}
