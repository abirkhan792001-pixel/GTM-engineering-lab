import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Machine-checkable rules parsed from src/context/voice.md, so the prose guide the
// team edits is also what the draft linter enforces. A missing rule fails at load.

export const VoiceGuidelinesSchema = z.strictObject({
  firstTouchMaxWords: z.number().int().positive(),
  subjectMaxWords: z.number().int().positive(),
  sentenceMaxWords: z.number().int().positive(),
  bannedBuzzwords: z.array(z.string().min(1)).min(1),
});
export type VoiceGuidelines = z.infer<typeof VoiceGuidelinesSchema>;

export function parseVoiceGuidelines(markdown: string): VoiceGuidelines {
  const number = (pattern: RegExp, label: string): number => {
    const match = markdown.match(pattern);
    if (!match?.[1]) throw new Error(`voice.md: could not find the ${label} rule (${pattern})`);
    return Number(match[1]);
  };
  const bannedSection = markdown.split(/^## Banned buzzwords\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  return VoiceGuidelinesSchema.parse({
    firstTouchMaxWords: number(/first touch ≤ (\d+) words/, 'first-touch length'),
    subjectMaxWords: number(/Subject line ≤ (\d+) words/, 'subject length'),
    sentenceMaxWords: number(/Aim for ≤ (\d+) words/, 'sentence length'),
    bannedBuzzwords: bannedSection
      .split(',')
      .map(word => word.trim().toLowerCase())
      .filter(Boolean),
  });
}

export const VOICE_MARKDOWN = readFileSync(new URL('../context/voice.md', import.meta.url), 'utf8');
export const VOICE: VoiceGuidelines = parseVoiceGuidelines(VOICE_MARKDOWN);
