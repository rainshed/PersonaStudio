import { z } from 'zod';
import { STRICTNESS } from './task.ts';

export const analysisInputSchema = z
  .object({
    arxiv_input: z.string().max(500),
    persona_connection_id: z.string().max(100).nullable().default(null),
    scope: z
      .object({
        tag_ids: z.array(z.string().min(1).max(150)).max(30),
        tag_match: z.literal('any').default('any'),
      })
      .strict(),
    language: z.enum(['zh', 'en']),
    summary_length: z
      .object({
        min: z.number().int().min(200).max(2999),
        max: z.number().int().min(201).max(3000),
      })
      .strict(),
    recommendation_strictness: z.enum(STRICTNESS).default('balanced'),
    force_regenerate: z.boolean().default(false),
  })
  .strict();

export const followedAuthorsSchema = z.array(z.string().trim().min(1).max(150)).max(200);

export const subscriptionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    subject: z.string().min(1).max(80).optional(),
    subjects: z.array(z.string().min(1).max(80)).min(1).max(155).optional(),
    followed_authors: followedAuthorsSchema.default([]),
    persona_connection_id: z.string().max(100).nullable().default(null),
    scope: z
      .object({
        tag_ids: z.array(z.string().min(1).max(150)).max(30),
        tag_match: z.literal('any'),
      })
      .strict(),
    language: z.enum(['zh', 'en']),
    recommendation_strictness: z.enum(STRICTNESS).default('balanced'),
    summary_length: z
      .object({ min: z.number().int(), max: z.number().int() })
      .strict(),
    status: z.enum(['draft', 'enabled', 'paused', 'archived']).default('draft'),
    persona_reselection_required: z.boolean().optional(),
    include_updates: z.boolean().default(false),
    max_model_calls: z.number().int().min(1).max(2000).default(200),
  })
  .strict();

export type AnalysisInput = z.output<typeof analysisInputSchema>;
// Pre-v0.4 records may omit strictness; readers preserve that historical fact.
export type StoredAnalysisInput = Omit<
  AnalysisInput,
  'recommendation_strictness'
> & {
  recommendation_strictness?: AnalysisInput['recommendation_strictness'];
};
export type SubscriptionSettings = z.output<typeof subscriptionSchema>;
