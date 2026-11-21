import { mergedEnrichmentData } from '../../02_enrichment/index';
import { CrmSyncSchema, TouchSchema, type CrmSync, type Lead, type Touch } from '../../shared/types';

// Simulates an Attio/HubSpot connection with an in-memory store. Upserts are
// idempotent: syncing the same domain twice updates the existing records. Each account
// also has a timeline of touches (engagement in, outreach out) for attribution; a touch
// logged twice under the same id is kept once.

export interface SuppressionCheck {
  suppressed: boolean;
  reason: string | null;
}

export interface CrmAdapter {
  checkSuppression(query: { domain: string; email?: string | null }): Promise<SuppressionCheck>;
  syncContact(lead: Lead): Promise<CrmSync>;
  logTouch(touch: Touch): Promise<'logged' | 'duplicate'>;
  // The account's touches, oldest first.
  timeline(domain: string): Promise<Touch[]>;
}

export interface CrmFixtures {
  existingCustomers: string[];
  openOpportunities: string[];
  suppressedDomains: string[];
  suppressedEmails: string[];
}

// Synthetic `.example` domains only.
export const DEFAULT_CRM_FIXTURES: CrmFixtures = {
  existingCustomers: ['brightledger.example'],
  openOpportunities: ['harborline.example'],
  suppressedDomains: ['donotcontact.example'],
  suppressedEmails: ['optout@northwind-data.example'],
};

interface CompanyRecord {
  companyRecordId: string;
  dealId: string;
  fields: Record<string, unknown>;
  // The buyer from 04_contacts, linked to the company and deal.
  contact: { contactRecordId: string; fields: Record<string, unknown> } | null;
}

const CRM_BASE_URL = 'https://crm.mock.example';

export function createMockCRM(fixtures: CrmFixtures = DEFAULT_CRM_FIXTURES): CrmAdapter & { records: Map<string, CompanyRecord>; touches: Map<string, Touch[]> } {
  const records = new Map<string, CompanyRecord>();
  const touches = new Map<string, Touch[]>();
  const has = (list: string[], value: string) => list.some(item => item.toLowerCase() === value.toLowerCase());

  return {
    records,
    touches,

    async checkSuppression({ domain, email }) {
      if (email && has(fixtures.suppressedEmails, email)) return { suppressed: true, reason: `Email ${email} is on the suppression list` };
      if (has(fixtures.suppressedDomains, domain)) return { suppressed: true, reason: `Domain ${domain} is on the suppression list` };
      if (has(fixtures.existingCustomers, domain)) return { suppressed: true, reason: `${domain} is an existing customer` };
      if (has(fixtures.openOpportunities, domain)) return { suppressed: true, reason: `${domain} already has an open opportunity` };
      return { suppressed: false, reason: null };
    },

    async syncContact(lead) {
      const key = lead.companyDomain;
      const existing = records.get(key);
      const slug = key.replace(/[^a-z0-9]+/g, '-');
      const record: CompanyRecord = existing ?? { companyRecordId: `company_${slug}`, dealId: `deal_${slug}`, fields: {}, contact: null };
      record.fields = {
        ...record.fields,
        ...mergedEnrichmentData(lead),
        domain: lead.companyDomain,
        icpScore: lead.qualification?.score ?? null,
        icpDecision: lead.qualification?.decision ?? null,
        icpEvidence: lead.qualification?.evidence ?? [],
        dealStage: 'Qualified - outreach draft pending approval',
      };
      const person = lead.contact?.person;
      if (person) {
        const contactRecordId = `contact_${person.fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${slug}`;
        record.contact = {
          contactRecordId,
          fields: {
            fullName: person.fullName,
            title: person.title,
            persona: person.personaId,
            email: lead.contact?.email ?? null,
            emailStatus: lead.contact?.emailStatus ?? null,
          },
        };
      }
      records.set(key, record);
      return CrmSyncSchema.parse({
        action: existing ? 'updated' : 'created',
        companyRecordId: record.companyRecordId,
        contactRecordId: record.contact?.contactRecordId ?? null,
        dealId: record.dealId,
        url: `${CRM_BASE_URL}/companies/${record.companyRecordId}`,
      });
    },

    async logTouch(input) {
      const touch = TouchSchema.parse(input);
      const list = touches.get(touch.companyDomain) ?? [];
      touches.set(touch.companyDomain, list);
      if (list.some(t => t.id === touch.id)) return 'duplicate';
      list.push(touch);
      return 'logged';
    },

    async timeline(domain) {
      return [...(touches.get(domain.toLowerCase()) ?? [])].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    },
  };
}

export const mockCRM = createMockCRM();
