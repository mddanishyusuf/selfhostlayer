// Backup encryption: AES-256-GCM over 1MB chunks, so backups of any size
// stream through in constant memory, and any change, reordering or
// truncation is detected on restore.
//
//   header: "LAYERBK1" (8 bytes) + salt (32 bytes)
//   chunks: ciphertext + 16-byte tag; every chunk but the last holds exactly
//           CHUNK bytes of plaintext, the last holds fewer (possibly none)
//
// Each file gets its own key, HKDF-SHA256(recovery key, salt), and chunk i
// uses nonce = 4 zero bytes + i (64-bit big-endian), with the header and a
// "last chunk" flag as associated data.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

const MAGIC = Buffer.from("LAYERBK1");
const HEADER = MAGIC.length + 32;
export const CHUNK = 1024 * 1024;
const TAG = 16;

/** A recovery key as the user writes it down: "lbk1-" + 43 base64url characters. */
export function newRecoveryKey(): string {
  return `lbk1-${randomBytes(32).toString("base64url")}`;
}

export function parseRecoveryKey(text: string): Buffer {
  const m = /^lbk1-([A-Za-z0-9_-]{43})$/.exec(text.trim());
  if (!m) throw new Error("a recovery key looks like lbk1- followed by 43 letters, digits, - or _");
  return Buffer.from(m[1]!, "base64url");
}

function fileKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, salt, "layer-backup-v1", 32));
}

function nonce(i: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(i), 4);
  return n;
}

const aad = (header: Buffer, last: boolean) => Buffer.concat([header, Buffer.from([last ? 1 : 0])]);

export function encryptStream(master: Buffer): Transform {
  const header = Buffer.concat([MAGIC, randomBytes(32)]);
  const key = fileKey(master, header.subarray(MAGIC.length));
  let pending = Buffer.alloc(0);
  let index = 0;
  const seal = (plain: Buffer, last: boolean) => {
    const cipher = createCipheriv("aes-256-gcm", key, nonce(index++));
    cipher.setAAD(aad(header, last));
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  return new Transform({
    construct(cb) {
      this.push(header);
      cb();
    },
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      pending = Buffer.concat([pending, chunk]);
      // Strictly more than a chunk: the final chunk must stay shorter than CHUNK.
      while (pending.length > CHUNK) {
        this.push(seal(pending.subarray(0, CHUNK), false));
        pending = pending.subarray(CHUNK);
      }
      cb();
    },
    flush(cb) {
      if (pending.length === CHUNK) {
        this.push(seal(pending, false));
        pending = Buffer.alloc(0);
      }
      this.push(seal(pending, true));
      cb();
    },
  });
}

export class BackupDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupDecryptError";
  }
}

export function decryptStream(master: Buffer): Transform {
  let header: Buffer | null = null;
  let key: Buffer | null = null;
  let pending = Buffer.alloc(0);
  let index = 0;
  const open = (sealed: Buffer, last: boolean) => {
    const decipher = createDecipheriv("aes-256-gcm", key!, nonce(index++));
    decipher.setAAD(aad(header!, last));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    try {
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
    } catch {
      throw new BackupDecryptError("the backup doesn't match this recovery key, or it was changed or cut short");
    }
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      pending = Buffer.concat([pending, chunk]);
      try {
        if (!header) {
          if (pending.length < HEADER) return cb();
          if (!pending.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupDecryptError("not a Self Host Layer backup");
          header = Buffer.from(pending.subarray(0, HEADER));
          key = fileKey(master, header.subarray(MAGIC.length));
          pending = pending.subarray(HEADER);
        }
        while (pending.length > CHUNK + TAG) {
          this.push(open(pending.subarray(0, CHUNK + TAG), false));
          pending = pending.subarray(CHUNK + TAG);
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (!header) throw new BackupDecryptError("not a Self Host Layer backup");
        if (pending.length < TAG) throw new BackupDecryptError("the backup is cut short");
        this.push(open(pending, true));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}
