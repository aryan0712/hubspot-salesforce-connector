import crypto from 'node:crypto';
import type { Role } from '../db/operationsRepository.js';
import { hashPassword, verifyPassword } from './passwords.js';

/**
 * R11 identity and sessions.
 *
 * Sessions are server-side, short-lived (idle and absolute expiry) and revocable; the
 * browser holds only an unguessable token (HttpOnly cookie) whose SHA-256 is stored. Every
 * request re-reads the membership, so removing a member or changing a role takes effect
 * immediately. Unsafe requests carry a per-session CSRF token.
 *
 * The identity provider is pluggable: `LocalPasswordProvider` (scrypt) works without any
 * external service; an external provider (OIDC/SAML -- an open product decision) supplies
 * a verified user id and then uses the same sessions.
 */

export interface UserRecord {
  id: string;
  email: string;
  passwordHash?: string;
  disabledAt?: string;
}

export interface Membership {
  tenantId: string;
  userId: string;
  email: string;
  role: Role;
}

export interface LoginFailureCounts {
  /** This email from this IP. */
  byEmailAndIp: number;
  /** This email from any IP (slows distributed guessing against one account). */
  byEmail: number;
  /** Any email from this IP. */
  byIp: number;
}

export interface SessionRow {
  tokenHash: string;
  userId: string;
  tenantId: string;
  csrfHash: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  expiresAt: string;
  revokedAt?: string;
  ip?: string;
  userAgent?: string;
}

export interface IdentityStore {
  userByEmail(email: string): Promise<UserRecord | undefined>;
  userById(id: string): Promise<UserRecord | undefined>;
  createUser(email: string, passwordHash?: string): Promise<UserRecord>;
  setPassword(userId: string, passwordHash: string): Promise<void>;
  /** Every workspace this user belongs to (sign-in only). */
  membershipsOf(userId: string): Promise<Membership[]>;
  membership(tenantId: string, userId: string): Promise<Membership | undefined>;
  listMembers(tenantId: string): Promise<Membership[]>;
  setMembership(membership: Membership): Promise<void>;
  removeMembership(tenantId: string, userId: string): Promise<boolean>;
  createSession(row: SessionRow): Promise<void>;
  session(tokenHash: string): Promise<SessionRow | undefined>;
  touchSession(tokenHash: string, lastSeenAt: string, idleExpiresAt: string): Promise<void>;
  revokeSession(tokenHash: string): Promise<void>;
  /** Revokes a user's sessions (in one workspace, or everywhere). */
  revokeUserSessions(userId: string, tenantId?: string): Promise<number>;
  recordLoginAttempt(email: string, ip: string, succeeded: boolean): Promise<void>;
  recentFailures(email: string, ip: string, since: string): Promise<LoginFailureCounts>;
}

/** Verifies credentials and returns the user id, or undefined. */
export interface IdentityProvider {
  readonly id: string;
  authenticate(email: string, password: string): Promise<string | undefined>;
}

const DUMMY_HASH_PROMISE = hashPassword(crypto.randomBytes(16).toString('hex'));

export class LocalPasswordProvider implements IdentityProvider {
  readonly id = 'local-password';

  constructor(private readonly store: IdentityStore) {}

  async authenticate(email: string, password: string): Promise<string | undefined> {
    const user = await this.store.userByEmail(email);
    // Verify against a dummy hash for unknown users so timing does not reveal accounts.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH_PROMISE));
    if (!user || !user.passwordHash || user.disabledAt || !ok) return undefined;
    return user.id;
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class LoginThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('too many failed sign-in attempts; try again later');
    this.name = 'LoginThrottledError';
  }
}

export class NoMembershipError extends Error {
  constructor() {
    super('this account does not belong to the requested workspace');
    this.name = 'NoMembershipError';
  }
}

export interface SessionAuth {
  sessionHash: string;
  userId: string;
  email: string;
  tenantId: string;
  role: Role;
  csrfHash: string;
}

export interface IssuedSession {
  token: string;
  csrfToken: string;
  auth: SessionAuth;
}

