import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { isValidKeepDays, MAX_KEEP_DAYS, restoreSession, SYNC_INTERVAL_MS, syncArchive } from './archive.js';
import { DEFAULT_PORT, expandHome, isValidPort, MIN_PORT, readConfig, resolveClaudeDir, writeConfig } from './config.js';
import { DEFAULT_EDITOR, EDITORS, editorCommand, openEditor } from './editor.js';
import { launch as spawnTerminal, terminalCommand } from './resume.js';
import { findSession, listProjects, listRecent, listSessions, parseSession, readConversation, searchSessions, sessionPath } from './sessions.js';

const INDEX = new URL('../public/index.html', import.meta.url);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const SESSIONS_ROUTE = /^\/api\/projects\/([^/]+)\/sessions$/;
const MESSAGES_ROUTE = /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/;
const MAX_RECENT_HOURS = 168;
const MAX_BODY_BYTES = 10_000;
const MAX_QUERY_LENGTH = 200;
const MAX_PATH_LENGTH = 1000;
const SETTING_KEYS = ['claudeDir', 'editor', 'openBrowser', 'port', 'archive', 'archiveDays'];
const BOOLEAN_SETTINGS = ['openBrowser', 'archive'];
export const RESUME_HEADER = 'claude-gui';

export function createServer({ root, claudeDir, source = 'default', configFile = null, env = process.env, editor = DEFAULT_EDITOR, terminal = 'terminal', platform = process.platform, launch = spawnTerminal, openFolder = openEditor, archiveDir = null, archive = false, archiveDays = null, syncIntervalMs = SYNC_INTERVAL_MS }) {
  const settings = { root: root ?? join(claudeDir, 'projects'), claudeDir: claudeDir ?? null, source, editor: Object.hasOwn(EDITORS, editor) ? editor : DEFAULT_EDITOR, archiveDir, archiving: Boolean(archive && archiveDir), archiveDays: isValidKeepDays(archiveDays) ? archiveDays : null };
  const archiver = createArchiver(settings, syncIntervalMs);

  const server = createHttpServer(async (req, res) => {
    const { root } = settings;
    const archived = { archive: settings.archiving ? settings.archiveDir : null };
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
        return send(res, 200, await listProjects(root, archived));
      }
      if (pathname === '/api/recent') {
        const hours = Math.min(MAX_RECENT_HOURS, Math.max(1, Number(url.searchParams.get('hours')) || 24));
        return send(res, 200, await listRecent(root, hours, Date.now(), archived));
      }
      if (pathname === '/api/search') {
        return send(res, 200, await searchSessions(root, (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LENGTH), archived));
      }
      if (pathname === '/api/settings') {
        return await updateSettings(req, res, { settings, configFile, env, archiver });
      }
      if (pathname === '/api/open-editor') {
        return await openInEditor(req, res, { root, archive: archived.archive, editor: settings.editor, platform, open: openFolder });
      }
      if (pathname === '/api/resume') {
        return await resume(req, res, { root, archive: archived.archive, terminal, platform, launch });
      }
      const messagesMatch = MESSAGES_ROUTE.exec(pathname);
      if (messagesMatch) {
        const messages = await readConversation(root, safeDecode(messagesMatch[1]), safeDecode(messagesMatch[2]), archived);
        return messages ? send(res, 200, messages) : send(res, 404, { error: 'Not found' });
      }
      const match = SESSIONS_ROUTE.exec(pathname);
      const sessions = match && await listSessions(root, safeDecode(match[1]), archived);
      if (sessions) {
        return send(res, 200, sessions);
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) {
      send(res, 500, { error: error.message });
    }
  });
  server.on('listening', () => archiver.start());
  server.on('close', () => archiver.stop());

  return server;
}

// Keeps the archive in sync while archiving is on: once at start, then every `intervalMs`.
function createArchiver(settings, intervalMs) {
  let timer = null;
  let running = null;
  const run = () => {
    if (!settings.archiving || running) {
      return running;
    }
    running = syncArchive(settings.root, settings.archiveDir, { keepDays: settings.archiveDays }).catch(() => null).finally(() => { running = null; });
    return running;
  };

  return {
    start() {
      if (!settings.archiving || timer) {
        return;
      }
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    run,
  };
}

async function resume(req, res, { root, archive, terminal, platform, launch }) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Use POST' });
  }
  // A custom header can't be sent cross-site without a CORS preflight, which this server never approves.
  if (req.headers['x-requested-with'] !== RESUME_HEADER) {
    return send(res, 400, { error: 'Missing X-Requested-With header' });
  }
  const body = await readJson(req);
  const projectId = String(body?.projectId ?? '');
  const file = body && await sessionPath(root, projectId, String(body.sessionId ?? ''), archive);
  const session = file && await parseSession(file);
  if (!session) {
    return send(res, 404, { error: 'Session not found' });
  }
  if (!session.cwd || !existsSync(session.cwd)) {
    return send(res, 409, { error: 'The session folder no longer exists' });
  }
  // Claude Code deleted this transcript; put the archived copy back so `claude --resume` finds it.
  const restored = session.archived && await restoreSession(file, join(root, projectId, `${session.id}.jsonl`));
  const [command, args] = terminalCommand({ platform, terminal, cwd: session.cwd, sessionId: session.id });
  await launch(command, args);

  return send(res, 200, { opened: true, restored: Boolean(restored) });
}

