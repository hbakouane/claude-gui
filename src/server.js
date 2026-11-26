import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { listProjects, listRecent, listSessions, readConversation } from './sessions.js';

const INDEX = new URL('../public/index.html', import.meta.url);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const SESSIONS_ROUTE = /^\/api\/projects\/([^/]+)\/sessions$/;
const MESSAGES_ROUTE = /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/;
const MAX_RECENT_HOURS = 168;

export function createServer({ root }) {
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
