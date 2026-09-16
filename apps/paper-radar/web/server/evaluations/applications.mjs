import { hash } from '../analyses/contracts.mjs';
import { resolveConnection } from '../../lib/host-models.ts';
import { upgradeRoutes } from '../../lib/host-settings.ts';
import { identifier, stamp } from './repository.mjs';
import { fail } from './errors.mjs';
import { SCREEN_RULES } from '../prompts/language-prompts.mjs';

function validatePromptApplication(store, changes) {
  const snapshot = store.snapshot();
  for (const [id, version] of Object.entries(changes)) {
    snapshot.versions[id] = store.makeVersion(id, version.templates);
  }
  // Shared rules can affect tasks beyond screening. Check their complete
  // composition with the same synthetic inputs used by prompt settings.
  const changed = Object.keys(changes).map((id) => store.definition(id));
  for (const task of store
    .catalog()
    .filter((p) => p.settings_role === 'task')) {
    if (
      !changed.some(
        (p) =>
          p.id === task.id ||
          (p.language === task.language &&
            (p.settings_role === 'shared' ||
              (p.settings_role === 'screening_rule' &&
                task.task === 'screen'))),
      )
    )
      continue;
    for (const rule of task.task === 'screen' ? SCREEN_RULES : ['balanced']) {
      const variables = structuredClone(store.definition(task.id).example);
      if (task.task === 'screen') {
        variables.recommendation_strictness = rule;
        variables.task.criteria = {
          ...variables.task.criteria,
          strictness: rule,
        };
      }
      store.preview(task.id, variables, { snapshot });
    }
  }
}

const choice = (model) => ({
  model: model ? { provider: model.providerId, model: model.modelId } : null,
  reasoningEffort: model?.reasoningEffort ?? null,
});

async function currentState(service, backend, promptIds, tasks = ['screen']) {
  const router = service.models;
  const host =
    router.hosts?.[backend] ?? (backend === router.mode ? router : null);
  if (!host) fail('not_configured', '所选 Agent 不存在。');
  const config = await host.config();
  if (!config.connected)
    fail('not_configured', '所选 Agent 暂不可用，请先连接。');
  return {
    backend: router.activeBackend ?? router.mode,
    backend_revision: router.revision ?? 0,
    active_model: resolveConnection(
      (router.hosts?.[router.activeBackend] ?? host).store.state.settings,
      tasks[0],
    ),
    routing: config.routing,
    model: resolveConnection(host.store.state.settings, tasks[0]),
    prompts: Object.fromEntries(
      promptIds.map((id) => [id, service.prompts.version(id)]),
    ),
  };
}

export async function previewApplication(service, runId, raw) {
  const run = service.repo.get('evaluation_runs', runId);
  if (service.report(runId).status !== 'completed')
    fail('invalid_request', '请等待实验完成后再应用配置。');
  const restore = raw.restore === true;
  const candidate = run.candidates.find((c) => c.id === raw.candidate_id);
  const previous = run.application;
  if (restore && (!previous || previous.restored_at))
    fail('invalid_request', '没有可以恢复的应用记录。');
  if (!restore && (!candidate?.experimental || !candidate.settings))
    fail('invalid_request', '这个历史实验不支持直接应用，请创建新实验。');
  const backend = restore ? previous.target_backend : candidate.backend;
  const watchedIds = restore
    ? Object.keys(previous.before.prompts)
    : candidate.prompt_fields.map((p) => p.id);
  const ids = restore
    ? (previous.changed_ids ?? watchedIds)
    : watchedIds.filter(
        (id) =>
          service.prompts.version(id).id !==
          candidate.prompt_snapshot.versions[id].id,
      );
  const tasks = restore
    ? (previous.tasks ?? ['screen'])
    : (candidate.task_keys ?? ['screen']);
  const before = await currentState(service, backend, watchedIds, tasks);
  if (restore && hash(before) !== previous.after_hash)
    fail(
      'conflict',
      '应用后设置已有新修改，请在设置中选择需要恢复的版本。',
      409,
    );
  const target = restore
    ? {
        backend: previous.before.backend,
        routing: previous.before.routing,
        prompts: Object.fromEntries(
          ids.map((id) => [id, previous.before.prompts[id]]),
        ),
      }
    : {
        backend,
        routing: upgradeRoutes(before.routing),
        prompts: Object.fromEntries(
          ids.map((id) => [id, candidate.prompt_snapshot.versions[id]]),
        ),
      };
  if (!restore) {
    for (const task of tasks) {
      target.routing.assignments[task] = 'custom';
      target.routing.tasks[task] = choice(candidate.model);
    }
  }
  for (const [id, version] of Object.entries(target.prompts))
    service.prompts.makeVersion(id, version.templates);
  validatePromptApplication(service.prompts, target.prompts);
  const token = identifier('apply');
  service.applicationPreviews ??= new Map();
  for (const [key, plan] of service.applicationPreviews)
    if (Date.now() - plan.at > 1800000) service.applicationPreviews.delete(key);
  service.applicationPreviews.set(token, {
    runId,
    candidateId: candidate?.id,
    tasks,
    restore,
    backend,
    before,
    target,
    at: Date.now(),
  });
  return {
    token,
    restore,
    from_backend: before.backend,
    to_backend: target.backend,
    from_model: before.active_model,
    to_model: restore ? previous.before.active_model : candidate.model,
    prompts: ids.map((id) => ({
      id,
      name: service.prompts.definition(id).name,
      shared: service.prompts.definition(id).settings_role === 'shared',
      before: before.prompts[id].templates,
      after: target.prompts[id].templates,
    })),
  };
}

