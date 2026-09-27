import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
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
// Hardening: JSON only, 64 KB body limit, optional shared secret (x-webhook-secret, compared
// in constant time), bounded in-memory job store. Pipeline errors mark the job failed; they
// never take the server down.

const MAX_BODY_BYTES = 64 * 1024;
const MAX_JOBS = 1000;

export interface LeadJob {
  leadId: string;
  companyDomain: string;
  status: 'processing' | 'done' | 'failed';
  receivedAt: string;
  finishedAt?: string;
  result?: ReturnType<typeof summarize>;
  error?: string;
}

export interface SignalServerOptions {
  runtime: Runtime;
  secret?: string;
  // Injected for tests; defaults to the real pipeline with the runtime's integrations.
  process?: (lead: Lead) => Promise<PipelineResult>;
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

export function createSignalServer({ runtime, secret, process: run, log = console.log }: SignalServerOptions): { server: Server; jobs: Map<string, LeadJob> } {
  const jobs = new Map<string, LeadJob>();
  const runPipeline = run ?? ((lead: Lead) => processLead(lead, runtime.pipeline));

  const remember = (job: LeadJob) => {
    jobs.set(job.leadId, job);
    if (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  };

  async function acceptSignal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (secret && !secretMatches(secret, req.headers['x-webhook-secret'])) return send(res, 401, { error: 'Missing or invalid x-webhook-secret header' });
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return send(res, 415, { error: 'Content-Type must be application/json' });
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return send(res, 413, { error: `Body exceeds ${MAX_BODY_BYTES} bytes` });
    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: `Body exceeds ${MAX_BODY_BYTES} bytes` });

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'Body is not valid JSON' });
    }
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
          Object.assign(job, { status: 'done', finishedAt: new Date().toISOString(), result: summarize(result) });
          log(`[pipeline] ${lead.id}: ${result.lead.qualification?.decision} -> ${result.activation.outcome}`);
        })
        .catch(error => {
          Object.assign(job, { status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
          log(`[pipeline] ${lead.id} failed: ${job.error}`);
        });
    });
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = async () => {
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

  return { server, jobs };
}

function main(): void {
  loadDotEnv();
  const config = loadConfig();
  const runtime = buildRuntime(config);
  if (runtime.mode === 'live' && !config.WEBHOOK_SECRET) {
    runtime.warnings.push('WEBHOOK_SECRET is not set: anyone who can reach this server can trigger the live pipeline.');
  }

  const { server } = createSignalServer({ runtime, secret: config.WEBHOOK_SECRET });
  server.listen(config.PORT, () => {
    console.log(`[server] ${runtime.mode.toUpperCase()} mode, listening on http://localhost:${config.PORT}`);
    for (const [stage, value] of Object.entries(runtime.integrations)) console.log(`  ${stage.padEnd(14)} ${value}`);
    for (const warning of runtime.warnings) console.warn(`  warning: ${warning}`);
    console.log(`  POST /api/webhooks/signal  |  GET /api/leads/:id  |  GET /health`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
