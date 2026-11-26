import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export function projectsRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

export async function parseSession(file) {
  const info = await stat(file);

  let title = null;
  let cwd = null;
  let gitBranch = null;
  let lastTimestamp = 0;

  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = Date.parse(event.timestamp);
    if (timestamp > lastTimestamp) {
      lastTimestamp = timestamp;
    }
    if (event.cwd) {
      cwd = event.cwd;
    }
    if (event.gitBranch) {
      gitBranch = event.gitBranch;
    }
    if (event.type === 'ai-title' && event.aiTitle) {
      title = event.aiTitle;
    }
  }

  const session = {
    id: basename(file, '.jsonl'),
    title: title ?? 'Untitled session',
    cwd,
    gitBranch,
    lastActivity: new Date(lastTimestamp || info.mtimeMs).toISOString(),
  };

  return session;
}
