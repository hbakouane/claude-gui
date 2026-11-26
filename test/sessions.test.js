import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer } from '../src/server.js';
import { listProjects, listSessions, parseConversation, parseSession, projectsRoot, readConversation } from '../src/sessions.js';

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
  { type: 'ai-title', aiTitle: 'verify-login-fix-prod' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Bash', input: { command: 'WT=../app-fix && git worktree add -b fix/login "$WT" origin/main 2>&1 | tail -2' } }] }, cwd: '/Users/me/code/app' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Artifact', input: { file_path: '/tmp/x/report.html' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'Published /tmp/x/report.html at https://claude.ai/code/artifact/abc (Version 1, version id 1)' }] } },
  { type: 'system', subtype: 'turn_duration' },
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
      worktrees: [
        { path: '/Users/me/code/app', exists: false },
        { path: '/Users/me/code/app-fix', exists: false },
      ],
      prs: [{ url: 'https://github.com/acme/app/pull/7', number: 7, repository: 'acme/app' }],
      mcps: ['claude_ai_Linear', 'supabase'],
      artifacts: [{ url: 'https://claude.ai/code/artifact/abc', name: 'report', change: 'created', version: 1 }],
      lastPrompt: 'Fix the login bug please',
      lastReply: null,
      turnOpen: false,
      lastActivity: '2026-11-20T11:31:00.000Z',
    });
  });

  it('falls back to the first real prompt when there is no ai-title', async () => {
    const longPrompt = `Investigate ${'why the nightly sync is slow '.repeat(10)}`;
    const file = await writeSession('-titles', 'no-title', lines(
      { type: 'user', message: { content: '<system-reminder>ignore</system-reminder>' }, timestamp: '2026-11-20T10:00:00.000Z' },
      { type: 'user', message: { content: longPrompt }, timestamp: '2026-11-20T10:00:01.000Z' },
    ));

    const { title, worktrees, prs, mcps, artifacts } = await parseSession(file);

    assert.equal(title.length, 80);
    assert.ok(title.startsWith('Investigate why the nightly sync'));
    assert.ok(title.endsWith('…'));
    assert.deepEqual(worktrees, []);
    assert.deepEqual(prs, []);
    assert.deepEqual(mcps, []);
    assert.deepEqual(artifacts, []);
  });

  it('uses the first task slug when the session only has slug titles', async () => {
    const file = await writeSession('-titles', 'slugs', lines(
      { type: 'user', message: { content: 'Do the thing' } },
      { type: 'ai-title', aiTitle: 'build-portfolio-site' },
      { type: 'ai-title', aiTitle: 'deploy-portfolio' },
    ));

    assert.equal((await parseSession(file)).title, 'build-portfolio-site');
  });

  it('records the last real prompt and the last reply as one-line previews', async () => {
    const file = await writeSession('-previews', 'stopped', lines(
      { type: 'user', message: { content: 'First question' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'First answer' }] } },
      { type: 'user', message: { content: `Second   question\nwith ${'detail '.repeat(60)}` } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'output' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Draft' }, { type: 'text', text: 'Final answer' }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
      { type: 'user', isMeta: true, message: { content: 'Caveat: hidden' } },
      { type: 'user', message: { content: '<local-command-stdout>noise</local-command-stdout>' } },
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ));

    const { lastPrompt, lastReply } = await parseSession(file);

    assert.equal(lastPrompt.length, 200);
    assert.ok(lastPrompt.startsWith('Second question with detail'));
    assert.ok(lastPrompt.endsWith('…'));
    assert.equal(lastReply, 'Final answer');
  });

  it('strips markdown and paste wrappers from the previews', async () => {
    const file = await writeSession('-previews', 'markdown', lines(
      { type: 'user', message: { content: 'Look at this:\n<pasted_content id="ab12">\nerror log\n</pasted_content id="ab12">' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '## Result\n**Fixed** the `parse_tenant` bug:\n```php\n$a = 1;\n```' }] } },
    ));

    const { lastPrompt, lastReply } = await parseSession(file);

    assert.equal(lastPrompt, 'Look at this: error log');
    assert.equal(lastReply, 'Result Fixed the parse_tenant bug: $a = 1;');
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

