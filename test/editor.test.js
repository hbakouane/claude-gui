import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { editorCommand, EDITORS } from '../src/editor.js';
import { createServer, RESUME_HEADER } from '../src/server.js';

describe('editorCommand', () => {
  it('opens the app by name on macOS, so the editor CLI does not need to be installed', () => {
    assert.deepEqual(editorCommand({ platform: 'darwin', editor: 'vscode', dir: '/Users/me/my app' }), ['open', ['-a', 'Visual Studio Code', '/Users/me/my app']]);
    assert.deepEqual(editorCommand({ platform: 'darwin', editor: 'phpstorm', dir: '/x' }), ['open', ['-a', 'PhpStorm', '/x']]);
  });

  it('uses the editor CLI on Linux and through cmd on Windows', () => {
    assert.deepEqual(editorCommand({ platform: 'linux', editor: 'cursor', dir: '/home/me/app' }), ['cursor', ['/home/me/app']]);
    assert.deepEqual(editorCommand({ platform: 'win32', editor: 'zed', dir: 'C:\\code\\app' }), ['cmd', ['/c', 'zed', 'C:\\code\\app']]);
  });

  it('refuses editors it does not know', () => {
    assert.throws(() => editorCommand({ platform: 'darwin', editor: 'notepad', dir: '/x' }), /Unknown editor/);
  });

  it('has a label, app name and CLI for every editor', () => {
    for (const [id, editor] of Object.entries(EDITORS)) {
      assert.ok(editor.label && editor.app && editor.cli, id);
    }
  });
});

describe('POST /api/open-editor', () => {
  const SESSION = 'eeee1111-ffff-2222-aaaa-333344445555';
  let scratch;
  let projectDir;
  let worktree;
  let server;
  let port;
  let opened;
  let failNext;

  const post = (body, headers = { 'x-requested-with': RESUME_HEADER }, method = 'POST') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/open-editor', method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'csd-editor-'));
    projectDir = join(scratch, 'app');
    worktree = join(scratch, 'app-fix');
    await mkdir(projectDir);
    await mkdir(worktree);
    await mkdir(join(scratch, 'projects', 'p'), { recursive: true });
    await writeFile(join(scratch, 'projects', 'p', `${SESSION}.jsonl`), [
      { type: 'user', cwd: projectDir, message: { content: 'go' } },
      { type: 'assistant', cwd: projectDir, message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: `git worktree add ${worktree}` } }] } },
    ].map((event) => JSON.stringify(event)).join('\n'));
    server = createServer({ root: join(scratch, 'projects'), editor: 'cursor', platform: 'linux', openFolder: async (command, args) => {
      if (failNext) {
        failNext = false;
        throw new Error('spawn cursor ENOENT');
      }
      opened.push([command, args]);
    } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });

  it("opens the session's folder in the chosen editor", async () => {
    opened = [];
    const response = await post({ projectId: 'p', sessionId: SESSION });

    assert.equal(response.status, 200);
    assert.deepEqual(opened, [['cursor', [projectDir]]]);
  });

  it('opens one of the session worktrees when asked', async () => {
    opened = [];
    assert.equal((await post({ projectId: 'p', sessionId: SESSION, path: worktree })).status, 200);
    assert.deepEqual(opened, [['cursor', [worktree]]]);
  });

  it('refuses folders that do not belong to the session', async () => {
    opened = [];
    for (const path of ['/etc', scratch, `${projectDir}/..`]) {
      assert.equal((await post({ projectId: 'p', sessionId: SESSION, path })).status, 400, path);
    }
    assert.deepEqual(opened, []);
  });

  it('reports unknown sessions, a missing header, the wrong method and a failed launch', async () => {
    assert.equal((await post({ projectId: 'p', sessionId: 'nope' })).status, 404);
    assert.equal((await post({ projectId: 'p', sessionId: SESSION }, {})).status, 400);
    assert.equal((await post(undefined, { 'x-requested-with': RESUME_HEADER }, 'GET')).status, 405);
    failNext = true;
    const failed = await post({ projectId: 'p', sessionId: SESSION });
    assert.equal(failed.status, 409);
    assert.match(failed.body.error, /Could not open Cursor/);
  });

  it('reports a folder that was deleted since', async () => {
    await rm(worktree, { recursive: true });
    assert.equal((await post({ projectId: 'p', sessionId: SESSION, path: worktree })).status, 409);
  });
});
