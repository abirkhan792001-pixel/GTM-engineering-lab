import { z } from 'zod';
import routingJson from '../context/routing.json';
import { ICP } from './icp';

// Typed, validated view of src/context/routing.json.

export const RoutingSchema = z.strictObject({
  version: z.string().min(1),
  description: z.string(),
  // Signal types (from icp.json scoring.signals) that hand a lead straight to sales.
  routeToSalesSignals: z.array(z.string().min(1)),
  // The most first-touch emails per day: drafts per batch run, sends per day after approval.
  dailyOutreachLimit: z.number().int().positive(),
});
export type Routing = z.infer<typeof RoutingSchema>;

export const ROUTING: Routing = RoutingSchema.superRefine((routing, ctx) => {
  for (const type of routing.routeToSalesSignals) {
    if (!(type in ICP.scoring.signals) || type === 'default') {
      ctx.addIssue({ code: 'custom', path: ['routeToSalesSignals'], message: `'${type}' is not a signal type in icp.json scoring.signals` });
    }
  }
}).parse(routingJson);
