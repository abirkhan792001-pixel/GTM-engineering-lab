import { mergedEnrichmentData } from '../../02_enrichment/index';
import { PERSONAS, selectPersona, type Persona } from '../../shared/personas';
import { EmailDraftSchema, type EmailDraft, type Lead, type Signal } from '../../shared/types';
import { VOICE, type VoiceGuidelines } from '../../shared/voice';

// Simulates drafting a first touch (as an LLM would) for a Resend-style sender.
// Safeguard: this adapter has no send method. It only produces DRAFTs that need
// human approval; sending an approved draft is a separate, later step.
//
// Copy rules come from src/context/voice.md: the draft uses one observation taken
// from the signal that qualification scored, and is linted against the parsed
// limits and banned words. Failed checks become review notes; they are never hidden.

export interface EmailAdapter {
  generateDraft(lead: Lead): Promise<EmailDraft>;
}

export interface EmailOptions {
  voice?: VoiceGuidelines;
  personas?: Persona[];
  senderName?: string;
  // The approved offer, stated plainly. No claims beyond this sentence go in the copy.
  offer?: string;
  cta?: string;
}

const DEFAULT_OFFER = 'We build lead qualification pipelines where every score cites its evidence.';
const DEFAULT_CTA = 'Worth sending you a one-page diagram of how it works?';

// Signal and enrichment text is untrusted input. Only short, plain strings are
// allowed into copy; anything else is dropped rather than quoted.
function safeText(value: unknown): string | null {
  return typeof value === 'string' && /^[\p{L}\p{N} &'.,/-]{1,80}$/u.test(value.trim()) ? value.trim() : null;
}

function companyName(lead: Lead): string {
  for (const signal of lead.signals) {
    const name = safeText(signal.rawData.companyName);
    if (name) return name;
  }
  const label = lead.companyDomain.split('.')[0] ?? lead.companyDomain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// The signal qualification counted as strongest, identified by its id in the evidence.
function scoredSignal(lead: Lead): { signal: Signal; evidenceLine: string } | null {
  for (const line of lead.qualification?.evidence ?? []) {
    const id = line.match(/^Fresh .*\[(.+)\]$/)?.[1];
    const signal = id ? lead.signals.find(s => s.id === id) : undefined;
    if (signal) return { signal, evidenceLine: line };
  }
  return null;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function lint(subject: string, body: string, voice: VoiceGuidelines): EmailDraft['checks'] {
  const bodyWords = words(body).length;
  const sentences = body.split(/(?<=[.?!])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const longSentences = sentences.filter(s => words(s).length > voice.sentenceMaxWords);
  const text = `${subject}\n${body}`.toLowerCase();
  const banned = voice.bannedBuzzwords.filter(word => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text));
  const questions = (body.match(/\?/g) ?? []).length;
  const placeholders = `${subject}\n${body}`.match(/\{\{[^}]*\}\}|\[[^\]]*\]/g) ?? [];
  return [
    { name: 'word-limit', passed: bodyWords <= voice.firstTouchMaxWords, detail: `${bodyWords}/${voice.firstTouchMaxWords} words` },
    { name: 'subject-length', passed: words(subject).length <= voice.subjectMaxWords, detail: `${words(subject).length}/${voice.subjectMaxWords} words` },
    {
      name: 'sentence-length',
      passed: longSentences.length === 0,
      detail: longSentences.length ? `Over ${voice.sentenceMaxWords} words: ${longSentences.map(s => `"${s}"`).join('; ')}` : `All sentences <= ${voice.sentenceMaxWords} words`,
    },
    { name: 'banned-buzzwords', passed: banned.length === 0, detail: banned.length ? `Found: ${banned.join(', ')}` : 'None found' },
    { name: 'single-ask', passed: questions === 1, detail: `${questions} question(s)` },
    { name: 'no-placeholders', passed: placeholders.length === 0, detail: placeholders.length ? `Unrendered: ${placeholders.join(', ')}` : 'None found' },
  ];
}

export function createMockEmail(options: EmailOptions = {}): EmailAdapter {
  const voice = options.voice ?? VOICE;
  const personas = options.personas ?? PERSONAS.personas;
  const senderName = options.senderName ?? 'The GTM Engineering Lab team';
  const offer = options.offer ?? DEFAULT_OFFER;
  const cta = options.cta ?? DEFAULT_CTA;

  return {
    async generateDraft(lead) {
      if (lead.qualification?.decision !== 'pass') {
        throw new Error(`Refusing to draft for ${lead.companyDomain}: qualification decision is not 'pass'`);
      }
      const data = mergedEnrichmentData(lead);
      const headcount = typeof data.headcount === 'number' ? data.headcount : null;
      const persona = selectPersona(headcount, personas);
      const company = companyName(lead);
      const scored = scoredSignal(lead);
      const reviewNotes: string[] = [];
      const evidenceUsed: string[] = [];

      // 1. One observation, only if the scored signal is publicly observable and safe to quote.
      //    Website visits are never mentioned to the prospect.
      const jobTitle = scored?.signal.rawData.signalType === 'hiring' ? safeText(scored.signal.rawData.jobTitle) : null;
      let observation: string;
      let subject: string;
      if (scored && jobTitle) {
        observation = `I saw ${company} is hiring a ${jobTitle}.`;
        subject = `your ${jobTitle.toLowerCase()} hire`;
        evidenceUsed.push(scored.evidenceLine);
      } else {
        const industry = safeText(data.industry);
        observation = industry ? `I work with ${industry} teams on lead qualification.` : 'I work with B2B teams on lead qualification.';
        subject = `lead qualification at ${company.toLowerCase()}`;
        reviewNotes.push('No quotable public observation; used a role-relevant opener instead of personalising.');
      }

      // 2. Why it matters to the persona, framed as a common pattern, not a claim about them.
      const painPoint = persona.painPoints[0]!;
      const relevance = `Often that means ${lowerFirst(painPoint)}.`;
      evidenceUsed.push(`Persona '${persona.id}' pain point: ${painPoint}`);

      // 3. Offer, 4. one ask, sign-off.
      const body = ['Hi,', observation, `${relevance}`, offer, cta, `Best,\n${senderName}`].join('\n\n');

      const checks = lint(subject, body, voice);
      for (const check of checks) if (!check.passed) reviewNotes.push(`Voice check '${check.name}' failed: ${check.detail}`);
      reviewNotes.push('No verified contact email yet: resolve and verify a contact before approving.');

      return EmailDraftSchema.parse({
        status: 'DRAFT',
        requiresApproval: true,
        to: null,
        persona: persona.id,
        subject,
        body,
        evidenceUsed,
        checks,
        reviewNotes,
      });
    },
  };
}

export const mockEmail = createMockEmail();
