import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { archivePath, restoreSession, syncArchive } from '../src/archive.js';
import { createServer, RESUME_HEADER } from '../src/server.js';
import { listProjects, listSessions, readConversation, searchSessions } from '../src/sessions.js';

const HOUR = 3600_000;
const lines = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const transcript = (cwd, text) => lines(
  { type: 'user', cwd, message: { content: text }, timestamp: '2026-10-01T10:00:00.000Z' },
  { type: 'assistant', message: { content: [{ type: 'text', text: `Answer about ${text}` }] }, timestamp: '2026-10-01T10:00:05.000Z' },
  { type: 'system', subtype: 'turn_duration' },
);

let scratch;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'csd-archive-'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function write(file, content, ageMs) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
}

describe('archivePath', () => {
  it('lives under XDG_DATA_HOME, or ~/.local/share by default', () => {
    assert.equal(archivePath({ XDG_DATA_HOME: '/data' }), '/data/claude-gui/archive');
    assert.match(archivePath({}), /\/\.local\/share\/claude-gui\/archive$/);
  });
});

describe('syncArchive', () => {
  let root;
  let archive;

  before(async () => {
    root = join(scratch, 'sync', 'projects');
    archive = join(scratch, 'sync', 'archive');
    await write(join(root, '-p', 'old.jsonl'), transcript('/Users/me/p', 'old work'), 5 * HOUR);
    await write(join(root, '-p', 'fresh.jsonl'), transcript('/Users/me/p', 'still writing'), 1000);
    await write(join(root, '-p', 'notes.txt'), 'not a session', 5 * HOUR);
  });

  it('copies settled transcripts as gzip, readable only by their owner, and leaves files still being written', async () => {
    assert.deepEqual(await syncArchive(root, archive), { copied: 1, removed: 0 });

    const copy = join(archive, '-p', 'old.jsonl.gz');
    assert.equal(gunzipSync(await readFile(copy)).toString(), transcript('/Users/me/p', 'old work'));
    assert.equal((await stat(copy)).mode & 0o777, 0o600);
    assert.equal((await stat(join(archive, '-p'))).mode & 0o777, 0o700);
    assert.equal(await stat(join(archive, '-p', 'fresh.jsonl.gz')).catch(() => null), null);
    assert.equal(await stat(join(archive, '-p', 'notes.txt.gz')).catch(() => null), null);
  });

  it('skips copies that are up to date and refreshes ones whose transcript changed', async () => {
    assert.deepEqual(await syncArchive(root, archive), { copied: 0, removed: 0 });

    await write(join(root, '-p', 'old.jsonl'), transcript('/Users/me/p', 'old work, continued'), 4 * HOUR);
    assert.deepEqual(await syncArchive(root, archive), { copied: 1, removed: 0 });
    assert.match(gunzipSync(await readFile(join(archive, '-p', 'old.jsonl.gz'))).toString(), /old work, continued/);
  });

  it('does nothing when the Claude folder is missing', async () => {
    assert.deepEqual(await syncArchive(join(scratch, 'missing'), archive), { copied: 0, removed: 0 });
  });
});

describe('keeping copies for a number of days', () => {
  it('deletes copies whose session has been inactive longer, and never copies expired sessions', async () => {
    const DAY = 24 * HOUR;
    const root = join(scratch, 'keep', 'projects');
    const archive = join(scratch, 'keep', 'archive');
    await write(join(root, '-p', 'recent.jsonl'), transcript('/Users/me/p', 'recent'), 2 * DAY);
    await write(join(root, '-p', 'month.jsonl'), transcript('/Users/me/p', 'a month old'), 30 * DAY);
    await write(join(archive, '-gone', 'ancient.jsonl.gz'), 'old copy', 90 * DAY);
    await write(join(archive, '-q', 'kept.jsonl.gz'), 'old copy', 5 * DAY);

    assert.deepEqual(await syncArchive(root, archive, { keepDays: 7 }), { copied: 1, removed: 1 });
    assert.ok(await stat(join(archive, '-p', 'recent.jsonl.gz')));
    assert.equal(await stat(join(archive, '-p', 'month.jsonl.gz')).catch(() => null), null);
    assert.ok(await stat(join(archive, '-q', 'kept.jsonl.gz')));
    // The emptied project folder goes too.
    assert.equal(await stat(join(archive, '-gone')).catch(() => null), null);

    assert.deepEqual(await syncArchive(root, archive), { copied: 1, removed: 0 });
    assert.ok(await stat(join(archive, '-p', 'month.jsonl.gz')));
  });
});

