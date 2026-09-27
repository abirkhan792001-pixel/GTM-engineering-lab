// Synthetic companies for the A/B learning cohort (reserved `.example` TLD; not real).
// One source of truth: 01_signals turns them into hiring signals and mock Apollo
// serves their firmographics, so the cohort runs through the real pipeline stages.

export interface MockCompany {
  domain: string;
  name: string;
  industry: string;
  headcount: number;
  hqCountry: string;
  hiringFor: string;
  signalAgeDays: number;
}

export const LEARNING_COHORT: readonly MockCompany[] = [
  { domain: 'acornmetrics.example', name: 'Acorn Metrics', industry: 'Data & Analytics', headcount: 85, hqCountry: 'US', hiringFor: 'Head of Revenue Operations', signalAgeDays: 1 },
  { domain: 'bluefjord.example', name: 'Blue Fjord', industry: 'Developer Tools', headcount: 60, hqCountry: 'NL', hiringFor: 'RevOps Manager', signalAgeDays: 2 },
  { domain: 'cobaltpay.example', name: 'Cobalt Pay', industry: 'Fintech Infrastructure', headcount: 220, hqCountry: 'GB', hiringFor: 'Director of Sales Operations', signalAgeDays: 4 },
  { domain: 'driftwoodhq.example', name: 'Driftwood', industry: 'B2B SaaS', headcount: 130, hqCountry: 'US', hiringFor: 'VP Revenue Operations', signalAgeDays: 3 },
  { domain: 'emberstack.example', name: 'Ember Stack', industry: 'Developer Tools', headcount: 75, hqCountry: 'DE', hiringFor: 'Head of Revenue Operations', signalAgeDays: 5 },
  { domain: 'fernlogic.example', name: 'Fern Logic', industry: 'B2B SaaS', headcount: 95, hqCountry: 'CH', hiringFor: 'RevOps Manager', signalAgeDays: 2 },
  { domain: 'granitecloud.example', name: 'Granite Cloud', industry: 'B2B SaaS', headcount: 310, hqCountry: 'US', hiringFor: 'Director of Sales Operations', signalAgeDays: 6 },
  { domain: 'harbourdata.example', name: 'Harbour Data', industry: 'Data & Analytics', headcount: 150, hqCountry: 'GB', hiringFor: 'Head of Revenue Operations', signalAgeDays: 1 },
  { domain: 'ironleaf.example', name: 'Ironleaf', industry: 'Fintech Infrastructure', headcount: 180, hqCountry: 'AT', hiringFor: 'VP Revenue Operations', signalAgeDays: 3 },
  { domain: 'junipersignal.example', name: 'Juniper Signal', industry: 'B2B SaaS', headcount: 55, hqCountry: 'US', hiringFor: 'RevOps Manager', signalAgeDays: 2 },
];
