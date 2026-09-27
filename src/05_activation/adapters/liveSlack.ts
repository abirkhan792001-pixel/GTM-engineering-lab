import { SlackAlertSchema, type SlackChannel } from '../../shared/types';
import { formatAlert, type NotifierAdapter } from './mockNotifier';

// Live Slack notifier: posts Block Kit alerts to an incoming-webhook URL. Used when
// MOCK_MODE=false and SLACK_WEBHOOK_URL is set (see src/runtime.ts).
//
// An incoming webhook is bound to one Slack channel, so both #hot-leads and #manual-review
// alerts go to that channel, labelled with their intended route. A failed post is reported
// on the alert (delivery: 'failed') and logged; it never throws into the pipeline.

export type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

// Slack mrkdwn treats <, > and & as control characters (links, @channel mentions).
// Escaping keeps text that came from scraped pages or signals from pinging or linking.
const escapeMrkdwn = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function toBlockKit(text: string, channel: SlackChannel) {
  const [header = '', ...rest] = escapeMrkdwn(text).split('\n');
  const title = header.replace(/^:\w+: /, '').replace(/\*/g, '');
  return {
    text: truncate(title, 300), // notification fallback
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: truncate(`${channel === '#hot-leads' ? '🔥' : '🔎'} ${title}`, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: truncate(rest.join('\n') || title, 3000) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Route: ${channel} · GTM Engineering Lab` }] },
    ],
  };
}

export interface LiveSlackOptions {
  webhookUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function createLiveSlack({ webhookUrl, fetch = globalThis.fetch, timeoutMs = 10_000 }: LiveSlackOptions): NotifierAdapter {
  return {
    async sendAlert(lead, channel, context) {
      const text = formatAlert(lead, channel, context);
      let delivery: 'sent' | 'failed' = 'failed';
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toBlockKit(text, channel)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) delivery = 'sent';
        else console.warn(`[slack] webhook returned ${response.status}: ${truncate(await response.text(), 200)}`);
      } catch (error) {
        console.warn(`[slack] webhook post failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return SlackAlertSchema.parse({ channel, text, sentAt: context.sentAt, delivery });
    },
  };
}
