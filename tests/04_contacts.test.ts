import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMockCohort, generateMockSignals } from '../src/01_signals/index';
import { enrichLead } from '../src/02_enrichment/index';
import { qualifyLead } from '../src/03_qualification/index';
import {
  DEFAULT_EMAIL_WATERFALL,
  lookupContact,
  MAX_VERIFICATION_AGE_DAYS,
  recipientGap,
  sendableEmail,
  totalContactCostInCents,
  type Candidate,
  type EmailFinderProvider,
  type PeopleSearchProvider,
} from '../src/04_contacts/index';
import { ContactSchema, type Lead } from '../src/shared/types';
import { CLOCKS, DAY_MS, makeLead, NOW, OFFLINE, passQualification, signal, verifiedContact } from './helpers';

const now = () => NOW;
const passLead = (overrides: Partial<Lead> = {}) => makeLead({ qualification: passQualification(), ...overrides });

function people(candidates: Candidate[] | (() => never)) {
  let calls = 0;
  const provider: PeopleSearchProvider & { calls: () => number } = {
    name: 'people',
    costInCents: 1,
    calls: () => calls,
    async search() {
      calls++;
      return typeof candidates === 'function' ? candidates() : candidates;
    },
  };
  return provider;
}

function finder(result: Awaited<ReturnType<EmailFinderProvider['find']>> | (() => never)): EmailFinderProvider {
  return { name: 'finder', costInCents: 2, find: async () => (typeof result === 'function' ? result() : result) };
}

// A finder that can also verify a known address; records which method ran.
function verifyingFinder() {
  const calls: string[] = [];
  const provider: EmailFinderProvider & { calls: string[] } = {
    name: 'finder',
    costInCents: 2,
    calls,
    async find({ fullName }) {
      calls.push(`find:${fullName}`);
      return { email: 'guessed@test.example', status: 'valid' };
    },
    async verify(email) {
      calls.push(`verify:${email}`);
      return { email, status: 'valid' };
    },
  };
  return provider;
}

// A pass lead whose only fresh signal names a person.
const namedLead = (rawData: Record<string, unknown>, ageDays = 1) =>
  passLead({ signals: [signal({ id: 'sig_named', source: 'linkedin', ageDays, rawData: { signalType: 'linkedin-own-post-engagement', ...rawData } })] });

async function qualifiedMock(index: number): Promise<Lead> {
  const lead = await enrichLead(generateMockSignals()[index]!.lead, { now: CLOCKS.enrich });
  return qualifyLead(lead, { now: CLOCKS.qualify, ...OFFLINE });
}

describe('04 contacts: lookup on the mock leads', () => {
  it('addresses the LinkedIn engager at northwind-data.example, skipping the people search', async () => {
    const lead = await lookupContact(await qualifiedMock(0), { now });
    const c = lead.contact!;
    assert.equal(c.status, 'verified');
    assert.deepEqual(c.person, { fullName: 'Lena Hoffmann', title: 'Director of Sales Operations', personaId: 'revops-leader', linkedinUrl: 'https://linkedin.example/in/lena-hoffmann' });
    assert.equal(c.email, 'lena.hoffmann@northwind-data.example');
    assert.equal(c.verifiedAt, NOW);
    assert.deepEqual(c.steps.map(s => [s.step, s.source]), [['signal', 'linkedin'], ['email_finder', 'email-finder']]);
    assert.match(c.reason, /named by the linkedin-own-post-engagement signal/);
    assert.equal(totalContactCostInCents(lead), 2);
    assert.equal(lead.updatedAt, NOW);
  });

  it('verifies the email a demo request gave for ravenhill.example', async () => {
    const lead = await lookupContact(await qualifiedMock(3), { now });
    assert.equal(lead.contact!.status, 'verified');
    assert.equal(lead.contact!.email, 'sam.okafor@ravenhill.example');
    assert.equal(lead.contact!.person!.personaId, 'revops-leader');
  });

  it('skips leads that did not pass qualification, at no cost', async () => {
    for (const index of [1, 2]) {
      const qualified = await qualifiedMock(index);
      const spy = people([{ fullName: 'A B', title: 'CEO' }]);
      const lead = await lookupContact(qualified, { peopleSearch: spy, now });
      assert.equal(lead.contact, null);
      assert.equal(spy.calls(), 0);
      assert.equal(lead, qualified, 'returned unchanged');
    }
    assert.equal((await lookupContact(makeLead(), { now })).contact, null, 'unqualified lead skipped');
  });

  it('gives every cohort account a verified recipient, falling back to founders where needed', async () => {
    const byDomain = new Map<string, Lead>();
    for (const lead of generateMockCohort()) {
      const qualified = await qualifyLead(await enrichLead(lead, { now: CLOCKS.enrich }), { now: CLOCKS.qualify, ...OFFLINE });
      byDomain.set(lead.companyDomain, await lookupContact(qualified, { now }));
    }
    assert.ok([...byDomain.values()].every(l => l.contact?.status === 'verified'));
    assert.deepEqual(byDomain.get('acornmetrics.example')!.contact!.person, { fullName: 'Priya Nair', title: 'CEO', personaId: 'growth-founder' });
  });
});

