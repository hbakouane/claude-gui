import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { listProjects, listSessions } from './sessions.js';

const INDEX = new URL('../public/index.html', import.meta.url);
const SESSIONS_ROUTE = /^\/api\/projects\/([^/]+)\/sessions$/;

export function createServer({ root }) {
  return createHttpServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(await readFile(INDEX));
      }
      if (pathname === '/api/projects') {
        return send(res, 200, await listProjects(root));
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
