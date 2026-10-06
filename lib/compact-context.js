const COMMON_COMMANDS = new Set([
  'ls', 'pwd', 'find', 'du', 'df', 'cat', 'head', 'tail', 'less', 'wc',
  'grep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'xargs',
  'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'chown', 'ln',
  'ps', 'top', 'kill', 'lsof', 'ss', 'date', 'uname', 'whoami',
  'curl', 'wget', 'tar', 'unzip', 'zip', 'git', 'jq', 'python3', 'node',
  'npm', 'docker', 'systemctl', 'launchctl', 'open', 'pbcopy', 'pbpaste',
]);

// Select useful names from a PATH scan; never launch programs to probe versions.
export function buildCompactCommandContext(installedCommands, userPrompt, packageManagers = []) {
  const installed = new Set(installedCommands);
  const mentioned = new Set(userPrompt.toLowerCase().match(/[a-z0-9_.+-]+/g) || []);
  const safeNames = installedCommands.filter(command => /^[a-z0-9_.+-]+$/i.test(command));
  const commands = [...new Set([
    ...safeNames.filter(command => mentioned.has(command.toLowerCase())),
    ...safeNames.filter(command => COMMON_COMMANDS.has(command)),
  ])].slice(0, 80);
  const managers = packageManagers.filter(manager => installed.has(manager.command));
  return [
    commands.length ? `Available commands (partial list): ${commands.join(', ')}.` : '',
    managers.length ? `Available package managers: ${managers.map(manager => `${manager.command} (${manager.installTemplate})`).join('; ')}.` : '',
    'Prefer standard OS tools or listed commands. This list is partial: an omitted command is not necessarily missing. Do not add installation steps unless needed for the task.',
  ].filter(Boolean).join('\n');
}