describe('04 contacts: choosing the buyer', () => {
  it('prefers the persona sized for the account over other personas', async () => {
    const roster = people([
      { fullName: 'Paul Wagner', title: 'CEO' },
      { fullName: 'Lena Hoffmann', title: 'RevOps Manager' },
    ]);
    const lead = await lookupContact(passLead(), { peopleSearch: roster, emailFinder: finder({ email: 'x@test.example', status: 'valid' }), now });
    assert.equal(lead.contact!.person!.fullName, 'Lena Hoffmann', 'headcount 100 -> revops-leader first');
  });

  it('matches titles ignoring case and punctuation', async () => {
    const roster = people([{ fullName: 'Sam Lee', title: 'vp, revenue operations' }]);
    const lead = await lookupContact(passLead(), { peopleSearch: roster, emailFinder: finder({ email: 's@test.example', status: 'valid' }), now });
    assert.equal(lead.contact!.person!.title, 'vp, revenue operations');
  });

  it('never picks an excluded title', async () => {
    const roster = people([
      { fullName: 'Rita Cole', title: 'Director of Sales Operations' },
      { fullName: 'Paul Wagner', title: 'CEO' },
    ]);
    const lead = await lookupContact(passLead(), { peopleSearch: roster, emailFinder: finder({ email: 'p@test.example', status: 'valid' }), excludedTitles: ['Director'], now });
    assert.equal(lead.contact!.person!.fullName, 'Paul Wagner');
  });

  it('reports not_found when nobody has a persona title (no email lookup spent)', async () => {
    const lead = await lookupContact(passLead(), { peopleSearch: people([{ fullName: 'Rosa Martin', title: 'Office Manager' }]), now });
    const c = lead.contact!;
    assert.equal(c.status, 'not_found');
    assert.equal(c.person, null);
    assert.deepEqual(c.steps.map(s => s.step), ['person_search']);
    assert.equal(totalContactCostInCents(lead), 1);
    assert.match(recipientGap(lead, NOW)!, /No buyer found: nobody at test\.example has a persona title/);
  });
});

