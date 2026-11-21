import { z } from 'zod';
import icpJson from '../context/icp.json';

// Typed, validated view of src/context/icp.json. Config is input like any other:
// a typo or a rubric that does not sum to 100 fails at load time, not mid-run.

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
      // Signal type -> warmth tier (5 = hand-raise ... 1 = data only, see shared/warmth.ts) and points.
      signals: z
        .record(z.string(), z.strictObject({ tier: z.number().int().min(1).max(5), points: Points }))
        .refine(s => 'default' in s, "signals needs a 'default' entry"),
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
    const { weights, signals } = icp.scoring;
    const rules = Object.entries(signals);
    const max = weights.industry + weights.companySize + weights.country + Math.max(...rules.map(([, r]) => r.points));
    if (max !== 100) ctx.addIssue({ code: 'custom', path: ['scoring'], message: `Maximum rubric score is ${max}; it must be 100` });
    // The ladder must hold: a warmer signal never earns fewer points than a colder one.
    for (const [type, rule] of rules) {
      const colder = rules.find(([, other]) => other.tier < rule.tier && other.points > rule.points);
      if (colder) {
        ctx.addIssue({ code: 'custom', path: ['scoring', 'signals', type], message: `'${type}' (tier ${rule.tier}) earns fewer points than colder '${colder[0]}' (tier ${colder[1].tier})` });
      }
    }
    if (icp.qualification.holdThreshold > icp.qualification.passThreshold) {
      ctx.addIssue({ code: 'custom', path: ['qualification'], message: 'holdThreshold must not exceed passThreshold' });
    }
    if (icp.companySize.minEmployees > icp.companySize.maxEmployees) {
      ctx.addIssue({ code: 'custom', path: ['companySize'], message: 'minEmployees must not exceed maxEmployees' });
    }
  });
export type Icp = z.infer<typeof IcpSchema>;

export const ICP: Icp = IcpSchema.parse(icpJson);
