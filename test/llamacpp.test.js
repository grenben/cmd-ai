import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeLlamaCppBaseUrl,
  getLlamaCppModels,
  generateLlamaCppCommand,
} from '../lib/llamacpp.js';

const request = {
  baseUrl: 'http://localhost:8080',
  model: 'shell-model',
  systemInstruction: 'Generate shell commands for zsh.',
  userPrompt: 'List files',
  explainMode: false,
};

function completion(content, finishReason = 'stop') {
  return Response.json({
    choices: [{ finish_reason: finishReason, message: { content } }],
  });
}

test('accepts server roots or API roots and rejects invalid endpoints', () => {
  assert.equal(normalizeLlamaCppBaseUrl('localhost:8080'), 'http://localhost:8080/v1');
  assert.equal(normalizeLlamaCppBaseUrl(' https://example.test/proxy/v1/ '), 'https://example.test/proxy/v1');
  assert.equal(normalizeLlamaCppBaseUrl('http://[::1]:8080/'), 'http://[::1]:8080/v1');
  for (const invalid of ['', null, 'not a host', 'ftp://localhost',
    'http://user:secret@localhost', 'http://localhost?key=secret', 'http://localhost#fragment']) {
    assert.throws(() => normalizeLlamaCppBaseUrl(invalid));
  }
});

test('discovers server model IDs without using a cloud key', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://localhost:8080/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ data: [{ id: 'custom-model' }, { id: 'custom-model' }, { id: '' }, {}] });
  });
  assert.deepEqual(await getLlamaCppModels(request.baseUrl), ['custom-model']);
});

test('sends the task and shell context to the configured chat endpoint', async t => {
  const output = JSON.stringify({ commands: ['ls -la'] });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://localhost:8080/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, undefined);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, request.model);
    assert.deepEqual(payload.messages, [
      { role: 'system', content: request.systemInstruction },
      { role: 'user', content: request.userPrompt },
    ]);
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.response_format.schema.required, ['commands']);
    return completion(output);
  });
  assert.equal(await generateLlamaCppCommand(request), output);
});

test('explanation mode requires and preserves an explanation', async t => {
  const output = JSON.stringify({ commands: ['pwd'], explanation: 'Show the current directory.' });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.ok(payload.response_format.schema.required.includes('explanation'));
    return completion(output);
  });
  assert.equal(await generateLlamaCppCommand({ ...request, explainMode: true }), output);
});

test('fails before parsing commands when output is truncated or malformed', async t => {
  const cases = [
    ['{"commands":["ls"]}', 'length', /truncated/],
    ['ls -la', 'stop', /valid command JSON/],
    [undefined, 'stop', /valid command JSON/],
    ['null', 'stop', /invalid command response/],
    ['{"commands":[]}', 'stop', /invalid command response/],
    ['{"commands":[" "]}', 'stop', /invalid command response/],
    ['{"commands":[42]}', 'stop', /invalid command response/],
  ];
  for (const [content, finish, message] of cases) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => completion(content, finish));
    await assert.rejects(generateLlamaCppCommand(request), message);
    mocked.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => completion('{"commands":["ls"]}'));
  await assert.rejects(generateLlamaCppCommand({ ...request, explainMode: true }), /invalid command response/);
});

test('reports server and connection failures', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: 'Model is loading' } }, { status: 503 }));
  await assert.rejects(getLlamaCppModels(request.baseUrl), /503.*Model is loading/);
  mocked.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Connection refused'); });
  await assert.rejects(getLlamaCppModels(request.baseUrl), /Could not reach llama.cpp.*Connection refused/);
});

test('rejects non-JSON or invalid model lists and accepts an empty list', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'));
  await assert.rejects(getLlamaCppModels(request.baseUrl), /invalid JSON/);
  mocked.mock.restore();
  const invalid = t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [] }));
  await assert.rejects(getLlamaCppModels(request.baseUrl), /invalid model list/);
  invalid.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
  assert.deepEqual(await getLlamaCppModels(request.baseUrl), []);
});

test('requires a model before making a request', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(generateLlamaCppCommand({ ...request, model: '' }), /Missing llama.cpp model/);
  assert.equal(mocked.mock.callCount(), 0);
});
