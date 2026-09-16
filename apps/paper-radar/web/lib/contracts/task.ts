import { z } from 'zod';

export const ANALYSIS_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export const DAILY_STATUSES = [
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
  'paused',
] as const;
export const DISCUSSION_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export const COMPONENT_STATUSES = [
  'pending',
  'available',
  'failed',
  'needs_review',
  'not_requested',
] as const;
export const SCREENING_DECISIONS = [
  'recommended',
  'not_recommended',
  'needs_fulltext',
] as const;
export const ANALYSIS_DECISIONS = [
  'recommended',
  'not_recommended',
  'undetermined',
] as const;
export const STRICTNESS = ['focused', 'balanced', 'exploratory'] as const;

export const analysisStatusSchema = z.enum(ANALYSIS_STATUSES);
export const dailyStatusSchema = z.enum(DAILY_STATUSES);
export const discussionStatusSchema = z.enum(DISCUSSION_STATUSES);
export const componentStatusSchema = z.enum(COMPONENT_STATUSES);
export const screeningDecisionSchema = z.enum(SCREENING_DECISIONS);
export const analysisDecisionSchema = z.enum(ANALYSIS_DECISIONS);
export const taskErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;
export type DailyStatus = z.infer<typeof dailyStatusSchema>;
export type DiscussionStatus = z.infer<typeof discussionStatusSchema>;
export type ComponentStatus = z.infer<typeof componentStatusSchema>;
export type ScreeningDecision = z.infer<typeof screeningDecisionSchema>;
export type AnalysisDecision = z.infer<typeof analysisDecisionSchema>;
export type TaskError = z.infer<typeof taskErrorSchema>;

export const isTaskActive = (status: string) =>
  status === 'queued' || status === 'running';
export const isBinaryDecision = (
  value: unknown,
): value is 'recommended' | 'not_recommended' =>
  value === 'recommended' || value === 'not_recommended';

// Execution, recommendation and content availability are separate dimensions.
// An unsuccessful task can still have a valid submitted component; neither
// failure nor lack of a judgment is a negative recommendation.
export function taskPresentation(
  status: AnalysisStatus | DailyStatus | DiscussionStatus,
) {
  return {
    active: isTaskActive(status),
    successful: status === 'succeeded' || status === 'completed',
    retryable: [
      'failed',
      'interrupted',
      'partial',
      'paused',
      'cancelled',
    ].includes(status),
  };
}