export interface SessionServiceOptions {
  idleMs?: number;
  absoluteMs?: number;
  /** Failed attempts allowed per email from one IP within the window. */
  maxFailuresPerEmailAndIp?: number;
  /** Failed attempts allowed per email from any IP within the window. */
  maxFailuresPerEmail?: number;
  /** Failed attempts allowed per IP (any email) within the window. */
  maxFailuresPerIp?: number;
  windowMs?: number;
  now?: () => number;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class SessionService {
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly maxEmailIp: number;
  private readonly maxEmail: number;
  private readonly maxIp: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    readonly store: IdentityStore,
    private readonly provider: IdentityProvider,
    opts: SessionServiceOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.absoluteMs = opts.absoluteMs ?? 12 * 60 * 60_000;
    this.maxEmailIp = opts.maxFailuresPerEmailAndIp ?? 5;
    this.maxEmail = opts.maxFailuresPerEmail ?? 20;
    this.maxIp = opts.maxFailuresPerIp ?? 50;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  get idleSeconds(): number {
    return Math.floor(this.idleMs / 1000);
  }

  async login(input: {
    email: string;
    password: string;
    ip: string;
    userAgent?: string;
    tenantId?: string;
  }): Promise<IssuedSession> {
    const email = normalizeEmail(input.email);
    const since = new Date(this.now() - this.windowMs).toISOString();
    const failures = await this.store.recentFailures(email, input.ip, since);
    if (
      failures.byEmailAndIp >= this.maxEmailIp ||
      failures.byEmail >= this.maxEmail ||
      failures.byIp >= this.maxIp
    ) {
      throw new LoginThrottledError(Math.ceil(this.windowMs / 1000));
    }
    const userId = await this.provider.authenticate(email, input.password);
    await this.store.recordLoginAttempt(email, input.ip, Boolean(userId));
    if (!userId) throw new InvalidCredentialsError();
    return this.issue(userId, input.tenantId, input.ip, input.userAgent);
  }

  /** Starts a session for a user an external identity provider has already verified. */
  async issue(userId: string, tenantId: string | undefined, ip?: string, userAgent?: string): Promise<IssuedSession> {
    const user = await this.store.userById(userId);
    if (!user || user.disabledAt) throw new InvalidCredentialsError();
    const memberships = await this.store.membershipsOf(userId);
    const membership = tenantId
      ? memberships.find((candidate) => candidate.tenantId === tenantId)
      : memberships[0];
    if (!membership) throw new NoMembershipError();
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const now = this.now();
    const row: SessionRow = {
      tokenHash: sha256(token),
      userId,
      tenantId: membership.tenantId,
      csrfHash: sha256(csrfToken),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      idleExpiresAt: new Date(now + this.idleMs).toISOString(),
      expiresAt: new Date(now + this.absoluteMs).toISOString(),
      ip,
      userAgent: userAgent?.slice(0, 300),
    };
    await this.store.createSession(row);
    return {
      token,
      csrfToken,
      auth: {
        sessionHash: row.tokenHash,
        userId,
        email: user.email,
        tenantId: membership.tenantId,
        role: membership.role,
        csrfHash: row.csrfHash,
      },
    };
  }

  /** The session behind a token, with the member's CURRENT role; undefined if not valid. */
  async resolve(token: string): Promise<SessionAuth | undefined> {
    if (!token) return undefined;
    const hash = sha256(token);
    const row = await this.store.session(hash);
    const now = this.now();
    if (
      !row ||
      row.revokedAt ||
      Date.parse(row.expiresAt) <= now ||
      Date.parse(row.idleExpiresAt) <= now
    ) {
      return undefined;
    }
    const [user, membership] = await Promise.all([
      this.store.userById(row.userId),
      this.store.membership(row.tenantId, row.userId),
    ]);
    if (!user || user.disabledAt || !membership) return undefined;
    // Sliding idle expiry, written at most once a minute per session.
    if (now - Date.parse(row.lastSeenAt) > 60_000) {
      await this.store.touchSession(hash, new Date(now).toISOString(), new Date(now + this.idleMs).toISOString());
    }
    return {
      sessionHash: hash,
      userId: row.userId,
      email: user.email,
      tenantId: row.tenantId,
      role: membership.role,
      csrfHash: row.csrfHash,
    };
  }

  verifyCsrf(auth: SessionAuth, header: string | undefined): boolean {
    if (!header) return false;
    const expected = Buffer.from(auth.csrfHash, 'hex');
    const actual = Buffer.from(sha256(header), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  async logout(token: string): Promise<void> {
    if (token) await this.store.revokeSession(sha256(token));
  }

  /** Moves to another workspace the user belongs to; the old session is revoked (rotation). */
  async switchTenant(token: string, tenantId: string): Promise<IssuedSession> {
    const current = await this.resolve(token);
    if (!current) throw new InvalidCredentialsError();
    const next = await this.issue(current.userId, tenantId);
    await this.store.revokeSession(current.sessionHash);
    return next;
  }

  async workspaces(userId: string): Promise<Membership[]> {
    return this.store.membershipsOf(userId);
  }

  /** Creates (or updates) a local user and adds them to a workspace. */
  async addMember(input: { tenantId: string; email: string; role: Role; password?: string }): Promise<Membership> {
    const email = normalizeEmail(input.email);
    let user = await this.store.userByEmail(email);
    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    if (!user) user = await this.store.createUser(email, passwordHash);
    else if (passwordHash && !user.passwordHash) await this.store.setPassword(user.id, passwordHash);
    const membership: Membership = { tenantId: input.tenantId, userId: user.id, email, role: input.role };
    await this.store.setMembership(membership);
    return membership;
  }

  /** Removes a member and revokes their sessions in that workspace immediately. */
  async removeMember(tenantId: string, userId: string): Promise<boolean> {
    const removed = await this.store.removeMembership(tenantId, userId);
    await this.store.revokeUserSessions(userId, tenantId);
    return removed;
  }
}

export class InMemoryIdentityStore implements IdentityStore {
  private users = new Map<string, UserRecord>();
  private members = new Map<string, Membership>();
  private sessions = new Map<string, SessionRow>();
  private attempts: { email: string; ip: string; succeeded: boolean; at: string }[] = [];

  async userByEmail(email: string): Promise<UserRecord | undefined> {
    const normalized = normalizeEmail(email);
    const user = [...this.users.values()].find((candidate) => candidate.email === normalized);
    return user ? { ...user } : undefined;
  }

  async userById(id: string): Promise<UserRecord | undefined> {
    const user = this.users.get(id);
    return user ? { ...user } : undefined;
  }

  async createUser(email: string, passwordHash?: string): Promise<UserRecord> {
    const user = { id: crypto.randomUUID(), email: normalizeEmail(email), passwordHash };
    this.users.set(user.id, user);
    return { ...user };
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.passwordHash = passwordHash;
  }

  /** Test helper. */
  disable(userId: string): void {
    const user = this.users.get(userId);
    if (user) user.disabledAt = new Date().toISOString();
  }

  async membershipsOf(userId: string): Promise<Membership[]> {
    return [...this.members.values()].filter((item) => item.userId === userId).map((item) => ({ ...item }));
  }

  async membership(tenantId: string, userId: string): Promise<Membership | undefined> {
    const item = this.members.get(`${tenantId}:${userId}`);
    return item ? { ...item } : undefined;
  }

  async listMembers(tenantId: string): Promise<Membership[]> {
    return [...this.members.values()].filter((item) => item.tenantId === tenantId).map((item) => ({ ...item }));
  }

  async setMembership(membership: Membership): Promise<void> {
    this.members.set(`${membership.tenantId}:${membership.userId}`, { ...membership });
  }

  async removeMembership(tenantId: string, userId: string): Promise<boolean> {
    return this.members.delete(`${tenantId}:${userId}`);
  }

  async createSession(row: SessionRow): Promise<void> {
    this.sessions.set(row.tokenHash, { ...row });
  }

  async session(tokenHash: string): Promise<SessionRow | undefined> {
    const row = this.sessions.get(tokenHash);
    return row ? { ...row } : undefined;
  }

  async touchSession(tokenHash: string, lastSeenAt: string, idleExpiresAt: string): Promise<void> {
    const row = this.sessions.get(tokenHash);
    if (row && !row.revokedAt) Object.assign(row, { lastSeenAt, idleExpiresAt });
  }

  async revokeSession(tokenHash: string): Promise<void> {
    const row = this.sessions.get(tokenHash);
    if (row && !row.revokedAt) row.revokedAt = new Date().toISOString();
  }

  async revokeUserSessions(userId: string, tenantId?: string): Promise<number> {
    let count = 0;
    for (const row of this.sessions.values()) {
      if (row.userId !== userId || row.revokedAt || (tenantId && row.tenantId !== tenantId)) continue;
      row.revokedAt = new Date().toISOString();
      count += 1;
    }
    return count;
  }

  async recordLoginAttempt(email: string, ip: string, succeeded: boolean): Promise<void> {
    this.attempts.push({ email: normalizeEmail(email), ip, succeeded, at: new Date().toISOString() });
  }

  async recentFailures(email: string, ip: string, since: string): Promise<LoginFailureCounts> {
    const recent = this.attempts.filter((item) => !item.succeeded && item.at >= since);
    const byEmail = recent.filter((item) => item.email === normalizeEmail(email));
    return {
      byEmailAndIp: byEmail.filter((item) => item.ip === ip).length,
      byEmail: byEmail.length,
      byIp: recent.filter((item) => item.ip === ip).length,
    };
  }
}
