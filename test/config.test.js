import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configPath, DEFAULT_PORT, expandHome, readConfig, resolveClaudeDir, startupOptions, writeConfig } from '../src/config.js';
import { createServer, RESUME_HEADER } from '../src/server.js';

let scratch;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'csd-config-'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('resolveClaudeDir', () => {
  it('prefers the flag, then the saved setting, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    const env = { CLAUDE_CONFIG_DIR: '/env/claude' };

    assert.deepEqual(resolveClaudeDir({ flag: '/flag/claude', saved: '/saved/claude', env }), { claudeDir: '/flag/claude', source: 'flag' });
    assert.deepEqual(resolveClaudeDir({ saved: '/saved/claude', env }), { claudeDir: '/saved/claude', source: 'settings' });
    assert.deepEqual(resolveClaudeDir({ env }), { claudeDir: '/env/claude', source: 'env' });
    assert.deepEqual(resolveClaudeDir({ env: {} }), { claudeDir: join(homedir(), '.claude'), source: 'default' });
  });

  it('expands ~ and relative paths in the flag', () => {
    assert.equal(resolveClaudeDir({ flag: '~/work/.claude', env: {} }).claudeDir, join(homedir(), 'work/.claude'));
    assert.equal(resolveClaudeDir({ flag: 'rel/claude', env: {} }).claudeDir, join(process.cwd(), 'rel/claude'));
  });

  it('ignores a saved value that is not an absolute path', () => {
    assert.equal(resolveClaudeDir({ saved: 'relative/path', env: {} }).source, 'default');
    assert.equal(resolveClaudeDir({ saved: 42, env: {} }).source, 'default');
  });
});

describe('startupOptions', () => {
  it('uses the flags first, then the saved settings, then the defaults', () => {
    assert.deepEqual(startupOptions({}), { port: DEFAULT_PORT, openBrowser: true });
    assert.deepEqual(startupOptions({ config: { port: 5000, openBrowser: false } }), { port: 5000, openBrowser: false });
    assert.deepEqual(startupOptions({ flags: { port: '6000', 'no-open': true }, config: { port: 5000, openBrowser: true } }), { port: 6000, openBrowser: false });
  });

  it('ignores a saved port that is out of range or not a number', () => {
    assert.equal(startupOptions({ config: { port: 80 } }).port, DEFAULT_PORT);
    assert.equal(startupOptions({ config: { port: '5000' } }).port, DEFAULT_PORT);
  });
});

describe('config file', () => {
  it('lives under XDG_CONFIG_HOME, or ~/.config by default', () => {
    assert.equal(configPath({ XDG_CONFIG_HOME: '/xdg' }), '/xdg/claude-gui/config.json');
    assert.equal(configPath({}), join(homedir(), '.config/claude-gui/config.json'));
  });

  it('round-trips, and reads a missing, broken or non-object file as empty', async () => {
    const file = join(scratch, 'nested', 'config.json');
    assert.deepEqual(await readConfig(file), {});

    await writeConfig(file, { claudeDir: '/x' });
    assert.deepEqual(await readConfig(file), { claudeDir: '/x' });

    await writeFile(file, '{ not json');
    assert.deepEqual(await readConfig(file), {});
    await writeFile(file, '[1, 2]');
    assert.deepEqual(await readConfig(file), {});
  });

  it('expands ~ only at the start of a path', () => {
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('  ~/a  '), join(homedir(), 'a'));
    assert.equal(expandHome('/a/~/b'), '/a/~/b');
  });
});