describe('reading archived sessions', () => {
  let root;
  let archive;

  before(async () => {
    root = join(scratch, 'read', 'projects');
    archive = join(scratch, 'read', 'archive');
    await write(join(root, '-Users-me-kept', 'kept.jsonl'), transcript('/Users/me/kept', 'kept session'), 5 * HOUR);
    await write(join(root, '-Users-me-kept', 'deleted.jsonl'), transcript('/Users/me/kept', 'tax rounding fix'), 5 * HOUR);
    await write(join(root, '-Users-me-gone', 'lonely.jsonl'), transcript('/Users/me/gone', 'a project Claude removed'), 5 * HOUR);
    await syncArchive(root, archive);
    // Claude Code's cleanup deletes old transcripts, and sometimes the whole project folder.
    await unlink(join(root, '-Users-me-kept', 'deleted.jsonl'));
    await rm(join(root, '-Users-me-gone'), { recursive: true });
    await write(join(archive, '-Users-me-kept', 'broken.jsonl.gz'), 'not gzip at all', 5 * HOUR);
  });

  it('lists sessions and projects that now exist only in the archive, marked as archived, and skips corrupt copies', async () => {
    const projects = await listProjects(root, { archive });
    assert.deepEqual(projects.map((p) => p.path).sort(), ['/Users/me/gone', '/Users/me/kept']);

    const sessions = await listSessions(root, '-Users-me-kept', { archive });
    // The corrupt copy is skipped instead of breaking the list.
    assert.deepEqual(sessions.map((s) => [s.id, s.archived]).sort(), [['deleted', true], ['kept', false]]);
    assert.equal(sessions.find((s) => s.id === 'deleted').title, 'tax rounding fix');
  });

  it('prefers the live transcript when both exist', async () => {
    const sessions = await listSessions(root, '-Users-me-kept', { archive });
    assert.equal(sessions.filter((s) => s.id === 'kept').length, 1);
    assert.equal(sessions.find((s) => s.id === 'kept').archived, false);
  });

  it('reads and searches archived conversations', async () => {
    const conversation = await readConversation(root, '-Users-me-kept', 'deleted', { archive });
    assert.deepEqual(conversation.map((item) => item.text), ['tax rounding fix', 'Answer about tax rounding fix']);

    const { results } = await searchSessions(root, 'tax rounding', { archive });
    assert.deepEqual(results.map((r) => [r.sessionId, r.kind]), [['deleted', 'assistant'], ['deleted', 'user']]);
  });

  it('hides the archive when it is not passed in', async () => {
    assert.deepEqual((await listProjects(root)).map((p) => p.path), ['/Users/me/kept']);
    assert.equal(await readConversation(root, '-Users-me-kept', 'deleted'), null);
  });
});

describe('restoreSession', () => {
  it('writes the transcript back uncompressed, and never overwrites an existing one', async () => {
    const root = join(scratch, 'restore', 'projects');
    const archive = join(scratch, 'restore', 'archive');
    await write(join(root, '-p', 's.jsonl'), transcript('/Users/me/p', 'restore me'), 5 * HOUR);
    await syncArchive(root, archive);
    const target = join(root, '-p', 's.jsonl');
    await writeFile(target, 'newer content');

    assert.equal(await restoreSession(join(archive, '-p', 's.jsonl.gz'), target), false);
    assert.equal(await readFile(target, 'utf8'), 'newer content');

    await unlink(target);
    assert.equal(await restoreSession(join(archive, '-p', 's.jsonl.gz'), target), true);
    assert.equal(await readFile(target, 'utf8'), transcript('/Users/me/p', 'restore me'));
  });
});

describe('archive through the server', () => {
  let server;
  let port;
  let root;
  let archive;
  let configFile;
  const launched = [];

  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-requested-with': RESUME_HEADER } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  before(async () => {
    root = join(scratch, 'server', 'projects');
    archive = join(scratch, 'server', 'archive');
    configFile = join(scratch, 'server', 'config.json');
    await write(join(root, '-tmp-x', 'old.jsonl'), transcript(scratch, 'resume me later'), 5 * HOUR);
    await syncArchive(root, archive);
    await unlink(join(root, '-tmp-x', 'old.jsonl'));
    server = createServer({ root, configFile, archiveDir: archive, archive: true, platform: 'darwin', launch: async (command, args) => { launched.push([command, args]); } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('restores an archived session before resuming it', async () => {
    const response = await call('POST', '/api/resume', { projectId: '-tmp-x', sessionId: 'old' });

    assert.deepEqual([response.status, response.body], [200, { opened: true, restored: true }]);
    assert.equal(await readFile(join(root, '-tmp-x', 'old.jsonl'), 'utf8'), transcript(scratch, 'resume me later'));
    assert.equal(launched.length, 1);
  });

  it('reports and saves the archive setting, and rejects values that are not booleans', async () => {
    const settings = (await call('GET', '/api/settings')).body;
    assert.deepEqual([settings.archive, settings.archiveDir, settings.notifications], [true, archive, false]);

    assert.equal(settings.archiveDays, null);
    for (const archiveDays of [0, -3, 1.5, '30', 36501]) {
      assert.equal((await call('POST', '/api/settings', { archiveDays })).status, 400, String(archiveDays));
    }
    const days = await call('POST', '/api/settings', { archiveDays: 90 });
    assert.deepEqual([days.status, days.body.archiveDays], [200, 90]);
    assert.equal((await call('POST', '/api/settings', { archiveDays: null })).body.archiveDays, null);

    assert.equal((await call('POST', '/api/settings', { archive: 'yes' })).status, 400);
    assert.equal((await call('POST', '/api/settings', { notifications: 1 })).status, 400);

    const off = await call('POST', '/api/settings', { archive: false, notifications: true });
    assert.deepEqual([off.status, off.body.archive, off.body.notifications], [200, false, true]);
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), { archive: false, notifications: true });
    assert.equal((await call('GET', '/api/projects/-tmp-x/sessions')).body.some((s) => s.archived), false);
  });

  it('refuses to turn archiving on when there is no archive folder', async () => {
    const bare = createServer({ root, configFile: join(scratch, 'server', 'bare.json') });
    await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const barePort = bare.address().port;
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: barePort, path: '/api/settings', method: 'POST', headers: { host: `127.0.0.1:${barePort}`, 'content-type': 'application/json', 'x-requested-with': RESUME_HEADER } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(JSON.stringify({ archive: true }));
    });
    await new Promise((resolve) => bare.close(resolve));

    assert.equal(status, 409);
  });
});
