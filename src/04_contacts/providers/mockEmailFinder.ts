import type { EmailStatus } from '../../shared/types';
import type { EmailFinderProvider } from './types';

// Simulates an email finder with built-in verification (Hunter/Prospeo-style): guesses the
// first.last@domain pattern, then checks the mailbox. A catch-all server accepts every
// address, so the mailbox can't be confirmed and the email is not safe to send.

const MAIL_SERVER_STATUS: Record<string, EmailStatus> = {
  'lumenforge.example': 'catch_all',
  'tallowworks.example': 'catch_all',
};

// Domains the first finder has no pattern for; the backup finder in the waterfall does.
const PRIMARY_MISSES = new Set(['quillstack.example']);

const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.');

export const mockEmailFinder: EmailFinderProvider = {
  name: 'email-finder',
  costInCents: 2,
  async find({ fullName, companyDomain }) {
    const local = slug(fullName);
    if (!local || PRIMARY_MISSES.has(companyDomain)) return { email: null, status: 'unknown' };
    return { email: `${local}@${companyDomain}`, status: MAIL_SERVER_STATUS[companyDomain] ?? 'valid' };
  },
  async verify(email) {
    const domain = email.split('@')[1]!.toLowerCase();
    return { email, status: MAIL_SERVER_STATUS[domain] ?? 'valid' };
  },
};

// The second finder in the waterfall (an Icypeas/AI Ark-style provider): only asked when the
// first had no valid address. Its pattern is first@domain; the mailbox check is the same.
export const mockBackupEmailFinder: EmailFinderProvider = {
  name: 'backup-email-finder',
  costInCents: 3,
  async find({ fullName, companyDomain }) {
    const first = slug(fullName).split('.')[0];
    if (!first) return { email: null, status: 'unknown' };
    return { email: `${first}@${companyDomain}`, status: MAIL_SERVER_STATUS[companyDomain] ?? 'valid' };
  },
};