describe('settings API', () => {
  let server;
  let port;
  let defaultDir;
  let otherDir;
  let configFile;

  const call = (method, body, headers = { 'x-requested-with': RESUME_HEADER }) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/settings', method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const projects = () => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/projects', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(JSON.parse(text).map((project) => project.path)));
    }).on('error', reject).end();
  });

  before(async () => {
    defaultDir = join(scratch, 'default-claude');
    otherDir = join(scratch, 'other-claude');
    configFile = join(scratch, 'settings', 'config.json');
    for (const [dir, cwd] of [[defaultDir, '/Users/me/default-project'], [otherDir, '/Users/me/other-project']]) {
      await mkdir(join(dir, 'projects', 'p'), { recursive: true });
      await writeFile(join(dir, 'projects', 'p', 's.jsonl'), `${JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })}\n`);
    }
    await mkdir(join(scratch, 'not-claude'), { recursive: true });
    server = createServer({ claudeDir: defaultDir, source: 'env', configFile, env: { CLAUDE_CONFIG_DIR: defaultDir } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('reports the folder in use and where it came from', async () => {
    const { body } = await call('GET');

    assert.deepEqual([body.claudeDir, body.projectsDir, body.source, body.configFile], [defaultDir, join(defaultDir, 'projects'), 'env', configFile]);
    assert.deepEqual([body.editor, body.openBrowser, body.port, body.defaultPort, body.runningPort], ['vscode', true, null, DEFAULT_PORT, port]);
    assert.ok(body.editors.some((editor) => editor.id === 'cursor' && editor.label === 'Cursor'));
  });

  it('switches to a new folder right away and saves it', async () => {
    const response = await call('POST', { claudeDir: otherDir });

    assert.equal(response.status, 200);
    assert.equal(response.body.source, 'settings');
    assert.deepEqual(await projects(), ['/Users/me/other-project']);
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), { claudeDir: otherDir });
  });

  it('rejects folders without a projects folder and relative paths, keeping the current folder', async () => {
    const missing = await call('POST', { claudeDir: join(scratch, 'not-claude') });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /No projects folder/);

    assert.equal((await call('POST', { claudeDir: 'relative/claude' })).status, 400);
    assert.equal((await call('POST', { claudeDir: 7 })).status, 400);
    assert.equal((await call('POST', { color: 'red' })).status, 400);
    assert.deepEqual(await projects(), ['/Users/me/other-project']);
  });

  it('refuses changes without the dashboard header, so other websites cannot change it', async () => {
    const response = await call('POST', { claudeDir: defaultDir }, {});

    assert.equal(response.status, 400);
    assert.deepEqual(await projects(), ['/Users/me/other-project']);
  });

  it('resets to the environment or default folder and forgets the saved one', async () => {
    await writeConfig(configFile, { claudeDir: otherDir, somethingElse: true });
    const response = await call('POST', { claudeDir: null });

    assert.equal(response.status, 200);
    assert.deepEqual([response.body.claudeDir, response.body.source], [defaultDir, 'env']);
    assert.deepEqual(await projects(), ['/Users/me/default-project']);
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), { somethingElse: true });
  });

  it('saves the editor, browser and port choices together', async () => {
    const response = await call('POST', { editor: 'cursor', openBrowser: false, port: 5005 });

    assert.equal(response.status, 200);
    assert.deepEqual([response.body.editor, response.body.openBrowser, response.body.port], ['cursor', false, 5005]);
    const saved = JSON.parse(await readFile(configFile, 'utf8'));
    assert.deepEqual([saved.editor, saved.openBrowser, saved.port], ['cursor', false, 5005]);
  });

  it('rejects unknown editors, non-boolean browser choices and bad ports without saving anything', async () => {
    for (const body of [{ editor: 'notepad' }, { editor: 'toString' }, { openBrowser: 'yes' }, { port: 80 }, { port: 70000 }, { port: 5000.5 }, { port: '5000' }, { editor: 'zed', port: 1 }]) {
      assert.equal((await call('POST', body)).status, 400, JSON.stringify(body));
    }
    const saved = JSON.parse(await readFile(configFile, 'utf8'));
    assert.deepEqual([saved.editor, saved.openBrowser, saved.port], ['cursor', false, 5005]);
  });

  it('forgets the saved port when sent null', async () => {
    const response = await call('POST', { port: null });

    assert.equal(response.body.port, null);
    assert.equal('port' in JSON.parse(await readFile(configFile, 'utf8')), false);
  });

  it('only allows GET and POST', async () => {
    assert.equal((await call('DELETE')).status, 405);
  });
});
