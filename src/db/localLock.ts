import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from '../logger.js';

/**
 * The OS process name at `pid`, if one is running -- undefined if nothing is there, or if
 * the name can't be determined. Used so a stale lock file isn't trusted just because *some*
 * process now holds that PID: PIDs are reused quickly on Windows, so a live but unrelated
 * process could otherwise block the local cluster from ever starting again.
 */
export function processNameAt(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const firstLine = output.split('\n')[0]?.trim() ?? '';
      if (!firstLine || firstLine.startsWith('INFO:')) return undefined; // "No tasks are running..."
      return firstLine.split('","')[0]?.replace(/^"/, '') || undefined;
    }
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Removes `dir`'s postmaster.pid when it no longer names a live PostgreSQL process. */
export function cleanStalePidFile(dir: string): void {
  const pidFile = path.join(dir, 'postmaster.pid');
  if (!fs.existsSync(pidFile)) return;

  try {
    const content = fs.readFileSync(pidFile, 'utf8');
    const firstLine = content.split('\n')[0]?.trim();
    const pid = firstLine ? parseInt(firstLine, 10) : NaN;

    if (!isNaN(pid)) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive && /postgres/i.test(processNameAt(pid) ?? '')) return;
      logger.warn(
        { pid },
        alive
          ? 'removing stale postmaster.pid: PID now belongs to an unrelated process'
          : 'removing stale postmaster.pid from a previously terminated PostgreSQL process',
      );
      fs.unlinkSync(pidFile);
    } else {
      logger.warn('removing corrupted postmaster.pid');
      fs.unlinkSync(pidFile);
    }
  } catch (err) {
    logger.warn({ err }, 'failed to inspect postmaster.pid');
  }
}
