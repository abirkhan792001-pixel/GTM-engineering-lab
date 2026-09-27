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

// The Response subset used, so tests can inject a fake with no network access.
export type OllamaFetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text' | 'json'>>;

export interface OllamaClientOptions {
  baseUrl?: string;
  fetch?: OllamaFetchLike;
}

// Ollama constrains generation to this JSON schema, the same shape Claude is asked for.
const OUTPUT_SCHEMA = z.toJSONSchema(ClaudeQualificationSchema);

interface ParseParams {
  model: string;
  system?: string;
  messages: { role: string; content: unknown }[];
}

export function createOllamaClient(options: OllamaClientOptions = {}): ClaudeClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  const doFetch: OllamaFetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  const parse = async (params: ParseParams) => {
    const messages = [
      ...(params.system ? [{ role: 'system', content: params.system }] : []),
      ...params.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
    ];

    let res: Awaited<ReturnType<OllamaFetchLike>>;
    try {
      res = await doFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: params.model, messages, format: OUTPUT_SCHEMA, stream: false, options: { temperature: 0 } }),
      });
    } catch (error) {
      throw new Error(`could not reach Ollama at ${baseUrl} (is it running?): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const body = (await res.json()) as { message?: { content?: string } };
    let parsed_output: unknown = null;
    try {
      parsed_output = JSON.parse(body.message?.content ?? '');
    } catch {
      // Left null: the evaluator treats it as "no structured output" and holds the lead.
    }
    return { stop_reason: 'end_turn', parsed_output, content: [] };
  };

  return { messages: { parse } } as unknown as ClaudeClient;
}
