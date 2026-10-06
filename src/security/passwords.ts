import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

/** scrypt password hash, self-describing so parameters can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, n, r, p, saltText, keyText] = encoded.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltText, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Minimum policy for locally managed passwords (an external IdP applies its own). */
export function passwordProblem(password: string): string | undefined {
  if (password.length < 12) return 'password must be at least 12 characters';
  if (password.length > 256) return 'password is too long';
  return undefined;
}
