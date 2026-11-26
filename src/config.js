import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { projectsRoot } from './sessions.js';

export const DEFAULT_PORT = 4321;
export const MIN_PORT = 1024;

export function configPath(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'claude-gui', 'config.json');
}

export async function readConfig(file) {
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

export async function writeConfig(file, config) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function expandHome(path) {
  return String(path).trim().replace(/^~(?=$|[/\\])/, homedir());
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= MIN_PORT && port <= 65535;
}

export function startupOptions({ flags = {}, config = {} } = {}) {
  return {
    port: flags.port !== undefined ? Number(flags.port) : isValidPort(config.port) ? config.port : DEFAULT_PORT,
    openBrowser: flags['no-open'] ? false : config.openBrowser !== false,
  };
}

export function resolveClaudeDir({ flag, saved, env = process.env } = {}) {
  if (flag) {
    return { claudeDir: resolve(expandHome(flag)), source: 'flag' };
  }
  if (typeof saved === 'string' && isAbsolute(saved)) {
    return { claudeDir: saved, source: 'settings' };
  }

  return { claudeDir: dirname(projectsRoot(env)), source: env.CLAUDE_CONFIG_DIR ? 'env' : 'default' };
}
