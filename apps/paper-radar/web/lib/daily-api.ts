import type { SubscriptionSettings } from './contracts/analysis';
import type { DailyStatus } from './contracts/task';
import type { DailySource } from './daily-source';
import type { Feedback, FeedbackDimension } from './radar';
import type {
  RealTag,
  RealJob,
  TaskError,
  PersonalData,
  Evidence,
  PersonaCoverage,
} from './analysis-api';
export type DailySubscription = Omit<
  SubscriptionSettings,
  'subject' | 'subjects' | 'followed_authors'
> & {
  id: string;
  subject: string;
  subjects?: string[];
  followed_authors?: string[];
  tags: RealTag[];
  revision: number;
  created_at: string;
  updated_at: string;
};
export type SubscriptionDraft = Omit<
  DailySubscription,
  | 'id'
  | 'tags'
  | 'revision'
  | 'created_at'
  | 'updated_at'
  | 'subject'
  | 'subjects'
> & { subjects: string[] };
export type DailyRun = {
  id: string;
  report_id: string | null;
  subscription: DailySubscription;
  date?: string;
  source?: DailySource;
  generation?: number;
  status: DailyStatus;
  message: string;
  created_at: string;
  updated_at: string;
  actual_attempts: number;
  max_model_calls: number;
  error: TaskError | null;
  stats: {
    followed_authors?: number;
    screened: number;
    screening_pending: number;
    needs_confirmation: number;
    details_active: number;
    total: number;
    recommended: number;
    not_recommended: number;
    pending: number;
    details_complete: number;
    excluded: number;
    failed: number;
    reused?: number;
  };
  discovery: null | {
    batch_id: string;
    revision_id: string;
    date: string;
    subject: string;
    subjects?: string[];
    sources?: {
      subject: string;
      date: string | null;
      status: string;
      completeness: string;
      source_url: string;
      issues: string[];
    }[];
    cross_subject_duplicates?: number;
    completeness: string;
    issues: string[];
    coverage_basis: string;
    source_url: string;
    raw_count: number;
    duplicates: number;
    rejected: { id: string; reason: string }[];
  };
  persona: null | {
    revision: number;
    tags: RealTag[];
    coverage: PersonaCoverage;
  };
  usage: {
    requests: number;
    recorded_attempts: number;
    input: number;
    output: number;
    cost: number | null;
  };
  models: { task: string; model: string }[];
};
export type DailyVersion = {
  id: string;
  kind: 'screening' | 'analysis';
  analysis_id?: string;
  data: Partial<PersonalData> & {
    introduction?: string;
    questions_for_fulltext?: string[];
    outcome?: string;
    reason?: string;
    paper_evidence_ids?: string[];
    persona_evidence_ids?: string[];
  };
  persona_revision: number;
  model?: { model_id: string; reasoning_effort?: string | null };
  created_at?: string;
  reading_coverage?: {
    complete: boolean;
    total_records: number | null;
    delivered_records: number;
    paper_sections: string[];
  };
  cache_hit?: boolean;
  evidence_index: Omit<Evidence, 'text'>[];
  feedback: Partial<Record<FeedbackDimension, Feedback>>;
  feedback_dimensions: FeedbackDimension[];
};
export type DailyItem = {
  id: string;
  run_id: string;
  paper: {
    id: string;
    version: number;
    url: string;
    title: string;
    abstract: string;
    authors: string[];
    categories: string[];
    announce_type: string;
    matched_subjects?: string[];
    source_matches?: {
      subject: string;
      version: number;
      announce_type: string;
    }[];
  };
  excluded: boolean;
  processing_status: string;
  screening_agent?: boolean;
  screening_active?: boolean;
  rescreen_requested?: boolean;
  screening_reuse?: {
    reused: boolean;
    version_id: string;
    generated_at: string;
    linked_at: string;
    reason: string;
  };
  agent_progress?: {
    phase: string;
    step?: number;
    coverage?: {
      total_records: number | null;
      delivered_records: number;
      complete: boolean;
    };
  };
  final_decision: 'recommended' | 'not_recommended' | null;
  decision_basis: string | null;
  analysis_decision?: 'recommended' | 'not_recommended' | 'undetermined' | null;
  details_status: string;
  job_id: string | null;
  analysis_id: string | null;
  current_version_id: string | null;
  error: TaskError | null;
  version: DailyVersion | null;
  screening: DailyVersion | null;
  details_error?: TaskError | null;
  job: RealJob | null;
};
export type DailyReport = {
  id: string;
  date: string;
  subject: string;
  subjects?: string[];
  current_run_id: string;
  current_run?: DailyRun;
  runs?: DailyRun[];
};

export type FollowedAuthorPaper = DailyItem['paper'] & {
  date: string;
  matched_authors: string[];
  matched_subjects: string[];
};
export type FollowedAuthorFeed = {
  papers: FollowedAuthorPaper[];
  total: number;
  next_offset: number | null;
  sources: {
    subject: string;
    date: string | null;
    completeness: string;
    issues: string[];
  }[];
};
