import crypto from 'node:crypto';

/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) for the OAuth authorization-code flow.
 * The client generates a random `verifier`, sends its SHA-256 `challenge` on the authorize
 * request, and proves possession by sending the `verifier` on the token exchange. Salesforce
 * External Client Apps require this; HubSpot supports it. It also doubles as CSRF protection.
 */
export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
