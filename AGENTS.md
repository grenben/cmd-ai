# cmd-ai Agent Notes

## What This Project Is
`cmd-ai` is an npm package that installs a global `ai` command for terminal use.

Primary flow:
- user writes a natural-language task, e.g. `ai list files`
- provider generates shell command(s)
- CLI shows the proposed command
- user confirms execution
- command runs (or is skipped by `--dry`, cancellation, or safety block)

## Current Providers
Configured with `ai config`.

Supported providers:
- `codex` (default): uses `codex exec` with an existing ChatGPT subscription login
- `ollama`: uses local Ollama models selected from `ollama list`
- `llamacpp`: uses a configurable llama.cpp HTTP(S) server through `/v1/chat/completions`, with models discovered from `/v1/models`
- `openai`: uses OpenAI Codex models through the Responses API
- `gemini`: uses Google Gemini models through `generateContent`
- `claude`: uses Anthropic Claude models through the Messages API

### Codex subscription behavior
- requires a recent Codex CLI installed on PATH and `codex login` with ChatGPT
- verifies login using `codex login status`, without reading stored tokens
- ignores API-key environment variables and enforces ChatGPT authentication
- stores optional `codexModel` (empty means the CLI's built-in default) and `codexReasoningEffort` (default `low`)
- uses `codex exec` in a temporary directory, with user config ignored, action tools disabled, read-only sandbox, and schema-constrained JSON output
- tasks are passed through stdin; generated commands still pass through the normal danger filter, confirmation, dry-run, and history paths
- uses a compact PATH inventory of common/task-mentioned commands and package managers without launching version probes
- existing explicitly configured providers are retained until changed via `ai config`

### OpenAI API (hardcoded model list, separately billed)
- `gpt-5.3-codex`
- `gpt-5.3-codex-spark`
- `gpt-5.2-codex`
- `gpt-5.1-codex`
- `gpt-5.1-codex-max`

Configurable in CLI:
- API key
- model
- reasoning effort (`low`/`medium`/`high`, plus `xhigh` for `gpt-5.3-codex` and `gpt-5.2-codex`)

### Gemini (hardcoded model list)
- `gemini-3.1-pro-preview`
- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`

Configurable in CLI:
- API key
- model
- reasoning effort (`low`/`medium`/`high`)

Implementation detail:
- Gemini 3.x models use `thinkingConfig.thinkingLevel`
- Gemini 2.5 models use `thinkingConfig.thinkingBudget` mapped from effort

### Claude (hardcoded model list)
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`

Configurable in CLI:
- API key
- model
- reasoning effort (`low`/`medium`/`high`; `max` also available for `claude-opus-4-6`)

Implementation detail:
- reasoning effort is sent via `output_config.effort` for supported models (`opus` and `sonnet`)
- `claude-haiku-4-5` is supported as a model choice, but effort control is not applied in this CLI path

### Ollama behavior
- checks that `ollama` command exists
- fetches local models from `ollama list`
- user picks one model in `ai config`
- selected model is stored in config and used for prompt generation

### llama.cpp behavior
- `ai config` prompts for the endpoint and discovers models from the server
- stores `llamacppBaseUrl` (including `/v1`) and `llamacppModel` in config
- uses schema-constrained JSON for commands and optional explanations
- uses a concise shell/OS prompt without the command inventory for small models
- rejects truncated or malformed responses before command parsing
- requires no local Ollama installation; currently supports servers without authentication

## Commands and Flags
Commands:
- `ai <task>`
- `ai config`
- `ai history`
- `ai man`
- `ai install-autocomplete`

Flags:
- `--explain`
- `--dry`
- `--help` / `-h`
- `--version`

## Config and History Files
Config:
- `$XDG_CONFIG_HOME/cmd-ai/config.json`
- fallback when `XDG_CONFIG_HOME` is unset: `~/.config/cmd-ai/config.json`
- legacy read compatibility: `~/.ai-config.json`

History:
- `$XDG_STATE_HOME/cmd-ai/history.json`
- fallback when `XDG_STATE_HOME` is unset: `~/.local/state/cmd-ai/history.json`
- legacy read compatibility: `~/.ai-command-history.json`

History entry fields:
- `timestamp`
- `prompt`
- `command`
- `executed`
- `provider`
- optional `notes`

History is trimmed to the latest 1000 entries before append.

## Safety and Execution
- proposed commands pass through a danger-pattern filter before execution
- obviously risky commands are not auto-executed and are logged
- execution still requires user confirmation (unless cancelled/dry run path)
- execution prefers `process.execve` handoff when available (non-Windows runtimes that support it), with fallback to `child_process.exec`

## Output Parsing
Generated provider output is parsed by:
- extracting fenced code blocks when present
- otherwise finding first command-like line
- stripping shell prompt noise and wrappers
- separating explanation from command when `--explain` is on

## Autocomplete
`ai install-autocomplete`:
- copies `cmd-ai-completion.sh` to `$XDG_DATA_HOME/cmd-ai/cmd-ai-completion.sh`
- fallback when `XDG_DATA_HOME` is unset: `~/.local/share/cmd-ai/cmd-ai-completion.sh`
- updates shell rc source line to that XDG path when possible

## Core Files
- CLI logic: `bin/ai.js`
- Codex subscription backend: `lib/codex.js`
- Codex command context: `lib/compact-context.js`
- llama.cpp server backend: `lib/llamacpp.js`
- Provider and confirmation-flow tests: `test/` (`npm test`, also run by `dev:check`)
- shell completion script: `cmd-ai-completion.sh`
- package metadata + bin mapping: `package.json`
- docs: `README.md`
- release helper: `scripts/release.mjs`

## Release flow

Use this for future releases:

1. Decide release kind:
   - `fix` (patch)
   - `feature` (minor)
   - `breaking` (major)
2. Run:

```bash
npm run release
```

`npm run release` does all of the following:
- verifies required scripts exist in `package.json` (`dev:check`, `lint`)
- runs `npm run dev:check`
- runs `npm run lint` (required) and `npm run dev:pack` (optional) checks if present
- prompts for release kind if not passed as an argument (or accepts:
  - `npm run release -- fix`
  - `npm run release -- feature`
  - `npm run release -- breaking`
  )
- runs `npm version` without creating a git tag directly, then creates an annotated release commit and tag
- creates an annotated version tag (default `npm version` format)
- pushes commit and tags
- runs `npm publish` (supports interactive OTP prompt or `NPM_OTP` env var when 2FA is required)
- prints the published package version

If you prefer manual steps, run these in order:

```bash
npm run dev:check
npm run lint
npm run dev:pack
npm version patch # or minor/major
git push --follow-tags
npm publish
```

## Known Limitations
- model lists are intentionally hardcoded; updating requires code changes in `bin/ai.js`
- `install-autocomplete` copies the bundled `cmd-ai-completion.sh` from the installed package path and sources it from the XDG data path
- safety filter is pattern-based, not a full shell parser/sandbox
