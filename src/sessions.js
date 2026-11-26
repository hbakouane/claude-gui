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
  let isWorktree = false;
  let lastTimestamp = 0;
  const prs = new Map();

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
    if (event.type === 'pr-link' && event.prUrl) {
      prs.set(event.prUrl, { url: event.prUrl, number: event.prNumber ?? null, repository: event.prRepository ?? null });
    }
    if (event.attachment?.type === 'environment') {
      isWorktree = event.attachment.snapshot?.isWorktree === true;
    }
  }

  const session = {
    id: basename(file, '.jsonl'),
    title: title ?? 'Untitled session',
    cwd,
    gitBranch,
    isWorktree,
    prs: [...prs.values()],
    lastActivity: new Date(lastTimestamp || info.mtimeMs).toISOString(),
  };

  return session;
}
