import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listProjects, listSessions, parseSession, projectsRoot } from '../src/sessions.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const PROJECT = '-Users-me-code-app';

const lines = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const fullSession = lines(
  { type: 'user', isMeta: true, message: { content: 'meta caveat' }, cwd: '/Users/me/code/app', gitBranch: 'main', timestamp: '2026-11-20T10:00:00.000Z' },
  { type: 'user', message: { content: '<command-name>/clear</command-name>' }, cwd: '/Users/me/code/app', timestamp: '2026-11-20T10:00:01.000Z' },
  { type: 'user', message: { content: [{ type: 'text', text: 'Fix the login bug please' }] }, cwd: '/Users/me/code/app', gitBranch: 'main', timestamp: '2026-11-20T10:00:02.000Z' },
  { type: 'attachment', attachment: { type: 'environment', snapshot: { isWorktree: true } }, timestamp: '2026-11-20T10:00:03.000Z' },
  { type: 'ai-title', aiTitle: 'First title' },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'mcp__claude_ai_Linear__get_issue' },
    { type: 'tool_use', name: 'mcp__supabase__execute_sql' },
    { type: 'tool_use', name: 'mcp__supabase__list_tables' },
    { type: 'tool_use', name: 'Bash' },
  ] }, cwd: '/Users/me/code/app', gitBranch: 'fix/login', timestamp: '2026-11-20T11:00:00.000Z' },
  { type: 'pr-link', prUrl: 'https://github.com/acme/app/pull/7', prNumber: 7, prRepository: 'acme/app', timestamp: '2026-11-20T11:30:00.000Z' },
  { type: 'pr-link', prUrl: 'https://github.com/acme/app/pull/7', prNumber: 7, prRepository: 'acme/app', timestamp: '2026-11-20T11:31:00.000Z' },
  { type: 'ai-title', aiTitle: 'Fix login bug' },
);

let root;

async function writeSession(project, id, content) {
  await mkdir(join(root, project), { recursive: true });
  const file = join(root, project, `${id}.jsonl`);
  await writeFile(file, content);
  return file;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('parseSession', () => {
  it('extracts every dashboard field', async () => {
    const session = await parseSession(await writeSession(PROJECT, SESSION_ID, fullSession));

    assert.deepEqual(session, {
      id: SESSION_ID,
      title: 'Fix login bug',
      cwd: '/Users/me/code/app',
      gitBranch: 'fix/login',
      isWorktree: true,
      prs: [{ url: 'https://github.com/acme/app/pull/7', number: 7, repository: 'acme/app' }],
      mcps: ['claude_ai_Linear', 'supabase'],
      lastActivity: '2026-11-20T11:31:00.000Z',
    });
  });

  it('falls back to the first real prompt when there is no ai-title', async () => {
    const longPrompt = `Investigate ${'why the nightly sync is slow '.repeat(10)}`;
    const file = await writeSession('-titles', 'no-title', lines(
      { type: 'user', message: { content: '<system-reminder>ignore</system-reminder>' }, timestamp: '2026-11-20T10:00:00.000Z' },
      { type: 'user', message: { content: longPrompt }, timestamp: '2026-11-20T10:00:01.000Z' },
    ));

    const { title, isWorktree, prs, mcps } = await parseSession(file);

    assert.equal(title.length, 80);
    assert.ok(title.startsWith('Investigate why the nightly sync'));
    assert.ok(title.endsWith('…'));
    assert.equal(isWorktree, false);
    assert.deepEqual(prs, []);
    assert.deepEqual(mcps, []);
  });

  it('uses a placeholder title and the file time when the session has neither', async () => {
    const file = await writeSession('-titles', 'empty', lines({ type: 'mode', mode: 'normal' }));

    const session = await parseSession(file);

    assert.equal(session.title, 'Untitled session');
    assert.ok(!Number.isNaN(Date.parse(session.lastActivity)));
  });

  it('ignores a half-written last line left by a crash', async () => {
    const file = await writeSession('-crash', 'crashed', `${fullSession}{"type":"assistant","message":{"content":[{"ty`);

    const session = await parseSession(file);

    assert.equal(session.title, 'Fix login bug');
    assert.equal(session.lastActivity, '2026-11-20T11:31:00.000Z');
  });

  it('serves an unchanged file from the cache and re-reads a changed one', async () => {
    const file = await writeSession('-cache', 'cached', fullSession);

    const first = await parseSession(file);
    assert.equal(await parseSession(file), first);

    await appendFile(file, lines({ type: 'ai-title', aiTitle: 'Renamed' }));
    const changed = await parseSession(file);
    assert.notEqual(changed, first);
    assert.equal(changed.title, 'Renamed');
  });
});

describe('listProjects', () => {
  it('lists projects by real folder path, newest first, hiding temp folders and empty folders', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'csd-projects-'));
    const previousRoot = root;
    root = projectsDir;
    try {
      await writeSession('-Users-me-old', 'a', lines({ type: 'user', cwd: '/Users/me/old', message: { content: 'hi' } }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeSession('-Users-me-new', 'b', lines({ type: 'mode' }, { type: 'user', cwd: '/Users/me/new', message: { content: 'hi' } }));
      await writeSession('-Users-me-new', 'c', lines({ type: 'user', cwd: '/Users/me/new', message: { content: 'hi' } }));
      await writeSession('-private-var-folders-x', 'd', lines({ type: 'user', cwd: '/private/var/folders/x/T/tmp', message: { content: 'hi' } }));
      await writeSession('-tmp-x', 'e', lines({ type: 'user', cwd: '/tmp/x', message: { content: 'hi' } }));
      await mkdir(join(projectsDir, '-Users-me-empty'));

      const projects = await listProjects(projectsDir);

      assert.deepEqual(projects.map(({ id, path, sessionCount }) => ({ id, path, sessionCount })), [
        { id: '-Users-me-new', path: '/Users/me/new', sessionCount: 2 },
        { id: '-Users-me-old', path: '/Users/me/old', sessionCount: 1 },
      ]);
    } finally {
      root = previousRoot;
      await rm(projectsDir, { recursive: true, force: true });
    }
  });

  it('returns no projects when the projects folder does not exist', async () => {
    assert.deepEqual(await listProjects(join(root, 'missing')), []);
  });
});

describe('listSessions', () => {
  it('lists only top-level session files, newest activity first', async () => {
    await writeSession('-sorting', 'older', lines({ type: 'user', message: { content: 'a' }, timestamp: '2026-11-01T00:00:00.000Z' }));
    await writeSession('-sorting', 'newer', lines({ type: 'user', message: { content: 'b' }, timestamp: '2026-11-02T00:00:00.000Z' }));
    await mkdir(join(root, '-sorting', 'newer', 'subagents'), { recursive: true });
    await writeFile(join(root, '-sorting', 'newer', 'subagents', 'agent.jsonl'), lines({ type: 'user' }));

    const sessions = await listSessions(root, '-sorting');

    assert.deepEqual(sessions.map((session) => session.id), ['newer', 'older']);
  });

  it('returns null for a folder that is not a project', async () => {
    assert.equal(await listSessions(root, '../..'), null);
    assert.equal(await listSessions(root, 'nope'), null);
  });
});

describe('projectsRoot', () => {
  it('respects CLAUDE_CONFIG_DIR', () => {
    assert.equal(projectsRoot({ CLAUDE_CONFIG_DIR: '/custom' }), '/custom/projects');
    assert.ok(projectsRoot({}).endsWith('/.claude/projects'));
  });
});
