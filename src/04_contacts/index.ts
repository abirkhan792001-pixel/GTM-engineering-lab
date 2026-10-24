import { mergedEnrichmentData } from '../02_enrichment/index';
import { ICP, type Icp } from '../shared/icp';
import { PERSONAS, selectPersona, type Persona } from '../shared/personas';
import { ContactSchema, LeadSchema, type Contact, type ContactLookupStep, type Lead, type Person } from '../shared/types';
import { freshSignalsByWarmth } from '../shared/warmth';
import { mockEmailFinder } from './providers/mockEmailFinder';
import { mockPeopleSearch } from './providers/mockPeopleSearch';
import type { Candidate, EmailFinderProvider, PeopleSearchProvider } from './providers/types';

export type { Candidate, EmailFinderProvider, PeopleSearchProvider } from './providers/types';

// Contact lookup: find the person to address at an account that passed qualification.
//   1. If a fresh signal names someone (a form fill, signup or LinkedIn engager), they come
//      first: the warmest such signal wins, provided their title matches a persona. A
//      signal without a title is matched against the people search to find it.
//   2. Otherwise people search lists who works there; the first person whose title matches
//      a persona in personas.json wins (the persona sized for the account first, then the others).
//   3. Their work email: the one the signal gave, if it is on the company's domain, is
//      verified; otherwise an email finder guesses and verifies one.
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
  // Freshness window for signals that name a person.
  icp?: Icp;
  // Injected clock: stamps verifiedAt and updatedAt, and is the signal-freshness reference.
  now?: () => number;
}

export async function lookupContact(lead: Lead, options: LookupOptions = {}): Promise<Lead> {
  if (lead.qualification?.decision !== 'pass') return lead;

  const {
    peopleSearch = mockPeopleSearch,
    emailFinder = mockEmailFinder,
    personas = PERSONAS.personas,
    excludedTitles = PERSONAS.excludedTitles,
    icp = ICP,
    now = Date.now,
  } = options;
  const lookedUpAt = now();
  const steps: ContactLookupStep[] = [];

  const headcount = mergedEnrichmentData(lead).headcount;
  const preferred = selectPersona(typeof headcount === 'number' ? headcount : null, personas);
  const personaOrder = [preferred, ...personas.filter(p => p.id !== preferred.id)];

  // Who works there? Searched at most once, and only when needed.
  let roster: Candidate[] | null = null;
  async function searchPeople(): Promise<Candidate[]> {
    if (roster) return roster;
    try {
      roster = await peopleSearch.search(lead.companyDomain);
      steps.push({ step: 'person_search', source: peopleSearch.name, status: roster.length ? 'found' : 'not_found', costInCents: peopleSearch.costInCents });
    } catch {
      roster = [];
      steps.push({ step: 'person_search', source: peopleSearch.name, status: 'failed', costInCents: peopleSearch.costInCents });
    }
    return roster;
  }

  // What is their verified work email? `note` explains how they were chosen, if not the usual way.
  async function withEmail(person: Person, knownEmail: string | null, note: string | null): Promise<Lead> {
    let found: { email: string | null; status: Contact['emailStatus'] } = { email: null, status: null };
    try {
      found = knownEmail && emailFinder.verify
        ? await emailFinder.verify(knownEmail)
        : await emailFinder.find({ fullName: person.fullName, companyDomain: lead.companyDomain });
      steps.push({ step: 'email_finder', source: emailFinder.name, status: found.email ? 'found' : 'not_found', costInCents: emailFinder.costInCents });
    } catch {
      steps.push({ step: 'email_finder', source: emailFinder.name, status: 'failed', costInCents: emailFinder.costInCents });
    }

    const who = `${person.fullName}, ${person.title} (persona '${person.personaId}')`;
    const suffix = note ? ` (${note})` : '';
    if (found.email && found.status === 'valid') {
      return withContact(lead, { status: 'verified', person, email: found.email, emailStatus: 'valid', verifiedAt: lookedUpAt, steps, reason: `${who}: email verified${suffix}` }, lookedUpAt);
    }
    const why = !found.email ? 'no email found' : `email status is ${found.status}, so delivery can't be confirmed`;
    return withContact(lead, { status: 'unverified', person, email: found.email, emailStatus: found.status, verifiedAt: null, steps, reason: `${who}: ${why}${suffix}` }, lookedUpAt);
  }

  // 1. The person a signal names, if they are a buyer.
  let passedOver: string | null = null;
  const named = namedBySignal(lead, lookedUpAt, icp);
  if (named) {
    steps.push({ step: 'signal', source: named.source, status: 'found', costInCents: 0 });
    const title = named.title ?? (await searchPeople()).find(c => norm(c.fullName) === norm(named.fullName))?.title ?? null;
    const person = title ? pickBuyer([{ fullName: named.fullName, title }], personaOrder, excludedTitles) : null;
    if (person) return withEmail(person, named.email, `named by the ${named.type} signal`);
    passedOver = title
      ? `${named.fullName} (${title}) from the ${named.type} signal is not a buyer persona`
      : `${named.fullName} from the ${named.type} signal has no known title`;
  }

  // 2. Otherwise the first persona match among the people who work there.
  const person = pickBuyer(await searchPeople(), personaOrder, excludedTitles);
  if (!person) {
    const searchFailed = steps.some(step => step.step === 'person_search' && step.status === 'failed');
    const searched = searchFailed ? 'the people search failed' : `nobody at ${lead.companyDomain} has a persona title`;
    const reason = `No buyer found: ${searched}${passedOver ? `; ${passedOver}` : ''}`;
    return withContact(lead, { status: 'not_found', person: null, email: null, emailStatus: null, verifiedAt: null, steps, reason }, lookedUpAt);
  }
  return withEmail(person, null, passedOver);
}

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

// The person the warmest fresh signal names, with the email it gave if that is on the company's domain.
function namedBySignal(lead: Lead, asOfMs: number, icp: Icp): { fullName: string; title: string | null; email: string | null; type: string; source: string } | null {
  for (const { signal, type } of freshSignalsByWarmth(lead.signals, asOfMs, icp)) {
    const fullName = text(signal.rawData.contactName);
    if (!fullName) continue;
    const email = text(signal.rawData.contactEmail)?.toLowerCase() ?? null;
    return { fullName, title: text(signal.rawData.contactTitle), email: email?.endsWith(`@${lead.companyDomain}`) ? email : null, type, source: signal.source };
  }
  return null;
}

// The first candidate whose title matches a persona target title, trying personas in order.
function pickBuyer(candidates: Candidate[], personas: Persona[], excludedTitles: string[]): Person | null {
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
