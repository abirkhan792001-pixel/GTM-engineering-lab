import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMockCohort, generateMockSignals } from '../src/01_signals/index';
import { enrichLead } from '../src/02_enrichment/index';
import { qualifyLead } from '../src/03_qualification/index';
import {
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
import { CLOCKS, DAY_MS, makeLead, NOW, OFFLINE, passQualification, verifiedContact } from './helpers';

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

async function qualifiedMock(index: number): Promise<Lead> {
  const lead = await enrichLead(generateMockSignals()[index]!.lead, { now: CLOCKS.enrich });
  return qualifyLead(lead, { now: CLOCKS.qualify, ...OFFLINE });
}

describe('04 contacts: lookup on the mock leads', () => {
  it('finds and verifies the buyer at northwind-data.example for 3 cents', async () => {
    const lead = await lookupContact(await qualifiedMock(0), { now });
    const c = lead.contact!;
    assert.equal(c.status, 'verified');
    assert.deepEqual(c.person, { fullName: 'Lena Hoffmann', title: 'Director of Sales Operations', personaId: 'revops-leader' });
    assert.equal(c.email, 'lena.hoffmann@northwind-data.example');
    assert.equal(c.verifiedAt, NOW);
    assert.equal(totalContactCostInCents(lead), 3);
    assert.equal(lead.updatedAt, NOW);
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
