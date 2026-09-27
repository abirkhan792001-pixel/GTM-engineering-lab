import type { EmailStatus } from '../../shared/types';
import type { EmailFinderProvider } from './types';

// Simulates an email finder with built-in verification (Hunter/Prospeo-style): guesses the
// first.last@domain pattern, then checks the mailbox. A catch-all server accepts every
// address, so the mailbox can't be confirmed and the email is not safe to send.

const MAIL_SERVER_STATUS: Record<string, EmailStatus> = {
  'lumenforge.example': 'catch_all',
};

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
    if (!local) return { email: null, status: 'unknown' };
    return { email: `${local}@${companyDomain}`, status: MAIL_SERVER_STATUS[companyDomain] ?? 'valid' };
  },
};
