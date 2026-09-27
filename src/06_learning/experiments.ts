import { createHash } from 'node:crypto';
import { z } from 'zod';

// First-touch A/B experiment. Assignment is deterministic: the same lead always gets
// the same variant, with no stored state, so reruns and retries cannot switch a lead's
// treatment mid-round. Our leads are accounts, so the account is the randomisation unit.
//
// Freeze rules for a running round: never reorder `variants` or change the experiment
// id; both would reshuffle assignments. Start a new round (new id) to change anything.

export const VARIANT_IDS = ['variant_a_pain', 'variant_b_social_proof'] as const;
export const VariantIdSchema = z.enum(VARIANT_IDS);
export type VariantId = z.infer<typeof VariantIdSchema>;

export interface ExperimentVariant {
  id: VariantId;
  // {{placeholders}} filled by the drafter; the subject must stay within voice.md limits.
  subjectLineTemplate: string;
  angle: string;
  // The one sentence that changes between variants; everything else in the draft is fixed.
  bodyLineTemplate: string;
  // Extra review instruction attached to every draft of this variant, if any.
  reviewNote: string | null;
}

export interface Experiment {
  id: string;
  hypothesis: string;
  primaryMetric: 'meeting_booked_rate';
  // A review trigger, not a significance test: below it, a "winner" is only directional.
  minSendsPerVariant: number;
  variants: readonly [ExperimentVariant, ExperimentVariant];
}

export const FIRST_TOUCH_EXPERIMENT: Experiment = {
  id: 'first-touch-angle-001',
  hypothesis: 'Naming the persona pain point books more meetings than a social-proof line.',
  primaryMetric: 'meeting_booked_rate',
  minSendsPerVariant: 100,
  variants: [
    {
      id: 'variant_a_pain',
      subjectLineTemplate: 'your {{jobTitle}} hire',
      angle: "Pain: state the persona's top pain point as a common pattern, not a claim about them.",
      bodyLineTemplate: 'Often that means {{painPoint}}.',
      reviewNote: null,
    },
    {
      id: 'variant_b_social_proof',
      subjectLineTemplate: '{{company}} and lead qualification',
      angle: 'Social proof: cite an approved result from teams at a similar stage.',
      bodyLineTemplate: 'Teams at a similar stage use it to cut manual lead review.',
      reviewNote: 'Variant B makes a social-proof claim: confirm it is real and approved before sending.',
    },
  ],
};

// sha256 rather than FNV-1a: with FNV, `hash % 2` is just the parity of the character
// codes, so the split would correlate with how ids are spelled.
export function assignVariant(leadId: string, experiment: Experiment = FIRST_TOUCH_EXPERIMENT): ExperimentVariant {
  const key = `${experiment.id}:${leadId.trim().toLowerCase()}`;
  const bucket = createHash('sha256').update(key).digest().readUInt32BE(0) % experiment.variants.length;
  return experiment.variants[bucket]!;
}

export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    const value = vars[name];
    if (value === null || value === undefined || value === '') {
      missing.push(name);
      return placeholder;
    }
    return value;
  });
  return { text, missing };
}