describe('04 contacts: people named by signals', () => {
  it('uses a named person with a buyer title, with no people search', async () => {
    const roster = people([{ fullName: 'Paul Wagner', title: 'Director of Sales Operations' }]);
    const lead = await lookupContact(namedLead({ contactName: 'Mia Chen', contactTitle: 'RevOps Manager' }), { peopleSearch: roster, emailFinder: verifyingFinder(), now });
    assert.equal(lead.contact!.person!.fullName, 'Mia Chen');
    assert.equal(roster.calls(), 0);
    assert.deepEqual(lead.contact!.steps[0], { step: 'signal', source: 'linkedin', status: 'found', costInCents: 0 });
  });

  it('verifies the email the signal gave when it is on the company domain', async () => {
    const emailFinder = verifyingFinder();
    const lead = await lookupContact(namedLead({ contactName: 'Mia Chen', contactTitle: 'CEO', contactEmail: 'Mia@Test.example' }), { emailFinder, now });
    assert.deepEqual(emailFinder.calls, ['verify:mia@test.example']);
    assert.equal(lead.contact!.email, 'mia@test.example');
  });

  it('looks up a work email instead of using one on another domain', async () => {
    const emailFinder = verifyingFinder();
    const lead = await lookupContact(namedLead({ contactName: 'Mia Chen', contactTitle: 'CEO', contactEmail: 'mia@gmail.com' }), { emailFinder, now });
    assert.deepEqual(emailFinder.calls, ['find:Mia Chen']);
    assert.equal(lead.contact!.email, 'guessed@test.example');
  });

  it('finds a missing title in the people search', async () => {
    const roster = people([{ fullName: 'mia chen', title: 'VP Revenue Operations' }]);
    const lead = await lookupContact(namedLead({ contactName: 'Mia Chen' }), { peopleSearch: roster, emailFinder: verifyingFinder(), now });
    assert.equal(lead.contact!.person!.title, 'VP Revenue Operations');
    assert.deepEqual(lead.contact!.steps.map(s => s.step), ['signal', 'person_search', 'email_finder']);
  });

  for (const [why, rawData] of [
    ['is not a buyer persona', { contactName: 'Mia Chen', contactTitle: 'Software Engineer' }],
    ['has an excluded title', { contactName: 'Mia Chen', contactTitle: 'Recruiter, RevOps Manager' }],
    ['has no known title', { contactName: 'Mia Chen' }],
  ] as const) {
    it(`falls back to the persona search when the named person ${why}`, async () => {
      const roster = people([{ fullName: 'Lena Hoffmann', title: 'RevOps Manager' }]);
      const lead = await lookupContact(namedLead(rawData), { peopleSearch: roster, emailFinder: verifyingFinder(), now });
      assert.equal(lead.contact!.person!.fullName, 'Lena Hoffmann');
      assert.equal(roster.calls(), 1, 'searched once');
      assert.match(lead.contact!.reason, /Mia Chen .*from the linkedin-own-post-engagement signal/);
    });
  }

  it('ignores a stale signal and picks the person from the warmest fresh one', async () => {
    assert.equal((await lookupContact(namedLead({ contactName: 'Mia Chen', contactTitle: 'CEO' }, 45), { peopleSearch: people([]), now })).contact!.status, 'not_found');

    const lead = passLead({
      signals: [
        signal({ id: 'li', source: 'linkedin', ageDays: 0, rawData: { signalType: 'linkedin-profile-view', contactName: 'Mia Chen', contactTitle: 'CEO' } }),
        signal({ id: 'su', source: 'app', ageDays: 3, rawData: { signalType: 'signup', contactName: 'Tom Ruiz', contactTitle: 'Founder' } }),
      ],
    });
    assert.equal((await lookupContact(lead, { emailFinder: verifyingFinder(), now })).contact!.person!.fullName, 'Tom Ruiz', 'tier 5 signup beats a newer tier 4 view');
  });
});

describe('04 contacts: email verification and failures', () => {
  const buyer = people([{ fullName: 'Lena Hoffmann', title: 'RevOps Manager' }]);

  for (const status of ['catch_all', 'invalid', 'unknown'] as const) {
    it(`keeps a ${status} email but never makes it sendable`, async () => {
      const lead = await lookupContact(passLead(), { peopleSearch: buyer, emailFinder: finder({ email: 'lena@test.example', status }), now });
      assert.equal(lead.contact!.status, 'unverified');
      assert.equal(lead.contact!.email, 'lena@test.example');
      assert.equal(sendableEmail(lead, NOW), null);
      assert.match(recipientGap(lead, NOW)!, new RegExp(`email status is ${status}`));
    });
  }

  it('reports unverified when no email is found', async () => {
    const lead = await lookupContact(passLead(), { peopleSearch: buyer, emailFinder: finder({ email: null, status: 'unknown' }), now });
    assert.equal(lead.contact!.status, 'unverified');
    assert.match(lead.contact!.reason, /no email found/);
  });

  it('records a failing people search as a billed failed step', async () => {
    const lead = await lookupContact(passLead(), { peopleSearch: people(() => { throw new Error('timeout'); }), now });
    assert.equal(lead.contact!.status, 'not_found');
    assert.deepEqual(lead.contact!.steps, [{ step: 'person_search', source: 'people', status: 'failed', costInCents: 1 }]);
    assert.match(lead.contact!.reason, /people search failed/);
  });

  it('records a failing email finder and keeps the person', async () => {
    const lead = await lookupContact(passLead(), { peopleSearch: buyer, emailFinder: finder(() => { throw new Error('down'); }), now });
    assert.equal(lead.contact!.status, 'unverified');
    assert.equal(lead.contact!.person!.fullName, 'Lena Hoffmann');
    assert.equal(lead.contact!.steps[1]!.status, 'failed');
  });
});

