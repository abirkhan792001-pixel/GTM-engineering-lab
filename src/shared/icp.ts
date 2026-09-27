import { z } from 'zod';
import { readContextFile } from './profile';

// Typed, validated view of icp.json (src/context/, or the GTM_PROFILE folder). Config is
// input like any other: a typo or a rubric that does not sum to 100 fails at load time.

const Points = z.number().int().nonnegative();

export const IcpSchema = z
  .object({
    version: z.string().min(1),
    description: z.string(),
    companySize: z.strictObject({ minEmployees: Points, maxEmployees: Points }),
    targetIndustries: z.array(z.string().min(1)).min(1),
    targetCountries: z.array(z.string().length(2)).min(1),
    dealbreakers: z.array(z.string().min(1)),
    hardGates: z.strictObject({
      minHeadcount: Points,
      excludedBusinessModels: z.array(z.string().min(1)),
      excludedIndustryKeywords: z.array(z.string().min(1)),
      requireTargetCountry: z.boolean(),
    }),
    scoring: z.strictObject({
      weights: z.strictObject({ industry: Points, companySize: Points, country: Points }),
      signalPoints: z.record(z.string(), Points).refine(p => 'default' in p, "signalPoints needs a 'default' entry"),
      maxSignalAgeDays: z.number().positive(),
    }),
    qualification: z.strictObject({
      passThreshold: z.number().min(0).max(100),
      holdThreshold: z.number().min(0).max(100),
      requiredFields: z.array(z.string().min(1)).min(1),
      notes: z.string(),
    }),
  })
  .superRefine((icp, ctx) => {
    const { weights, signalPoints } = icp.scoring;
    const max = weights.industry + weights.companySize + weights.country + Math.max(...Object.values(signalPoints));
    if (max !== 100) ctx.addIssue({ code: 'custom', path: ['scoring'], message: `Maximum rubric score is ${max}; it must be 100` });
    if (icp.qualification.holdThreshold > icp.qualification.passThreshold) {
      ctx.addIssue({ code: 'custom', path: ['qualification'], message: 'holdThreshold must not exceed passThreshold' });
    }
    if (icp.companySize.minEmployees > icp.companySize.maxEmployees) {
      ctx.addIssue({ code: 'custom', path: ['companySize'], message: 'minEmployees must not exceed maxEmployees' });
    }
  });
export type Icp = z.infer<typeof IcpSchema>;

export function parseIcp(json: string, label = 'icp.json'): Icp {
  const parsed = IcpSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`${label} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export const ICP: Icp = parseIcp(readContextFile('icp.json'));
