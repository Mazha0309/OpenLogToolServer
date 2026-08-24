import { AppConfig } from '../config';
import { AppError } from '../errors/app-error';

export interface JsonCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
}

export interface JsonCompletionClient {
  completeJson(request: JsonCompletionRequest): Promise<Record<string, unknown>>;
}

export interface LlmPublicConfiguration {
  configured: boolean;
  provider: AppConfig['llmProvider'];
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}

export function llmPublicConfiguration(
  config: AppConfig,
  apiKey = config.llmApiKey,
): LlmPublicConfiguration {
  return {
    configured: llmConfigured(config, apiKey),
    provider: config.llmProvider,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    timeoutSeconds: config.llmTimeoutSeconds,
  };
}

export function llmConfigured(config: AppConfig, apiKey = config.llmApiKey): boolean {
  return config.llmProvider !== 'disabled' &&
    config.llmBaseUrl.trim().length > 0 &&
    config.llmModel.trim().length > 0 &&
    apiKey.trim().length > 0;
}

export function requireLlmConfigured(config: AppConfig, apiKey = config.llmApiKey): void {
  if (llmConfigured(config, apiKey)) return;
  throw new AppError(
    503,
    'LLM_NOT_CONFIGURED',
    'The server LLM is not configured. Configure the provider, API Base URL, model, and API key in the administrator WebUI.',
  );
}

function endpoint(baseUrl: string, suffix: readonly string[]): URL {
  const base = new URL(baseUrl);
  const segments = base.pathname.split('/').filter(Boolean);
  if (suffix[0] === 'v1' && segments.at(-1) === 'v1') {
    segments.push(...suffix.slice(1));
  } else {
    segments.push(...suffix);
  }
  base.pathname = `/${segments.join('/')}`;
  base.search = '';
  return base;
}

function decodeObject(text: string): Record<string, unknown> {
  let source = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  if (fence) source = fence[1].trim();
  const candidates = [source];
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next bounded candidate. Never eval or repair arbitrary content.
    }
  }
  throw new AppError(
    502,
    'LLM_RESPONSE_NOT_JSON',
    'The configured LLM did not return a valid JSON object',
  );
}

function openAiResponsesText(value: Record<string, unknown>): string | null {
  if (typeof value.output_text === 'string' && value.output_text.trim()) {
    return value.output_text;
  }
  if (!Array.isArray(value.output)) return null;
  const parts: string[] = [];
  for (const item of value.output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const record = part as Record<string, unknown>;
      if (record.type === 'output_text' && typeof record.text === 'string') {
        parts.push(record.text);
      }
    }
  }
  const joined = parts.join('').trim();
  return joined || null;
}

function openAiChatText(value: Record<string, unknown>): string | null {
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return null;
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    return typeof record.text === 'string' ? [record.text] : [];
  });
  return parts.join('').trim() || null;
}

function anthropicText(value: Record<string, unknown>): string | null {
  if (!Array.isArray(value.content)) return null;
  const parts = value.content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
  return parts.join('').trim() || null;
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new AppError(502, 'LLM_INVALID_RESPONSE', 'The configured LLM returned invalid JSON');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new AppError(502, 'LLM_INVALID_RESPONSE', 'The configured LLM returned an invalid response');
  }
  return decoded as Record<string, unknown>;
}

function modelUsesCompletionTokens(model: string): boolean {
  return model.trim().toLowerCase().startsWith('mimo-v2.5');
}

function retryableRequestShapeError(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'LLM_HTTP_ERROR') return false;
  const status = Number((error.details as { upstreamStatus?: unknown } | undefined)?.upstreamStatus);
  return status === 400 || status === 422;
}

function openAiChatReachedOutputLimit(value: Record<string, unknown>): boolean {
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const choice = choices[0];
  return Boolean(
    choice &&
    typeof choice === 'object' &&
    !Array.isArray(choice) &&
    (choice as Record<string, unknown>).finish_reason === 'length',
  );
}

export class HttpJsonCompletionClient implements JsonCompletionClient {
  constructor(private readonly config: AppConfig) {}

