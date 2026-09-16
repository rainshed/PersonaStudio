import { readBackendResponse } from './backend-response.ts';

export type PromptTemplates = Record<string, string>;
export type PromptVersion = {
  id: string;
  templates: PromptTemplates;
  note: string;
  created_at: string;
  compatible?: boolean;
};
export type PromptEntry = {
  id: string;
  name: string;
  description: string;
  group: string;
  kind: 'message' | 'choice' | 'fragment';
  active_version: string;
  default_version: string;
  dependencies: string[];
  used_by: string[];
  language: 'zh' | 'en';
  settings_role: 'shared' | 'task' | 'screening_rule';
  task: string | null;
  screening_rule?: string;
  base_prompt?: string;
  variables: { name: string; label: string; required?: boolean }[];
};
export type PromptDetail = PromptEntry & {
  templates: PromptTemplates;
  active: PromptVersion;
  versions: PromptVersion[];
};
export type PromptPreview = {
  context?: AgentContext;
  preview_source?: {
    kind: string;
    run_id?: string;
    created_at?: string;
    tool_source?: string;
  };
  rendered: PromptTemplates;
  blocks: {
    kind: string;
    text: string;
    source: {
      prompt_id: string;
      version: string;
      language: string;
      rule?: string;
    };
  }[];
};
export type ContextSection = {
  id: string;
  kind: string;
  title: string;
  stage: string;
  status: string;
  editable: boolean;
  condition?: string;
  edit_target?: string;
  content: unknown;
  source: {
    label: string;
    kind: string;
    prompt_id?: string;
    version?: string;
    language?: string;
  };
};
export type AgentContext = {
  task: string;
  language: string;
  sample: boolean;
  sections: ContextSection[];
  request: {
    task: string;
    systemPrompt: string;
    prompt: string;
    tools: unknown[];
    submitTool: string;
  };
  runtime: {
    backend: string;
    messages: unknown[];
    conditional_messages: unknown[];
    response_schema?: unknown;
    unavailable: string[];
  };
  prompt_versions: Record<string, string>;
  input_template?: string;
};
export type ContextRunSummary = {
  id: string;
  created_at: string;
  task: string;
  language: string;
  title?: string;
  status: string;
  backend?: string;
  recording: string;
  experiment?: boolean;
};
export type ContextEvent = {
  seq: number;
  at: string;
  kind: string;
  source: string;
  content: unknown;
  delivery?: string;
  call_id?: string;
};
export type ContextRun = ContextRunSummary & {
  context?: AgentContext;
  prepared?: PromptPreview;
  events: ContextEvent[];
  next_after: number | null;
  event_count: number;
  recording_limited?: boolean;
  error?: { message: string };
};

export async function promptSettingsApi<T>(
  path = '',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return readBackendResponse<T>(
    await fetch(`/api/prompt-settings${path ? '/' + path : ''}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers:
        body === undefined
          ? undefined
          : {
              'Content-Type': 'application/json',
              'X-Paper-Radar': '1',
            },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }),
  );
}
