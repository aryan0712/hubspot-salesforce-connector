import crypto from 'node:crypto';

/**
 * Application-level envelope for secrets before they reach PostgreSQL. The database only
 * sees versioned AES-256-GCM ciphertext (`v<N>.iv.tag.data`), with the ciphertext bound to
 * its row by the authenticated context.
 *
 * R14 key rotation: the cipher holds one CURRENT key (all new encryptions) and any number
 * of PREVIOUS keys (decrypt only). Rotate by deploying a new current key with the old one
 * listed as previous, running `npm run secrets:rotate -- --confirm` to re-encrypt stored
 * secrets, then removing the old key once nothing uses it (`needsRotation` is false for all).
 */
export class SecretCipher {
  private readonly keys = new Map<number, Buffer>();

  constructor(
    secret: string,
    private readonly version = 1,
    previous: Record<number, string> = {},
  ) {
    this.keys.set(version, deriveKey(secret, 'APP_ENCRYPTION_KEY'));
    for (const [oldVersion, oldSecret] of Object.entries(previous)) {
      const numeric = Number(oldVersion);
      if (numeric === version) throw new Error(`previous key v${numeric} has the same version as the current key`);
      this.keys.set(numeric, deriveKey(oldSecret, `previous key v${numeric}`));
    }
  }

  get currentVersion(): number {
    return this.version;
  }

  encrypt(plaintext: string, context: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keys.get(this.version)!, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      `v${this.version}`,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  decrypt(encoded: string, context: string): string {
    const [versionText, ivText, tagText, ciphertext] = encoded.split('.');
    const version = versionOf(encoded);
    if (version === undefined || !ivText || !tagText || ciphertext === undefined) {
      throw new Error('unsupported encrypted secret format');
    }
    const key = this.keys.get(version);
    if (!key) {
      throw new Error(
        `secret was encrypted with key ${versionText}, which is not configured (add it to APP_ENCRYPTION_PREVIOUS_KEYS)`,
      );
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** True when a stored value is not encrypted with the current key. */
  needsRotation(encoded: string): boolean {
    return versionOf(encoded) !== this.version;
  }
}

export function versionOf(encoded: string): number | undefined {
  const match = /^v(\d+)\./.exec(encoded);
  return match ? Number(match[1]) : undefined;
}

function deriveKey(secret: string, label: string): Buffer {
  if (secret.length < 32) throw new Error(`${label} must contain at least 32 characters`);
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Parses APP_ENCRYPTION_PREVIOUS_KEYS: comma-separated `<version>:<key>` pairs, e.g.
 * `1:oldkey...,2:olderkey...`.
 */
export function parsePreviousKeys(value: string | undefined): Record<number, string> {
  const keys: Record<number, string> = {};
  for (const part of (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const separator = part.indexOf(':');
    const version = Number(part.slice(0, separator));
    const key = part.slice(separator + 1);
    if (separator < 1 || !Number.isInteger(version) || version < 1 || !key) {
      throw new Error('APP_ENCRYPTION_PREVIOUS_KEYS must be comma-separated <version>:<key> pairs');
    }
    keys[version] = key;
  }
  return keys;
}
