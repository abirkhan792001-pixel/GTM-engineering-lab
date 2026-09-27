import { mergedEnrichmentData } from '../02_enrichment/index';
import { PERSONAS, selectPersona, type Persona } from '../shared/personas';
import { ContactSchema, LeadSchema, type Contact, type ContactLookupStep, type Lead, type Person } from '../shared/types';
import { mockEmailFinder } from './providers/mockEmailFinder';
import { mockPeopleSearch } from './providers/mockPeopleSearch';
import type { Candidate, EmailFinderProvider, PeopleSearchProvider } from './providers/types';

export type { Candidate, EmailFinderProvider, PeopleSearchProvider } from './providers/types';

// Contact lookup: find the buyer to address at an account that passed qualification.
//   1. People search lists who works there; the first person whose title matches a persona
//      in personas.json wins (the persona sized for the account first, then the others).
//   2. An email finder guesses and verifies their work email.
// Only leads that passed qualification are looked up, so nothing is spent on holds or
// disqualified accounts. Only a 'valid' email becomes a sendable recipient; catch-all,
// unknown or invalid addresses are kept for a human to check but never used as `to`.

// A verification older than this is stale and must be re-checked before sending.
export const MAX_VERIFICATION_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface LookupOptions {
  peopleSearch?: PeopleSearchProvider;
  emailFinder?: EmailFinderProvider;
  personas?: Persona[];
  excludedTitles?: string[];
  // Injected clock: stamps verifiedAt and updatedAt.
  now?: () => number;
}

export async function lookupContact(lead: Lead, options: LookupOptions = {}): Promise<Lead> {
  if (lead.qualification?.decision !== 'pass') return lead;

  const {
    peopleSearch = mockPeopleSearch,
    emailFinder = mockEmailFinder,
    personas = PERSONAS.personas,
    excludedTitles = PERSONAS.excludedTitles,
    now = Date.now,
  } = options;
  const lookedUpAt = now();
  const steps: ContactLookupStep[] = [];

  // 1. Who works there?
  let candidates: Candidate[] = [];
  try {
    candidates = await peopleSearch.search(lead.companyDomain);
    steps.push({ step: 'person_search', source: peopleSearch.name, status: candidates.length ? 'found' : 'not_found', costInCents: peopleSearch.costInCents });
  } catch {
    steps.push({ step: 'person_search', source: peopleSearch.name, status: 'failed', costInCents: peopleSearch.costInCents });
  }

  const headcount = mergedEnrichmentData(lead).headcount;
  const preferred = selectPersona(typeof headcount === 'number' ? headcount : null, personas);
  const person = pickBuyer(candidates, [preferred, ...personas.filter(p => p.id !== preferred.id)], excludedTitles);

  if (!person) {
    const searched = steps[0]!.status === 'failed' ? 'the people search failed' : `nobody at ${lead.companyDomain} has a persona title`;
    return withContact(lead, { status: 'not_found', person: null, email: null, emailStatus: null, verifiedAt: null, steps, reason: `No buyer found: ${searched}` }, lookedUpAt);
  }

  // 2. What is their verified work email?
  let found: { email: string | null; status: Contact['emailStatus'] } = { email: null, status: null };
  try {
    found = await emailFinder.find({ fullName: person.fullName, companyDomain: lead.companyDomain });
    steps.push({ step: 'email_finder', source: emailFinder.name, status: found.email ? 'found' : 'not_found', costInCents: emailFinder.costInCents });
  } catch {
    steps.push({ step: 'email_finder', source: emailFinder.name, status: 'failed', costInCents: emailFinder.costInCents });
  }

  const who = `${person.fullName}, ${person.title} (persona '${person.personaId}')`;
  if (found.email && found.status === 'valid') {
    return withContact(lead, { status: 'verified', person, email: found.email, emailStatus: 'valid', verifiedAt: lookedUpAt, steps, reason: `${who}: email verified` }, lookedUpAt);
  }
  const why = !found.email ? 'no email found' : `email status is ${found.status}, so delivery can't be confirmed`;
  return withContact(lead, { status: 'unverified', person, email: found.email, emailStatus: found.status, verifiedAt: null, steps, reason: `${who}: ${why}` }, lookedUpAt);
}

// The first candidate whose title matches a persona target title, trying personas in order.
function pickBuyer(candidates: Candidate[], personas: Persona[], excludedTitles: string[]): Person | null {
  const norm = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const excluded = excludedTitles.map(norm);
  const eligible = candidates.filter(c => !excluded.some(x => norm(c.title).includes(x)));
  for (const persona of personas) {
    for (const target of persona.targetTitles) {
      const match = eligible.find(c => norm(c.title) === norm(target));
      if (match) return { fullName: match.fullName, title: match.title, personaId: persona.id };
    }
  }
  return null;
}

function withContact(lead: Lead, contact: Contact, updatedAt: number): Lead {
  return LeadSchema.parse({ ...lead, contact: ContactSchema.parse(contact), updatedAt });
}

// The email a draft may be addressed to: verified, and verified recently enough.
export function sendableEmail(lead: Lead, asOfMs: number): string | null {
  const c = lead.contact;
  if (c?.status !== 'verified' || !c.email || c.verifiedAt === null) return null;
  const ageDays = (asOfMs - c.verifiedAt) / DAY_MS;
  return ageDays >= 0 && ageDays <= MAX_VERIFICATION_AGE_DAYS ? c.email : null;
}

// Why a lead has no sendable recipient, for review notes and alerts; null if it has one.
export function recipientGap(lead: Lead, asOfMs: number): string | null {
  if (sendableEmail(lead, asOfMs)) return null;
  const c = lead.contact;
  if (!c) return 'No contact lookup has run for this lead.';
  if (c.status === 'verified') return `Email verification is older than ${MAX_VERIFICATION_AGE_DAYS} days; re-verify before sending.`;
  return c.reason;
}

export function totalContactCostInCents(lead: Lead): number {
  return lead.contact?.steps.reduce((sum, step) => sum + step.costInCents, 0) ?? 0;
}