  async completeJson(request: JsonCompletionRequest): Promise<Record<string, unknown>> {
    requireLlmConfigured(this.config);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.llmTimeoutSeconds * 1_000,
    );
    try {
      const text = await this.requestText(request, controller.signal);
      return decodeObject(text);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppError(504, 'LLM_TIMEOUT', 'The configured LLM request timed out');
      }
      throw new AppError(502, 'LLM_REQUEST_FAILED', 'The configured LLM request failed', undefined, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestText(
    request: JsonCompletionRequest,
    signal: AbortSignal,
  ): Promise<string> {
    switch (this.config.llmProvider) {
      case 'openai-responses':
        return this.openAiResponses(request, signal);
      case 'openai-chat':
        return this.openAiChat(request, signal);
      case 'anthropic':
        return this.anthropic(request, signal);
      case 'disabled':
        requireLlmConfigured(this.config);
        throw new AppError(503, 'LLM_NOT_CONFIGURED', 'The server LLM is disabled');
    }
  }

  private async post(
    url: URL,
    body: Record<string, unknown>,
    signal: AbortSignal,
    additionalHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
        ...additionalHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new AppError(
        502,
        'LLM_HTTP_ERROR',
        `The configured LLM returned HTTP ${response.status}`,
        { upstreamStatus: response.status },
      );
    }
    return responseObject(response);
  }

  private async postWithShapeFallbacks(
    url: URL,
    bodies: readonly Record<string, unknown>[],
    signal: AbortSignal,
    additionalHeaders: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (const [index, body] of bodies.entries()) {
      try {
        return await this.post(url, body, signal, additionalHeaders);
      } catch (error) {
        lastError = error;
        if (index === bodies.length - 1 || !retryableRequestShapeError(error)) throw error;
      }
    }
    throw lastError;
  }

  private async openAiResponses(
    request: JsonCompletionRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const baseBody = {
      model: this.config.llmModel,
      instructions: request.systemPrompt,
      input: request.userPrompt,
      max_output_tokens: request.maxOutputTokens,
      stream: false,
    };
    const decoded = await this.postWithShapeFallbacks(
      endpoint(this.config.llmBaseUrl, ['responses']),
      [{
        ...baseBody,
        reasoning: { effort: 'none' },
        text: { format: { type: 'json_object' } },
      }, baseBody],
      signal,
      { authorization: `Bearer ${this.config.llmApiKey}` },
    );
    const text = openAiResponsesText(decoded);
    if (!text) throw new AppError(502, 'LLM_EMPTY_RESPONSE', 'The configured LLM returned no text');
    return text;
  }

  private async openAiChat(
    request: JsonCompletionRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const tokenField = modelUsesCompletionTokens(this.config.llmModel)
      ? 'max_completion_tokens'
      : 'max_tokens';
    const maxOutputTokens = Math.max(1_024, request.maxOutputTokens);
    const baseBody = {
      model: this.config.llmModel,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      stream: false,
    };
    const decoded = await this.postWithShapeFallbacks(
      endpoint(this.config.llmBaseUrl, ['chat', 'completions']),
      [{
        ...baseBody,
        temperature: 0,
        [tokenField]: maxOutputTokens,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      }, {
        ...baseBody,
        thinking: { type: 'disabled' },
      }, {
        ...baseBody,
        [tokenField]: maxOutputTokens,
      }],
      signal,
      { authorization: `Bearer ${this.config.llmApiKey}` },
    );
    if (openAiChatReachedOutputLimit(decoded)) {
      throw new AppError(
        502,
        'LLM_OUTPUT_LIMIT',
        'The configured LLM reached its output limit before returning complete JSON',
      );
    }
    const text = openAiChatText(decoded);
    if (!text) throw new AppError(502, 'LLM_EMPTY_RESPONSE', 'The configured LLM returned no text');
    return text;
  }

  private async anthropic(
    request: JsonCompletionRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const decoded = await this.post(
      endpoint(this.config.llmBaseUrl, ['v1', 'messages']),
      {
        model: this.config.llmModel,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.userPrompt }],
        max_tokens: request.maxOutputTokens,
        temperature: 0,
      },
      signal,
      {
        'x-api-key': this.config.llmApiKey,
        'anthropic-version': '2023-06-01',
      },
    );
    const text = anthropicText(decoded);
    if (!text) throw new AppError(502, 'LLM_EMPTY_RESPONSE', 'The configured LLM returned no text');
    return text;
  }
}
