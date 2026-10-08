import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanStalePidFile, processNameAt } from '../src/db/localLock.js';

/**
 * Exercises against a scratch directory under the OS temp dir -- never data/postgres/, the
 * real local cluster's data directory, which the project's safety rules forbid touching.
 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sync-pidfile-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('processNameAt', () => {
  it('returns undefined for a PID nothing is running at', () => {
    expect(processNameAt(999_999)).toBeUndefined();
  });

  it('names the process actually running at this process\'s own PID', () => {
    const name = processNameAt(process.pid);
    expect(name).toBeTruthy();
    expect(name).not.toMatch(/postgres/i);
  });
});

describe('cleanStalePidFile', () => {
  it('does nothing when there is no lock file', () => {
    expect(() => cleanStalePidFile(dir)).not.toThrow();
  });

  it('removes a lock file left by a PID that no longer exists', () => {
    fs.writeFileSync(path.join(dir, 'postmaster.pid'), '999999\n/some/data/dir\n');
    cleanStalePidFile(dir);
    expect(fs.existsSync(path.join(dir, 'postmaster.pid'))).toBe(false);
  });

  it('removes a lock file whose PID is alive but belongs to a non-PostgreSQL process', () => {
    // This test process itself is alive at process.pid, and is not named postgres --
    // simulating a PID that PostgreSQL once held and the OS has since reused.
    fs.writeFileSync(path.join(dir, 'postmaster.pid'), `${process.pid}\n/some/data/dir\n`);
    cleanStalePidFile(dir);
    expect(fs.existsSync(path.join(dir, 'postmaster.pid'))).toBe(false);
  });

  it('removes a corrupted lock file whose first line is not a number', () => {
    fs.writeFileSync(path.join(dir, 'postmaster.pid'), 'not-a-pid\n');
    cleanStalePidFile(dir);
    expect(fs.existsSync(path.join(dir, 'postmaster.pid'))).toBe(false);
  });
});
