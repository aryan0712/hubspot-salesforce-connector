import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection(port, '127.0.0.1');
    s.setTimeout(500);
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
    s.on('error', () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function main() {
  if (await isPortOpen(5432)) {
    console.log('PostgreSQL is already active on port 5432.');
    process.exit(0);
  }

  console.log('Starting project-local PostgreSQL database...');
  const child = spawn(
    process.execPath,
    [path.join(rootDir, 'node_modules/tsx/dist/cli.mjs'), path.join(rootDir, 'src/db/local.ts')],
    {
      cwd: rootDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();

  console.log('Waiting for PostgreSQL to become ready...');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await isPortOpen(5432)) {
      console.log('PostgreSQL is ready!');
      process.exit(0);
    }
  }

  console.error('[Error] PostgreSQL failed to start on port 5432.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

