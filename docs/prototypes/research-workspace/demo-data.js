/* Fictional research examples. No real workspace, model, or external service is used. */
window.createResearchDemo = () => {
  const created = '2026-09-12T08:00:00Z';
  const record = (id, values) => ({ id, created_at: created, updated_at: created, revision: 1, archived: false, ...values });
  const projects = [
    record('p_spin', { title: '一维自旋链中的慢弛豫', subtitle: '从一个数值观察出发，逐步排查可能的物理机制。', goal: '判断慢弛豫来自边界条件、近守恒量，还是有限尺寸效应。', state: 'active', focus: '优先检查弱耦合极限下的近守恒量。', blocker: '现有数据只覆盖小尺寸，尚未完成可靠的尺寸外推。', next: '推导最低阶表达式，并与已完成的数值结果对照。', body: '## 研究背景\n在一个虚构的一维自旋模型中，局域自旋关联表现出较长的衰减时间。我们希望先区分边界条件和有限尺寸带来的影响，再讨论可能的物理解释。\n\n## 当前约定\n固定初态与耦合参数，比较开放和周期边界。观察量为归一化的自旋关联函数 C(t)。不同对称性扇区分开记录。\n\n## 参考基准\n先核对可解析极限，再检查求解精度和有限尺寸效应。', current: 'u4', origin: null, updated_at: '2026-09-26T10:20:00Z', entries: [{ id: 'w1', kind: 'local', label: '本机工作目录', target: '~/Research/spin-relaxation', detail: 'Mac · 主目录' }, { id: 'w2', kind: 'repo', label: '项目代码仓库', target: 'https://github.com/example/spin-relaxation', detail: 'GitHub · 示例仓库' }, { id: 'w3', kind: 'remote', label: '计算服务器', target: '/research/demo/spin-relaxation/runs', detail: 'Compute-01 · 结果目录' }], questions: ['目前观察到的长时间行为会随尺寸消失吗？', '是否存在能够解释慢弛豫的近守恒量？', '哪些结论可以跨边界条件成立？'] }),
    record('p_tensor', { title: '张量网络的误差与收敛', subtitle: '建立一套可比较的数值检查流程。', goal: '区分截断误差和时间步长误差对关联函数的影响。', state: 'paused', focus: '等待基准数据整理。', blocker: '不同实现的归一化约定尚未统一。', next: '整理两组方法的参数与输出格式。', body: '先整理一个可重复的小尺寸基准。计算设置和误差定义需要保持一致。', current: null, origin: null, updated_at: '2026-09-22T09:00:00Z', entries: [], questions: ['怎样选择足够可信的收敛标准？'] }),
    record('p_geometry', { title: '几何约束下的有效模型', subtitle: '从最小模型理解约束如何改变低能行为。', goal: '在一个可解析极限下建立最小有效描述。', state: 'active', focus: '核对有效哈密顿量的推导。', blocker: '', next: '补充二阶修正项。', body: '先明确约束空间，再讨论有效自由度。这个项目尚处于最初的推导阶段。', current: null, origin: null, updated_at: '2026-09-24T13:30:00Z', entries: [], questions: ['哪些修正项必须保留？'] }),
  ];
  const ideas = [
    record('i1', { project: 'p_spin', title: '从弱耦合极限寻找近守恒量', state: 'exploring', verdict: 'unassessed', verdict_note: '', closure_note: '', novelty: 'incremental', novelty_reason: '近守恒量的思路已有，先明确它是否适用于目前的模型。', difficulty: 'medium', difficulty_reason: '最低阶推导可以完成，高阶修正需要进一步检查。', body: '如果弱耦合下存在一个缓慢变化的量，它可能为较长的弛豫时间提供解释。\n\n## 最小尝试\n先求出最低阶有效表达式，检查适用条件，再与相同参数下的数值数据比较。\n\n> 得到近似表达式后，还需要检查被忽略项的大小。', resources: [], updated_at: '2026-09-26T08:30:00Z' }),
    record('i2', { project: 'p_spin', title: '边界条件是否导致了慢弛豫？', state: 'closed', verdict: 'unsupported', verdict_note: '在本轮测试的 N = 12、16、20 中，两种边界条件均出现慢衰减。当前对照不支持“仅由边界产生”的解释。', closure_note: '本轮对照已完成。接下来优先排查近守恒量和有限尺寸效应。', novelty: 'unknown', novelty_reason: '', difficulty: 'low', difficulty_reason: '可以复用现有代码，改变边界条件后重新计算。', body: '最初猜想，边界附近的局域行为可能拖慢整体弛豫。\n\n## 已完成的检查\n- 固定初态和耦合参数\n- 比较开放与周期边界\n- 检查相同求解精度下的结果\n\n结论只覆盖已经测试的尺寸与参数，不直接外推到热力学极限。', resources: ['fig_boundary', 'note_run'], updated_at: '2026-09-25T14:15:00Z' }),
    record('i3', { project: 'p_spin', title: '直接扩大系统尺寸做验证', state: 'abandoned', verdict: 'supported', verdict_note: '补充更大尺寸有助于区分有限尺寸行为。现有资源估算支持这一验证路线的技术可行性。', closure_note: '计算资源投入超出本阶段预算。先通过小尺寸对照与解析极限缩小问题范围。', novelty: 'non_novel', novelty_reason: '属于常规的尺寸分析。', difficulty: 'high', difficulty_reason: '内存和计算时间随尺寸增长较快。', body: '尝试把已有参数点扩展到更大的系统尺寸，并保持精度条件可比。\n\n## 当前决策\n本阶段不继续投入。这个决定针对资源安排，已有判断和估算记录仍然保留。', resources: ['resource_estimate'], updated_at: '2026-09-24T09:50:00Z' }),
    record('i4', { project: 'p_spin', title: '比较不同初态的尺寸依赖', state: 'pending', verdict: 'unassessed', verdict_note: '', closure_note: '', novelty: 'unknown', novelty_reason: '', difficulty: 'unknown', difficulty_reason: '', body: '目前只检查了一种初态。先比较两种结构不同的初态，再判断是否值得展开完整参数扫描。', resources: [], updated_at: '2026-09-23T10:00:00Z' }),
    record('i5', { project: 'p_spin', title: '检查对称性扇区的影响', state: 'exploring', verdict: 'inconclusive', verdict_note: '两个已计算扇区的长时间行为有差异，但目前样本不足，不能确定是否具有一般性。', closure_note: '', novelty: 'unknown', novelty_reason: '', difficulty: 'medium', difficulty_reason: '需要统一不同扇区的初态和观测量定义。', body: '避免把单个扇区内的观察解释为完整系统的普遍行为。先核对各扇区的计算约定。', resources: [], updated_at: '2026-09-24T15:00:00Z' }),
    record('i6', { project: null, title: '从负面结果整理一张问题地图', state: 'pending', verdict: 'unassessed', verdict_note: '', closure_note: '', novelty: 'novel', novelty_reason: '希望按“为什么不成立”组织记录，仍需要核对相关工具。', difficulty: 'low', difficulty_reason: '', body: '把阅读和研究中被排除的解释留下来，也许能更快识别下一步值得尝试的问题。', resources: [], updated_at: '2026-09-25T08:00:00Z' }),
    record('i7', { project: null, title: '用最小反例检查近似的适用范围', state: 'pending', verdict: 'unassessed', verdict_note: '', closure_note: '', novelty: 'incremental', novelty_reason: '', difficulty: 'medium', difficulty_reason: '', body: '对每个常用近似，保留一个能显示其失效条件的简单例子。先从熟悉的模型入手。', resources: [], updated_at: '2026-09-24T08:00:00Z' }),
    record('i8', { project: null, title: '建立可复用的数值收敛笔记', state: 'exploring', verdict: 'unassessed', verdict_note: '', closure_note: '', novelty: 'non_novel', novelty_reason: '', difficulty: 'low', difficulty_reason: '', body: '不同方法的收敛标准并不一样。将时间步长、截断和有限尺寸检查分别记录，方便下次查找。', resources: [], updated_at: '2026-09-22T08:00:00Z' }),
    record('i9', { project: 'p_geometry', title: '先核对最低阶有效自由度', state: 'exploring', verdict: 'unassessed', verdict_note: '', closure_note: '', novelty: 'unknown', novelty_reason: '', difficulty: 'medium', difficulty_reason: '', body: '从约束子空间的最小例子开始。', resources: [], updated_at: '2026-09-24T13:00:00Z' }),
  ];
  const taskSeed = [
    ['t1', '推导弱耦合下的最低阶表达式', 'doing', 'i1', '完成有效表达式，标出使用的近似条件，并记录尚未处理的修正项。'],
    ['t2', '补充两种初态的对照计算', 'todo', 'i4', '先在 N = 12 和 N = 16 下比较，不展开完整扫描。'],
    ['t3', '整理本周结果用于组会讨论', 'todo', null, '汇总已排除的解释、主要卡点和下一步。'],
    ['t4', '完成两种边界条件的对照并生成图', 'done', 'i2', '已生成比较图。当前对照不支持仅由边界产生的解释。'],
    ['t5', '估算扩大尺寸的计算资源', 'done', 'i3', '已完成估算，本阶段的计算预算不足以支持全面扩展。'],
    ['t6', '核对两个对称性扇区的计算约定', 'done', 'i5', '已统一归一化约定，但仍需增加样本。'],
    ['t7', '整理输入配置与运行记录', 'todo', null, '为后续复查保留计算入口。'],
    ['t8', '复现零耦合极限的基准结果', 'done', 'i1', '已完成小尺寸基准比较。'],
    ['t9', '启动更大尺寸的完整计算', 'cancelled', 'i3', '根据当前资源决策取消，保留任务供以后重开。'],
    ['t10', '扩展全参数扫描', 'cancelled', 'i3', '本阶段先缩小问题范围。'],
  ];
  const tasks = taskSeed.map(([id, title, state, idea, body], index) => record(id, { project: 'p_spin', title, state, idea, body, completed_at: state === 'done' ? '2026-09-25T13:00:00Z' : null, updated_at: '2026-09-25T13:00:00Z', order: index, resources: id === 't4' ? ['fig_boundary'] : [] }));
  const updates = [
    record('u4', { project: 'p_spin', title: '边界效应不足以解释当前观察', body: '完成第一轮边界条件对照后，慢弛豫仍然存在。当前结果不支持仅由边界产生的解释，但尚不能排除有限尺寸影响。\n\n下一步优先检查弱耦合下的近守恒量，并补充不同初态的对照。', key: false, validity: 'valid', review: 'preliminary', superseded_by: null, status_note: '', ideas: ['i1', 'i2'], tasks: ['t4'], resources: [], occurred_at: '2026-09-26T09:00:00Z', created_at: '2026-09-26T10:20:00Z', updated_at: '2026-09-26T10:20:00Z' }),
    record('u3', { project: 'p_spin', title: '两种边界条件下均观察到慢衰减', body: '在固定初态和耦合参数下，完成了开放与周期边界的对照。两种边界下都观察到了较慢的关联衰减。\n\n## 当前判断\n本轮结果不支持“慢弛豫仅由边界条件导致”的解释。此前单个尺寸上的差异不足以支持这一判断。\n\n## 条件与检查\n- 尺寸：N = 12、16、20\n- 保持求解精度和初态定义一致\n- 已检查零耦合极限\n- 尚未完成可靠的尺寸外推\n\n$$C(t) = \\langle S^z(t) S^z(0) \\rangle$$\n\n## 下一步\n检查近守恒量的解释，并评估初态选择的影响。', key: true, validity: 'valid', review: 'reviewed', superseded_by: null, status_note: '', review_note: '已检查所列尺寸、求解精度和零耦合基准。', ideas: ['i2'], tasks: ['t4'], resources: ['fig_boundary', 'note_run'], occurred_at: '2026-09-25T13:00:00Z', created_at: '2026-09-25T14:20:00Z', updated_at: '2026-09-25T14:20:00Z' }),
    record('u2', { project: 'p_spin', title: '单个尺寸上观察到边界条件差异', body: '在最初测试的一个尺寸中，两种边界下的关联函数存在差异，一度考虑边界可能是主要原因。\n\n补充多个尺寸和精度检查后，原先的解释缺乏足够支持。请参考后续的完整对照记录。', key: true, validity: 'superseded', review: 'preliminary', superseded_by: 'u3', status_note: '后续增加尺寸点并统一了求解精度，原先的解释已被更新。', ideas: ['i2'], tasks: [], resources: [], occurred_at: '2026-09-20T11:00:00Z', created_at: '2026-09-20T13:00:00Z', updated_at: '2026-09-25T14:20:00Z' }),
    record('u1', { project: 'p_spin', title: '完成最小计算基准', body: '建立了一个小尺寸基准，核对了零耦合极限和观测量归一化。\n\n接下来固定这些设置，开展第一轮边界条件对照。', key: false, validity: 'valid', review: 'preliminary', superseded_by: null, status_note: '', ideas: ['i1'], tasks: ['t8'], resources: [], occurred_at: '2026-09-16T08:00:00Z', created_at: '2026-09-16T09:00:00Z', updated_at: '2026-09-16T09:00:00Z' }),
  ];
  window.ResearchReferences.seedRecords({ projects, ideas });
  const history = {};
  for (const [type, list] of Object.entries({ projects, ideas, tasks, updates })) for (const item of list) history[`${type}:${item.id}`] = [{ ...structuredClone(item), action_label: '示例记录' }];
  return { version: 1, libraryVersion: 1, projects, ideas, tasks, updates, history, events: [
    { id: 'ev1', project: 'p_spin', type: 'ideas', target: 'i2', revision: 1, label: '结束探索：边界条件是否导致了慢弛豫？', time: '2026-09-25T14:15:00Z', progress: true, note: ideas[1].verdict_note, verdict: 'unsupported' },
    { id: 'ev2', project: 'p_spin', type: 'ideas', target: 'i3', revision: 1, label: '放弃方向：直接扩大系统尺寸做验证', time: '2026-09-24T09:50:00Z', progress: true, note: ideas[2].closure_note, verdict: 'supported' },
    { id: 'ev3', project: 'p_spin', type: 'tasks', target: 't4', revision: 1, label: '完成待办：完成两种边界条件的对照并生成图', time: '2026-09-25T13:00:00Z', progress: false, note: '' },
  ] };
};
