import { LEARNING_COHORT } from '../../shared/mockCompanies';
import type { Candidate, PeopleSearchProvider } from './types';

// Simulates a people database search (Apollo-style). Returns everyone listed at a domain,
// including people who are not buyers, so the stage has to pick the right one.
// All people are fictional; domains use the reserved `.example` TLD.

const ROSTERS: Record<string, Candidate[]> = {
  'northwind-data.example': [
    { fullName: 'Jana Richter', title: 'Talent Acquisition Partner' },
    { fullName: 'Paul Wagner', title: 'CEO' },
    { fullName: 'Lena Hoffmann', title: 'Director of Sales Operations' },
  ],
  // Demo accounts for the contacts runner: nobody with a buyer title, and a catch-all mail server.
  'tidewater.example': [{ fullName: 'Rosa Martin', title: 'Office Manager' }],
  'lumenforge.example': [{ fullName: 'Chris Dunn', title: 'Head of Revenue Operations' }],
  ...Object.fromEntries(
    LEARNING_COHORT.map(c => [c.domain, [{ fullName: 'Alex Morgan', title: 'Account Executive' }, c.buyer]]),
  ),
};

export const mockPeopleSearch: PeopleSearchProvider = {
  name: 'apollo-people',
  costInCents: 1,
  async search(companyDomain) {
    return (ROSTERS[companyDomain] ?? []).map(person => ({ ...person }));
  },
};
