import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { loadConfig } from '../src/config';
import { HttpJsonCompletionClient } from '../src/llm/json-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request() {
  return {
    systemPrompt: 'Return JSON only.',
    userPrompt: 'Read the worksheet.',
    maxOutputTokens: 2_048,
  };
}

test('OpenAI-compatible Chat retries with the baseline legacy request shape', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      body,
      authorization: headers.get('authorization'),
    });
    if (calls.length < 3) {
      return new Response('{"error":"unsupported field"}', { status: 400 });
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"records":[]}' } }],
    }), { status: 200 });
  };

  const config = loadConfig({
    LLM_PROVIDER: 'openai-chat',
    LLM_BASE_URL: 'https://llm.example/v1/',
    LLM_MODEL: 'generic-chat-model',
    LLM_API_KEY: 'write-only-secret',
  });
  const result = await new HttpJsonCompletionClient(config).completeJson(request());

  assert.deepEqual(result, { records: [] });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer write-only-secret');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.equal(calls[1].body.response_format, undefined);
  assert.deepEqual(calls[1].body.thinking, { type: 'disabled' });
  assert.equal(calls[2].body.thinking, undefined);
  assert.equal(calls[2].body.max_tokens, 2_048);
});

test('OpenAI Responses retries without optional reasoning and JSON-mode fields', async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (bodies.length === 1) return new Response('{}', { status: 422 });
    return new Response(JSON.stringify({ output_text: '```json\n{"records":[]}\n```' }), {
      status: 200,
    });
  };

  const config = loadConfig({
    LLM_PROVIDER: 'openai-responses',
    LLM_BASE_URL: 'https://llm.example/v1',
    LLM_MODEL: 'responses-model',
    LLM_API_KEY: 'secret',
  });
  const result = await new HttpJsonCompletionClient(config).completeJson(request());

  assert.deepEqual(result, { records: [] });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].reasoning, { effort: 'none' });
  assert.deepEqual(bodies[0].text, { format: { type: 'json_object' } });
  assert.equal(bodies[1].reasoning, undefined);
  assert.equal(bodies[1].text, undefined);
});

test('MiMo v2.5 Chat uses max_completion_tokens', async () => {
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
    }), { status: 200 });
  };

  const config = loadConfig({
    LLM_PROVIDER: 'openai-chat',
    LLM_BASE_URL: 'https://api.xiaomimimo.com/v1',
    LLM_MODEL: 'mimo-v2.5-flash',
    LLM_API_KEY: 'secret',
  });
  await new HttpJsonCompletionClient(config).completeJson(request());

  assert.equal(body?.max_tokens, undefined);
  assert.equal(body?.max_completion_tokens, 2_048);
});
