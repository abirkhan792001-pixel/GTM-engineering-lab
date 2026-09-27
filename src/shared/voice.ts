import { z } from 'zod';
import { readContextFile } from './profile';

// Machine-checkable rules parsed from voice.md (src/context/, or the GTM_PROFILE folder),
// so the prose guide the team edits is also what the draft linter enforces. A missing rule
// fails at load.

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

// The approved offer from an optional "## Offer" section (generated profiles have one):
//   - **What we offer:** ...   - **Ask:** ...?   - **Sign-off:** ...
// Drafts use these instead of the engine's built-in lines. The ask only counts when it is
// a question, because a first touch has exactly one question.
export interface VoiceOffer {
  offer?: string;
  ask?: string;
  signOff?: string;
}

export function parseVoiceOffer(markdown: string): VoiceOffer {
  const section = markdown.split(/^## Offer\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const field = (label: string) => section.match(new RegExp(`^- \\*\\*${label}:\\*\\*\\s*(.+)$`, 'm'))?.[1]?.trim() || undefined;
  const ask = field('Ask');
  return { offer: field('What we offer'), ask: ask?.endsWith('?') ? ask : undefined, signOff: field('Sign-off') };
}

export const VOICE_MARKDOWN = readContextFile('voice.md');
export const VOICE: VoiceGuidelines = parseVoiceGuidelines(VOICE_MARKDOWN);
export const VOICE_OFFER: VoiceOffer = parseVoiceOffer(VOICE_MARKDOWN);