describe('04 contacts: sendable recipients and schema rules', () => {
  it(`treats a verification as fresh for ${MAX_VERIFICATION_AGE_DAYS} days`, () => {
    const lead = passLead({ contact: verifiedContact() });
    assert.equal(sendableEmail(lead, NOW + MAX_VERIFICATION_AGE_DAYS * DAY_MS), 'lena.hoffmann@test.example');
    assert.equal(sendableEmail(lead, NOW + (MAX_VERIFICATION_AGE_DAYS + 1) * DAY_MS), null);
    assert.equal(sendableEmail(lead, NOW - DAY_MS), null, 'verified in the future');
    assert.match(recipientGap(lead, NOW + 30 * DAY_MS)!, /older than 7 days/);
    assert.equal(recipientGap(lead, NOW), null);
  });

  it('rejects contacts that break the status rules', () => {
    assert.ok(ContactSchema.safeParse(verifiedContact()).success);
    assert.ok(!ContactSchema.safeParse(verifiedContact({ email: null })).success, 'verified without email');
    assert.ok(!ContactSchema.safeParse(verifiedContact({ emailStatus: 'catch_all' })).success, 'verified with catch_all');
    assert.ok(!ContactSchema.safeParse(verifiedContact({ verifiedAt: null })).success, 'verified without timestamp');
    assert.ok(!ContactSchema.safeParse(verifiedContact({ status: 'unverified', person: null })).success, 'unverified without person');
    assert.ok(!ContactSchema.safeParse(verifiedContact({ status: 'not_found' })).success, 'not_found carrying a person');
    assert.ok(!ContactSchema.safeParse(verifiedContact({ steps: [] })).success, 'no steps');
  });
});

