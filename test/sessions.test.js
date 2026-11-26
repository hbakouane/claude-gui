import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseSession, projectsRoot } from '../src/sessions.js';

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
});

describe('projectsRoot', () => {
  it('respects CLAUDE_CONFIG_DIR', () => {
    assert.equal(projectsRoot({ CLAUDE_CONFIG_DIR: '/custom' }), '/custom/projects');
    assert.ok(projectsRoot({}).endsWith('/.claude/projects'));
  });
});
