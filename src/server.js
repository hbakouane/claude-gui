import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { launch as spawnTerminal, terminalCommand } from './resume.js';
import { findSession, listProjects, listRecent, listSessions, readConversation, searchSessions } from './sessions.js';

const INDEX = new URL('../public/index.html', import.meta.url);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const SESSIONS_ROUTE = /^\/api\/projects\/([^/]+)\/sessions$/;
const MESSAGES_ROUTE = /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/;
const MAX_RECENT_HOURS = 168;
const MAX_BODY_BYTES = 10_000;
const MAX_QUERY_LENGTH = 200;
export const RESUME_HEADER = 'claude-sessions-dashboard';

export function createServer({ root, terminal = 'terminal', platform = process.platform, launch = spawnTerminal }) {
  return createHttpServer(async (req, res) => {
    // Session files are private; rejecting foreign Host headers blocks DNS-rebinding reads from other sites.
    if (!LOCAL_HOSTS.has((req.headers.host ?? '').replace(/:\d+$/, ''))) {
      return send(res, 403, { error: 'Forbidden' });
    }

    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(await readFile(INDEX));
      }
      if (pathname === '/api/projects') {
        return send(res, 200, await listProjects(root));
      }
      if (pathname === '/api/recent') {
        const hours = Math.min(MAX_RECENT_HOURS, Math.max(1, Number(url.searchParams.get('hours')) || 24));
        return send(res, 200, await listRecent(root, hours));
      }
      if (pathname === '/api/search') {
        return send(res, 200, await searchSessions(root, (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LENGTH)));
      }
      if (pathname === '/api/resume') {
        return await resume(req, res, { root, terminal, platform, launch });
      }
      const messagesMatch = MESSAGES_ROUTE.exec(pathname);
      if (messagesMatch) {
        const messages = await readConversation(root, safeDecode(messagesMatch[1]), safeDecode(messagesMatch[2]));
        return messages ? send(res, 200, messages) : send(res, 404, { error: 'Not found' });
      }
      const match = SESSIONS_ROUTE.exec(pathname);
      const sessions = match && await listSessions(root, safeDecode(match[1]));
      if (sessions) {
        return send(res, 200, sessions);
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) {
      send(res, 500, { error: error.message });
    }
  });
}

async function resume(req, res, { root, terminal, platform, launch }) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Use POST' });
  }
  // A custom header can't be sent cross-site without a CORS preflight, which this server never approves.
  if (req.headers['x-requested-with'] !== RESUME_HEADER) {
    return send(res, 400, { error: 'Missing X-Requested-With header' });
  }
  const body = await readJson(req);
  const session = body && await findSession(root, String(body.projectId ?? ''), String(body.sessionId ?? ''));
  if (!session) {
    return send(res, 404, { error: 'Session not found' });
  }
  if (!session.cwd || !existsSync(session.cwd)) {
    return send(res, 409, { error: 'The session folder no longer exists' });
  }
  const [command, args] = terminalCommand({ platform, terminal, cwd: session.cwd, sessionId: session.id });
  await launch(command, args);

  return send(res, 200, { opened: true });
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) {
      return null;
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
