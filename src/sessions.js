import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const TEMP_PATH = /^\/(private\/)?(var\/folders|tmp)\//;
const MCP_TOOL = /^mcp__(.+?)__/;
const TASK_SLUG = /^[a-z0-9]+(-[a-z0-9]+)+$/;
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
    const path = await firstCwd(files);
    if (!path) {
      return null;
    }
    return {
      id,
      path,
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
  let slugTitle = null;
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
      if (!TASK_SLUG.test(event.aiTitle)) {
        title = event.aiTitle;
      } else {
        slugTitle ??= event.aiTitle;
      }
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
    title: title ?? slugTitle ?? truncate(firstPrompt) ?? 'Untitled session',
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

const TOOL_INPUT_LIMIT = 4000;
const TOOL_RESULT_LIMIT = 6000;
const SUMMARY_LENGTH = 160;
const conversationCache = new Map();

export async function readConversation(root, projectId, sessionId) {
  if (!(await projectDirs(root)).includes(projectId)) {
    return null;
  }
  const dir = join(root, projectId);
  const names = await readdir(dir).catch(() => []);
  if (!names.includes(`${sessionId}.jsonl`)) {
    return null;
  }

  return parseConversation(join(dir, `${sessionId}.jsonl`));
}

export async function parseConversation(file) {
  const info = await stat(file);
  const cached = conversationCache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return cached.items;
  }

  const items = [];
  const tools = new Map();

  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.isSidechain || event.isMeta) {
      continue;
    }
    const at = event.timestamp ?? null;

    if (event.type === 'assistant') {
      for (const block of blocks(event.message?.content)) {
        if (block.type === 'text' && block.text?.trim()) {
          items.push({ kind: 'assistant', text: block.text, at });
        } else if (block.type === 'tool_use') {
          const tool = { kind: 'tool', id: block.id, name: block.name, summary: toolSummary(block.input), input: clip(JSON.stringify(block.input ?? {}, null, 2), TOOL_INPUT_LIMIT), result: null, isError: false, at };
          tools.set(block.id, tool);
          items.push(tool);
        }
      }
      continue;
    }

    if (event.type !== 'user') {
      continue;
    }
    const content = event.message?.content;
    if (event.isCompactSummary) {
      items.push({ kind: 'compact', text: typeof content === 'string' ? content : blocks(content).map((b) => b.text ?? '').join('\n'), at });
      continue;
    }
    const parts = [];
    for (const block of typeof content === 'string' ? [{ type: 'text', text: content }] : blocks(content)) {
      if (block.type === 'tool_result') {
        const tool = tools.get(block.tool_use_id);
        if (tool) {
          tool.result = clip(resultText(block.content), TOOL_RESULT_LIMIT);
          tool.isError = block.is_error === true;
        }
      } else if (block.type === 'image') {
        parts.push('[Image]');
      } else if (block.type === 'text' && block.text) {
        const special = specialMessage(block.text, at);
        if (special) {
          items.push(special);
        } else if (!block.text.trim().startsWith('<')) {
          parts.push(block.text.trim());
        }
      }
    }
    if (parts.length) {
      items.push({ kind: 'user', text: parts.join('\n\n'), at });
    }
  }

  conversationCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, items });

  return items;
}

function blocks(content) {
  return Array.isArray(content) ? content.filter((block) => block && typeof block === 'object') : [];
}

function specialMessage(text, at) {
  const trimmed = text.trim();
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(trimmed);
  if (command && trimmed.startsWith('<command-')) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed)?.[1]?.trim();
    return { kind: 'command', text: [command[1].trim(), args].filter(Boolean).join(' '), at };
  }
  if (trimmed.startsWith('<task-notification>')) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(trimmed)?.[1]?.trim();
    return { kind: 'event', text: summary || 'Background task finished', at };
  }
  if (/^\[Request interrupted/.test(trimmed)) {
    return { kind: 'event', text: 'Interrupted by user', at };
  }

  return null;
}

function toolSummary(input) {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const preferred = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'prompt'];
  const value = preferred.map((key) => input[key]).find((v) => typeof v === 'string' && v.trim())
    ?? Object.values(input).find((v) => typeof v === 'string' && v.trim());

  return value ? truncateTo(value.replace(/\s+/g, ' ').trim(), SUMMARY_LENGTH) : '';
}

function resultText(content) {
  if (typeof content === 'string') {
    return content;
  }

  return blocks(content).map((block) => {
    if (block.type === 'text') {
      return block.text ?? '';
    }
    if (block.type === 'image') {
      return '[Image]';
    }
    return block.tool_name ? `[${block.tool_name}]` : '';
  }).filter(Boolean).join('\n');
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters` : text;
}

function truncateTo(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
