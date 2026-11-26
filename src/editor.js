import { spawn } from 'node:child_process';

export const DEFAULT_EDITOR = 'vscode';

export const EDITORS = {
  vscode: { label: 'VS Code', app: 'Visual Studio Code', cli: 'code' },
  cursor: { label: 'Cursor', app: 'Cursor', cli: 'cursor' },
  zed: { label: 'Zed', app: 'Zed', cli: 'zed' },
  windsurf: { label: 'Windsurf', app: 'Windsurf', cli: 'windsurf' },
  sublime: { label: 'Sublime Text', app: 'Sublime Text', cli: 'subl' },
  phpstorm: { label: 'PhpStorm', app: 'PhpStorm', cli: 'phpstorm' },
  webstorm: { label: 'WebStorm', app: 'WebStorm', cli: 'webstorm' },
  idea: { label: 'IntelliJ IDEA', app: 'IntelliJ IDEA', cli: 'idea' },
};

export function editorCommand({ platform, editor, dir }) {
  const config = EDITORS[editor];
  if (!config) {
    throw new Error(`Unknown editor: ${editor}`);
  }
  if (platform === 'darwin') {
    return ['open', ['-a', config.app, dir]];
  }
  if (platform === 'win32') {
    return ['cmd', ['/c', config.cli, dir]];
  }

  return [config.cli, [dir]];
}

// `open -a` exits non-zero when the app isn't installed, so wait for it; editor CLIs keep running, so only wait for them to start.
export function openEditor(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    if (command !== 'open') {
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      return;
    }
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `open exited with code ${code}`))));
  });
}
