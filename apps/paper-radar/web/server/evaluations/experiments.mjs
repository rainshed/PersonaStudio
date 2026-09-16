import { casePlan } from './current-input.mjs';
import { resolveConnection } from '../../lib/host-models.ts';
import { digest } from '../prompts/store.mjs';
import { compositionFor, fingerprintInput } from '../prompts/render-policy.mjs';
import { fail } from './errors.mjs';
import { identifier, stamp } from './repository.mjs';

// The editor and settings use the same language-specific prompt definitions.
// Only prompts actually consumed by this suite can be overridden.
export function suitePrompts(
  service,
  suite,
  snapshot = service.prompts.snapshot(),
) {
  const ids = new Set();
  for (const member of suite.members) {
    const c = service.caseRevision(member);
    const planInput = casePlan(service, c);
    const input = {
      prompt: { prompt_id: planInput.prompt_id },
      variables: planInput.variables,
    };
    const preview = service.prompts.preview(
      input.prompt.prompt_id,
      input.variables,
      { snapshot },
    );
    Object.keys(preview.versions).forEach((id) => ids.add(id));
    // An empty shared rule is still editable.
    const plan = compositionFor(input.prompt.prompt_id, input.variables);
    if (plan) ids.add(plan.shared);
  }
  return [...ids];
}

export async function experimentOptions(service, suiteId, scopeKey) {
  const models = service.models;
  const hosts = models.hosts ?? { [models.mode ?? 'dsh']: models };
  const results = await Promise.allSettled(
    Object.entries(hosts).map(async ([id, host]) => {
      const config = await host.config();
      const settings = structuredClone(host.store.state.settings);
      const choices = (config.catalog?.groups ?? [])
        .flatMap((g) => g.models)
        .filter((m) => !m.unavailable)
        .map((m) => ({ ...m, providerId: m.provider, modelId: m.model }));
      return {
        id,
        name: id === 'codex' ? 'Codex' : 'DSH',
        connected: config.connected,
        error: config.error?.message,
        models: choices,
        settings,
        routing: config.routing,
        default: resolveConnection(settings, 'screen') ?? null,
        defaults: Object.fromEntries(
          ['screen', 'single'].map((task) => [
            task,
            resolveConnection(settings, task) ?? null,
          ]),
        ),
      };
    }),
  );
  service.experimentHosts = new Map(
    results.flatMap((r, i) => {
      if (r.status === 'fulfilled') return [[r.value.id, r.value]];
      const id = Object.keys(hosts)[i];
      return [
        [
          id,
          {
            id,
            name: id === 'codex' ? 'Codex' : 'DSH',
            connected: false,
            models: [],
            error: '暂时无法连接',
            default: null,
          },
        ],
      ];
    }),
  );
  const suite =
    suiteId === 'dataset'
      ? service.datasetSuite(scopeKey)
      : suiteId
        ? service.repo.get('evaluation_suites', suiteId)
        : null;
  const tasks = [
    ...new Set(
      (suite?.members ?? [])
        .map((m) => service.caseRevision(m))
        .map((c) =>
          casePlan(service, c).prompt_id === 'paper-radar.task-single'
            ? 'single'
            : 'screen',
        ),
    ),
  ];
  const prompts = suite
    ? suitePrompts(service, suite).map((id) => {
        const p = service.prompts.detail(id);
        return {
          id,
          name: p.name,
          kind: p.kind,
          language: p.language,
          settings_role: p.settings_role,
          active_version: p.active_version,
          templates: p.active.templates,
        };
      })
    : [];
  return {
    active_backend: models.activeBackend ?? models.mode ?? 'dsh',
    hosts: [...service.experimentHosts.values()].map(
      ({ settings: _settings, routing: _routing, ...host }) => ({
        ...host,
        default: host.defaults?.[tasks[0] ?? 'screen'] ?? host.default,
      }),
    ),
    prompt_fields: prompts,
  };
}

export function experimentCandidate(service, candidate, suite, bundle) {
  const selection = candidate.selection;
  const host = service.experimentHosts?.get(selection.backend);
  if (!host?.connected)
    fail('not_configured', '所选 Agent 暂不可用，请刷新配置或到设置中连接。');
  const model = host.models.find(
    (m) =>
      m.providerId === selection.providerId && m.modelId === selection.modelId,
  );
  if (!model) fail('invalid_request', '所选模型不可用，请刷新配置。');
  const effort =
    selection.reasoningEffort ?? model.reasoning?.defaultEffort ?? null;
  if (effort && !model.reasoning?.efforts?.some((e) => e.id === effort))
    fail('invalid_request', '所选模型不支持这个思考强度。');
  const connection = {
    id: 'evaluation-selection',
    name: model.name,
    providerId: model.providerId,
    modelId: model.modelId,
    reasoningEffort: effort,
    contextWindow: model.contextWindow ?? 200000,
    maxTokens: model.maxTokens ?? 8192,
  };
  const settings = {
    ...structuredClone(host.settings),
    connections: [connection],
    defaultConnectionId: connection.id,
    overrides: { screen: connection.id, single: connection.id },
    fallback: { enabled: false },
  };
  const snapshot = structuredClone(bundle);
  const allowed = suitePrompts(service, suite, snapshot);
  const overrides = candidate.prompt_overrides ?? {};
  if (
    !overrides ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides) ||
    Object.keys(overrides).some((id) => !allowed.includes(id))
  )
    fail('invalid_request', '实验只能修改此测试集使用的提示词。');
  for (const [id, templates] of Object.entries(overrides))
    snapshot.versions[id] = service.prompts.makeVersion(
      id,
      templates,
      '推荐评测实验',
    );
  snapshot.fingerprint = digest(
    fingerprintInput(
      snapshot,
      Object.fromEntries(
        Object.entries(snapshot.versions).map(([id, v]) => [id, v.id]),
      ),
    ),
  );
  return {
    settings,
    connection,
    snapshot,
    backend: host.id,
    experimental: true,
    base_prompt_versions: Object.fromEntries(
      allowed.map((id) => [id, bundle.versions[id].id]),
    ),
    prompt_changes: allowed.filter(
      (id) => snapshot.versions[id].id !== bundle.versions[id].id,
    ),
    prompt_fields: allowed.map((id) => ({
      id,
      name: service.prompts.definition(id).name,
      templates: snapshot.versions[id].templates,
    })),
  };
}

export function saveDraft(service, raw) {
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 150)
    fail('invalid_request', '请输入实验名称。');
  service.prepare(raw.configuration);
  const old = raw.id ? service.repo.get('evaluation_drafts', raw.id) : null;
  if (old && raw.revision !== old.revision)
    fail('conflict', '草稿已在其他页面修改，请重新打开。', 409);
  return service.repo.put('evaluation_drafts', {
    id: old?.id ?? identifier('draft'),
    name: raw.name.trim(),
    name_is_default:
      raw.name_is_default === true && raw.name === '我的推荐测试集 · 新实验',
    revision: (old?.revision ?? 0) + 1,
    configuration: raw.configuration,
    updated_at: stamp(),
  });
}
