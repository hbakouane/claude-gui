import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const MCP_TOOL = /^mcp__(.+?)__/;
const TITLE_LENGTH = 80;

export function projectsRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

export async function parseSession(file) {
  const info = await stat(file);

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

  return session;
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
