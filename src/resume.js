import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SAFE_SESSION_ID = /^[\w-]+$/;
const shellScript = (script) => ['sh', '-c', script];
const MAC_APP_FOLDERS = ['/Applications', '/Applications/Utilities', '/System/Applications/Utilities', join(homedir(), 'Applications')];

// The terminals Resume can open, per platform. Apps on macOS are found by their .app bundle, the rest on the PATH.
// `args` turns the shell script that resumes the session into the terminal's own "run this" arguments.
export const TERMINALS = {
  darwin: {
    terminal: { label: 'Terminal', app: 'Terminal' },
    iterm: { label: 'iTerm2', app: 'iTerm' },
    ghostty: { label: 'Ghostty', app: 'Ghostty', args: (script) => ['-e', ...shellScript(script)] },
    wezterm: { label: 'WezTerm', app: 'WezTerm', args: (script) => ['start', '--', ...shellScript(script)] },
    kitty: { label: 'kitty', app: 'kitty', args: (script) => shellScript(script) },
    alacritty: { label: 'Alacritty', app: 'Alacritty', args: (script) => ['-e', ...shellScript(script)] },
  },
  linux: {
    default: { label: 'System default', bin: 'x-terminal-emulator', args: (script) => ['-e', ...shellScript(script)] },
    'gnome-terminal': { label: 'GNOME Terminal', bin: 'gnome-terminal', args: (script) => ['--', ...shellScript(script)] },
    konsole: { label: 'Konsole', bin: 'konsole', args: (script) => ['-e', ...shellScript(script)] },
    ghostty: { label: 'Ghostty', bin: 'ghostty', args: (script) => ['-e', ...shellScript(script)] },
    wezterm: { label: 'WezTerm', bin: 'wezterm', args: (script) => ['start', '--', ...shellScript(script)] },
    kitty: { label: 'kitty', bin: 'kitty', args: (script) => shellScript(script) },
    alacritty: { label: 'Alacritty', bin: 'alacritty', args: (script) => ['-e', ...shellScript(script)] },
  },
  win32: {
    cmd: { label: 'Command Prompt', bin: 'cmd.exe' },
    wt: { label: 'Windows Terminal', bin: 'wt.exe' },
  },
};

const terminalsFor = (platform) => TERMINALS[platform] ?? TERMINALS.linux;
export const defaultTerminal = (platform) => Object.keys(terminalsFor(platform))[0];
export const isTerminal = (platform, id) => typeof id === 'string' && Object.hasOwn(terminalsFor(platform), id);

export function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// Every terminal for this platform, with whether it's installed. The platform default always counts as installed.
export function listTerminals({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const fallback = defaultTerminal(platform);
  const onPath = (bin) => String(env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean).some((dir) => exists(join(dir, bin)));

  return Object.entries(terminalsFor(platform)).map(([id, terminal]) => ({
    id,
    label: terminal.label,
    installed: id === fallback || (terminal.app ? MAC_APP_FOLDERS.some((dir) => exists(join(dir, `${terminal.app}.app`))) : onPath(terminal.bin)),
  }));
}

export function terminalCommand({ platform, terminal, cwd, sessionId }) {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error('Invalid session id');
  }
  const id = isTerminal(platform, terminal) ? terminal : defaultTerminal(platform);
  const command = `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
  // Keep the window open on the user's shell after Claude exits.
  const script = `${command}; exec "\${SHELL:-sh}"`;
  const appleScriptString = `"${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  if (platform === 'darwin') {
    if (id === 'iterm') {
      return ['osascript', [
        '-e', 'tell application "iTerm"',
        '-e', 'activate',
        '-e', 'set newWindow to (create window with default profile)',
        '-e', `tell current session of newWindow to write text ${appleScriptString}`,
        '-e', 'end tell',
      ]];
    }
    if (id === 'terminal') {
      return ['osascript', [
        '-e', `tell application "Terminal" to do script ${appleScriptString}`,
        '-e', 'tell application "Terminal" to activate',
      ]];
    }
    const app = TERMINALS.darwin[id];
    return ['open', ['-na', app.app, '--args', ...app.args(script)]];
  }
  if (platform === 'win32') {
    return id === 'wt'
      ? ['wt', ['-d', cwd, 'cmd', '/k', `claude --resume ${sessionId}`]]
      : ['cmd', ['/c', 'start', '', 'cmd', '/k', `cd /d "${cwd}" && claude --resume ${sessionId}`]];
  }
  const linux = TERMINALS.linux[id];

  return [linux.bin, linux.args(script)];
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
