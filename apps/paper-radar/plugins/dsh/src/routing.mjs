import { BridgeError } from './transport.mjs';
import { validateChoice, modelKey } from '@paper-radar/host-contract/routing';
export * from '@paper-radar/host-contract/routing';
export function selectRoute(task, routes, defaults, { session, explicit, parent } = {}) {
  const layers = [
    ['本次选择', validateChoice(explicit)],
    ['任务设置', routes.tasks[task] ?? {}],
    ...(routes.version !== 2 && parent && parent !== task ? [['所属任务默认', routes.tasks[parent] ?? {}]] : []),
  ];
  const base = session ?? defaults;
  if (!base?.provider || !base?.model) throw new BridgeError('not_configured', '请先在 DSH 中选择默认模型。');
  const pickedModel = layers.find(([, choice]) => choice.model);
  const route = pickedModel?.[1].model ?? { provider: base.provider, model: base.model };
  const pickedEffort = layers.find(([, choice]) => choice.reasoningEffort != null && (!choice.model || modelKey(choice.model) === modelKey(route)));
  // An effort belongs to an exact model. Never carry another model's default across a switch.
  const sameModel = modelKey(route) === modelKey(base);
  const effort = pickedEffort?.[1].reasoningEffort ?? (sameModel ? base.reasoningEffort : undefined);
  return { ...route, ...(effort ? { reasoningEffort: effort } : {}), source: { model: pickedModel?.[0] ?? (session ? 'DSH 会话' : 'DSH 默认'), reasoningEffort: pickedEffort?.[0] ?? (sameModel && session ? 'DSH 会话' : '宿主模型默认') } };
}
