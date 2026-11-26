import { homedir } from 'node:os';
import { join } from 'node:path';

export function projectsRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}
