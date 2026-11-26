import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { summarizeUsage } from './pricing.js';

const TEMP_PATH = /^\/(private\/)?(var\/folders|tmp)\//;
const MCP_TOOL = /^mcp__(.+?)__/;
const TASK_SLUG = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const TITLE_LENGTH = 80;
const PREVIEW_LENGTH = 200;
const PARALLEL_FILES = 8;
const RECENT_LIMIT = 50;
const WORKTREE_ADD = /(?:^|[;&|(\n]|\$\()\s*git\s+(?:-C\s+\S+\s+)?worktree\s+add\b([^;&|\n]*)/g;
const SHELL_ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
const PLAIN_PATH = /^[\w@%+=:,./~-]+$/;
const ARTIFACT_URL = /\bat (https:\/\/claude\.ai\/[^\s)]+)/;
const ARTIFACT_VERSION = /\(Version (\d+)/;
const ARTIFACT_RANK = { viewed: 0, updated: 1, created: 2 };
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

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

export async function listRecent(root, hours, now = Date.now()) {
  const since = new Date(now - hours * 3600000).toISOString();
  const recent = [];
  for (const project of (await listProjects(root)).filter((p) => p.lastActivity >= since)) {
    for (const session of (await listSessions(root, project.id)) ?? []) {
      if (session.lastActivity >= since) {
        recent.push({ ...session, projectId: project.id, projectPath: project.path });
      }
    }
  }

  return recent.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, RECENT_LIMIT);
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
  let lastPrompt = null;
  let lastReply = null;
  let cwd = null;
  let gitBranch = null;
  let lastTimestamp = 0;
  let turnOpen = false;
  const prs = new Map();
  const mcps = new Set();
  const worktrees = new Set();
  const artifacts = new Map();
  const artifactCalls = new Map();
  const fileCalls = new Map();
  const files = new Map();
  const usageById = new Map();

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
    if (event.attachment?.type === 'environment' && event.attachment.snapshot?.isWorktree === true) {
      worktrees.add(event.attachment.snapshot.workingDirectory ?? cwd);
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_use') {
          continue;
        }
        const match = MCP_TOOL.exec(block.name);
        if (match) {
          mcps.add(match[1]);
        }
        if (block.name === 'Bash') {
          worktreeTargets(String(block.input?.command ?? ''), event.cwd ?? cwd).forEach((path) => worktrees.add(path));
        }
        if (block.name === 'EnterWorktree' && (block.input?.path || block.input?.name)) {
          worktrees.add(resolve(event.cwd ?? cwd ?? '/', block.input.path ?? join('.claude', 'worktrees', block.input.name)));
        }
        if (block.name === 'Artifact') {
          artifactCalls.set(block.id, block.input ?? {});
        }
        const filePath = FILE_TOOLS.has(block.name) && (block.input?.file_path ?? block.input?.notebook_path);
        if (filePath) {
          fileCalls.set(block.id, { path: resolve(event.cwd ?? cwd ?? '/', String(filePath)), edits: block.name === 'MultiEdit' ? block.input.edits?.length || 1 : 1 });
        }
      }
    }
    if (event.type === 'assistant' && event.message?.usage) {
      usageById.set(event.message.id ?? `line-${usageById.size}`, { model: event.message.model, usage: event.message.usage });
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_result' || block.is_error) {
          continue;
        }
        const artifactCall = artifactCalls.get(block.tool_use_id);
        if (artifactCall) {
          recordArtifact(artifacts, artifactCall, resultText(block.content));
        }
        const fileCall = fileCalls.get(block.tool_use_id);
        if (fileCall) {
          const file = files.get(fileCall.path) ?? { path: fileCall.path, edits: 0 };
          file.edits += fileCall.edits;
          files.set(fileCall.path, file);
        }
      }
    }
    if (event.type === 'system' && event.subtype === 'turn_duration') {
      turnOpen = false;
    }
    if (event.type === 'user' && !event.isMeta && !event.isSidechain) {
      turnOpen = !/^\s*(<local-command|\[Request interrupted)/.test(promptText(event.message?.content, true) ?? '');
    }
    if (firstPrompt === null && event.type === 'user' && !event.isMeta && !event.isSidechain) {
      firstPrompt = promptText(event.message?.content);
    }
    if (event.type === 'user' && !event.isMeta && !event.isSidechain) {
      const prompt = promptText(event.message?.content);
      if (prompt && !prompt.startsWith('[Request interrupted')) {
        lastPrompt = truncate(plainText(prompt), PREVIEW_LENGTH);
      }
    }
    if (event.type === 'assistant' && !event.isSidechain && Array.isArray(event.message?.content)) {
      const reply = event.message.content.findLast((block) => block?.type === 'text' && block.text?.trim())?.text;
      if (reply) {
        lastReply = truncate(plainText(reply), PREVIEW_LENGTH);
      }
    }
  }

  const session = {
    id: basename(file, '.jsonl'),
    title: title ?? slugTitle ?? truncate(firstPrompt) ?? 'Untitled session',
    cwd,
    gitBranch,
    worktrees: [...worktrees].map((path) => ({ path, exists: existsSync(path) })),
    prs: [...prs.values()],
    mcps: [...mcps].sort((a, b) => a.localeCompare(b)),
    artifacts: [...artifacts.values()],
    filesChanged: [...files.values()],
    usage: summarizeUsage(usageById.values()),
    lastPrompt,
    lastReply,
    turnOpen,
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

function worktreeTargets(command, cwd) {
  const vars = new Map([['HOME', homedir()], ['PWD', cwd ?? '']]);
  for (const [, name, value] of command.matchAll(SHELL_ASSIGNMENT)) {
    vars.set(name, unquote(value));
  }
  const targets = [];
  for (const [, args] of command.matchAll(WORKTREE_ADD)) {
    const words = args.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (['-b', '-B', '--reason'].includes(words[i])) {
        i++;
        continue;
      }
      if (words[i].startsWith('-')) {
        continue;
      }
      const path = unquote(words[i]).replace(/\$\{?(\w+)\}?/g, (ref, name) => vars.get(name) ?? ref).replace(/^~(?=\/|$)/, homedir());
      if (PLAIN_PATH.test(path)) {
        targets.push(resolve(cwd ?? '/', path));
      }
      break;
    }
  }

  return targets;
}

