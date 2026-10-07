import net from 'node:net';

const port = 5432;
const once = process.argv.includes('--once');
const maxAttempts = once ? 1 : 40;
let attempts = 0;

function check() {
  const socket = net.createConnection(port, '127.0.0.1');
  socket.setTimeout(800);
  socket.on('connect', () => {
    socket.destroy();
    process.exit(0);
  });
  socket.on('timeout', () => {
    socket.destroy();
    onFail();
  });
  socket.on('error', () => {
    socket.destroy();
    onFail();
  });
}

function onFail() {
  attempts++;
  if (attempts >= maxAttempts) {
    process.exit(1);
  }
  setTimeout(check, 350);
}

check();

