import type { EmailStatus } from '../../shared/types';

export interface Candidate {
  fullName: string;
  title: string;
}

// Looks up the people employed at a company (e.g. an Apollo people search).
export interface PeopleSearchProvider {
  name: string;
  costInCents: number;
  search(companyDomain: string): Promise<Candidate[]>;
}

// Finds a work email for one person and reports its verification status.
export interface EmailFinderProvider {
  name: string;
  costInCents: number;
  find(input: { fullName: string; companyDomain: string }): Promise<{ email: string | null; status: EmailStatus }>;
  // Checks an address we already have (e.g. from a form fill). Providers without it fall
  // back to find(), which may return a different address.
  verify?(email: string): Promise<{ email: string; status: EmailStatus }>;
}
