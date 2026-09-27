// Synthetic companies for the A/B learning cohort (reserved `.example` TLD; not real).
// One source of truth: 01_signals turns them into hiring signals, mock Apollo serves
// their firmographics and the mock people search serves their buyer, so the cohort runs
// through the real pipeline stages. People are fictional.

export interface MockCompany {
  domain: string;
  name: string;
  industry: string;
  headcount: number;
  hqCountry: string;
  hiringFor: string;
  signalAgeDays: number;
  // The person the contact lookup should find: a RevOps title, or a founder/CEO when the
  // company has no RevOps leader yet (exercises the persona fallback).
  buyer: { fullName: string; title: string };
}

export const LEARNING_COHORT: readonly MockCompany[] = [
  { domain: 'acornmetrics.example', name: 'Acorn Metrics', industry: 'Data & Analytics', headcount: 85, hqCountry: 'US', hiringFor: 'Head of Revenue Operations', signalAgeDays: 1, buyer: { fullName: 'Priya Nair', title: 'CEO' } },
  { domain: 'bluefjord.example', name: 'Blue Fjord', industry: 'Developer Tools', headcount: 60, hqCountry: 'NL', hiringFor: 'RevOps Manager', signalAgeDays: 2, buyer: { fullName: 'Jonas Berg', title: 'Director of Sales Operations' } },
  { domain: 'cobaltpay.example', name: 'Cobalt Pay', industry: 'Fintech Infrastructure', headcount: 220, hqCountry: 'GB', hiringFor: 'Director of Sales Operations', signalAgeDays: 4, buyer: { fullName: 'Amelia Clarke', title: 'VP Revenue Operations' } },
  { domain: 'driftwoodhq.example', name: 'Driftwood', industry: 'B2B SaaS', headcount: 130, hqCountry: 'US', hiringFor: 'VP Revenue Operations', signalAgeDays: 3, buyer: { fullName: 'Marcus Reed', title: 'Co-Founder' } },
  { domain: 'emberstack.example', name: 'Ember Stack', industry: 'Developer Tools', headcount: 75, hqCountry: 'DE', hiringFor: 'Head of Revenue Operations', signalAgeDays: 5, buyer: { fullName: 'Felix Braun', title: 'RevOps Manager' } },
  { domain: 'fernlogic.example', name: 'Fern Logic', industry: 'B2B SaaS', headcount: 95, hqCountry: 'CH', hiringFor: 'RevOps Manager', signalAgeDays: 2, buyer: { fullName: 'Nina Keller', title: 'Head of Revenue Operations' } },
  { domain: 'granitecloud.example', name: 'Granite Cloud', industry: 'B2B SaaS', headcount: 310, hqCountry: 'US', hiringFor: 'Director of Sales Operations', signalAgeDays: 6, buyer: { fullName: 'Daniel Cho', title: 'VP Revenue Operations' } },
  { domain: 'harbourdata.example', name: 'Harbour Data', industry: 'Data & Analytics', headcount: 150, hqCountry: 'GB', hiringFor: 'Head of Revenue Operations', signalAgeDays: 1, buyer: { fullName: 'Olivia Grant', title: 'CEO' } },
  { domain: 'ironleaf.example', name: 'Ironleaf', industry: 'Fintech Infrastructure', headcount: 180, hqCountry: 'AT', hiringFor: 'VP Revenue Operations', signalAgeDays: 3, buyer: { fullName: 'Lukas Huber', title: 'Director of Sales Operations' } },
  { domain: 'junipersignal.example', name: 'Juniper Signal', industry: 'B2B SaaS', headcount: 55, hqCountry: 'US', hiringFor: 'RevOps Manager', signalAgeDays: 2, buyer: { fullName: 'Grace Liu', title: 'Founder' } },
];
