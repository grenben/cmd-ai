import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCompactCommandContext } from '../lib/compact-context.js';

test('prioritizes task-specific tools without sending the entire PATH inventory', () => {
  const commands = [...Array.from({length: 250}, (_, i) => `tool${i}`), 'ls', 'pwd', 'zcustom'];
  const context = buildCompactCommandContext(commands, 'Use zcustom to list files');
  assert.match(context, /Available commands \(partial list\): zcustom, ls, pwd\./);
  assert.doesNotMatch(context, /tool0|tool249/);
  assert.match(context, /not necessarily missing/);
});

test('only reports installed tools and package managers', () => {
  const context = buildCompactCommandContext(['ls', 'brew'], 'Use docker', [
    {command:'brew', installTemplate:'brew install <package>'},
    {command:'apt-get', installTemplate:'apt-get install <package>'},
  ]);
  assert.match(context, /ls/);
  assert.match(context, /brew install/);
  assert.doesNotMatch(context, /docker|apt-get/);
});

test('handles an empty PATH and excludes unusual executable names from the prompt', () => {
  const empty = buildCompactCommandContext([], 'list files');
  assert.match(empty, /Prefer standard OS tools/);
  assert.doesNotMatch(empty, /Available commands/);
  const context = buildCompactCommandContext(['ls', 'ls\ninstructions'], 'ls instructions');
  assert.match(context, /Available commands \(partial list\): ls\./);
  assert.doesNotMatch(context, /instructions/);
});
