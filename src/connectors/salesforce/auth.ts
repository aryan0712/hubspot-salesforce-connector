import axios from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import {
  connections,
  type Connection,
  type Environment,
} from '../../core/connectionStore.js';
import { settings } from '../../core/settingsStore.js';
import { reconnectRequired } from '../oauthError.js';

/**
 * Salesforce OAuth 2.0 (web-server flow) with PRODUCTION and SANDBOX support.
 *
 * A single Connected App works for both — only the login/token host differs:
 *   production -> https://login.salesforce.com
 *   sandbox    -> https://test.salesforce.com
 * The chosen environment is persisted on the Connection so token refresh always targets
 * the right host.
 */
const LOGIN_URL: Record<Environment, string> = {
  production: 'https://login.salesforce.com',
  sandbox: 'https://test.salesforce.com',
};
let refreshInFlight: Promise<{ accessToken: string; instanceUrl: string }> | undefined;

/** App credentials: browser-entered settings take precedence over env vars. */
async function creds(): Promise<{ clientId: string; clientSecret: string }> {
  const s = await settings.get('salesforce');
  return {
    clientId: s?.clientId ?? env.SF_CLIENT_ID ?? '',
    clientSecret: s?.clientSecret ?? env.SF_CLIENT_SECRET ?? '',
  };
}

export async function isConfigured(): Promise<boolean> {
  const c = await creds();
  return Boolean(c.clientId && c.clientSecret);
}

function redirectUri(): string {
  return env.SF_REDIRECT_URI ?? `${env.PUBLIC_BASE_URL}/auth/salesforce/callback`;
}

/** Build the authorize URL to send the user's browser to. Includes the PKCE challenge. */
export async function authUrl(environment: Environment, state: string, codeChallenge?: string): Promise<string> {
  return salesforceAuthUrl(environment, state, codeChallenge);
}

export async function salesforceAuthUrl(environment: Environment, state: string, codeChallenge?: string): Promise<string> {
  const credentials = await creds();
  const u = new URL('/services/oauth2/authorize', LOGIN_URL[environment]);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', credentials.clientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', 'api refresh_token offline_access');
  u.searchParams.set('state', state);
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

/** Exchange the authorization code for tokens and persist the connection. */
export async function exchangeCode(environment: Environment, code: string, codeVerifier?: string): Promise<void> {
  const credentials = await creds();
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: redirectUri(),
  };
  if (codeVerifier) body.code_verifier = codeVerifier;
  const { data } = await axios.post(
    `${LOGIN_URL[environment]}/services/oauth2/token`,
    new URLSearchParams(body),
  );
  await connections.set({
    system: 'salesforce',
    environment,
    refreshToken: data.refresh_token,
    instanceUrl: data.instance_url,
    accessToken: data.access_token,
    expiresAt: Date.now() + 90 * 60_000,
    accountLabel: hostLabel(data.instance_url),
    connectedAt: new Date().toISOString(),
  });
  logger.info({ environment, instanceUrl: data.instance_url }, 'Salesforce connected');
}

/** Return a valid access token + instance URL, refreshing via the stored refresh token. */
export async function getAccessToken(): Promise<{ accessToken: string; instanceUrl: string }> {
  let conn = await connections.get('salesforce');
  // Back-compat: seed a connection from env vars if one was provided the old way.
  if (!conn && env.SF_REFRESH_TOKEN) {
    conn = {
      system: 'salesforce',
      environment: 'production',
      refreshToken: env.SF_REFRESH_TOKEN,
      instanceUrl: env.SF_INSTANCE_URL,
      connectedAt: new Date().toISOString(),
    };
    await connections.set(conn);
  }
  if (!conn) throw new Error('Salesforce not connected. Start OAuth at /auth/salesforce/start');

  if (conn.accessToken && conn.expiresAt && conn.expiresAt > Date.now() + 60_000) {
    return { accessToken: conn.accessToken, instanceUrl: conn.instanceUrl ?? '' };
  }
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(conn).finally(() => {
      refreshInFlight = undefined;
    });
  }
  return refreshInFlight;
}

async function refreshAccessToken(
  conn: Connection,
): Promise<{ accessToken: string; instanceUrl: string }> {
  const credentials = await creds();
  let data: {
    access_token: string;
    instance_url?: string;
    refresh_token?: string;
  };
  try {
    const response = await axios.post(
      `${LOGIN_URL[conn.environment]}/services/oauth2/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: conn.refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    );
    data = response.data;
  } catch (error) {
    throw reconnectRequired('salesforce', error) ?? error;
  }
  const instanceUrl = data.instance_url ?? conn.instanceUrl ?? '';
  await connections.set({
    ...conn,
    refreshToken: data.refresh_token ?? conn.refreshToken,
    accessToken: data.access_token,
    instanceUrl,
    expiresAt: Date.now() + 90 * 60_000,
  });
  logger.debug(
    { refreshTokenRotated: Boolean(data.refresh_token) },
    'Refreshed Salesforce access token',
  );
  return { accessToken: data.access_token, instanceUrl };
}

function hostLabel(url?: string): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}
