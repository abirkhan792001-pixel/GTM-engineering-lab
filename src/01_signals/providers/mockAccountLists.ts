import type { AccountListProvider } from '../sourcing';

// Five simulated list providers with overlapping results, the way real ICP lists overlap.
// Domains are written the way providers return them (URLs, www., mixed case) so the dedupe
// has real work to do. One record has no usable domain. Synthetic `.example` accounts only.

const list = (name: string, costPerRecordInCents: number, records: unknown[]): AccountListProvider => ({
  name,
  costPerRecordInCents,
  async fetchAccounts() {
    return records.map(record => ({ ...(record as object) }));
  },
});

export const MOCK_ACCOUNT_LISTS: AccountListProvider[] = [
  list('blitzapi', 1, [
    { website: 'quillstack.example', companyName: 'Quill Stack' },
    { website: 'tallowworks.example', companyName: 'Tallow Works' },
    { website: 'cobaltpay.example', companyName: 'Cobalt Pay' },
  ]),
  list('sales-navigator', 2, [
    { website: 'https://www.quillstack.example/', companyName: 'Quill Stack' },
    { website: 'orchardops.example', companyName: 'Orchard Ops' },
  ]),
  list('prospeo', 1, [
    { website: 'tallowworks.example', companyName: 'Tallow Works' },
    { website: 'vervepath.example', companyName: 'Verve Path' },
    { website: 'not a website', companyName: 'Unknown Co' },
  ]),
  list('ai-ark', 1, [
    { website: 'http://orchardops.example/about', companyName: 'Orchard Ops' },
    { website: 'quillstack.example', companyName: 'Quill Stack' },
  ]),
  list('ocean-io', 2, [
    // Lookalikes of current best customers.
    { website: 'www.TallowWorks.example', companyName: 'Tallow Works' },
    { website: 'cobaltpay.example', companyName: 'Cobalt Pay' },
  ]),
];