describe('04 contacts: email waterfall', () => {
  const buyer = people([{ fullName: 'Lena Hoffmann', title: 'RevOps Manager' }]);
  const named = (name: string, result: Parameters<typeof finder>[0], costInCents = 2): EmailFinderProvider => ({ ...finder(result), name, costInCents });

  it('stops at the first provider with a valid address', async () => {
    const third = verifyingFinder();
    const lead = await lookupContact(passLead(), {
      peopleSearch: buyer,
      emailFinders: [named('first', { email: null, status: 'unknown' }), named('second', { email: 'lena@test.example', status: 'valid' }, 3), third],
      now,
    });
    assert.equal(lead.contact!.status, 'verified');
    assert.equal(lead.contact!.email, 'lena@test.example');
    assert.deepEqual(lead.contact!.steps.slice(1).map(s => [s.source, s.status, s.costInCents]), [['first', 'not_found', 2], ['second', 'found', 3]]);
    assert.deepEqual(third.calls, [], 'never asked once an address verified');
    assert.equal(totalContactCostInCents(lead), 1 + 2 + 3);
  });

  it('moves past catch-all results and provider errors', async () => {
    const lead = await lookupContact(passLead(), {
      peopleSearch: buyer,
      emailFinders: [named('catchall', { email: 'lena@test.example', status: 'catch_all' }), named('broken', () => { throw new Error('down'); }), named('good', { email: 'l.hoffmann@test.example', status: 'valid' })],
      now,
    });
    assert.equal(lead.contact!.email, 'l.hoffmann@test.example');
    assert.deepEqual(lead.contact!.steps.slice(1).map(s => s.status), ['found', 'failed', 'found']);
  });

  it('keeps the first unverifiable address for review when nothing verifies', async () => {
    const lead = await lookupContact(passLead(), {
      peopleSearch: buyer,
      emailFinders: [named('a', { email: null, status: 'unknown' }), named('b', { email: 'lena@test.example', status: 'catch_all' }), named('c', { email: 'other@test.example', status: 'invalid' })],
      now,
    });
    assert.deepEqual([lead.contact!.status, lead.contact!.email, lead.contact!.emailStatus], ['unverified', 'lena@test.example', 'catch_all']);
    assert.equal(lead.contact!.steps.length, 4, 'every provider was tried');
  });

  it('falls back to the finders when a known address does not verify', async () => {
    const bounced: EmailFinderProvider = { ...verifyingFinder(), verify: async email => ({ email, status: 'invalid' }) };
    const lead = await lookupContact(namedLead({ contactName: 'Mia Chen', contactTitle: 'CEO', contactEmail: 'mia@test.example' }), { emailFinders: [bounced], now });
    assert.equal(lead.contact!.email, 'guessed@test.example');
    assert.deepEqual(lead.contact!.steps.filter(s => s.step === 'email_finder').length, 2, 'one verify, one find');
  });

  it('defaults to a two-provider waterfall that finds quillstack.example through the backup', async () => {
    assert.deepEqual(DEFAULT_EMAIL_WATERFALL.map(f => f.name), ['email-finder', 'backup-email-finder']);
    const lead = await lookupContact(passLead({ companyDomain: 'quillstack.example' }), { now });
    assert.equal(lead.contact!.email, 'sofia@quillstack.example');
    assert.deepEqual(lead.contact!.steps.map(s => `${s.source}:${s.status}`), ['apollo-people:found', 'email-finder:not_found', 'backup-email-finder:found']);
    assert.equal(lead.contact!.person!.personaId, 'demand-gen-leader', 'VP Marketing matched the fallback persona');
  });
});

describe('04 contacts: LinkedIn and phone', () => {
  it('carries the LinkedIn URL and phone from the people search onto the person', async () => {
    const roster = people([{ fullName: 'Hannah Vogel', title: 'Chief Revenue Officer', linkedinUrl: 'https://linkedin.example/in/hannah-vogel', phone: '+1 555 0142' }]);
    const lead = await lookupContact(passLead(), { peopleSearch: roster, emailFinder: finder({ email: 'h@test.example', status: 'valid' }), now });
    assert.deepEqual(lead.contact!.person, { fullName: 'Hannah Vogel', title: 'Chief Revenue Officer', personaId: 'revenue-leader', linkedinUrl: 'https://linkedin.example/in/hannah-vogel', phone: '+1 555 0142' });
  });

  it('takes the LinkedIn URL from an engagement signal', async () => {
    const lead = await lookupContact(namedLead({ contactName: 'Mia Chen', contactTitle: 'CEO', contactLinkedinUrl: 'https://linkedin.example/in/mia-chen' }), { emailFinder: verifyingFinder(), now });
    assert.equal(lead.contact!.person!.linkedinUrl, 'https://linkedin.example/in/mia-chen');
  });

  it('says LinkedIn steps only when no email verifies but the profile is known', async () => {
    const lead = await lookupContact(passLead({ companyDomain: 'tallowworks.example' }), { now });
    assert.equal(lead.contact!.status, 'unverified');
    assert.match(lead.contact!.reason, /catch_all.*LinkedIn steps only/);
    assert.equal(lead.contact!.person!.linkedinUrl, 'https://linkedin.example/in/owen-pike');
  });

  it('rejects a malformed phone number or LinkedIn URL on the contact', () => {
    const person = { fullName: 'A B', title: 'CEO', personaId: 'growth-founder' };
    assert.ok(!ContactSchema.safeParse(verifiedContact({ person: { ...person, phone: '555-CALL-NOW' } })).success);
    assert.ok(!ContactSchema.safeParse(verifiedContact({ person: { ...person, linkedinUrl: 'not a url' } })).success);
  });
});
