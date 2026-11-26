#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { archivePath } from '../src/archive.js';
import { configPath, readConfig, resolveClaudeDir, startupOptions } from '../src/config.js';
import { isTerminal, TERMINALS } from '../src/resume.js';
import { createServer } from '../src/server.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    terminal: { type: 'string' },
    'claude-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: claude-gui [--port 4321] [--no-open] [--terminal ${Object.keys(TERMINALS[process.platform] ?? TERMINALS.linux).join('|')}] [--claude-dir ~/.claude]`);
  process.exit(0);
}

const configFile = configPath();
const config = await readConfig(configFile);
const { port, openBrowser: shouldOpen } = startupOptions({ flags: values, config });
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid --port: ${values.port}`);
  process.exit(1);
}

if (values.terminal !== undefined && !isTerminal(process.platform, values.terminal)) {
  console.error(`Invalid --terminal: ${values.terminal}. Use one of: ${Object.keys(TERMINALS[process.platform] ?? TERMINALS.linux).join(', ')}.`);
  process.exit(1);
}

const { claudeDir, source } = resolveClaudeDir({ flag: values['claude-dir'], saved: config.claudeDir });
const archiveDir = archivePath();
const archive = config.archive !== false;
const server = createServer({ claudeDir, source, configFile, editor: config.editor, terminal: values.terminal ?? config.terminal, archiveDir, archive, archiveDays: config.archiveDays, notifications: config.notifications !== false });

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port <another port>.` : error.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`claude-gui is running at ${url}`);
  console.log(`Reading ${join(claudeDir, 'projects')}`);
  if (archive) {
    console.log(`Keeping a copy of every session in ${archiveDir} (turn this off in Settings)`);
  }
  if (shouldOpen) {
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
