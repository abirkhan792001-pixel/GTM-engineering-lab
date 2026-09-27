import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { createOllamaChat, type ClaudeClient, type OllamaClientOptions } from '../03_qualification/index';

// The model that turns research sources into structured answers. Two implementations:
// Claude (paid, strongest) and a local model through Ollama (free). Each answer is
// constrained to a JSON schema and validated again by the caller.

export interface StructuredModel {
  name: string;
  generate(request: { schema: z.ZodType; system: string; prompt: string }): Promise<unknown>;
}

export class ResearchModelError extends Error {}

export function claudeResearchModel(client: ClaudeClient, model: string): StructuredModel {
  return {
    name: model,
    async generate({ schema, system, prompt }) {
      const response = await client.messages.parse({
        model,
        max_tokens: 16000,
        output_config: { effort: 'medium', format: zodOutputFormat(schema) },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason === 'refusal') throw new ResearchModelError('the model declined the request');
      if (response.stop_reason === 'max_tokens') throw new ResearchModelError('the answer was cut off at the token limit');
      return response.parsed_output;
    },
  };
}

// Research prompts are much longer than a qualification prompt and answers are bigger, so
// the local model gets a larger context window, a larger answer cap and more time.
export const OLLAMA_RESEARCH_DEFAULTS: OllamaClientOptions = { contextTokens: 16384, maxOutputTokens: 4096, timeoutMs: 1_200_000 };

export function ollamaResearchModel(model: string, options: OllamaClientOptions = {}): StructuredModel {
  const chat = createOllamaChat({ ...OLLAMA_RESEARCH_DEFAULTS, ...options });
  return {
    name: `${model} (local, Ollama)`,
    async generate({ schema, system, prompt }) {
      const { text, doneReason } = await chat({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        schema: z.toJSONSchema(schema),
      });
      if (doneReason === 'length') throw new ResearchModelError('the answer was cut off at the token limit (the model may be repeating itself; a larger model usually helps)');
      try {
        return JSON.parse(text);
      } catch {
        throw new ResearchModelError('the model did not return valid JSON');
      }
    },
  };
}
