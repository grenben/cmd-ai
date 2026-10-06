import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkCodexLogin, generateCodexCommand } from '../lib/codex.js';

const cli = fileURLToPath(new URL('../bin/ai.js', import.meta.url));
const request = {
  systemInstruction: 'Generate zsh commands on macOS.',
  userPrompt: 'List files; $(do-not-run) `do-not-run` --dangerously-bypass-approvals-and-sandbox',
  reasoningEffort: 'low',
  explainMode: false,
};

function fixture(t, mode = 'ok') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-ai-codex-test-'));
  const trace = path.join(directory, 'trace.json');
  const original = { ...process.env };
  process.env.PATH = `${directory}${path.delimiter}${original.PATH}`;
  process.env.CMD_AI_CODEX_TEST_MODE = mode;
  process.env.CMD_AI_CODEX_TEST_TRACE = trace;
  process.env.OPENAI_API_KEY = 'test-api-key-not-for-use';
  process.env.CODEX_API_KEY = 'test-codex-key-not-for-use';
  process.env.CODEX_ACCESS_TOKEN = 'test-access-token-not-for-use';
  process.env.OPENAI_BASE_URL = 'https://unused.example.test';
  fs.writeFileSync(path.join(directory, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.CMD_AI_CODEX_TEST_MODE;
if (args[0] === 'login') {
  if (mode === 'logged-out') { process.stderr.write('Not logged in'); process.exit(1); }
  process.stderr.write(mode === 'api' ? 'Logged in using an API key' : 'Logged in using ChatGPT');
  process.exit(0);
}
const outputPath = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.CMD_AI_CODEX_TEST_TRACE, JSON.stringify({
    args, prompt, cwd:process.cwd(), outputPath,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN),
    hasBaseUrl: Boolean(process.env.OPENAI_BASE_URL),
    schema: JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')),
  }));
  if (mode === 'failure') { process.stderr.write('prompt that must not be echoed\\nERROR: usage limit reached'); process.exit(1); }
  if (mode === 'old-cli') { process.stderr.write('error: unexpected argument --ignore-user-config'); process.exit(2); }
  if (mode !== 'missing-output') {
    fs.writeFileSync(outputPath, mode === 'broken-json' ? '{"commands":[' : process.env.CMD_AI_CODEX_TEST_RESPONSE || JSON.stringify({commands:['ls'],explanation:null}));
  }
  process.stdout.write('Progress output is not a shell command.');
});
`, { mode: 0o755 });
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, trace };
}

test('requires a ChatGPT login and never falls back to an API key', async t => {
  const {trace} = fixture(t, 'api');
  await assert.rejects(generateCodexCommand(request), /requires a ChatGPT login/);
  assert.equal(fs.existsSync(trace), false);
});

test('reports missing CLI and logged-out sessions', async t => {
  const {directory} = fixture(t, 'logged-out');
  await assert.rejects(checkCodexLogin(), /codex login/);
  fs.unlinkSync(path.join(directory, 'codex'));
  process.env.PATH = directory;
  await assert.rejects(checkCodexLogin(), /Codex CLI was not found/);
});

test('isolates generation, removes API credentials, and passes tasks through stdin', async t => {
  const {trace} = fixture(t);
  const result = await generateCodexCommand(request);
  assert.deepEqual(JSON.parse(result), {commands:['ls'], explanation:null});
  const run = JSON.parse(fs.readFileSync(trace, 'utf8'));
  assert.equal(run.prompt, request.userPrompt);
  assert.equal(run.args.includes(request.userPrompt), false);
  assert.equal(run.args.at(-1), '-');
  assert.equal(run.hasApiKey, false);
  assert.equal(run.hasBaseUrl, false);
  assert.equal(process.env.OPENAI_API_KEY, 'test-api-key-not-for-use');
  assert.ok(run.args.includes('forced_login_method="chatgpt"'));
  assert.ok(run.args.includes('--ignore-user-config'));
  assert.ok(run.args.includes('--ephemeral'));
  assert.equal(run.args[run.args.indexOf('--sandbox') + 1], 'read-only');
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent']) {
    const index = run.args.indexOf(feature);
    assert.ok(index > 0);
    assert.equal(run.args[index - 1], '--disable');
  }
  assert.equal(run.args.includes('--model'), false);
  assert.notEqual(run.cwd, process.cwd());
  assert.equal(fs.existsSync(run.cwd), false);
  assert.equal(fs.existsSync(run.outputPath), false);
});

test('preserves model selection and explanations', async t => {
  const {trace} = fixture(t);
  process.env.CMD_AI_CODEX_TEST_RESPONSE = JSON.stringify({commands:['pwd'], explanation:'Print the working directory.'});
  const output = await generateCodexCommand({...request, model:'chosen-model', explainMode:true});
  assert.equal(JSON.parse(output).explanation, 'Print the working directory.');
  const run = JSON.parse(fs.readFileSync(trace, 'utf8'));
  assert.equal(run.args[run.args.indexOf('--model') + 1], 'chosen-model');
});

test('rejects malformed responses and cleans temporary output after failures', async t => {
  const {trace} = fixture(t);
  for (const mode of ['missing-output', 'broken-json', 'failure', 'old-cli']) {
    process.env.CMD_AI_CODEX_TEST_MODE = mode;
    const pattern = mode === 'failure' ? /^Error: ERROR: usage limit reached$/ :
      mode === 'old-cli' ? /Update with/ : /complete JSON command response/;
    await assert.rejects(generateCodexCommand(request), pattern);
    assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(trace, 'utf8')).cwd), false);
  }
  process.env.CMD_AI_CODEX_TEST_MODE = 'ok';
  for (const commands of [[], [''], [null], 'ls']) {
    process.env.CMD_AI_CODEX_TEST_RESPONSE = JSON.stringify({commands, explanation:null});
    await assert.rejects(generateCodexCommand(request), /invalid command response/);
  }
  process.env.CMD_AI_CODEX_TEST_RESPONSE = JSON.stringify({commands:['ls'], explanation:null});
  await assert.rejects(generateCodexCommand({...request, explainMode:true}), /invalid command response/);
});

test('CLI dry run and cancellation preserve the confirmation boundary and history', async t => {
  const {directory} = fixture(t);
  const configRoot = path.join(directory, 'config');
  const stateRoot = path.join(directory, 'state');
  const marker = path.join(directory, 'must-not-exist');
  const probeMarker = path.join(directory, 'version-probe-must-not-run');
  fs.writeFileSync(path.join(directory, 'python3'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(probeMarker)}, 'probed');\n`, {mode:0o755});
  fs.mkdirSync(path.join(configRoot, 'cmd-ai'), {recursive:true});
  fs.writeFileSync(path.join(configRoot, 'cmd-ai/config.json'), JSON.stringify({provider:'codex'}));
  process.env.CMD_AI_CODEX_TEST_RESPONSE = JSON.stringify({commands:[`touch '${marker}'`], explanation:'Create a file.'});
  for (const dryRun of [true, false]) {
    const child = spawn(process.execPath, [cli, 'Create a file', '--explain', ...(dryRun ? ['--dry'] : [])], {
      env: {...process.env, XDG_CONFIG_HOME:configRoot, XDG_STATE_HOME:stateRoot},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let prompted = false;
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!prompted && output.includes(dryRun ? '[Dry run] Press ENTER' : 'Do you want to run')) {
        prompted = true;
        assert.equal(fs.existsSync(marker), false);
        child.stdin.write(dryRun ? '\n' : 'n\n');
      }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, output);
    assert.equal(prompted, true);
    assert.match(output, /Provider: codex/);
    assert.match(output, /Create a file\./);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(probeMarker), false);
  }
  const history = JSON.parse(fs.readFileSync(path.join(stateRoot, 'cmd-ai/history.json')));
  assert.deepEqual(history.map(entry => [entry.provider, entry.executed, entry.notes]), [
    ['codex', false, 'Dry run'], ['codex', false, 'Cancelled by user'],
  ]);
});
