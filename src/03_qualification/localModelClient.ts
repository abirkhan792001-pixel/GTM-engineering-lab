import { z } from 'zod';
import { ClaudeQualificationSchema, type ClaudeClient } from './evaluator';

// Free, local alternative to the Claude client: talks to an Ollama server
// (https://ollama.com) running on your machine instead of the Anthropic API. No API key and
// no per-request cost.
//
// It implements the one method the evaluator calls (`messages.parse`), so it drops into the
// `client` option and everything else is unchanged: the same prompt, the same structured
// output schema, and the same deterministic policy (decide(), required-field re-check) on
// top of the model's answer. Unreachable servers and unparsable output fall back to a safe
// 'hold', exactly as a Claude failure does.
//
// Setup: install Ollama, `ollama pull llama3.2`, and leave it running. Small local models
// follow the rubric less reliably than Claude, so expect more holds and compare against
// the offline scorer (npm run qualify:local does this).

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';
// A qualification answer needs a few hundred tokens. The cap stops a small model that
// loops (repeating text inside the JSON) instead of letting it run for minutes.
export const DEFAULT_OLLAMA_MAX_OUTPUT_TOKENS = 1024;
// Whole-request backstop, including loading the model into memory on a slow machine.
export const DEFAULT_OLLAMA_TIMEOUT_MS = 600_000;
// Context window (prompt + answer) in tokens. Ollama's own default is small (2-4k on many
// versions) and it silently drops the start of a longer prompt, which is where the rules
// are. 8k fits a qualification prompt and its answer with room to spare.
export const DEFAULT_OLLAMA_CONTEXT_TOKENS = 8192;

// The Response subset used, so tests can inject a fake with no network access.
export type OllamaFetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

export interface OllamaClientOptions {
  baseUrl?: string;
  fetch?: OllamaFetchLike;
  maxOutputTokens?: number;
  timeoutMs?: number;
  contextTokens?: number;
}

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

// Qualification answers are constrained to this schema (with real enums, which Ollama
// enforces while generating; Anthropic's format helper only describes them).
const QUALIFICATION_SCHEMA = z.toJSONSchema(ClaudeQualificationSchema);

export interface OllamaChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  // JSON schema the answer must follow.
  schema: unknown;
}

export interface OllamaChatResult {
  text: string;
  // 'length' when the token cap cut the answer off.
  doneReason: string | undefined;
}

// One structured-output chat call to Ollama. Throws with a readable message when Ollama is
// unreachable, answers with an error, or times out.
export function createOllamaChat(options: OllamaClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  const doFetch: OllamaFetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_OLLAMA_MAX_OUTPUT_TOKENS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
  const contextTokens = options.contextTokens ?? DEFAULT_OLLAMA_CONTEXT_TOKENS;
  const failure = (what: string, error: unknown) =>
    new Error(
      error instanceof Error && error.name === 'TimeoutError'
        ? `Ollama did not finish within ${Math.round(timeoutMs / 1000)}s`
        : `${what}: ${error instanceof Error ? error.message : String(error)}`,
    );

  return async (request: OllamaChatRequest): Promise<OllamaChatResult> => {
    let res: Awaited<ReturnType<OllamaFetchLike>>;
    try {
      // Streamed: Ollama sends response headers at once and tokens as it generates them.
      // Unstreamed, it replies only when finished, and Node's fetch gives up after 300s
      // without response headers, which a slow laptop can exceed.
      res = await doFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          format: request.schema,
          stream: true,
          options: { temperature: 0, num_predict: maxOutputTokens, num_ctx: contextTokens },
        }),
      });
    } catch (error) {
      throw failure(`could not reach Ollama at ${baseUrl} (is it running?)`, error);
    }
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);

    let raw: string;
    try {
      raw = await res.text();
    } catch (error) {
      throw failure('Ollama stopped mid-answer', error);
    }

    // Newline-delimited JSON: one chunk of the answer per line, then a final line saying
    // why generation stopped.
    let text = '';
    let doneReason: string | undefined;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let chunk: OllamaChunk;
      try {
        chunk = JSON.parse(line) as OllamaChunk;
      } catch {
        throw new Error(`unreadable reply from Ollama: ${line.slice(0, 80)}`);
      }
      if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
      text += chunk.message?.content ?? '';
      if (chunk.done) doneReason = chunk.done_reason;
    }
    return { text, doneReason };
  };
}

interface ParseParams {
  model: string;
  system?: string;
  messages: { role: string; content: unknown }[];
}

export function createOllamaClient(options: OllamaClientOptions = {}): ClaudeClient {
  const chat = createOllamaChat(options);

  const parse = async (params: ParseParams) => {
    const messages = [
      ...(params.system ? [{ role: 'system', content: params.system }] : []),
      ...params.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
    ];
    const { text, doneReason } = await chat({ model: params.model, messages, schema: QUALIFICATION_SCHEMA });

    // 'length' means the token cap cut the answer off; the evaluator reports it as truncated.
    if (doneReason === 'length') return { stop_reason: 'max_tokens', parsed_output: null, content: [] };

    let parsed_output: unknown = null;
    try {
      parsed_output = JSON.parse(text);
    } catch {
      // Left null: the evaluator treats it as "no structured output" and holds the lead.
    }
    return { stop_reason: 'end_turn', parsed_output, content: [] };
  };

  return { messages: { parse } } as unknown as ClaudeClient;
}
