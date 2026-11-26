import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listTerminals, shellQuote, terminalCommand } from '../src/resume.js';
import { createServer, RESUME_HEADER } from '../src/server.js';

const SESSION_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';

describe('terminalCommand', () => {
  it('opens Terminal on macOS by default', () => {
    assert.deepEqual(terminalCommand({ platform: 'darwin', terminal: 'terminal', cwd: '/Users/me/app', sessionId: SESSION_ID }), ['osascript', [
      '-e', `tell application "Terminal" to do script "cd /Users/me/app && claude --resume ${SESSION_ID}"`,
      '-e', 'tell application "Terminal" to activate',
    ]]);
  });

  it('opens a new iTerm window when asked', () => {
    const [command, args] = terminalCommand({ platform: 'darwin', terminal: 'iterm', cwd: '/Users/me/app', sessionId: SESSION_ID });

    assert.equal(command, 'osascript');
    assert.ok(args.includes(`tell current session of newWindow to write text "cd /Users/me/app && claude --resume ${SESSION_ID}"`));
  });

  it('quotes awkward folder names for both the shell and AppleScript', () => {
    const [, args] = terminalCommand({ platform: 'darwin', terminal: 'terminal', cwd: `/Users/me/it's "my" app`, sessionId: SESSION_ID });

    assert.equal(args[1], `tell application "Terminal" to do script "cd '/Users/me/it'\\\\''s \\"my\\" app' && claude --resume ${SESSION_ID}"`);
  });

  it('uses x-terminal-emulator on Linux and keeps the shell open', () => {
    assert.deepEqual(terminalCommand({ platform: 'linux', terminal: 'terminal', cwd: '/home/me/app', sessionId: SESSION_ID }), ['x-terminal-emulator', [
      '-e', 'sh', '-c', `cd /home/me/app && claude --resume ${SESSION_ID}; exec "\${SHELL:-sh}"`,
    ]]);
  });

  it('uses a new cmd window on Windows', () => {
    assert.deepEqual(terminalCommand({ platform: 'win32', terminal: 'terminal', cwd: 'C:\\code\\app', sessionId: SESSION_ID }), ['cmd', [
      '/c', 'start', '', 'cmd', '/k', `cd /d "C:\\code\\app" && claude --resume ${SESSION_ID}`,
    ]]);
  });

  it('opens other macOS terminals as a new app instance running the resume script', () => {
    const script = `cd /Users/me/app && claude --resume ${SESSION_ID}; exec "\${SHELL:-sh}"`;
    const run = (terminal) => terminalCommand({ platform: 'darwin', terminal, cwd: '/Users/me/app', sessionId: SESSION_ID });

    assert.deepEqual(run('ghostty'), ['open', ['-na', 'Ghostty', '--args', '-e', 'sh', '-c', script]]);
    assert.deepEqual(run('wezterm'), ['open', ['-na', 'WezTerm', '--args', 'start', '--', 'sh', '-c', script]]);
    assert.deepEqual(run('kitty'), ['open', ['-na', 'kitty', '--args', 'sh', '-c', script]]);
    assert.deepEqual(run('alacritty'), ['open', ['-na', 'Alacritty', '--args', '-e', 'sh', '-c', script]]);
  });

  it('runs the chosen Linux terminal, and Windows Terminal in the session folder', () => {
    const script = `cd /home/me/app && claude --resume ${SESSION_ID}; exec "\${SHELL:-sh}"`;
    const linux = (terminal) => terminalCommand({ platform: 'linux', terminal, cwd: '/home/me/app', sessionId: SESSION_ID });

    assert.deepEqual(linux('gnome-terminal'), ['gnome-terminal', ['--', 'sh', '-c', script]]);
    assert.deepEqual(linux('konsole'), ['konsole', ['-e', 'sh', '-c', script]]);
    assert.deepEqual(linux('wezterm'), ['wezterm', ['start', '--', 'sh', '-c', script]]);
    assert.deepEqual(terminalCommand({ platform: 'win32', terminal: 'wt', cwd: 'C:\\code\\app', sessionId: SESSION_ID }), ['wt', ['-d', 'C:\\code\\app', 'cmd', '/k', `claude --resume ${SESSION_ID}`]]);
  });

  it('falls back to the platform default for a terminal from another platform', () => {
    assert.equal(terminalCommand({ platform: 'darwin', terminal: 'konsole', cwd: '/x', sessionId: SESSION_ID })[0], 'osascript');
    assert.equal(terminalCommand({ platform: 'linux', terminal: 'iterm', cwd: '/x', sessionId: SESSION_ID })[0], 'x-terminal-emulator');
    assert.equal(terminalCommand({ platform: 'win32', terminal: 'ghostty', cwd: 'C:\\x', sessionId: SESSION_ID })[0], 'cmd');
  });

  it('refuses session ids that are not plain identifiers', () => {
    assert.throws(() => terminalCommand({ platform: 'darwin', cwd: '/x', sessionId: 'abc; rm -rf ~' }), /Invalid session id/);
  });

  it('only quotes values that need it', () => {
    assert.equal(shellQuote('/Users/me/app-1.2'), '/Users/me/app-1.2');
    assert.equal(shellQuote('/Users/me/my app'), `'/Users/me/my app'`);
  });
});

