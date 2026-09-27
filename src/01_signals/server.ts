import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createApprovalService, type ApprovalOutcome, type ApprovalService, type DraftRecord, type DraftStatus, DraftStatusSchema } from '../05_activation/index';
import { processLead, type PipelineResult } from '../runPipeline';
import { buildRuntime, type Runtime } from '../runtime';
import { loadConfig } from '../shared/config';
import { loadDotEnv } from '../shared/env';
import type { Lead } from '../shared/types';
import { IntakeError, IntentSignalSchema, intentToLead } from './intake';

// Real-time signal intake over HTTP (Node's built-in http module, no framework).
//
//   POST /api/webhooks/signal  validate an IntentSignal, create a lead, answer 202 with its id,
//                              then run the pipeline for it in the background
//   GET  /api/leads/:id        processing status and result summary for that lead
//   GET  /health               mode and which integrations are live
//
// Draft approval (requires `Authorization: Bearer <APPROVAL_TOKEN>`; disabled in live mode
// when no token is configured, because approving sends real email to prospects):
//   GET  /api/drafts[?status=pending_approval]   drafts awaiting review (or any status)
//   GET  /api/drafts/:id                          full draft, content hash and audit history
//   POST /api/drafts/:id/approve                  {approvedBy, contentHash, acknowledgeReviewNotes?}
//   POST /api/drafts/:id/reject                   {rejectedBy, reason}
//
// Hardening: JSON only, 64 KB body limit, optional shared secret (x-webhook-secret, compared
// in constant time), bounded in-memory job and draft stores. Pipeline errors mark the job
// failed; they never take the server down.

const MAX_BODY_BYTES = 64 * 1024;
const MAX_JOBS = 1000;

export interface LeadJob {
  leadId: string;
  companyDomain: string;
  status: 'processing' | 'done' | 'failed';
  receivedAt: string;
  finishedAt?: string;
  result?: ReturnType<typeof summarize> & { draftId: string | null };
  error?: string;
}

export interface SignalServerOptions {
  runtime: Runtime;
  secret?: string;
  // Injected for tests; defaults to the real pipeline with the runtime's integrations.
  process?: (lead: Lead) => Promise<PipelineResult>;
  // Approval queue for drafts; defaults to one using the runtime's sender and CRM.
  approvals?: ApprovalService;
  // Bearer token for the /api/drafts endpoints.
  approvalToken?: string;
  log?: (line: string) => void;
}