async function updateSettings(req, res, { settings, configFile, env, archiver }) {
  if (req.method === 'GET') {
    return send(res, 200, await describe(settings, configFile, req));
  }
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Use GET or POST' });
  }
  if (req.headers['x-requested-with'] !== RESUME_HEADER) {
    return send(res, 400, { error: 'Missing X-Requested-With header' });
  }
  if (!configFile) {
    return send(res, 409, { error: 'Settings can\'t be saved in this mode' });
  }
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return send(res, 400, { error: 'Send a JSON object of settings' });
  }
  const unknown = Object.keys(body).find((key) => !SETTING_KEYS.includes(key));
  if (unknown) {
    return send(res, 400, { error: `Unknown setting: ${unknown}` });
  }
  const config = await readConfig(configFile);
  let folder = null;
  if ('claudeDir' in body) {
    if (body.claudeDir !== null && typeof body.claudeDir !== 'string') {
      return send(res, 400, { error: 'claudeDir must be a folder path, or null for the default' });
    }
    if (body.claudeDir === null || !body.claudeDir.trim()) {
      delete config.claudeDir;
      folder = resolveClaudeDir({ env });
    } else {
      const claudeDir = expandHome(body.claudeDir);
      if (claudeDir.length > MAX_PATH_LENGTH || !isAbsolute(claudeDir)) {
        return send(res, 400, { error: 'Use a full path, like ~/.claude or /Users/you/.claude' });
      }
      const projects = await stat(join(claudeDir, 'projects')).catch(() => null);
      if (!projects?.isDirectory()) {
        return send(res, 400, { error: `No projects folder in ${claudeDir}. Pick the folder Claude Code keeps its data in, the one that contains "projects".` });
      }
      config.claudeDir = claudeDir;
      folder = { claudeDir, source: 'settings' };
    }
  }
  if ('editor' in body) {
    if (!Object.hasOwn(EDITORS, body.editor)) {
      return send(res, 400, { error: `Pick one of these editors: ${Object.keys(EDITORS).join(', ')}` });
    }
    config.editor = body.editor;
  }
  for (const key of BOOLEAN_SETTINGS.filter((k) => k in body)) {
    if (typeof body[key] !== 'boolean') {
      return send(res, 400, { error: `${key} must be true or false` });
    }
    config[key] = body[key];
  }
  if ('archiveDays' in body) {
    if (body.archiveDays === null) {
      delete config.archiveDays;
    } else if (!isValidKeepDays(body.archiveDays)) {
      return send(res, 400, { error: `Keep copies for a whole number of days between 1 and ${MAX_KEEP_DAYS}, or empty to keep them forever` });
    } else {
      config.archiveDays = body.archiveDays;
    }
  }
  if (body.archive === true && !settings.archiveDir) {
    return send(res, 409, { error: 'Archiving isn\'t available in this mode' });
  }
  if ('port' in body) {
    if (body.port === null) {
      delete config.port;
    } else if (!isValidPort(body.port)) {
      return send(res, 400, { error: `Use a port between ${MIN_PORT} and 65535` });
    } else {
      config.port = body.port;
    }
  }
  await writeConfig(configFile, config);
  if (folder) {
    Object.assign(settings, { root: join(folder.claudeDir, 'projects'), claudeDir: folder.claudeDir, source: folder.source });
  }
  settings.editor = config.editor ?? settings.editor;
  settings.archiving = Boolean(settings.archiveDir) && config.archive !== false;
  settings.archiveDays = isValidKeepDays(config.archiveDays) ? config.archiveDays : null;
  if (settings.archiving) {
    archiver.start();
    const sync = archiver.run();
    // Wait when only the retention changed, so expired copies are gone before the page reloads its lists.
    if ('archiveDays' in body && !('archive' in body)) {
      await sync;
    }
  } else {
    archiver.stop();
  }

  return send(res, 200, await describe(settings, configFile, req));
}

async function describe(settings, configFile, req) {
  const config = configFile ? await readConfig(configFile) : {};

  return {
    claudeDir: settings.claudeDir,
    projectsDir: settings.root,
    source: settings.source,
    configFile,
    editor: settings.editor,
    editors: Object.entries(EDITORS).map(([id, { label }]) => ({ id, label })),
    openBrowser: config.openBrowser !== false,
    archive: settings.archiving,
    archiveDir: settings.archiveDir,
    archiveDays: settings.archiveDays,
    port: isValidPort(config.port) ? config.port : null,
    defaultPort: DEFAULT_PORT,
    runningPort: req.socket.localPort,
  };
}

async function openInEditor(req, res, { root, archive, editor, platform, open }) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Use POST' });
  }
  if (req.headers['x-requested-with'] !== RESUME_HEADER) {
    return send(res, 400, { error: 'Missing X-Requested-With header' });
  }
  const body = await readJson(req);
  const session = body && await findSession(root, String(body.projectId ?? ''), String(body.sessionId ?? ''), { archive });
  if (!session) {
    return send(res, 404, { error: 'Session not found' });
  }
  const dir = body.path == null ? session.cwd : String(body.path);
  // Only the session's own folder and worktrees can be opened, never an arbitrary path from the request.
  if (!dir || ![session.cwd, ...session.worktrees.map((worktree) => worktree.path)].includes(dir)) {
    return send(res, 400, { error: 'That folder does not belong to this session' });
  }
  if (!existsSync(dir)) {
    return send(res, 409, { error: 'That folder no longer exists' });
  }
  const [command, args] = editorCommand({ platform, editor, dir });
  try {
    await open(command, args);
  } catch (error) {
    return send(res, 409, { error: `Could not open ${EDITORS[editor].label}. Is it installed? (${error.message})` });
  }

  return send(res, 200, { opened: dir, editor });
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