function unquote(word) {
  return word.replace(/^(["'])(.*)\1$/, '$2');
}

function recordArtifact(artifacts, input, result) {
  const action = input.action ?? 'publish';
  if ((action !== 'publish' && action !== 'read') || input.asset) {
    return;
  }
  const url = (action === 'publish' ? ARTIFACT_URL.exec(result)?.[1] ?? input.url : input.url)?.split('?')[0];
  if (!url?.startsWith('https://claude.ai/')) {
    return;
  }
  const version = Number(ARTIFACT_VERSION.exec(result)?.[1]) || null;
  const change = action === 'read' ? 'viewed' : version === 1 || (!version && !input.url) ? 'created' : 'updated';
  const previous = artifacts.get(url);
  artifacts.set(url, {
    url,
    name: input.title ?? (input.file_path ? basename(input.file_path, extname(input.file_path)) : null) ?? previous?.name ?? url.split('/').pop(),
    change: previous && ARTIFACT_RANK[previous.change] > ARTIFACT_RANK[change] ? previous.change : change,
    version: Math.max(version ?? 0, previous?.version ?? 0) || null,
  });
}

function promptText(content, raw = false) {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.find((block) => block?.type === 'text')?.text : null;
  const trimmed = text?.trim();

  return trimmed && (raw || !trimmed.startsWith('<')) ? trimmed : null;
}

function plainText(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/```[^\n]*/g, ' ')
    .replace(/\*\*|`/g, '')
    .replace(/^\s*#{1,6}\s+/gm, '');
}

function truncate(text, limit = TITLE_LENGTH) {
  if (!text) {
    return null;
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();

  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
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
  const file = await sessionPath(root, projectId, sessionId);

  return file ? parseConversation(file) : null;
}

export async function findSession(root, projectId, sessionId) {
  const file = await sessionPath(root, projectId, sessionId);

  return file ? parseSession(file) : null;
}

async function sessionPath(root, projectId, sessionId) {
  if (!(await projectDirs(root)).includes(projectId)) {
    return null;
  }
  const dir = join(root, projectId);
  const names = await readdir(dir).catch(() => []);

  return names.includes(`${sessionId}.jsonl`) ? join(dir, `${sessionId}.jsonl`) : null;
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