function summarize({ lead, activation }: PipelineResult) {
  return {
    decision: lead.qualification?.decision ?? null,
    score: lead.qualification?.score ?? null,
    contact: lead.contact ? { status: lead.contact.status, reason: lead.contact.reason } : null,
    outcome: activation.outcome,
    reason: activation.reason,
    draftTo: activation.draft?.to ?? null,
    alerts: activation.alerts.map(a => ({ channel: a.channel, delivery: a.delivery })),
    log: activation.log,
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const APPROVAL_HTTP_STATUS: Record<Extract<ApprovalOutcome, { ok: false }>['code'], number> = {
  not_found: 404,
  invalid: 400,
  conflict: 409,
  blocked: 422,
  send_failed: 502,
};

// What reviewers see. The lead snapshot stays server-side apart from the contact summary.
function draftView(record: DraftRecord, full: boolean) {
  const base = {
    id: record.id,
    leadId: record.leadId,
    companyDomain: record.companyDomain,
    status: record.status,
    to: record.draft.to,
    subject: record.draft.subject,
    createdAt: new Date(record.createdAt).toISOString(),
  };
  if (!full) return base;
  return {
    ...base,
    contentHash: record.contentHash,
    body: record.draft.body,
    persona: record.draft.persona,
    variantId: record.draft.variantId,
    reviewNotes: record.draft.reviewNotes,
    checks: record.draft.checks,
    contact: record.lead.contact ? { status: record.lead.contact.status, person: record.lead.contact.person, reason: record.lead.contact.reason } : null,
    sent: record.sent ? { ...record.sent, at: new Date(record.sent.at).toISOString() } : null,
    history: record.history.map(entry => ({ ...entry, at: new Date(entry.at).toISOString() })),
  };
}

function secretMatches(expected: string, provided: string | string[] | undefined): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createSignalServer({ runtime, secret, process: run, approvals: approvalService, approvalToken, log = console.log }: SignalServerOptions): {
  server: Server;
  jobs: Map<string, LeadJob>;
  approvals: ApprovalService;
} {
  const jobs = new Map<string, LeadJob>();
  const runPipeline = run ?? ((lead: Lead) => processLead(lead, runtime.pipeline));
  const approvals = approvalService ?? createApprovalService({ sender: runtime.sender, crm: runtime.crm });

  const remember = (job: LeadJob) => {
    jobs.set(job.leadId, job);
    if (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  };

  // Reads a JSON body, answering the error itself and returning undefined on failure.
  async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      send(res, 415, { error: 'Content-Type must be application/json' });
      return undefined;
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      send(res, 413, { error: `Body exceeds ${MAX_BODY_BYTES} bytes` });
      return undefined;
    }
    const raw = await readBody(req);
    if (raw === null) {
      send(res, 413, { error: `Body exceeds ${MAX_BODY_BYTES} bytes` });
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch {
      send(res, 400, { error: 'Body is not valid JSON' });
      return undefined;
    }
  }

  async function acceptSignal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (secret && !secretMatches(secret, req.headers['x-webhook-secret'])) return send(res, 401, { error: 'Missing or invalid x-webhook-secret header' });
    const json = await readJson(req, res);
    if (json === undefined) return;
    const parsed = IntentSignalSchema.safeParse(json);
    if (!parsed.success) return send(res, 400, { error: 'Invalid signal', issues: z.prettifyError(parsed.error) });

    let lead: Lead;
    try {
      lead = intentToLead(parsed.data);
    } catch (error) {
      if (error instanceof IntakeError) return send(res, 422, { error: error.message });
      throw error;
    }

    const job: LeadJob = { leadId: lead.id, companyDomain: lead.companyDomain, status: 'processing', receivedAt: new Date().toISOString() };
    remember(job);
    send(res, 202, { status: 'accepted', leadId: lead.id, companyDomain: lead.companyDomain, statusUrl: `/api/leads/${lead.id}` });
    log(`[signal] accepted ${parsed.data.eventType} for ${lead.companyDomain} -> ${lead.id}`);

    // Run the pipeline after responding; a failure is recorded on the job, never thrown.
    setImmediate(() => {
      runPipeline(lead)
        .then(result => {
          const draft = result.activation.draft ? approvals.register(result.lead, result.activation.draft) : null;
          Object.assign(job, { status: 'done', finishedAt: new Date().toISOString(), result: { ...summarize(result), draftId: draft?.id ?? null } });
          log(`[pipeline] ${lead.id}: ${result.lead.qualification?.decision} -> ${result.activation.outcome}`);
        })
        .catch(error => {
          Object.assign(job, { status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
          log(`[pipeline] ${lead.id} failed: ${job.error}`);
        });
    });
  }

  // Approval endpoints are closed unless a token is configured, except in mock mode.
  function approvalAccessError(req: IncomingMessage): [number, string] | null {
    if (approvalToken) {
      const header = String(req.headers.authorization ?? '');
      const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
      return secretMatches(approvalToken, token) ? null : [401, 'Missing or invalid Authorization: Bearer <APPROVAL_TOKEN>'];
    }
    return runtime.mode === 'live' ? [503, 'Draft approval is disabled: set APPROVAL_TOKEN to enable it in live mode'] : null;
  }

  async function handleDrafts(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const denied = approvalAccessError(req);
    if (denied) return send(res, denied[0], { error: denied[1] });

    if (url.pathname === '/api/drafts') {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' }, { allow: 'GET' });
      const status = url.searchParams.get('status');
      if (status && !DraftStatusSchema.safeParse(status).success) return send(res, 400, { error: `Unknown status ${status}` });
      return send(res, 200, { drafts: approvals.list((status as DraftStatus) ?? undefined).map(r => draftView(r, false)) });
    }

    const match = url.pathname.match(/^\/api\/drafts\/([\w-]+)(?:\/(approve|reject))?$/);
    if (!match) return send(res, 404, { error: 'Not found' });
    const [, id, action] = match as [string, string, 'approve' | 'reject' | undefined];

    if (!action) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' }, { allow: 'GET' });
      const record = approvals.get(id);
      return record ? send(res, 200, draftView(record, true)) : send(res, 404, { error: `Unknown draft ${id}` });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { allow: 'POST' });
    const body = await readJson(req, res);
    if (body === undefined) return;
    const outcome = action === 'approve' ? await approvals.approve(id, body) : approvals.reject(id, body);
    if (outcome.ok) {
      log(`[approval] ${id} ${outcome.record.status}${outcome.record.sent ? ` to ${outcome.record.sent.to} via ${outcome.record.sent.provider}` : ''}`);
      return send(res, 200, draftView(outcome.record, true));
    }
    log(`[approval] ${id} ${action} refused (${outcome.code}): ${outcome.message}`);
    return send(res, APPROVAL_HTTP_STATUS[outcome.code], { error: outcome.message, code: outcome.code, ...(outcome.record && { draft: draftView(outcome.record, true) }) });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const route = async () => {
      if (path === '/api/drafts' || path.startsWith('/api/drafts/')) return handleDrafts(req, res, url);
      if (path === '/api/webhooks/signal') {
        if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { allow: 'POST' });
        return acceptSignal(req, res);
      }
      const leadMatch = path.match(/^\/api\/leads\/([\w-]+)$/);
      if (leadMatch && req.method === 'GET') {
        const job = jobs.get(leadMatch[1]!);
        return job ? send(res, 200, job) : send(res, 404, { error: 'Unknown lead id' });
      }
      if (path === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok', mode: runtime.mode, integrations: runtime.integrations });
      return send(res, 404, { error: 'Not found' });
    };
    route().catch(error => {
      log(`[server] ${req.method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    });
  });

  return { server, jobs, approvals };
}

function main(): void {
  loadDotEnv();
  const config = loadConfig();
  const runtime = buildRuntime(config);
  if (runtime.mode === 'live' && !config.WEBHOOK_SECRET) {
    runtime.warnings.push('WEBHOOK_SECRET is not set: anyone who can reach this server can trigger the live pipeline.');
  }

  const { server } = createSignalServer({ runtime, secret: config.WEBHOOK_SECRET, approvalToken: config.APPROVAL_TOKEN });
  server.listen(config.PORT, () => {
    console.log(`[server] ${runtime.mode.toUpperCase()} mode, listening on http://localhost:${config.PORT}`);
    for (const [stage, value] of Object.entries(runtime.integrations)) console.log(`  ${stage.padEnd(14)} ${value}`);
    for (const warning of runtime.warnings) console.warn(`  warning: ${warning}`);
    console.log(`  POST /api/webhooks/signal  |  GET /api/leads/:id  |  GET /health`);
    console.log(`  GET /api/drafts  |  GET /api/drafts/:id  |  POST /api/drafts/:id/approve  |  POST /api/drafts/:id/reject`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
