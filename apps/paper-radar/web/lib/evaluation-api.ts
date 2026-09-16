import { analysisApi } from './analysis-api';
export type EvaluationOutcome = 'recommended' | 'not_recommended';
export type EvaluationCase = {
  id: string;
  state: 'active' | 'withdrawn' | 'deleted';
  benchmark_revision: number;
  feedback_revision: number;
  original_outcome: EvaluationOutcome;
  expected_outcome: EvaluationOutcome;
  replay_status: string;
  group_id: string;
  input_hash: string | null;
  updated_at: string;
  feedback: { value: 'positive' | 'negative'; reason: string } | null;
  source: {
    scope_key?: string;
    scope_name?: string;
    kind?: 'analysis' | 'screening';
    job_id?: string;
    version_id: string;
    paper: { id: string; title: string; version?: number };
    subscription: { name: string; recommendation_strictness?: string };
    subscription_id: string;
    date: string;
    item_id: string;
    run_id: string;
    original_result?: { reason: string } | null;
  };
};
export type EvaluationSuite = {
  scope_key?: string | null;
  scope_name?: string;
  id: string;
  name: string;
  purpose: string;
  automatic?: boolean;
  version?: number;
  parent_id?: string;
  hash: string;
  created_at: string;
  members: {
    case_id: string;
    benchmark_revision: number;
    expected_outcome: EvaluationOutcome;
    replay_status: string;
    group_id: string;
  }[];
};
export type Ratio = {
  numerator: number;
  denominator: number;
  value: number | null;
};
export type EvaluationScore = {
  total: number;
  valid: number;
  correct: number;
  TP: number;
  TN: number;
  FP: number;
  FN: number;
  pass_rate: Ratio;
  coverage: Ratio;
  accuracy: Ratio;
  false_positive_rate: Ratio;
  false_negative_rate: Ratio;
  states: Record<string, number>;
};
export type EvaluationItem = {
  id: string;
  case_id: string;
  candidate_id: string;
  status: string;
  outcome: EvaluationOutcome | null;
  expected_outcome: EvaluationOutcome;
  duration_ms?: number;
  attempts: {
    usage?: { input?: number; output?: number; cost?: number | null };
  }[];
  error?: { message: string };
  output?: { reason: string; introduction: string };
};
export type EvaluationUsage = {
  calls: number;
  input: number;
  output: number;
  cost: number | null;
  known_cost: number;
  cost_complete: boolean;
  unknown_cost_calls: number;
  token_usage_complete: boolean;
};
export type EvaluationRun = {
  id: string;
  status: string;
  created_at: string;
  suite_id: string;
  name?: string;
  name_is_default?: boolean;
  application?: {
    candidate_id: string;
    applied_at: string;
    restored_at?: string;
  };
  partial: boolean;
  max_calls: number;
  actual_calls: number;
  usage: { input: number; output: number; cost: number | null };
  error: string | null;
  title: string;
  items: EvaluationItem[];
  scores: Record<string, EvaluationScore>;
  candidate_usage?: Record<string, EvaluationUsage>;
  candidates: {
    id: string;
    prompt_version: string;
    experimental?: boolean;
    current?: boolean;
    task_models?: Record<string, { modelId: string; reasoningEffort?: string }>;
    backend?: string;
    prompt_fields?: {
      id: string;
      name: string;
      templates: Record<string, string>;
    }[];
    attempt_unit?: string;
    model: { name?: string; modelId: string; reasoningEffort?: string };
  }[];
  comparisons: { case_id: string; change: string; both_valid: boolean }[];
};
export type EvaluationOptions = {
  connections: { id: string; name: string; modelId: string }[];
  default_connection_id: string | null;
  prompts: {
    id: string;
    name: string;
    active_version: string;
    versions: { id: string; label: string }[];
  }[];
};
export type EvaluationPreview = {
  preview_id: string;
  cases: number;
  papers: number;
  recommended: number;
  input_missing: number;
  max_calls: number;
  max_tokens: number;
  token_budget: number;
  note: string;
  candidates: {
    id: string;
    prompt_version: string;
    attempt_unit?: string;
    model: { modelId: string };
  }[];
};
export function evaluationApi<T>(
  path: string,
  init: Parameters<typeof analysisApi>[1] = {},
) {
  return analysisApi<T>('evaluations/v1/' + path, init);
}
export function evaluationWrite<T>(
  path: string,
  value: unknown = {},
  method = 'POST',
) {
  return evaluationApi<T>(path, { method, body: value });
}

export type ExperimentSelection = {
  backend: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string | null;
};
export type ExperimentPrompt = {
  id: string;
  name: string;
  kind: string;
  language?: string;
  settings_role?: string;
  active_version: string;
  templates: Record<string, string>;
};
export type ExperimentOptions = {
  active_backend: string;
  hosts: {
    id: string;
    name: string;
    connected: boolean;
    error?: string;
    default: {
      providerId: string;
      modelId: string;
      reasoningEffort?: string | null;
    } | null;
    defaults?: Record<
      string,
      { modelId: string; reasoningEffort?: string | null } | null
    >;
    models: {
      name: string;
      providerId: string;
      modelId: string;
      reasoning?: {
        defaultEffort?: string;
        efforts: { id: string; name: string }[];
      } | null;
    }[];
  }[];
  prompt_fields: ExperimentPrompt[];
};
export type ExperimentConfiguration = {
  name?: string;
  name_is_default?: boolean;
  suite_id: string;
  candidates: {
    selection: ExperimentSelection;
    current?: boolean;
    prompt_overrides?: Record<string, Record<string, string>>;
  }[];
  max_calls?: number;
  token_budget?: number;
};
export type ExperimentDraft = {
  name_is_default?: boolean;
  id: string;
  name: string;
  revision: number;
  configuration: ExperimentConfiguration;
  updated_at: string;
};
export type ApplicationPreview = {
  token: string;
  restore: boolean;
  from_backend: string;
  to_backend: string;
  from_model: { modelId: string; reasoningEffort?: string | null };
  to_model: { modelId: string; reasoningEffort?: string | null };
  prompts: {
    id: string;
    name: string;
    shared: boolean;
    before: Record<string, string>;
    after: Record<string, string>;
  }[];
};
