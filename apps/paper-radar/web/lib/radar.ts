export type Language = 'zh' | 'en';
export type Localized = { zh: string; en: string };
export type FeedbackDimension =
  | 'accuracy'
  | 'summary'
  | 'reason'
  | 'connections';
export type Feedback = {
  value: 'positive' | 'negative';
  reason: string;
  updatedAt: string;
};
export type FeedbackStore = Record<
  string,
  Partial<Record<FeedbackDimension, Feedback>>
>;
export type SummaryLength = { min: number; max: number };
export const DEFAULT_SUMMARY_LENGTH: SummaryLength = { min: 800, max: 1200 };
export type Subscription = {
  id: string;
  name: string;
  subject: string;
  tags: string[];
  authorIds: string[];
  language: Language;
  summaryLength: SummaryLength;
};
export type Material = {
  id: string;
  title: Localized;
  tag: string;
  kind: Localized;
  description: Localized;
};
export type Paper = {
  id: string;
  title: string;
  authors: string[];
  subjects: string[];
  tags: string[];
  topic: Localized;
  date: string;
  priority: boolean;
  overview: Localized;
  question: Localized;
  method: Localized;
  result: Localized;
  limitation: Localized;
  personalReason: Localized;
  generalReason: Localized;
  excludeReason: Localized;
  materialIds: string[];
  connection: Localized;
  hypothesis: Localized;
  validation: Localized;
};
export const L = (zh: string, en: string): Localized => ({ zh, en });
export const SUBJECTS = [
  { id: 'cond-mat.stat-mech', name: 'Statistical Mechanics', zh: '统计力学' },
  { id: 'quant-ph', name: 'Quantum Physics', zh: '量子物理' },
  { id: 'cs.AI', name: 'Artificial Intelligence', zh: '人工智能' },
  { id: 'math-ph', name: 'Mathematical Physics', zh: '数学物理' },
];
export const TAGS = ['Physics', 'AI', 'Mathematics'];
export const AUTHORS = [
  {
    id: 'maya',
    name: 'Maya Chen',
    initials: 'MC',
    field: L('量子输运 · 示例研究所 A', 'Quantum transport · Demo Institute A'),
    bio: L(
      '受约束量子系统、非平衡动力学',
      'Constrained quantum systems, nonequilibrium dynamics',
    ),
  },
  {
    id: 'alex',
    name: 'Alex Morgan',
    initials: 'AM',
    field: L('张量网络 · 示例研究所 B', 'Tensor networks · Demo Institute B'),
    bio: L(
      '量子多体数值方法、开放系统',
      'Numerical many-body methods, open systems',
    ),
  },
  {
    id: 'lin',
    name: 'Lin Zhao',
    initials: 'LZ',
    field: L(
      'AI for Science · 示例研究所 C',
      'AI for Science · Demo Institute C',
    ),
    bio: L(
      '科研 Agent、可验证的科学推理',
      'Research agents, verifiable scientific reasoning',
    ),
  },
  {
    id: 'oliver',
    name: 'Oliver Reed',
    initials: 'OR',
    field: L(
      '统计物理 · 示例研究所 A',
      'Statistical physics · Demo Institute A',
    ),
    bio: L('随机过程、输运标度', 'Stochastic processes, transport scaling'),
  },
  {
    id: 'noah',
    name: 'Noah Brooks',
    initials: 'NB',
    field: L(
      '凝聚态理论 · 示例研究所 D',
      'Condensed matter · Demo Institute D',
    ),
    bio: L(
      '有效理论、非平衡现象',
      'Effective theories, nonequilibrium phenomena',
    ),
  },
];
export const MATERIALS: Material[] = [
  {
    id: 'm-pxp',
    title: L('PXP 模型与约束动力学', 'PXP model and constrained dynamics'),
    tag: 'Physics',
    kind: L('研究笔记', 'Research note'),
    description: L(
      '这份示例笔记整理了局域约束、动力学观测量和有限尺寸效应，是比较约束模型的背景材料。',
      'This sample note covers local constraints, dynamical observables, and finite-size effects for comparing constrained models.',
    ),
  },
  {
    id: 'm-transport',
    title: L(
      '异常输运：机制与标度',
      'Anomalous transport: mechanisms and scaling',
    ),
    tag: 'Physics',
    kind: L('知识笔记', 'Knowledge note'),
    description: L(
      '这份示例材料对比扩散、超扩散和弹道传播，记录区分有限时间行为与渐近标度的思路。',
      'This sample material compares diffusion, superdiffusion, and ballistic spreading, including finite-time versus asymptotic behavior.',
    ),
  },
  {
    id: 'm-tensor',
    title: L('张量网络时间演化方法', 'Tensor-network time evolution'),
    tag: 'Physics',
    kind: L('方法笔记', 'Methods note'),
    description: L(
      '这份示例材料整理键维数、时间步长与截断误差，关注数值结果的收敛性。',
      'This sample note discusses bond dimension, time steps, truncation errors, and numerical convergence.',
    ),
  },
  {
    id: 'm-agent',
    title: L(
      '面向理论物理的科研 Agent',
      'Research agents for theoretical physics',
    ),
    tag: 'AI',
    kind: L('研究笔记', 'Research note'),
    description: L(
      '这份示例笔记关注工具使用、实验设计和人工可核查的科研过程。',
      'This sample note focuses on tool use, experiment design, and auditable scientific workflows.',
    ),
  },
  {
    id: 'm-eval',
    title: L(
      '科学推理的验证与评测',
      'Verification and evaluation of scientific reasoning',
    ),
    tag: 'AI',
    kind: L('方法笔记', 'Methods note'),
    description: L(
      '这份示例材料区分推理过程、可执行验证与最终结果，强调失败案例的价值。',
      'This sample material separates reasoning, executable verification, and final outcomes, emphasizing failure cases.',
    ),
  },
];
export const DEFAULT_SUBSCRIPTIONS: Subscription[] = [
  {
    id: 'transport',
    name: '量子动力学与输运',
    subject: 'cond-mat.stat-mech',
    tags: ['Physics'],
    authorIds: ['maya', 'alex'],
    language: 'zh',
    summaryLength: { ...DEFAULT_SUMMARY_LENGTH },
  },
  {
    id: 'agents',
    name: 'AI for Physics',
    subject: 'cs.AI',
    tags: ['AI'],
    authorIds: ['lin'],
    language: 'zh',
    summaryLength: { ...DEFAULT_SUMMARY_LENGTH },
  },
];
const physics = {
  tags: ['Physics'],
  date: '2026-09-06',
  limitation: L(
    '示例结论受有限尺寸和可达到的演化时间限制；需要进一步做收敛检查。',
    'The illustrative conclusions are limited by system size and accessible evolution times; convergence checks are still needed.',
  ),
  personalReason: L(
    '命中 Physics 范围内的量子动力学与输运主题，可以与所选标签中的方法和模型材料对照。',
    'Matches quantum dynamics and transport within your Physics scope, with connections to the methods and models in that selected tag.',
  ),
  generalReason: L(
    '为该领域的问题提供了清楚的方法与可检验的结果，适合作为领域精选进一步了解。',
    'Presents a concrete method and testable results for this field, making it a useful general-interest selection.',
  ),
  excludeReason: L(
    '与本订阅关注的动力学和输运机制关联较弱，暂未列入优先推荐。',
    'Only weakly related to the dynamics and transport mechanisms emphasized by this subscription.',
  ),
  connection: L(
    '研究问题与这份材料中的约束和输运讨论相邻。可对照其模型假设与观测量，而不能直接认定机制相同。',
    'The research question is adjacent to the constraints and transport discussed in this material. Compare model assumptions and observables rather than assuming an identical mechanism.',
  ),
  hypothesis: L(
    '尝试把论文中的比较方法用于已有模型，检查约束改变后动力学行为是否仍然成立。',
    'Try the paper’s comparison method on the existing model to check whether the dynamical behavior survives a change of constraints.',
  ),
  validation: L(
    '先在小系统上比较两个参数点，再增加系统尺寸与演化时间，检查趋势是否稳定。',
    'Start with two parameter points on a small system, then increase system size and evolution time to test whether the trend remains stable.',
  ),
};
const ai = {
  ...physics,
  tags: ['AI'],
  personalReason: L(
    '命中 AI 范围内的科研 Agent 与可验证推理主题，可用于思考物理研究任务的工具调用和评测。',
    'Matches research agents and verifiable reasoning within your AI scope, informing tool use and evaluation for physics research tasks.',
  ),
  excludeReason: L(
    '主要讨论通用应用性能，尚未提供与本订阅科研工作流相关的具体方法。',
    'Focuses on general application performance without a concrete method for the research workflows covered by this subscription.',
  ),
  connection: L(
    '与这份材料同样关注科研过程的可核查性，可比较任务分解方式、工具边界和失败记录。',
    'Both focus on auditable research processes. Compare task decomposition, tool boundaries, and failure reporting.',
  ),
  hypothesis: L(
    '将这里的验证步骤用于一个小型物理推导任务，比较有无工具验证时的错误类型。',
    'Apply the verification steps to a small physics derivation and compare failure types with and without tool-based checks.',
  ),
  validation: L(
    '选择一个有已知答案的计算任务，固定输入与工具权限，记录中间步骤和最终误差。',
    'Choose a calculation with a known answer, fix inputs and tool permissions, and record intermediate steps and final errors.',
  ),
};
export const PAPERS: Paper[] = [
  {
    ...physics,
    id: 'demo-01',
    title: 'Geometry-induced superdiffusion in constrained quantum chains',
    authors: ['maya', 'oliver', 'alex'],
    subjects: ['cond-mat.stat-mech', 'quant-ph'],
    topic: L('超扩散输运', 'Superdiffusive transport'),
    priority: true,
    overview: L(
      '分析局域约束如何改变能量传播，提出连接约束结构与超扩散行为的动力学比较方法。',
      'Analyzes how local constraints change energy spreading and compares constraint geometry with superdiffusive behavior.',
    ),
    question: L(
      '局域约束的几何结构是否会改变量子链中的能量传播规律？',
      'Can the geometry of local constraints change energy spreading in a quantum chain?',
    ),
    method: L(
      '比较多个受约束链模型，在相同初态下计算能量关联函数，并对不同尺寸进行标度分析。',
      'Compares constrained-chain models using energy correlation functions from identical initial states and finite-size scaling.',
    ),
    result: L(
      '在示例设定中，不同约束产生不同的传播趋势；作者通过尺度比较区分过渡行为与稳定的动力学特征。',
      'In this illustrative setup, different constraints produce distinct spreading trends; scale comparisons distinguish crossover behavior from stable dynamical features.',
    ),
    materialIds: ['m-pxp', 'm-transport'],
  },
  {
    ...physics,
    id: 'demo-02',
    title: 'Tensor-network methods for long-time open quantum dynamics',
    authors: ['alex', 'lin'],
    subjects: ['cond-mat.stat-mech', 'quant-ph'],
    topic: L('数值方法', 'Numerical methods'),
    priority: true,
    overview: L(
      '面向开放系统的长时间演化，对比截断策略如何影响输运观测量，为数值验证提供方法参考。',
      'Compares truncation strategies for long-time open-system evolution and their impact on transport observables.',
    ),
    question: L(
      '在计算资源有限时，怎样区分真实的长时间行为与数值截断带来的误差？',
      'How can long-time physical behavior be distinguished from truncation errors under limited compute?',
    ),
    method: L(
      '使用张量网络表示演化状态，逐步增加键维数，并与小尺寸精确计算进行交叉检查。',
      'Represents evolving states with tensor networks, increases bond dimension, and cross-checks against exact small-system calculations.',
    ),
    result: L(
      '示例比较显示，局域观测量与长程关联对截断的敏感度不同，需要分别报告收敛范围。',
      'The illustrative comparison shows different truncation sensitivity for local observables and long-range correlations, requiring separate convergence reports.',
    ),
    materialIds: ['m-tensor', 'm-transport'],
  },
  {
    ...physics,
    id: 'demo-03',
    title: 'Hydrodynamic signatures of weakly broken constraints',
    authors: ['noah', 'maya'],
    subjects: ['cond-mat.stat-mech'],
    topic: L('量子动力学', 'Quantum dynamics'),
    priority: true,
    overview: L(
      '研究弱扰动如何改变受约束系统的输运行为，重点区分有限时间效应与渐近动力学标度。',
      'Studies how weak perturbations alter transport in constrained systems, separating finite-time effects from asymptotic scaling.',
    ),
    question: L(
      '弱约束破坏会让异常输运立即消失，还是出现可观测的交叉时间尺度？',
      'Does weak constraint breaking immediately remove anomalous transport, or introduce an observable crossover timescale?',
    ),
    method: L(
      '对扰动强度做参数扫描，并通过关联函数和有效传播指数比较不同时间窗口。',
      'Scans perturbation strength and compares time windows using correlation functions and effective spreading exponents.',
    ),
    result: L(
      '示例模型表现出与扰动有关的交叉区间，提示需要同时比较参数、尺寸和时间。',
      'The sample model exhibits a perturbation-dependent crossover, suggesting joint comparisons across parameters, sizes, and times.',
    ),
    materialIds: ['m-pxp', 'm-transport'],
  },
  {
    ...physics,
    id: 'demo-04',
    title: 'Equilibrium phase boundaries in a classical lattice mixture',
    authors: ['oliver'],
    subjects: ['cond-mat.stat-mech'],
    topic: L('平衡相变', 'Equilibrium transitions'),
    priority: false,
    overview: L(
      '绘制经典晶格混合物的平衡相图，关注组分比例与静态序参量之间的关系。',
      'Maps equilibrium phase boundaries in a classical lattice mixture using composition and static order parameters.',
    ),
    question: L(
      '组分变化如何改变平衡相边界？',
      'How does composition affect equilibrium phase boundaries?',
    ),
    method: L(
      '通过静态采样估计自由能与序参量。',
      'Estimates free energy and order parameters through static sampling.',
    ),
    result: L(
      '示例相图展示不同参数区间的静态相。',
      'An illustrative phase diagram separates static phases across parameter ranges.',
    ),
    materialIds: [],
  },
  {
    ...physics,
    id: 'demo-05',
    title: 'Finite-size corrections to static critical exponents',
    authors: ['noah'],
    subjects: ['cond-mat.stat-mech'],
    topic: L('临界现象', 'Critical phenomena'),
    priority: false,
    overview: L(
      '讨论静态临界指数的有限尺寸修正，重点在平衡临界点附近的拟合策略。',
      'Discusses finite-size corrections to static critical exponents and fitting strategies near equilibrium critical points.',
    ),
    question: L(
      '怎样减少临界指数估计中的有限尺寸偏差？',
      'How can finite-size bias in critical exponent estimates be reduced?',
    ),
    method: L(
      '对比不同尺寸拟合与修正项选择。',
      'Compares size-dependent fits and correction terms.',
    ),
    result: L(
      '示例分析建议显式报告修正项对估计的影响。',
      'The illustrative analysis recommends reporting sensitivity to correction terms.',
    ),
    materialIds: [],
  },
  {
    ...physics,
    id: 'demo-06',
    title: 'Stochastic optimization for disordered classical networks',
    authors: ['oliver', 'noah'],
    subjects: ['cond-mat.stat-mech'],
    topic: L('经典网络', 'Classical networks'),
    priority: false,
    overview: L(
      '比较无序经典网络中的优化算法，主要关注求解效率与稳态目标函数。',
      'Compares optimization algorithms for disordered classical networks, emphasizing efficiency and steady-state objectives.',
    ),
    question: L(
      '哪些采样策略能提高网络优化效率？',
      'Which sampling strategies improve network optimization?',
    ),
    method: L(
      '比较不同随机更新规则下的求解开销。',
      'Compares solve costs under different stochastic update rules.',
    ),
    result: L(
      '示例数据展示性能依赖网络结构。',
      'Illustrative results show performance depending on network structure.',
    ),
    materialIds: [],
  },
  {
    ...ai,
    id: 'demo-07',
    title: 'Verifiable research agents for small-scale physics problems',
    authors: ['lin', 'alex'],
    subjects: ['cs.AI'],
    topic: L('科研 Agent', 'Research agents'),
    priority: true,
    overview: L(
      '把物理问题分解为可执行、可核查的步骤，比较工具验证对推理错误的影响。',
      'Decomposes physics problems into executable, auditable steps and evaluates how tool checks affect reasoning errors.',
    ),
    question: L(
      '工具验证能否帮助识别推导中看似合理但实际错误的步骤？',
      'Can tool checks identify plausible but incorrect derivation steps?',
    ),
    method: L(
      '在有已知答案的小任务上，比较无工具、计算工具和结构化验证三种工作流。',
      'Compares no-tool, computation-tool, and structured-verification workflows on small tasks with known answers.',
    ),
    result: L(
      '示例记录展示验证环节能暴露一部分中间错误，但最终结果正确仍不保证过程可靠。',
      'Illustrative logs show verification exposing some intermediate errors, while a correct final answer does not guarantee a reliable process.',
    ),
    materialIds: ['m-agent', 'm-eval'],
  },
  {
    ...ai,
    id: 'demo-08',
    title: 'Evidence-aware planning for scientific tool use',
    authors: ['lin', 'maya'],
    subjects: ['cs.AI'],
    topic: L('科学推理', 'Scientific reasoning'),
    priority: true,
    overview: L(
      '让科研工具调用计划显式关联证据和待验证假设，便于人工检查与纠正。',
      'Links scientific tool-use plans to evidence and hypotheses so people can inspect and correct them.',
    ),
    question: L(
      '怎样使多步骤工具调用计划更容易被研究者检查？',
      'How can researchers more easily inspect multi-step tool-use plans?',
    ),
    method: L(
      '将计划中的结论、假设和计算步骤分别记录，并保留失败结果。',
      'Records claims, assumptions, and computations separately, retaining failed outcomes.',
    ),
    result: L(
      '示例流程提升了检查中间产物的可见性，同时增加了记录成本。',
      'The sample workflow makes intermediate outputs more visible at the cost of additional logging.',
    ),
    materialIds: ['m-agent', 'm-eval'],
  },
  {
    ...ai,
    id: 'demo-09',
    title: 'Efficient routing for general-purpose language assistants',
    authors: ['noah'],
    subjects: ['cs.AI'],
    topic: L('通用助手', 'General assistants'),
    priority: false,
    overview: L(
      '研究通用语言助手的请求路由与响应效率，暂未覆盖科研验证场景。',
      'Studies routing and latency in general assistants without addressing scientific verification.',
    ),
    question: L(
      '怎样降低请求路由的开销？',
      'How can routing overhead be reduced?',
    ),
    method: L(
      '比较通用任务的路由策略。',
      'Compares routing strategies on general tasks.',
    ),
    result: L(
      '示例任务中的响应开销降低。',
      'Response overhead decreases on the sample tasks.',
    ),
    materialIds: [],
  },
  {
    ...physics,
    id: 'demo-10',
    date: '2026-09-05',
    title: 'Operator spreading under local kinetic constraints',
    authors: ['maya'],
    subjects: ['cond-mat.stat-mech', 'quant-ph'],
    topic: L('算符传播', 'Operator spreading'),
    priority: true,
    overview: L(
      '比较局域动力学约束对算符传播前沿的影响，为研究受约束模型提供另一种观测角度。',
      'Compares how kinetic constraints affect operator-spreading fronts, offering another observable for constrained models.',
    ),
    question: L(
      '传播前沿与能量输运是否呈现相同趋势？',
      'Do spreading fronts and energy transport show the same trends?',
    ),
    method: L(
      '在同一模型上比较两类关联函数。',
      'Compares two correlation functions in the same model.',
    ),
    result: L(
      '示例结果提示应分别检查不同观测量的行为。',
      'Illustrative results suggest checking observables separately.',
    ),
    materialIds: ['m-pxp', 'm-transport'],
  },
];
export function scopeMaterials(tags: string[]) {
  return MATERIALS.filter((m) => tags.includes(m.tag));
}
export function candidates(subscription: Subscription, date: string) {
  return PAPERS.filter(
    (p) => p.date === date && p.subjects.includes(subscription.subject),
  );
}
export function isRecommended(paper: Paper, subscription: Subscription) {
  return (
    paper.priority &&
    (!subscription.tags.length ||
      paper.tags.some((t) => subscription.tags.includes(t)))
  );
}
export function connectionsFor(paper: Paper, subscription: Subscription) {
  return scopeMaterials(subscription.tags).filter((m) =>
    paper.materialIds.includes(m.id),
  );
}
export function reasonFor(paper: Paper, subscription: Subscription): Localized {
  if (!isRecommended(paper, subscription))
    return paper.priority
      ? L(
          '与所选 Persona 标签范围没有明确联系，暂不推荐。',
          'No clear connection to the selected Persona scope; not recommended for this subscription.',
        )
      : paper.excludeReason;
  return subscription.tags.length ? paper.personalReason : paper.generalReason;
}
export function feedbackKey(
  paper: Paper,
  subscription: Subscription,
  dimension?: FeedbackDimension,
) {
  const base = [
    paper.id,
    'analysis-v1',
    subscription.id,
    subscription.subject,
    [...subscription.tags].sort().join(','),
    subscription.language,
  ].join('|');
  return dimension === 'summary'
    ? `${base}|summary-v2|${subscription.summaryLength.min}-${subscription.summaryLength.max}`
    : base;
}
export function applyFeedback(
  store: FeedbackStore,
  key: string,
  dimension: FeedbackDimension,
  value: Feedback | null,
): FeedbackStore {
  const next = { ...store },
    entry = { ...next[key] };
  if (value) entry[dimension] = value;
  else delete entry[dimension];
  if (Object.keys(entry).length) next[key] = entry;
  else delete next[key];
  return next;
}
export function validateSummaryLength(value: unknown): string | null {
  if (!value || typeof value !== 'object') return '请设置总结字数范围';
  const { min, max } = value as SummaryLength;
  if (!Number.isInteger(min) || !Number.isInteger(max))
    return '字数上下限必须为整数';
  if (min < 200 || max > 3000) return '总结范围支持 200–3000 字 / 词';
  if (min >= max) return '字数下限必须小于上限';
  return null;
}
export function validateSubscription(input: Subscription) {
  if (!input.name.trim()) return '请填写订阅名称';
  if (input.name.trim().length > 50) return '订阅名称请控制在 50 个字符以内';
  if (!SUBJECTS.some((s) => s.id === input.subject))
    return '请选择有效的 arXiv subject';
  if (input.tags.some((t) => !TAGS.includes(t)))
    return '请选择有效的 Persona 标签';
  if (input.authorIds.some((id) => !AUTHORS.some((a) => a.id === id)))
    return '请选择有效的作者';
  if (!['zh', 'en'].includes(input.language)) return '请选择中文或英文';
  return validateSummaryLength(input.summaryLength);
}
export function hydrateDemo(input: unknown): {
  subscriptions: Subscription[];
  activeId: string;
  feedback: FeedbackStore;
} | null {
  if (!input || typeof input !== 'object') return null;
  const x = input as Record<string, unknown>;
  if (
    !Array.isArray(x.subscriptions) ||
    !x.subscriptions.length ||
    x.subscriptions.length > 30
  )
    return null;
  const subscriptions = x.subscriptions
    .map((raw: unknown) => {
      if (!raw || typeof raw !== 'object') return raw;
      const s = raw as Record<string, unknown>;
      return {
        ...s,
        summaryLength:
          s.summaryLength === undefined
            ? { ...DEFAULT_SUMMARY_LENGTH }
            : s.summaryLength,
      };
    })
    .filter((raw): raw is Subscription => {
      if (!raw || typeof raw !== 'object') return false;
      const s = raw as Record<string, unknown>;
      return (
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        typeof s.subject === 'string' &&
        Array.isArray(s.tags) &&
        Array.isArray(s.authorIds) &&
        !validateSubscription(s as Subscription)
      );
    });
  if (
    subscriptions.length !== x.subscriptions.length ||
    new Set(subscriptions.map((s) => s.id)).size !== subscriptions.length
  )
    return null;
  const feedback: FeedbackStore = {};
  if (x.feedback && typeof x.feedback === 'object')
    for (const [key, raw] of Object.entries(x.feedback)) {
      if (!key.startsWith('demo-') || !raw || typeof raw !== 'object') continue;
      for (const dimension of [
        'accuracy',
        'summary',
        'reason',
        'connections',
      ] as FeedbackDimension[]) {
        const f = (raw as Record<string, unknown>)[dimension];
        if (!f || typeof f !== 'object') continue;
        const v = f as Feedback;
        if (
          !['positive', 'negative'].includes(v.value) ||
          typeof v.reason !== 'string' ||
          typeof v.updatedAt !== 'string'
        )
          continue;
        feedback[key] ??= {};
        feedback[key][dimension] = {
          value: v.value,
          reason: v.value === 'negative' ? v.reason.slice(0, 1000) : '',
          updatedAt: v.updatedAt,
        };
      }
    }
  return {
    subscriptions,
    activeId: subscriptions.some((s) => s.id === x.activeId)
      ? String(x.activeId)
      : subscriptions[0].id,
    feedback,
  };
}