describe('worktrees, artifacts and running turns', () => {
  const bash = (command) => ({ type: 'assistant', cwd: '/repo/app', message: { content: [{ type: 'tool_use', id: command, name: 'Bash', input: { command } }] } });
  const artifact = (id, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Artifact', input }] } });
  const result = (id, content, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

  it('finds worktrees made with git worktree add or the EnterWorktree tool', async () => {
    const existing = await mkdtemp(join(tmpdir(), 'csd-wt-'));
    try {
      const file = await writeSession('-wt', 'wt', lines(
        { type: 'user', cwd: '/repo/app', message: { content: 'go' } },
        bash('git worktree add --detach ../app-detached HEAD'),
        bash(`git worktree add -q -b feat/x "${existing}" origin/main`),
        bash('SP=/nonexistent/sp && git worktree add -q --detach $SP FETCH_HEAD'),
        bash('git worktree add ~/wt/home-one'),
        bash('git worktree add "$SET_IN_AN_EARLIER_COMMAND" main'),
        bash("grep -o 'git worktree add [^\"]*' notes.txt"),
        bash('echo "made with git worktree add or the tool" && cat <<EOF\nthen run git worktree add later\nEOF'),
        bash('cd /repo/app && git worktree add ../app-after-cd'),
        { type: 'assistant', cwd: '/repo/app', message: { content: [{ type: 'tool_use', id: 'e1', name: 'EnterWorktree', input: { name: 'quick-fix' } }] } },
      ));

      assert.deepEqual((await parseSession(file)).worktrees, [
        { path: '/repo/app-detached', exists: false },
        { path: existing, exists: true },
        { path: '/nonexistent/sp', exists: false },
        { path: join(homedir(), 'wt/home-one'), exists: false },
        { path: '/repo/app-after-cd', exists: false },
        { path: '/repo/app/.claude/worktrees/quick-fix', exists: false },
      ]);
    } finally {
      await rm(existing, { recursive: true, force: true });
    }
  });

  it('lists artifacts the session created, updated or opened', async () => {
    const file = await writeSession('-art', 'art', lines(
      artifact('p1', { file_path: '/s/plan.html' }), result('p1', 'Published /s/plan.html at https://claude.ai/code/artifact/plan (Version 1, version id x)'),
      artifact('p2', { file_path: '/s/plan.html' }), result('p2', 'Published /s/plan.html at https://claude.ai/code/artifact/plan (Version 2, version id y)'),
      artifact('r1', { action: 'read', url: 'https://claude.ai/artifact/shared?sk=secret' }), result('r1', '<html>'),
      artifact('u1', { url: 'https://claude.ai/artifact/shared', file_path: '/s/shared-v2.html' }), result('u1', 'Published /s/shared-v2.html at https://claude.ai/artifact/shared (Version 4, version id z)'),
      artifact('x1', { file_path: '/s/broken.html' }), result('x1', 'Publish refused', true),
      artifact('l1', { action: 'list' }), result('l1', 'https://claude.ai/artifact/other'),
      artifact('v1', { action: 'read', url: 'https://evil.example/x' }), result('v1', 'nope'),
    ));

    assert.deepEqual((await parseSession(file)).artifacts, [
      { url: 'https://claude.ai/code/artifact/plan', name: 'plan', change: 'created', version: 2 },
      { url: 'https://claude.ai/artifact/shared', name: 'shared-v2', change: 'updated', version: 4 },
    ]);
  });

  it('knows whether the last turn is still running', async () => {
    const turnOpen = async (id, ...events) => (await parseSession(await writeSession('-turn', id, lines(...events)))).turnOpen;
    const prompt = { type: 'user', message: { content: 'Do it' } };

    assert.equal(await turnOpen('running', prompt, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'sleep 60' } }] } }), true);
    assert.equal(await turnOpen('finished', prompt, { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }, { type: 'system', subtype: 'turn_duration' }), false);
    assert.equal(await turnOpen('interrupted', prompt, { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), false);
    assert.equal(await turnOpen('local-command', { type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } }), false);
  });
});

