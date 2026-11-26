import { spawn } from 'node:child_process';

const SAFE_SESSION_ID = /^[\w-]+$/;

export function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function terminalCommand({ platform, terminal, cwd, sessionId }) {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error('Invalid session id');
  }
  const command = `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
  const appleScriptString = `"${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  if (platform === 'darwin' && terminal === 'iterm') {
    return ['osascript', [
      '-e', 'tell application "iTerm"',
      '-e', 'activate',
      '-e', 'set newWindow to (create window with default profile)',
      '-e', `tell current session of newWindow to write text ${appleScriptString}`,
      '-e', 'end tell',
    ]];
  }
  if (platform === 'darwin') {
    return ['osascript', [
      '-e', `tell application "Terminal" to do script ${appleScriptString}`,
      '-e', 'tell application "Terminal" to activate',
    ]];
  }
  if (platform === 'win32') {
    return ['cmd', ['/c', 'start', '', 'cmd', '/k', `cd /d "${cwd}" && claude --resume ${sessionId}`]];
  }

  return ['x-terminal-emulator', ['-e', 'sh', '-c', `${command}; exec "\${SHELL:-sh}"`]];
}

export function launch(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
