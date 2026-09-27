import { createLiveFirecrawl, type FirecrawlScraper } from './02_enrichment/index';
import { mockScoreRubric } from './03_qualification/index';
import {
  createLiveResend,
  createLiveSlack,
  createMockCRM,
  createMockEmail,
  createMockNotifier,
  createMockSender,
  createResendSender,
  type CrmAdapter,
  type FetchLike,
  type ProspectSender,
} from './05_activation/index';
import type { PipelineOptions } from './runPipeline';
import type { Config } from './shared/config';

// Chooses mock or live integrations from the config. MOCK_MODE=true keeps everything
// offline. MOCK_MODE=false upgrades each integration whose credentials are present and
// keeps the mock (with a warning) for the rest, so a partial setup still runs end to end.

export interface Runtime {
  mode: 'mock' | 'live';
  pipeline: Omit<PipelineOptions, 'clocks'>;
  // Sends approved drafts to prospects (see 05_activation/approvals.ts), and the CRM the
  // approval step re-checks suppression against (the same one the pipeline writes to).
  sender: ProspectSender;
  crm: CrmAdapter;
  // What each stage will actually use, for startup logs and health checks.
  integrations: Record<'enrichment' | 'qualification' | 'contacts' | 'crm' | 'slack' | 'draftReview' | 'sending', string>;
  warnings: string[];
}

export interface RuntimeDeps {
  firecrawlClient?: FirecrawlScraper;
  fetch?: FetchLike;
}

export function buildRuntime(config: Config, deps: RuntimeDeps = {}): Runtime {
  const warnings: string[] = [];
  const crm = createMockCRM();
  const pipeline: Omit<PipelineOptions, 'clocks'> = {
    qualify: { scorer: mockScoreRubric },
    adapters: { crm, email: createMockEmail(), notifier: createMockNotifier() },
  };
  let sender: ProspectSender = createMockSender();
  const integrations: Runtime['integrations'] = {
    enrichment: 'mock (apollo, firecrawl)',
    qualification: 'offline scorer',
    contacts: 'mock (people search, email finder)',
    crm: 'mock',
    slack: 'mock',
    draftReview: 'off',
    sending: 'mock outbox (approved drafts are not emailed)',
  };

  if (config.MOCK_MODE) {
    const liveKeys = (['ANTHROPIC_API_KEY', 'FIRECRAWL_API_KEY', 'SLACK_WEBHOOK_URL', 'RESEND_API_KEY', 'ATTIO_API_KEY', 'HUBSPOT_API_KEY'] as const).filter(k => config[k]);
    if (liveKeys.length) warnings.push(`MOCK_MODE=true: ignoring configured credentials (${liveKeys.join(', ')}). Set MOCK_MODE=false to use them.`);
    return { mode: 'mock', pipeline, sender, crm, integrations, warnings };
  }

  if (config.FIRECRAWL_API_KEY) {
    pipeline.enrich = { fallback: createLiveFirecrawl({ apiKey: config.FIRECRAWL_API_KEY, client: deps.firecrawlClient }) };
    integrations.enrichment = 'apollo (mock) -> firecrawl (live)';
  } else {
    warnings.push('FIRECRAWL_API_KEY is not set: enrichment stays on the mock providers.');
  }

  if (config.ANTHROPIC_API_KEY) {
    pipeline.qualify = {};
    integrations.qualification = 'claude (live)';
  } else {
    warnings.push('ANTHROPIC_API_KEY is not set: qualification uses the offline scorer.');
  }

  if (config.SLACK_WEBHOOK_URL) {
    pipeline.adapters!.notifier = createLiveSlack({ webhookUrl: config.SLACK_WEBHOOK_URL, fetch: deps.fetch });
    integrations.slack = 'live (incoming webhook)';
  } else {
    warnings.push('SLACK_WEBHOOK_URL is not set: Slack alerts stay in the mock outbox.');
  }

  const resendMissing = (['RESEND_API_KEY', 'RESEND_FROM', 'DRAFT_REVIEW_EMAIL'] as const).filter(k => !config[k]);
  if (resendMissing.length === 0) {
    pipeline.adapters!.delivery = createLiveResend({ apiKey: config.RESEND_API_KEY!, from: config.RESEND_FROM!, reviewEmail: config.DRAFT_REVIEW_EMAIL!, fetch: deps.fetch });
    integrations.draftReview = `live (resend, to ${config.DRAFT_REVIEW_EMAIL})`;
  } else {
    warnings.push(`${resendMissing.join(', ')} not set: drafts are not delivered for review.`);
  }

  if (config.RESEND_API_KEY && config.RESEND_FROM) {
    sender = createResendSender({ apiKey: config.RESEND_API_KEY, from: config.RESEND_FROM, fetch: deps.fetch });
    integrations.sending = 'live (resend, to prospects after approval)';
  } else {
    warnings.push('RESEND_API_KEY and RESEND_FROM are needed to email approved drafts: approvals will use the mock outbox.');
  }
  if (!config.APPROVAL_TOKEN) {
    warnings.push('APPROVAL_TOKEN is not set: the draft approval endpoints are disabled in live mode.');
  }

  if (config.ATTIO_API_KEY || config.HUBSPOT_API_KEY) {
    warnings.push('A CRM key is set, but the CRM adapter is still a mock: nothing is written to your CRM yet.');
  }
  warnings.push('Contact lookup has no live provider yet: real domains will get no recipient.');

  return { mode: 'live', pipeline, sender, crm, integrations, warnings };
}
