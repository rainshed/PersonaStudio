import type { StoredAnalysisInput } from './contracts/analysis';
import type {
  AnalysisStatus,
  ComponentStatus,
  TaskError,
} from './contracts/task';
import type { Feedback, FeedbackDimension } from './radar';
import { readBackendResponse } from './backend-response.ts';
export type RealTag = {
  id: string;
  label: string;
  slug?: string;
  aliases: string[];
};
export type RealInput = StoredAnalysisInput;
export type { TaskError } from './contracts/task';
export type RealJob = {
  id: string;
  input: RealInput;
  status: AnalysisStatus;
  step: string;
  message: string;
  stages: { id: string; label: string; status: string; error?: TaskError }[];
  started_at?: string | null;
  created_at: string;
  updated_at: string;
  result_id: string | null;
  paper_title?: string;
  error: TaskError | null;
  actual_attempts: number;
  origin?: { daily_run_id: string; daily_item_id: string; trigger?: string };
};
export type SummaryData = {
  sections: { title: string; paragraphs: string[]; evidence_ids: string[] }[];
};
export type PersonalData = {
  matched_knowledge_ids?: string[];
  decision: 'recommended' | 'not_recommended' | 'undetermined';
  reasons: {
    text: string;
    paper_evidence_ids: string[];
    persona_evidence_ids: string[];
  }[];
  connections: {
    material_id: string;
    relation_type: string;
    explanation: string;
    paper_evidence_ids: string[];
    persona_evidence_ids: string[];
  }[];
  crossovers: {
    question: string;
    premises: string;
    supporting_evidence_ids: string[];
    unverified_points: string;
    first_check: string;
    novelty_check_scope: string;
  }[];
};
export type RealComponent<T> = {
  status: ComponentStatus;
  data?: T | null;
  actual_length?: number;
  version?: string;
  cache_hit?: boolean;
  error?: TaskError;
  validation?: { issues?: string[]; notes?: string[] };
  model?: {
    provider_id: string;
    model_id: string;
    request_id: string;
    fallback_from: string | null;
  };
};
export type Evidence = {
  id: string;
  title: string;
  kind: string;
  text: string;
  url?: string;
  section?: string;
  record_id?: string;
  record_revision?: number;
  lines?: number[];
  source_hash?: string;
  file_name?: string;
  pages?: number[];
  source_id?: string;
  file_id?: string;
  file_hash?: string;
  provenance?: Record<string, unknown>;
  locator?: Record<string, unknown>;
};
export type PersonaCoverage = {
  total_knowledge?: number;
  complete_knowledge_scan?: boolean;
  selected_records?: number;
  source_characters?: number;
  source_reading?: string;
  issues?: string[];
  // Saved historical reports retain their original coverage information.
  total_records?: number;
  searched_records?: number;
  complete_metadata_scan?: boolean;
};
export type RealResult = {
  id: string;
  job_id: string;
  created_at: string;
  settings_snapshot: RealInput;
  paper: {
    id: string;
    version: number;
    url: string;
    title: string;
    authors: string[];
    abstract: string;
    coverage: {
      format: string;
      reference_count: number | null;
      block_count: number;
      issues: string[];
    };
  };
  summary: RealComponent<SummaryData>;
  personalization: RealComponent<PersonalData>;
  persona: null | {
    schema_version?: string;
    knowledge_ids?: string[];
    revision: number;
    tags: RealTag[];
    records: {
      id: string;
      title: string;
      entity_type?: string;
      user_relationships?: string[];
    }[];
    coverage: PersonaCoverage;
  };
  evidence_index: Omit<Evidence, 'text'>[];
  feedback: Partial<Record<FeedbackDimension, Feedback>>;
  feedback_dimensions: FeedbackDimension[];
  quality_notice: string;
  attempts: {
    id: string;
    model_id: string;
    phase: string;
    status: string;
    duration_ms: number;
    usage: { input: number; output: number; cost: number | null } | null;
  }[];
};
export async function analysisApi<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const response = await fetch('/api/' + path, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.method && options.method !== 'GET'
        ? { 'Content-Type': 'application/json', 'X-Paper-Radar': '1' }
        : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 100000)])
      : AbortSignal.timeout(options.timeoutMs ?? 100000),
    cache: 'no-store',
  });
  return readBackendResponse<T>(response);
}
