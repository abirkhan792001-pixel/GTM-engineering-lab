import { mergedEnrichmentData } from '../../02_enrichment/index';
import { CrmSyncSchema, type CrmSync, type Lead } from '../../shared/types';

// Simulates an Attio/HubSpot connection with an in-memory store. Upserts are
// idempotent: syncing the same domain twice updates the existing records.

export interface SuppressionCheck {
  suppressed: boolean;
  reason: string | null;
}

export interface CrmAdapter {
  checkSuppression(query: { domain: string; email?: string | null }): Promise<SuppressionCheck>;
  syncContact(lead: Lead): Promise<CrmSync>;
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
}

const CRM_BASE_URL = 'https://crm.mock.example';

export function createMockCRM(fixtures: CrmFixtures = DEFAULT_CRM_FIXTURES): CrmAdapter & { records: Map<string, CompanyRecord> } {
  const records = new Map<string, CompanyRecord>();
  const has = (list: string[], value: string) => list.some(item => item.toLowerCase() === value.toLowerCase());

  return {
    records,

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
      const record: CompanyRecord = existing ?? { companyRecordId: `company_${slug}`, dealId: `deal_${slug}`, fields: {} };
      record.fields = {
        ...record.fields,
        ...mergedEnrichmentData(lead),
        domain: lead.companyDomain,
        icpScore: lead.qualification?.score ?? null,
        icpDecision: lead.qualification?.decision ?? null,
        icpEvidence: lead.qualification?.evidence ?? [],
        dealStage: 'Qualified - outreach draft pending approval',
      };
      records.set(key, record);
      return CrmSyncSchema.parse({
        action: existing ? 'updated' : 'created',
        companyRecordId: record.companyRecordId,
        dealId: record.dealId,
        url: `${CRM_BASE_URL}/companies/${record.companyRecordId}`,
      });
    },
  };
}

export const mockCRM = createMockCRM();
