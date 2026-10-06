import crypto from 'node:crypto';

/**
 * A one-way, truncated fingerprint of a secret (e.g. an API key), safe to store and display
 * so an admin can tell which credential is active without ever seeing it again.
 */
export function keyFingerprint(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
}