describe('listProjects', () => {
  it('lists projects by real folder path, newest first, hiding temp, empty and unreadable folders', async () => {
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
      await writeSession('-Users-me-unreadable', 'f', lines({ type: 'mode', mode: 'normal' }));

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

describe('server', () => {
  let server;
  let port;

  before(async () => {
    await writeSession(PROJECT, SESSION_ID, fullSession);
    server = createServer({ root });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const get = (path, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject).end();
  });

  it('serves the page', async () => {
    const response = await get('/');
    assert.equal(response.status, 200);
    assert.match(response.type, /text\/html/);
    assert.match(response.body, /<title>Claude Sessions<\/title>/);
  });

  it('serves projects and their sessions', async () => {
    const projects = JSON.parse((await get('/api/projects')).body);
    assert.ok(projects.some((project) => project.id === PROJECT && project.path === '/Users/me/code/app'));

    const sessions = JSON.parse((await get(`/api/projects/${encodeURIComponent(PROJECT)}/sessions`)).body);
    assert.equal(sessions[0].id, SESSION_ID);
  });

  it('answers 404 for unknown projects, traversal attempts and unknown routes', async () => {
    assert.equal((await get('/api/projects/nope/sessions')).status, 404);
    assert.equal((await get('/api/projects/..%2F..%2Fetc/sessions')).status, 404);
    assert.equal((await get('/api/projects/%E0%A4%A/sessions')).status, 404);
    assert.equal((await get('/secrets')).status, 404);
  });

  it('serves a session conversation and 404s unknown sessions', async () => {
    const response = await get(`/api/projects/${encodeURIComponent(PROJECT)}/sessions/${SESSION_ID}/messages`);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).map((item) => [item.kind, item.text]).slice(0, 2), [['command', '/clear'], ['user', 'Fix the login bug please']]);

    assert.equal((await get(`/api/projects/${encodeURIComponent(PROJECT)}/sessions/nope/messages`)).status, 404);
    assert.equal((await get(`/api/projects/${encodeURIComponent(PROJECT)}/sessions/..%2F${SESSION_ID}/messages`)).status, 404);
  });

  it('accepts localhost and rejects other Host headers', async () => {
    assert.equal((await get('/api/projects', `localhost:${port}`)).status, 200);
    assert.equal((await get('/api/projects', 'evil.example.com')).status, 403);
    assert.equal((await get('/api/projects', `evil.example.com:${port}`)).status, 403);
  });
});

describe('parseConversation', () => {
  const conversation = lines(
    { type: 'user', isMeta: true, message: { content: 'Caveat: hidden' }, timestamp: '2026-11-20T10:00:00.000Z' },
    { type: 'user', message: { content: '<command-message>ship</command-message>\n<command-name>/ship</command-name>\n<command-args>on that pr</command-args>' }, timestamp: '2026-11-20T10:00:01.000Z' },
    { type: 'user', message: { content: '<local-command-stdout>noise</local-command-stdout>' }, timestamp: '2026-11-20T10:00:02.000Z' },
    { type: 'user', message: { content: [{ type: 'text', text: 'Why is the sync slow?' }, { type: 'image', source: {} }] }, timestamp: '2026-11-20T10:00:03.000Z' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Let me check.' }] }, timestamp: '2026-11-20T10:00:04.000Z' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status', description: 'Show working tree status' } }] }, timestamp: '2026-11-20T10:00:05.000Z' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__supabase__execute_sql', input: { query: 'select 1' } }] }, timestamp: '2026-11-20T10:00:06.000Z' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'nothing to commit' }] }, timestamp: '2026-11-20T10:00:07.000Z' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'permission denied' }] }] }, timestamp: '2026-11-20T10:00:08.000Z' },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] }, timestamp: '2026-11-20T10:00:09.000Z' },
    { type: 'user', message: { content: '<task-notification>\n<task-id>x</task-id>\n<summary>Background build finished</summary>\n</task-notification>' }, timestamp: '2026-11-20T10:00:10.000Z' },
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: '2026-11-20T10:00:11.000Z' },
    { type: 'user', isCompactSummary: true, message: { content: 'Summary of earlier work' }, timestamp: '2026-11-20T10:00:12.000Z' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] }, timestamp: '2026-11-20T10:00:13.000Z' },
  );

  it('turns the transcript into chat items with tool results attached', async () => {
    const items = await parseConversation(await writeSession('-chat', 'chat', `${conversation}{"type":"user","mess`));

    assert.deepEqual(items.map(({ kind, text }) => [kind, text]), [
      ['command', '/ship on that pr'],
      ['user', 'Why is the sync slow?\n\n[Image]'],
      ['assistant', 'Let me check.'],
      ['tool', undefined],
      ['tool', undefined],
      ['event', 'Background build finished'],
      ['event', 'Interrupted by user'],
      ['compact', 'Summary of earlier work'],
      ['assistant', 'All done.'],
    ]);
    assert.deepEqual(
      items.filter((item) => item.kind === 'tool').map(({ name, summary, result, isError }) => ({ name, summary, result, isError })),
      [
        { name: 'Bash', summary: 'Show working tree status', result: 'nothing to commit', isError: false },
        { name: 'mcp__supabase__execute_sql', summary: 'select 1', result: 'permission denied', isError: true },
      ],
    );
    assert.equal(items[0].at, '2026-11-20T10:00:01.000Z');
  });

  it('clips very large tool output', async () => {
    const items = await parseConversation(await writeSession('-chat', 'big', lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'x'.repeat(10000) }] } },
    )));

    assert.ok(items[0].result.length < 6100);
    assert.match(items[0].result, /4000 more characters$/);
  });

  it('returns null for unknown projects and sessions', async () => {
    await writeSession('-chat', 'known', lines({ type: 'mode' }));

    assert.deepEqual(await readConversation(root, '-chat', 'known'), []);
    assert.equal(await readConversation(root, '-chat', 'unknown'), null);
    assert.equal(await readConversation(root, '-chat', '../-chat/known'), null);
    assert.equal(await readConversation(root, 'nope', 'known'), null);
  });
});
