import http from 'node:http';
import { exec } from 'node:child_process';

const url = 'http://localhost:3000/';
const healthUrl = 'http://localhost:3000/health';
let attempts = 0;
const maxAttempts = 60;

function poll() {
  const req = http.get(healthUrl, (res) => {
    if (res.statusCode === 200) {
      exec(`start ${url}`);
      process.exit(0);
    } else {
      retry();
    }
  });
  req.on('error', () => {
    retry();
  });
  req.setTimeout(1000, () => {
    req.destroy();
    retry();
  });
}

function retry() {
  attempts++;
  if (attempts >= maxAttempts) {
    process.exit(1);
  }
  setTimeout(poll, 400);
}

poll();

