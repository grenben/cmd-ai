import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const CODEX_REASONING_OPTIONS = ['low', 'medium', 'high', 'xhigh'];

function subscriptionEnvironment() {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']) {
    delete env[key];
  }
  return env;
}

export async function checkCodexLogin() {
  let result;
  try {
    result = await execFileAsync('codex', ['login', 'status'], {
      env: subscriptionEnvironment(),
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Codex CLI was not found. Install it with "npm install -g @openai/codex", then run "codex login".');
    }
    if (error.killed) {
      throw new Error('Checking Codex login timed out. Run "codex login status" in your terminal.');
    }
    throw new Error('Could not verify your Codex login. Run "codex login" and sign in with ChatGPT.');
  }

  // Inspect the CLI's status, never its stored tokens or credential files.
  if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error('The codex provider requires a ChatGPT login. Run "codex login" and sign in with ChatGPT; API-key login is not used by this provider.');
  }
}

export async function generateCodexCommand({
  model = '', reasoningEffort = 'low', systemInstruction, userPrompt, explainMode,
}) {
  if (!CODEX_REASONING_OPTIONS.includes(reasoningEffort)) {
    throw new Error('Invalid Codex reasoning effort. Run "ai config" first.');
  }
  await checkCodexLogin();

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-ai-codex-'));
  const schemaPath = path.join(directory, 'schema.json');
  const outputPath = path.join(directory, 'response.json');
  const instructionsPath = path.join(directory, 'instructions.txt');
  let child;
  const cleanup = () => {
    child?.kill('SIGTERM');
    fs.rmSync(directory, { recursive: true, force: true });
  };
  process.once('exit', cleanup);

  try {
    fs.writeFileSync(schemaPath, JSON.stringify({
      type: 'object',
      properties: {
        commands: { type: 'array', items: { type: 'string' }, minItems: 1 },
        explanation: { type: ['string', 'null'] },
      },
      required: ['commands', 'explanation'],
      additionalProperties: false,
    }));
    fs.writeFileSync(instructionsPath, [
      'You generate shell command suggestions for a separate CLI.',
      'Never execute commands, call tools, read files, or modify anything.',
      'Return only the requested JSON. The user will review the commands before execution.',
      systemInstruction,
      explainMode ? 'Include a brief explanation.' : 'Set explanation to null.',
    ].join('\n'));

    const args = [
      '--no-daemon', 'exec',
      '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
      '--enable', 'skip_host_skill_discovery',
      '--sandbox', 'read-only', '--color', 'never',
      '--output-schema', schemaPath, '--output-last-message', outputPath,
      '-c', 'forced_login_method="chatgpt"',
      '-c', 'model_provider="openai"',
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      '-c', 'project_doc_max_bytes=0',
      '-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
      '-c', `model_instructions_file=${JSON.stringify(instructionsPath)}`,
    ];
    // Generate suggestions in an empty directory with action tools disabled.
    // In particular, never let Codex run commands before cmd-ai asks the user.
    for (const feature of [
      'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'hooks',
      'multi_agent', 'browser_use', 'computer_use', 'in_app_browser',
      'image_generation', 'code_mode', 'code_mode_host', 'view_image',
    ]) {
      args.push('--disable', feature);
    }
    if (model) args.push('--model', model);
    args.push('-');

    const pending = execFileAsync('codex', args, {
      cwd: directory,
      env: subscriptionEnvironment(),
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    child = pending.child;
    // A task is data, never shell text or a Codex command-line option.
    child.stdin.on('error', () => {});
    child.stdin.end(userPrompt);
    try {
      await pending;
    } catch (error) {
      if (error.killed) {
        throw new Error('Codex command generation timed out. Try again or lower the reasoning effort in "ai config".');
      }
      const details = (error.stderr || '').trim();
      if (/unexpected argument|unknown feature|unrecognized/i.test(details)) {
        throw new Error('This Codex CLI version does not support the required options. Update with "npm install -g @openai/codex".');
      }
      // Codex prints the prompt in stderr; only surface explicit error lines.
      const message = details.split('\n').filter(line => /^error[:\s]/i.test(line)).join('\n');
      throw new Error(message || 'Codex command generation failed. Check "codex login status" and your Codex usage limits.');
    }

    let output;
    try {
      output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    } catch {
      throw new Error('Codex did not return a complete JSON command response.');
    }
    if (!Array.isArray(output?.commands) || output.commands.length === 0 ||
        output.commands.some(command => typeof command !== 'string' || !command.trim()) ||
        !Object.hasOwn(output, 'explanation') ||
        (output.explanation !== null && typeof output.explanation !== 'string') ||
        (explainMode && (typeof output.explanation !== 'string' || !output.explanation.trim()))) {
      throw new Error('Codex returned an invalid command response.');
    }
    return JSON.stringify(output);
  } finally {
    process.removeListener('exit', cleanup);
    cleanup();
  }
}
