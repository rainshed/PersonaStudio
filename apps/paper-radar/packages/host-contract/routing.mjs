import { BridgeError } from './transport.mjs';

export const TASKS = [
  { id: 'single', name: '单篇分析' }, { id: 'screen', name: '每日初筛' },
  { id: 'summary', name: '详细总结' }, { id: 'connections', name: '个性化分析' },
  { id: 'review', name: '内容复核' }, { id: 'discussion', name: '论文讨论' },
];
export const emptyRoutes = () => ({ revision: 0, tasks: Object.fromEntries(TASKS.map(({ id }) => [id, { model: null, reasoningEffort: null }])), fallback: { enabled: false, model: null, reasoningEffort: null } });
export const modelKey = (x) => JSON.stringify([x.provider, x.model ?? x.id]);
export function validateChoice(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((x) => !['model', 'reasoningEffort'].includes(x))) throw new BridgeError('invalid_selection', '模型选择格式无效。');
  const model = raw.model ?? null, reasoningEffort = raw.reasoningEffort ?? null;
  if (model !== null && (!model || typeof model !== 'object' || Object.keys(model).some((x) => !['provider', 'model'].includes(x)) || !['provider', 'model'].every((key) => typeof model[key] === 'string' && model[key].length > 0 && model[key].length <= 300))) throw new BridgeError('invalid_selection', '请选择宿主中可用的模型。');
  if (reasoningEffort !== null && (typeof reasoningEffort !== 'string' || !reasoningEffort || reasoningEffort.length > 100)) throw new BridgeError('invalid_selection', '思考强度格式无效。');
  return { model, reasoningEffort };
}