export async function applyConfiguration(service, runId, raw) {
  if (typeof raw.token !== 'string' || !raw.token)
    fail('invalid_request', '请先查看将要应用的配置。');
  if (service.applyingConfiguration)
    fail('conflict', '另一项配置正在应用，请稍后重试。', 409);
  service.applyingConfiguration = true;
  try {
    const run = service.repo.get('evaluation_runs', runId);
    if (
      run.application?.token === raw.token ||
      run.application?.restore_token === raw.token
    )
      return service.report(runId);
    const plan = service.applicationPreviews?.get(raw.token);
    if (!plan || plan.runId !== runId || Date.now() - plan.at > 1800000)
      fail('conflict', '配置预览已过期，请重新查看。', 409);
    const { before, target, backend } = plan;
    const fresh = await currentState(
      service,
      backend,
      Object.keys(before.prompts),
      plan.tasks,
    );
    if (hash(fresh) !== hash(before))
      fail('conflict', '设置已有变化，请重新查看将要应用的内容。', 409);
    validatePromptApplication(service.prompts, target.prompts);
    const router = service.models,
      host = router.hosts?.[backend] ?? router;
    let routed, selectedRevision;
    try {
      routed = await host.routing({
        ...target.routing,
        revision: before.routing.revision,
      });
      if (target.backend !== before.backend) {
        await router.selectBackend({
          backend: target.backend,
          revision: before.backend_revision,
        });
        selectedRevision = router.revision;
      }
      for (const [id, version] of Object.entries(before.prompts))
        if (service.prompts.version(id).id !== version.id)
          fail('conflict', '设置已有变化，请重新查看将要应用的内容。', 409);
      const changes = Object.entries(target.prompts).map(([id, version]) => ({
        prompt_id: id,
        version: service.prompts.saveVersion(
          id,
          version.templates,
          plan.restore ? '恢复评测前配置' : '应用推荐评测配置',
        ).id,
        expected_active: before.prompts[id].id,
      }));
      if (changes.length) service.prompts.activate(changes);
    } catch (error) {
      const rollbackErrors = [];
      if (selectedRevision !== undefined) {
        try {
          await router.selectBackend({
            backend: before.backend,
            revision: selectedRevision,
          });
        } catch (e) {
          rollbackErrors.push(e);
        }
      }
      if (routed) {
        try {
          await host.routing({
            ...before.routing,
            revision: routed.routing.revision,
          });
        } catch (e) {
          rollbackErrors.push(e);
        }
      }
      if (rollbackErrors.length)
        fail(
          'conflict',
          '配置未完整应用，部分模型设置未能恢复；请到设置中检查。',
          409,
        );
      throw error;
    }
    // Persist the exact previous configuration for an explicit restore action.
    // No network refresh is required after the successful writes.
    const after = {
      ...before,
      backend: target.backend,
      backend_revision: router.revision ?? 0,
      active_model: resolveConnection(
        (router.hosts?.[router.activeBackend] ?? host).store.state.settings,
        plan.tasks[0],
      ),
      routing: routed.routing,
      model: resolveConnection(host.store.state.settings, plan.tasks[0]),
      prompts: Object.fromEntries(
        Object.keys(before.prompts).map((id) => [
          id,
          service.prompts.version(id),
        ]),
      ),
    };
    run.application = plan.restore
      ? { ...run.application, restored_at: stamp(), restore_token: raw.token }
      : {
          token: raw.token,
          candidate_id: plan.candidateId,
          applied_at: stamp(),
          target_backend: backend,
          tasks: plan.tasks,
          changed_ids: Object.keys(target.prompts),
          before,
          after_hash: hash(after),
        };
    service.repo.put('evaluation_runs', run);
    service.applicationPreviews.delete(raw.token);
    return service.report(runId);
  } finally {
    service.applyingConfiguration = false;
  }
}
