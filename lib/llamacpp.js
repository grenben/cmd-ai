export function normalizeLlamaCppBaseUrl(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) {
    throw new Error('Missing llama.cpp endpoint. Run "ai config" first.');
  }

  let url;
  try {
    url = new URL(input.includes('://') ? input : `http://${input}`);
  } catch {
    throw new Error('Invalid llama.cpp endpoint. Use an HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS llama.cpp endpoint without credentials, query, or fragment.');
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  return url.toString().replace(/\/+$/, '');
}

async function requestLlamaCpp(baseUrl, route, payload) {
  const url = `${normalizeLlamaCppBaseUrl(baseUrl)}/${route}`;
  let response;
  try {
    response = await fetch(url, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json' } : {},
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(payload ? 60000 : 10000),
    });
  } catch (error) {
    throw new Error(`Could not reach llama.cpp at ${url}: ${error.message}`);
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `llama.cpp request failed (${response.status}): ${data?.error?.message || response.statusText}`
    );
  }
  if (!data) {
    throw new Error('llama.cpp returned an invalid JSON response.');
  }
  return data;
}

export async function getLlamaCppModels(baseUrl) {
  const data = await requestLlamaCpp(baseUrl, 'models');
  if (!Array.isArray(data.data)) {
    throw new Error('llama.cpp returned an invalid model list.');
  }
  return [...new Set(data.data
    .map(model => model?.id)
    .filter(id => typeof id === 'string' && id.trim()))];
}

export async function generateLlamaCppCommand({
  baseUrl, model, systemInstruction, userPrompt, explainMode,
}) {
  if (!model) {
    throw new Error('Missing llama.cpp model. Run "ai config" first.');
  }

  const properties = {
    commands: { type: 'array', items: { type: 'string' }, minItems: 1 },
  };
  if (explainMode) {
    properties.explanation = { type: 'string' };
  }
  const data = await requestLlamaCpp(baseUrl, 'chat/completions', {
    model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    temperature: 0,
    max_tokens: explainMode ? 1200 : 400,
    response_format: {
      type: 'json_object',
      schema: {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
  });

  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('llama.cpp response was truncated; try a simpler task.');
  }
  const content = choice?.message?.content;
  let output;
  try {
    output = JSON.parse(content);
  } catch {
    throw new Error('llama.cpp did not return valid command JSON.');
  }
  if (!Array.isArray(output?.commands) || output.commands.length === 0 ||
      output.commands.some(command => typeof command !== 'string' || !command.trim()) ||
      (explainMode && typeof output.explanation !== 'string')) {
    throw new Error('llama.cpp returned an invalid command response.');
  }
  return content;
}
