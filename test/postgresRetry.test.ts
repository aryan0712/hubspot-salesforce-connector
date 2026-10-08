import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { connectWithRetry } from '../src/db/postgres.js';

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

describe('connectWithRetry', () => {
  it('returns the client immediately when the first connect succeeds', async () => {
    const client = {} as PoolClient;
    const connect = vi.fn().mockResolvedValue(client);
    const result = await connectWithRetry(fakePool(connect), { attempts: 5, delayMs: 1 });
    expect(result).toBe(client);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('retries while PostgreSQL reports it is still starting up (57P03), then succeeds', async () => {
    const client = {} as PoolClient;
    const startingUp = Object.assign(new Error('the database system is starting up'), { code: '57P03' });
    const connect = vi.fn().mockRejectedValueOnce(startingUp).mockRejectedValueOnce(startingUp).mockResolvedValue(client);
    const result = await connectWithRetry(fakePool(connect), { attempts: 5, delayMs: 1 });
    expect(result).toBe(client);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('retries on ECONNREFUSED and on an unexpectedly terminated connection', async () => {
    const client = {} as PoolClient;
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const terminated = new Error('Connection terminated unexpectedly');
    const connect = vi.fn().mockRejectedValueOnce(refused).mockRejectedValueOnce(terminated).mockResolvedValue(client);
    const result = await connectWithRetry(fakePool(connect), { attempts: 5, delayMs: 1 });
    expect(result).toBe(client);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('gives up once the attempt budget is exhausted while the database stays unreachable', async () => {
    const startingUp = Object.assign(new Error('the database system is starting up'), { code: '57P03' });
    const connect = vi.fn().mockRejectedValue(startingUp);
    await expect(connectWithRetry(fakePool(connect), { attempts: 3, delayMs: 1 })).rejects.toBe(startingUp);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on a permanent error such as bad credentials, without retrying', async () => {
    const authFailed = Object.assign(new Error('password authentication failed for user "crm_sync"'), { code: '28P01' });
    const connect = vi.fn().mockRejectedValue(authFailed);
    await expect(connectWithRetry(fakePool(connect), { attempts: 5, delayMs: 1 })).rejects.toBe(authFailed);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('fails immediately when the named database does not exist', async () => {
    const unknownDb = Object.assign(new Error('database "crm_sync" does not exist'), { code: '3D000' });
    const connect = vi.fn().mockRejectedValue(unknownDb);
    await expect(connectWithRetry(fakePool(connect), { attempts: 5, delayMs: 1 })).rejects.toBe(unknownDb);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
