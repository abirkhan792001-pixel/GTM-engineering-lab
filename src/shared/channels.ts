import { z } from 'zod';
import channelsJson from '../context/channels.json';
import { AdPlatformSchema, ChannelSchema } from './types';

// Typed, validated view of src/context/channels.json.

const StepSchema = z.strictObject({
  day: z.number().int().nonnegative(),
  channel: ChannelSchema,
  action: z.string().min(1),
});

export const ChannelsConfigSchema = z
  .strictObject({
    version: z.string().min(1),
    description: z.string(),
    firstTouch: z.array(StepSchema).min(1),
    followUp: z.array(StepSchema).min(1),
    adPlatforms: z.array(AdPlatformSchema),
    founderPostAds: z.strictObject({
      maxAgeDays: z.number().positive(),
      minImpressions: z.number().int().nonnegative(),
      minEngagementRatePct: z.number().min(0).max(100),
      maxPostsToPromote: z.number().int().nonnegative(),
    }),
  })
  .superRefine((config, ctx) => {
    // The draft the pipeline writes is the day-0 email; a sequence must open with it.
    for (const key of ['firstTouch', 'followUp'] as const) {
      const steps = config[key];
      if (!steps.some(step => step.day === 0 && step.channel === 'email')) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} must start with a day-0 email step (the draft a person approves)` });
      }
      if (steps.some((step, i) => i > 0 && step.day < steps[i - 1]!.day)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} steps must be in day order` });
      }
    }
  });
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const CHANNELS: ChannelsConfig = ChannelsConfigSchema.parse(channelsJson);
