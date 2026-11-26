import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createNotifier, sessionChanges } from '../src/notify.js';
import { createServer } from '../src/server.js';
import { activeSessions, parseSession } from '../src/sessions.js';

const lines = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const prompt = (text) => ({ type: 'user', cwd: '/Users/me/app', message: { content: text }, timestamp: new Date().toISOString() });
const ask = (id, question) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question, header: 'DB', options: [] }] } }] } });
const answer = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Postgres' }] } });
const reply = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const endTurn = { type: 'system', subtype: 'turn_duration' };

let scratch;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'csd-notify-'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function parse(...events) {
  const file = join(scratch, `${Math.random().toString(36).slice(2)}.jsonl`);
  await writeFile(file, lines(...events));
  return parseSession(file);
}

describe('waitingFor', () => {
  it('reports a question Claude asked that has no answer yet, with its text', async () => {
    assert.deepEqual((await parse(prompt('Add search'), ask('q1', 'Which database should I use?'))).waitingFor, { kind: 'question', text: 'Which database should I use?' });
  });

  it('reports a plan waiting for approval', async () => {
    const plan = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: '1. Do it' } }] } };
    assert.deepEqual((await parse(prompt('Plan it'), plan)).waitingFor, { kind: 'plan', text: 'A plan is ready for your review' });
  });

  it('clears once the question is answered, rejected, or the turn ends', async () => {
    assert.equal((await parse(prompt('Add search'), ask('q1', 'Which?'), answer('q1'))).waitingFor, null);
    assert.equal((await parse(prompt('Add search'), ask('q1', 'Which?'), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'rejected', is_error: true }] } })).waitingFor, null);
    assert.equal((await parse(prompt('Add search'), ask('q1', 'Which?'), endTurn)).waitingFor, null);
  });
});

describe('sessionChanges', () => {
  const snap = (...entries) => new Map(entries.map((e) => [`p/${e.sessionId}`, { projectId: 'p', title: `Session ${e.sessionId}`, turnOpen: false, waitingFor: null, lastReply: null, ...e }]));

  it('reports finished turns and new questions, once each', () => {
    const before = snap({ sessionId: 'a', turnOpen: true }, { sessionId: 'b', turnOpen: true }, { sessionId: 'c', turnOpen: true });
    const after = snap(
      { sessionId: 'a', turnOpen: false, lastReply: 'All 14 tests pass.' },
      { sessionId: 'b', turnOpen: true, waitingFor: { kind: 'question', text: 'Which DB?' } },
      { sessionId: 'c', turnOpen: true },
    );

    assert.deepEqual(sessionChanges(before, after), [
      { projectId: 'p', sessionId: 'a', title: 'Session a', type: 'finished', detail: 'All 14 tests pass.' },
      { projectId: 'p', sessionId: 'b', title: 'Session b', type: 'question', detail: 'Which DB?' },
    ]);
    assert.deepEqual(sessionChanges(after, after), []);
  });

  it('treats a session it has not seen before as idle', () => {
    const after = snap({ sessionId: 'new', turnOpen: true, waitingFor: { kind: 'plan', text: 'A plan is ready for your review' } }, { sessionId: 'busy', turnOpen: true }, { sessionId: 'done', turnOpen: false });

    assert.deepEqual(sessionChanges(new Map(), after).map((e) => [e.sessionId, e.type]), [['new', 'plan']]);
  });
});

describe('createNotifier', () => {
  it('scans only while someone listens, and takes a baseline before reporting changes', async () => {
    let scans = 0;
    let turnOpen = true;
    const notifier = createNotifier({ intervalMs: 60_000, scan: async () => { scans++; return new Map([['p/a', { projectId: 'p', sessionId: 'a', title: 'A', turnOpen, waitingFor: null }]]); } });
    const events = [];

    const stop = notifier.subscribe((event) => events.push(event));
    await notifier.poll();
    assert.deepEqual(events, []);

    turnOpen = false;
    await notifier.poll();
    assert.deepEqual(events.map((e) => e.type), ['finished']);

    stop();
    const count = scans;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(scans, count);
  });
});

describe('activeSessions', () => {
  it('lists only recently written sessions, with their turn and waiting state', async () => {
    const root = join(scratch, 'active');
    await mkdir(join(root, '-Users-me-app'), { recursive: true });
    await writeFile(join(root, '-Users-me-app', 'live.jsonl'), lines(prompt('Go'), ask('q', 'Ready?')));

    const active = await activeSessions(root);
    assert.deepEqual(active.get('-Users-me-app/live'), { projectId: '-Users-me-app', sessionId: 'live', title: 'Go', turnOpen: true, waitingFor: { kind: 'question', text: 'Ready?' }, lastReply: null });
    assert.equal((await activeSessions(root, { now: Date.now() + 3600_000 })).size, 0);
  });
});

describe('GET /api/events', () => {
  let server;
  let port;
  let file;

  before(async () => {
    const root = join(scratch, 'events');
    await mkdir(join(root, '-Users-me-app'), { recursive: true });
    file = join(root, '-Users-me-app', 'run.jsonl');
    await writeFile(file, lines(prompt('Fix the build')));
    server = createServer({ root, watchIntervalMs: 30 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('streams a notification when a running session finishes its turn', async () => {
    const received = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` } }, (res) => {
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          const data = /^data: (.+)$/m.exec(buffer);
          if (data) {
            req.destroy();
            resolve(JSON.parse(data[1]));
          }
        });
      });
      req.on('error', (error) => (error.code === 'ECONNRESET' ? null : reject(error)));
      req.end();
      // Wait for the baseline scan, then finish the turn.
      setTimeout(() => appendFile(file, lines(reply('The build is green.'), endTurn)), 150);
    });

    assert.deepEqual(received, { projectId: '-Users-me-app', sessionId: 'run', title: 'Fix the build', type: 'finished', detail: 'The build is green.' });
  });
});
