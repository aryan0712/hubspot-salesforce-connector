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
 * HubSpot OAuth 2.0 with web-based connect.
 *
 * NOTE on environments: unlike Salesforce, HubSpot uses the SAME OAuth host for every
 * account — a "sandbox" is just a separate portal the user picks on HubSpot's login screen
 * during consent. We still record the chosen environment on the Connection for labeling and
 * so the UI can show which kind of portal is linked.
 *
 * A private-app token (HUBSPOT_PRIVATE_APP_TOKEN) still works as a shortcut and takes
 * precedence if set, but the product's primary path is this OAuth flow.
 */
const AUTHORIZE = 'https://app.hubspot.com/oauth/authorize';
const TOKEN = 'https://api.hubapi.com/oauth/v1/token';
const SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  // Without these, /crm/v3/schemas (how listObjects() discovers custom objects) 403s with
  // MISSING_SCOPES -- the app can't see or sync custom objects at all, no matter how the
  // HubSpot app itself is configured, because the token we mint never requested them.
  // Scoped to plain custom-object access only: nothing in the connector reads or writes a
  // sensitive/highly_sensitive tier property, and the app config (hubspot-app/.../
  // app-hsmeta.json) only declares these three -- requesting more than it declares gets the
  // whole OAuth connect rejected.
  'crm.objects.custom.read',
  'crm.objects.custom.write',
  'crm.schemas.custom.read',
];
let refreshInFlight: Promise<string> | undefined;

/** App credentials: browser-entered settings take precedence over env vars. */
async function creds(): Promise<{ clientId: string; clientSecret: string }> {
  const s = await settings.get('hubspot');
  return {
    clientId: s?.clientId ?? env.HUBSPOT_CLIENT_ID ?? '',
    clientSecret: s?.clientSecret ?? env.HUBSPOT_CLIENT_SECRET ?? '',
  };
}

export async function getAppSecret(): Promise<string> {
  return (await creds()).clientSecret;
}

export async function isConfigured(): Promise<boolean> {
  const c = await creds();
  return Boolean(c.clientId && c.clientSecret) || Boolean(env.HUBSPOT_PRIVATE_APP_TOKEN);
}

export function redirectUri(): string {
  return env.HUBSPOT_REDIRECT_URI ?? `${env.PUBLIC_BASE_URL}/auth/hubspot/callback`;
}

export async function authUrl(environment: Environment, state: string, codeChallenge?: string): Promise<string> {
  return hubspotAuthUrl(environment, state, codeChallenge);
}

export async function hubspotAuthUrl(_environment: Environment, state: string, codeChallenge?: string): Promise<string> {
  const credentials = await creds();
  const u = new URL(AUTHORIZE);
  u.searchParams.set('client_id', credentials.clientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('state', state);
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

/**
 * Exchanges the authorization code for tokens and returns the connection WITHOUT storing
 * it: the caller confirms the exact account (portal id) before it replaces a current one.
 */
export async function exchangeCode(environment: Environment, code: string, codeVerifier?: string): Promise<Connection> {
  const credentials = await creds();
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: redirectUri(),
    code,
  };
  if (codeVerifier) body.code_verifier = codeVerifier;
  const { data } = await axios.post(TOKEN, new URLSearchParams(body));
  const hub = await hubInfo(data.access_token);
  logger.info({ environment }, 'HubSpot authorization exchanged');
  return {
    system: 'hubspot',
    environment,
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    accountLabel: hub.label,
    accountId: hub.id,
    connectedAt: new Date().toISOString(),
  };
}

export async function getAccessToken(): Promise<string> {
  if (env.HUBSPOT_PRIVATE_APP_TOKEN) return env.HUBSPOT_PRIVATE_APP_TOKEN;

  let conn = await connections.get('hubspot');
  if (!conn && env.HUBSPOT_REFRESH_TOKEN) {
    conn = {
      system: 'hubspot',
      environment: 'production',
      refreshToken: env.HUBSPOT_REFRESH_TOKEN,
      connectedAt: new Date().toISOString(),
    };
    await connections.set(conn);
  }
  if (!conn) throw new Error('HubSpot not connected. Start OAuth at /auth/hubspot/start');

  if (conn.accessToken && conn.expiresAt && conn.expiresAt > Date.now() + 60_000) {
    return conn.accessToken;
  }
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(conn).finally(() => {
      refreshInFlight = undefined;
    });
  }
  return refreshInFlight;
}

/**
 * Called after HubSpot rejected `rejectedToken` (401). Invalidates it and runs ONE shared
 * refresh; concurrent callers reuse it, and a token someone else already refreshed is
 * returned as-is. A private-app token cannot be refreshed, so it is returned unchanged and
 * the single retry fails with a clear authorization error.
 */
export async function refreshAfterRejection(rejectedToken: string): Promise<string> {
  if (env.HUBSPOT_PRIVATE_APP_TOKEN) return env.HUBSPOT_PRIVATE_APP_TOKEN;
  const conn = await connections.get('hubspot');
  if (!conn) throw new Error('HubSpot not connected. Start OAuth at /auth/hubspot/start');
  if (conn.accessToken && conn.accessToken !== rejectedToken && (conn.expiresAt ?? 0) > Date.now() + 60_000) {
    return conn.accessToken;
  }
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken({ ...conn, accessToken: undefined, expiresAt: undefined }).finally(() => {
      refreshInFlight = undefined;
    });
  }
  return refreshInFlight;
}

async function refreshAccessToken(conn: Connection): Promise<string> {
  const credentials = await creds();
  let data: {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
  try {
    const response = await axios.post(
      TOKEN,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: conn.refreshToken,
      }),
    );
    data = response.data;
  } catch (error) {
    throw reconnectRequired('hubspot', error) ?? error;
  }
  await connections.set({
    ...conn,
    refreshToken: data.refresh_token ?? conn.refreshToken,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  logger.debug(
    { refreshTokenRotated: Boolean(data.refresh_token) },
    'Refreshed HubSpot access token',
  );
  return data.access_token;
}

/** Look up the portal's domain for a friendly UI label. */
async function hubInfo(accessToken: string): Promise<{ label?: string; id?: string }> {
  try {
    const { data } = await axios.get(`https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}`);
    return {
      label: data.hub_domain ?? (data.hub_id ? `Hub ${data.hub_id}` : undefined),
      id: data.hub_id !== undefined ? String(data.hub_id) : undefined,
    };
  } catch {
    return {};
  }
}
