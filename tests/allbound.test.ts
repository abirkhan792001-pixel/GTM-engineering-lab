import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MOCK_ACCOUNT_LISTS, type AccountListProvider } from '../src/01_signals/index';
import { runAllbound } from '../src/runAllbound';

// The whole allbound loop on mock data: source -> qualify -> every channel -> engagement ->
// follow-up -> meeting -> attribution, all through the real stages and one CRM timeline.

describe('allbound: the full loop', async () => {
  const run = await runAllbound();
  const outcome = (domain: string) => run.firstPass.find(r => r.lead.companyDomain === domain)!.activation;

  it('sources five lists into five deduped accounts and qualifies them', () => {
    assert.equal(run.sourced.leads.length, 5);
    assert.deepEqual(
      run.firstPass.map(r => [r.lead.companyDomain, r.activation.outcome]).sort(),
      [
        ['cobaltpay.example', 'activated'],
        ['orchardops.example', 'activated'],
        ['quillstack.example', 'activated'],
        ['tallowworks.example', 'activated'],
        ['vervepath.example', 'disqualified'],
      ],
    );
  });

  it('plans each channel only where the contact can be reached', () => {
    const planned = (domain: string) => outcome(domain).channels!.steps.filter(s => s.status === 'planned').map(s => s.channel);
    assert.deepEqual(planned('orchardops.example'), ['email', 'linkedin', 'call', 'linkedin', 'email'], 'CRO with LinkedIn and a phone');
    assert.deepEqual(planned('tallowworks.example'), ['linkedin', 'linkedin'], 'catch-all mail server: LinkedIn steps only');
    assert.deepEqual(outcome('tallowworks.example').channels!.audiences.map(a => a.status), ['added', 'skipped', 'skipped']);
  });

  it('sends approved first touches only to verified recipients', () => {
    assert.deepEqual(run.sentFirstTouches.map(s => s.split(' ')[0]).sort(), ['cobaltpay.example', 'orchardops.example', 'quillstack.example']);
  });

  it('follows up on engagement, waits where nothing happened, and hands the meeting to sales', () => {
    assert.equal(run.followUp.activation.draft!.touch, 'follow_up');
    assert.equal(run.followUp.activation.channels!.mode, 'follow_up');
    assert.equal(run.waiting.activation.outcome, 'in_sequence');
    assert.equal(run.meeting.activation.outcome, 'routed_to_sales');
    assert.ok(run.meeting.activation.log.some(l => l.startsWith('Attribution: 10 touch(es)')));
  });

  it('attributes the meeting to every channel that touched the account', () => {
    assert.deepEqual(run.attribution.byChannel, { outbound: { ads: 6, email: 2 }, inbound: { linkedin: 1, ads: 1 } });
    assert.equal(run.attribution.firstTouch!.kind, 'icp-audience');
    assert.equal(run.attribution.lastTouch!.kind, 'follow-up-email');
    assert.equal(run.timeline.at(-1)!.kind, 'meeting-booked');
  });

  it('promotes the two best recent founder posts', () => {
    assert.deepEqual(run.posts.promote.map(d => d.post.id), ['post_attribution_myths', 'post_scoring_breakdown']);
  });

  it('still runs when a list provider is down', async () => {
    const down: AccountListProvider = { name: 'blitzapi', costPerRecordInCents: 1, fetchAccounts: async () => { throw new Error('503'); } };
    const partial = await runAllbound({ lists: [down, ...MOCK_ACCOUNT_LISTS.slice(1)] });
    assert.equal(partial.sourced.sources[0]!.status, 'failed');
    assert.ok(partial.sourced.leads.some(l => l.companyDomain === 'quillstack.example'), 'other lists still found it');
  });
});
