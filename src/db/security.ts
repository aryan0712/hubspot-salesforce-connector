import crypto from 'node:crypto';

/**
 * Application-level envelope for OAuth secrets before they reach PostgreSQL.
 * The database only sees versioned AES-256-GCM ciphertext.
 */
export class SecretCipher {
  private readonly key: Buffer;

  constructor(secret: string, private readonly version = 1) {
    if (secret.length < 32) {
      throw new Error('APP_ENCRYPTION_KEY must contain at least 32 characters');
    }
    this.key = crypto.createHash('sha256').update(secret).digest();
  }

  encrypt(plaintext: string, context: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
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
    const [version, ivText, tagText, ciphertext] = encoded.split('.');
    if (version !== `v${this.version}` || !ivText || !tagText || ciphertext === undefined) {
      throw new Error('unsupported encrypted secret format');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivText, 'base64url'),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
