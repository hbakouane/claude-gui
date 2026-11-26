import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectsRoot } from '../src/sessions.js';

describe('projectsRoot', () => {
  it('respects CLAUDE_CONFIG_DIR', () => {
    assert.equal(projectsRoot({ CLAUDE_CONFIG_DIR: '/custom' }), '/custom/projects');
    assert.ok(projectsRoot({}).endsWith('/.claude/projects'));
  });
});
