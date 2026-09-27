import { z } from 'zod';

// Runtime configuration from environment variables (see .env.example).
//
// MOCK_MODE=true (the default) runs everything offline on mock providers. MOCK_MODE=false
// switches each integration to its live adapter, but only when that integration's
// credentials are present; anything missing falls back to its mock with a warning, so a
// partial setup never crashes the pipeline. See src/runtime.ts for the wiring.

const Bool = z
  .string()
  .trim()
  .toLowerCase()
  .refine(v => ['true', 'false', '1', '0', 'yes', 'no'].includes(v), 'Expected true or false')
  .transform(v => ['true', '1', 'yes'].includes(v));

// Unset and empty-string variables are both treated as "not configured".
const Optional = z
  .string()
  .trim()
  .optional()
  .transform(v => (v ? v : undefined));

export const ConfigSchema = z.object({
  MOCK_MODE: Bool.default(true),
  ANTHROPIC_API_KEY: Optional,
  FIRECRAWL_API_KEY: Optional,
  SLACK_WEBHOOK_URL: Optional.pipe(z.url().optional()),
  RESEND_API_KEY: Optional,
  // A sender on a domain verified in Resend, e.g. "GTM Lab <drafts@yourdomain.com>".
  RESEND_FROM: Optional,
  // Where live drafts are delivered for human review. Drafts never go to prospects directly.
  DRAFT_REVIEW_EMAIL: Optional.pipe(z.email().optional()),
  // CRM keys are accepted for forward compatibility; the CRM adapter is still a mock.
  ATTIO_API_KEY: Optional,
  HUBSPOT_API_KEY: Optional,
  // If set, the webhook server requires this value in the x-webhook-secret header.
  WEBHOOK_SECRET: Optional,
  // Bearer token for the draft approval endpoints. Required in live mode: approving sends
  // real email to prospects, and drafts contain prospect data.
  APPROVAL_TOKEN: Optional.pipe(z.string().min(16, 'APPROVAL_TOKEN must be at least 16 characters').optional()),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