describe('listTerminals', () => {
  const installed = (options) => listTerminals(options).filter((t) => t.installed).map((t) => t.id);

  it('finds macOS apps by their bundle, and always offers Terminal', () => {
    const apps = new Set(['/Applications/Ghostty.app', '/Applications/iTerm.app']);
    assert.deepEqual(installed({ platform: 'darwin', exists: (path) => apps.has(path) }), ['terminal', 'iterm', 'ghostty']);
    assert.deepEqual(listTerminals({ platform: 'darwin', exists: () => false }).map((t) => t.label), ['Terminal', 'iTerm2', 'Ghostty', 'WezTerm', 'kitty', 'Alacritty']);
  });

  it('finds Linux and Windows terminals on the PATH', () => {
    const bins = new Set(['/usr/bin/konsole', '/opt/bin/kitty', 'C:/tools/wt.exe']);
    const exists = (path) => bins.has(path.replace(/\\/g, '/'));

    assert.deepEqual(installed({ platform: 'linux', env: { PATH: '/usr/bin:/opt/bin' }, exists }), ['default', 'konsole', 'kitty']);
    assert.deepEqual(installed({ platform: 'linux', env: {}, exists }), ['default']);
    assert.deepEqual(installed({ platform: 'win32', env: { PATH: 'C:/tools' }, exists }).sort(), ['cmd', 'wt']);
  });
});

describe('POST /api/resume', () => {
  let root;
  let server;
  let port;
  let launched;

  const post = (body, headers = { 'x-requested-with': RESUME_HEADER }, method = 'POST') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/resume', method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'csd-resume-'));
    const cwd = await mkdtemp(join(tmpdir(), 'csd-cwd-'));
    await mkdir(join(root, '-proj'));
    await writeFile(join(root, '-proj', `${SESSION_ID}.jsonl`), `${JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })}\n`);
    await writeFile(join(root, '-proj', 'gone.jsonl'), `${JSON.stringify({ type: 'user', cwd: join(cwd, 'deleted'), message: { content: 'hi' } })}\n`);
    server = createServer({ root, platform: 'darwin', terminal: 'terminal', launch: async (command, args) => { launched.push([command, args]); } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  it('opens a terminal that resumes the session in its folder', async () => {
    launched = [];
    const response = await post({ projectId: '-proj', sessionId: SESSION_ID });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { opened: true, restored: false });
    assert.equal(launched.length, 1);
    assert.equal(launched[0][0], 'osascript');
    assert.match(launched[0][1][1], new RegExp(`claude --resume ${SESSION_ID}`));
  });

  it('opens the terminal chosen in Settings, and validates the choice', async () => {
    const configFile = join(root, 'config.json');
    const chooser = createServer({ root, configFile, platform: 'darwin', launch: async (command, args) => { launched.push([command, args]); } });
    await new Promise((resolve) => chooser.listen(0, '127.0.0.1', resolve));
    const call = (path, method, body) => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: chooser.address().port, path, method, headers: { 'content-type': 'application/json', 'x-requested-with': RESUME_HEADER } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

    try {
      const settings = (await call('/api/settings', 'GET')).body;
      assert.deepEqual([settings.terminal, settings.defaultTerminal], [null, 'terminal']);
      assert.deepEqual(settings.terminals.map((t) => t.id), ['terminal', 'iterm', 'ghostty', 'wezterm', 'kitty', 'alacritty']);

      assert.equal((await call('/api/settings', 'POST', { terminal: 'konsole' })).status, 400);
      assert.equal((await call('/api/settings', 'POST', { terminal: 7 })).status, 400);
      assert.equal((await call('/api/settings', 'POST', { terminal: 'ghostty' })).body.terminal, 'ghostty');

      launched = [];
      await call('/api/resume', 'POST', { projectId: '-proj', sessionId: SESSION_ID });
      assert.deepEqual(launched[0].slice(0, 1).concat(launched[0][1].slice(0, 3)), ['open', '-na', 'Ghostty', '--args']);

      assert.equal((await call('/api/settings', 'POST', { terminal: null })).body.terminal, null);
      launched = [];
      await call('/api/resume', 'POST', { projectId: '-proj', sessionId: SESSION_ID });
      assert.equal(launched[0][0], 'osascript');
    } finally {
      await new Promise((resolve) => chooser.close(resolve));
    }
  });

  it('rejects requests without the dashboard header, which blocks other websites', async () => {
    launched = [];

    assert.equal((await post({ projectId: '-proj', sessionId: SESSION_ID }, {})).status, 400);
    assert.equal(launched.length, 0);
  });

  it('only accepts POST', async () => {
    assert.equal((await post('', { 'x-requested-with': RESUME_HEADER }, 'GET')).status, 405);
  });

  it('404s unknown sessions, unknown projects, traversal and bad bodies', async () => {
    launched = [];

    assert.equal((await post({ projectId: '-proj', sessionId: 'nope' })).status, 404);
    assert.equal((await post({ projectId: 'nope', sessionId: SESSION_ID })).status, 404);
    assert.equal((await post({ projectId: '-proj', sessionId: `../-proj/${SESSION_ID}` })).status, 404);
    assert.equal((await post('not json')).status, 404);
    assert.equal((await post('x'.repeat(20000))).status, 404);
    assert.equal(launched.length, 0);
  });

  it('409s when the session folder no longer exists', async () => {
    launched = [];

    assert.equal((await post({ projectId: '-proj', sessionId: 'gone' })).status, 409);
    assert.equal(launched.length, 0);
  });
});
