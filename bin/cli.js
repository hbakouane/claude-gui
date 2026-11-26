#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createServer } from '../src/server.js';
import { projectsRoot } from '../src/sessions.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4321' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log('Usage: claude-sessions-dashboard [--port 4321] [--no-open]');
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid --port: ${values.port}`);
  process.exit(1);
}

const root = projectsRoot();
const server = createServer({ root });

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port <another port>.` : error.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`Claude sessions dashboard: ${url}`);
  console.log(`Reading ${root}`);
  if (!values['no-open']) {
    openBrowser(url);
  }
});

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('Open the URL above in your browser.'));
  child.unref();
}
