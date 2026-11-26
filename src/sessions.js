import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const TEMP_PATH = /^\/(private\/)?(var\/folders|tmp)\//;
const MCP_TOOL = /^mcp__(.+?)__/;
const TITLE_LENGTH = 80;
const PARALLEL_FILES = 8;

const cache = new Map();

export function projectsRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

export async function listProjects(root) {
  const projects = await Promise.all((await projectDirs(root)).map(async (id) => {
    const files = await sessionFiles(join(root, id));
    if (files.length === 0) {
      return null;
    }
    const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    return {
      id,
      path: (await firstCwd(files)) ?? id,
      sessionCount: files.length,
      lastActivity: new Date(newest.mtimeMs).toISOString(),
    };
  }));

  return projects
    .filter((project) => project && !TEMP_PATH.test(project.path))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

export async function listSessions(root, id) {
  if (!(await projectDirs(root)).includes(id)) {
    return null;
  }
  const files = await sessionFiles(join(root, id));
  const sessions = [];
  for (let i = 0; i < files.length; i += PARALLEL_FILES) {
    const batch = await Promise.allSettled(files.slice(i, i + PARALLEL_FILES).map((file) => parseSession(file.path)));
    sessions.push(...batch.filter((result) => result.status === 'fulfilled').map((result) => result.value));
  }

  return sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

export async function parseSession(file) {
  const info = await stat(file);
  const cached = cache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return cached.session;
  }

  let title = null;
  let firstPrompt = null;
  let cwd = null;
  let gitBranch = null;
  let isWorktree = false;
  let lastTimestamp = 0;
  const prs = new Map();
  const mcps = new Set();

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
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        const match = block?.type === 'tool_use' && MCP_TOOL.exec(block.name);
        if (match) {
          mcps.add(match[1]);
        }
      }
    }
    if (firstPrompt === null && event.type === 'user' && !event.isMeta && !event.isSidechain) {
      firstPrompt = promptText(event.message?.content);
    }
  }

  const session = {
    id: basename(file, '.jsonl'),
    title: title ?? truncate(firstPrompt) ?? 'Untitled session',
    cwd,
    gitBranch,
    isWorktree,
    prs: [...prs.values()],
    mcps: [...mcps].sort((a, b) => a.localeCompare(b)),
    lastActivity: new Date(lastTimestamp || info.mtimeMs).toISOString(),
  };
  cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, session });

  return session;
}

async function projectDirs(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function sessionFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(async (entry) => {
      const path = join(dir, entry.name);
      const info = await stat(path).catch(() => null);
      return info && { path, mtimeMs: info.mtimeMs };
    }));

  return files.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function firstCwd(files) {
  for (const file of files) {
    try {
      for await (const line of createInterface({ input: createReadStream(file.path), crlfDelay: Infinity })) {
        const cwd = line.includes('"cwd"') && safeParse(line)?.cwd;
        if (cwd) {
          return cwd;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

function promptText(content) {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.find((block) => block?.type === 'text')?.text : null;
  const trimmed = text?.trim();

  return trimmed && !trimmed.startsWith('<') ? trimmed : null;
}

function truncate(text) {
  if (!text) {
    return null;
  }
  const oneLine = text.replace(/\s+/g, ' ');

  return oneLine.length > TITLE_LENGTH ? `${oneLine.slice(0, TITLE_LENGTH - 1)}…` : oneLine;
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
