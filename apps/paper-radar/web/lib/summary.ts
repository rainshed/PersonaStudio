import type { Localized, Paper, Subscription } from './radar';

const text = (zh: string, en: string): Localized => ({ zh, en });
export type SummarySection = {
  id: string;
  title: string;
  paragraphs: string[];
};
import { countSummaryText } from './text-length.ts';
export { countSummaryText } from './text-length.ts';

// All descriptions below expand fictional demo papers; they are not claims about real research.
const details: Record<
  string,
  {
    background: Localized;
    work: Localized;
    findings: Localized;
    interpretation: Localized;
  }
> = {
  'demo-01': {
    background: text(
      '文章把问题收缩到受局域规则限制的量子链：并非所有相邻自旋构型都可以自由转换。作者想分辨，传播变慢或变快究竟来自约束本身，还是只因为比较的模型具有不同的初态、能量尺度或尺寸。为此，研究围绕一组可以逐项对照的约束规则展开。',
      'The paper focuses on a quantum chain in which local rules prevent some neighboring spin configurations from being freely converted. Its central comparison asks whether different spreading behavior comes from the constraint itself rather than changes in initial states, energy scales, or chain length. The fictional study is therefore organized around a family of constraint rules that can be compared one at a time, instead of collecting unrelated models with superficially similar behavior.',
    ),
    work: text(
      '具体工作分为三步：先明确每个模型允许的局域跃迁，建立可比较的时间演化；再制备局域能量扰动，追踪扰动在链上的空间分布；最后同时检查分布宽度、传播前沿和不同尺寸的变化。这样既能看到扰动向外传播多远，也能检查整体分布是否支持同一种输运解释。',
      'The work proceeds in three steps. First, it specifies the allowed local transitions in each model and constructs comparable time evolution. Second, it prepares a local energy perturbation and follows its spatial distribution along the chain. Third, it compares distribution width, propagation fronts, and dependence on chain length. These measurements serve complementary purposes: a front indicates how far a signal travels, while the full profile tests whether most of the disturbance follows the same transport pattern.',
    ),
    findings: text(
      '示例结果呈现出不同约束下不一致的展宽趋势。作者没有只用一条拟合直线概括结果，而是改变拟合时间窗、排除边界已明显影响的区间，再比较有效标度是否仍然稳定。这使“观察到较快传播”与“确认渐近超扩散”成为两个不同强度的判断。',
      'The illustrative results show different broadening trends for different constraints. Rather than summarizing each curve with one fitted line, the authors vary fitting windows, exclude intervals visibly affected by boundaries, and examine whether effective scaling remains stable. This distinguishes a relatively modest observation of faster spreading from the much stronger claim of asymptotic superdiffusion. The demo provides no numerical exponent, error bar, or universal classification, so none should be inferred from this description.',
    ),
    interpretation: text(
      '这篇文章的贡献在于把局域规则与可比较的动力学观测连接起来，提供检查机制的研究路线。它没有证明所有受约束链都共享一种输运规律，也没有把某个可观测量的变化直接推广到所有动力学行为。理解结果时，需要保留模型、初态和可观测时间窗这些条件。',
      'Its contribution is a research procedure that connects explicit local rules to comparable dynamical observables. It does not establish one transport law for all constrained chains, nor does it automatically extend a change in one observable to all dynamical behavior. The model, initial state, and accessible time window remain part of the conclusion. A meaningful extension would retain those conditions long enough to identify which change actually alters the observed trend.',
    ),
  },
  'demo-02': {
    background: text(
      '这篇文章关注开放量子系统的长时间数值演化。环境耦合会改变动力学，而张量网络截断也可能改变观测量；二者造成的偏差在图像上有时相似。作者希望建立一个比较流程，让研究者知道计算能可靠推进到哪里，以及哪些结果仍受到计算精度限制。',
      'This paper concerns long-time numerical evolution in open quantum systems. Coupling to an environment changes physical dynamics, while tensor-network truncation can also change observables; their effects can look similar in a plot. The study aims to organize comparisons that reveal how far a calculation is reliable and which observations still depend on numerical precision. It treats accessible simulation time as something to establish through checks, rather than assuming every computed point is equally trustworthy.',
    ),
    work: text(
      '作者先固定模型、初态与环境参数，用张量网络表示演化对象，再分别改变时间步长、最大键维数和截断策略。小尺寸结果与精确计算对照，较大尺寸则比较不同精度的自洽程度。局域量和长程关联被分别记录，避免用一个容易收敛的量替代所有误差检查。',
      'The authors first fix the model, initial state, and environment parameters, then vary the time step, maximum bond dimension, and truncation strategy independently. Small-system calculations are compared against exact references; larger systems are checked for consistency across numerical precision settings. Local observables and long-range correlations are recorded separately. This matters because a local quantity can appear converged even when a more demanding correlation function still changes substantially with the computational budget.',
    ),
    findings: text(
      '示例比较显示，不同观测量可达到的可靠时间范围并不一致。某种设置下局域量已经稳定，长程关联却仍随键维数改变。因此文章强调给出分观测量的收敛区间，同时报告获得该区间所需的计算开销，而不是只宣称算法能演化到更晚时间。',
      'The sample comparison finds that reliable time windows differ across observables. A local quantity may stabilize at a given setting while a long-range correlation still changes with bond dimension. The paper therefore reports convergence windows separately and considers the computational effort needed to obtain them. Reaching a later time is not presented as sufficient evidence of improvement unless the relevant observable is also accurate enough to support the physical interpretation.',
    ),
    interpretation: text(
      '文章提供的是评估时间演化可信度的方法框架。它的价值不只在于节约资源，还在于帮助研究者发现看似物理的数值伪影。结论依赖测试模型和误差标准；应用到新的输运问题时，仍需重新检查所需观测量，而不能照搬已有计算的可靠时间范围。',
      'The contribution is a framework for assessing the reliability of time evolution. Its value lies not only in possible computational savings but also in exposing numerical artifacts that could otherwise be mistaken for physics. Conclusions depend on the test model and error criterion. Applying the workflow to another transport problem requires new checks for the observables of interest; the reliable time interval from one calculation cannot simply be transferred to another system.',
    ),
  },
  'demo-03': {
    background: text(
      '文章从具有动力学约束的模型出发，逐渐加入破坏约束的弱扰动。研究问题是：原有异常输运是否立刻消失，还是会在一段较长时间内保留。作者把扰动强度和观测时间放在同一比较框架中，关注两者共同决定的交叉过程。',
      'The paper starts from a dynamically constrained model and gradually introduces weak perturbations that break its constraints. It asks whether the original anomalous transport disappears immediately or survives over an extended interval. Perturbation strength and observation time are compared together because either variable alone can give an incomplete picture. The fictional study focuses on a crossover process, rather than treating a finite-time curve as a direct measurement of the ultimate long-time regime.',
    ),
    work: text(
      '作者先建立无扰动的基准动力学，再对多组扰动强度计算相同的关联函数。每组结果都使用多个时间窗口提取有效传播趋势，并比较系统尺寸改变后的稳定性。随后把不同扰动下开始偏离基准的时间区间放在一起，检查是否存在一致的交叉特征。',
      'The work establishes unperturbed dynamics as a baseline, then evaluates the same correlation functions at several perturbation strengths. Each run is analyzed over multiple time windows, and the stability of the trend is checked as system size changes. The intervals where perturbed results depart from the baseline are then compared. This organization makes it possible to separate an early-time resemblance from a persistent similarity across parameters and observation scales.',
    ),
    findings: text(
      '示例模型中，弱扰动下的早期曲线与基准较接近，较晚时段才显示出差别。这个结果支持存在交叉区间的解释，但不能单凭有限时间内的相似性断言异常输运一直存在。文章的比较重点是趋势何时变化，以及这种变化是否随扰动呈现一致性。',
      'In the sample model, early-time curves under weak perturbations remain close to the baseline, with differences becoming visible later. This supports an interpretation involving a crossover interval, but finite-time similarity does not demonstrate that anomalous transport survives indefinitely. The key observation is when trends change and whether that change varies consistently with the perturbation. No universal crossover exponent or exact scaling law is specified in this fictional fixture.',
    ),
    interpretation: text(
      '这项工作提醒读者，有限时间内看到某种有效指数，与证明一个稳定输运相不是同一件事。它提供了组织参数扫描和时间窗口比较的方式。进一步理解机制，还需要分辨不同扰动是否引入新的慢变量、改变守恒关系，或只是延长原有的过渡行为。',
      'The work distinguishes observing an effective exponent over a finite interval from establishing a stable transport regime. It contributes a way to organize parameter scans and time-window comparisons. A deeper mechanism would require determining whether different perturbations introduce slow variables, change relevant conservation relations, or merely prolong existing transient behavior. Those alternatives should remain separate until the model and measurements can actually discriminate between them.',
    ),
  },
  'demo-07': {
    background: text(
      '文章研究科研 Agent 在小型物理任务中的可核查性。语言模型能写出连贯推导，但连贯不等于正确；一个中间步骤出错，也可能被后续计算掩盖。作者选取具有参考答案的任务，希望弄清工具验证在哪些位置能够发现问题，又在哪些位置仍然无能为力。',
      'The paper studies how to make research agents auditable on small physics tasks. A language model may produce a coherent derivation without producing a correct one, and errors in intermediate steps can be obscured by later calculations. The authors choose tasks with reference answers to examine where tool-based verification exposes problems and where it still fails. They evaluate the process of obtaining an answer, rather than relying exclusively on whether the final number happens to be correct.',
    ),
    work: text(
      '示例实验设置了无工具、可调用计算工具、以及带结构化验证步骤三种流程。每个任务尽量保持相同输入，并记录任务分解、工具调用、计算输出和答案修订。作者随后逐步检查日志，将错误定位到建模假设、公式变换、数值执行或结论解释等环节。',
      'The illustrative experiment compares three workflows: no tools, access to computation tools, and explicit structured verification. Inputs are kept comparable across each task, while task decomposition, tool calls, numerical outputs, and answer revisions are recorded. Logs are then examined step by step to locate errors in modeling assumptions, algebraic transformations, execution, or interpretation. This allows a workflow to be assessed for the mistakes it detects, the mistakes it introduces, and the errors it leaves unresolved.',
    ),
    findings: text(
      '示例记录中，验证步骤能暴露部分中间错误，尤其是可转成明确计算检查的问题。但调用工具本身不能保证输入公式合理，也不能保证 Agent 正确理解输出。作者因此把发现错误、修正错误和给出正确答案分别观察，而不是压缩成一个成功率。',
      'The sample logs show verification exposing some intermediate mistakes, especially those that can be translated into explicit computational checks. Tool access alone does not guarantee that the input expression is appropriate or that the agent interprets the output correctly. Detecting an error, repairing it, and returning a correct answer are therefore considered separately. The fictional example makes no claim about a measured benchmark improvement or general capability across arbitrary research tasks.',
    ),
    interpretation: text(
      '文章的贡献是把科研 Agent 的执行过程拆成可以检查的对象。它支持更透明的调试和评测，但尚不能证明 Agent 能独立完成开放研究。已知答案的小任务提供清晰检验条件；真正未知的问题还需要外部证据、人工判断和更严格的任务边界。',
      'The contribution is a way to break an agent’s research process into inspectable objects. It supports transparent debugging and evaluation without establishing that the agent can independently conduct open-ended research. Tasks with known answers provide unusually clear checks. Unknown scientific problems still require external evidence, human judgment, and carefully defined task boundaries. The distinction between solving a controlled exercise and making a defensible new research claim remains central to interpreting the results.',
    ),
  },
  'demo-08': {
    background: text(
      '这篇文章关注科研工具调用计划中一个常见问题：计划列出了很多动作，却没有交代每一步为什么需要做、依据是什么、什么结果会改变下一步。作者希望把计划中的证据、假设和操作显式连接，让研究者能在执行前后检查推理是否成立。',
      'This paper addresses scientific tool-use plans that list many actions without explaining why each is needed, what supports it, or what result would change the next step. It makes evidence, assumptions, and operations explicit parts of a plan. The aim is to let researchers inspect the reasoning both before and after execution. A plan is treated as a revisable argument for a sequence of actions, rather than a checklist whose completion automatically implies a reliable conclusion.',
    ),
    work: text(
      '作者将计划分为问题陈述、已有证据、待检验假设、拟执行计算和结果解释几类记录。一个计算步骤必须说明它检验哪个假设，执行后再把产物与原计划对应起来。失败计算和与预期相反的结果也保留，以便观察 Agent 是否需要修订路线。',
      'The workflow records problem statements, existing evidence, hypotheses, planned computations, and interpretations separately. A computation identifies which hypothesis it tests, and its output is linked back to that planned purpose. Failed computations and outcomes that contradict expectations are retained. This makes route revision observable: a reviewer can see whether the agent changes its plan in response to new evidence or simply continues through the original sequence despite a failed assumption.',
    ),
    findings: text(
      '示例流程使中间产物和计划变更更容易检查，用户可以定位某个结论依赖哪些步骤。代价是需要额外组织记录，且记录完整并不意味着内容真实。文章把可追溯性视为检查条件，而不将其直接等同于科研结论的正确性。',
      'The sample workflow makes intermediate outputs and plan changes easier to inspect, allowing users to locate the steps supporting a conclusion. It also adds recording overhead, and complete records do not guarantee truthful content. Traceability is treated as a condition that enables inspection rather than proof of correctness. The demo describes this organizational tradeoff without inventing user-study scores, time savings, or measured improvements in scientific discovery.',
    ),
    interpretation: text(
      '这项工作的意义是为人和 Agent 共同检查研究过程提供结构。它特别适合需要多次调用工具、并根据结果调整计划的任务。适用时仍要控制记录负担，确保关键假设和证据可见，而不是让大量日志掩盖真正影响结论的步骤。',
      'The contribution is a structure for researchers and agents to inspect a scientific process together. It is especially relevant when a task requires repeated tool calls and plans must change in response to results. Practical use still needs to control documentation overhead. Critical assumptions and evidence should remain visible instead of being buried in logs that are technically complete but difficult to navigate. Traceability is useful only when a person can follow and challenge the substantive dependencies.',
    ),
  },
};

const scienceNotes = [
  text(
    '研究设计把“现象存在”和“现象的原因”分开处理。前者依赖观测量中是否出现稳定趋势，后者还需要改变控制条件并排除替代解释。示例中的比较尽量让初态、单位和测量方式一致，从而减少把设定差异误认为物理机制的可能。这里没有提供真实论文的模型公式或参数表，因此不补写未经给出的数值。',
    'The study design separates the existence of an observed phenomenon from an explanation of its cause. The former requires a stable trend in observables; the latter also requires controlled changes and the exclusion of alternative explanations. Comparisons keep initial states, units, and measurement definitions aligned where possible. Otherwise, differences in preparation or analysis could be mistaken for a physical mechanism. The fixture does not supply an actual Hamiltonian, parameter table, or numerical dataset, so this summary does not invent those missing quantities.',
  ),
  text(
    '计算结果按参数、尺寸和时间组织，而不是只保留表现最明显的一组曲线。不同条件之间的比较回答不同问题：参数扫描检查趋势的适用范围，尺寸比较帮助判断边界影响，时间窗口则检验拟合是否被过渡行为支配。这些检查提供互补证据，不能互相替代。',
    'Results are organized by parameters, system sizes, and times rather than retaining only the curves with the most striking behavior. Each comparison answers a different question. Parameter scans test the range over which a trend appears. Size comparisons help identify boundary effects. Time-window changes test whether a fit is dominated by crossover behavior. These checks provide complementary evidence and cannot substitute for one another. A visually convincing curve at a single setting is therefore interpreted more cautiously than a pattern that survives all three comparisons.',
  ),
  text(
    '文章把观测量的计算和对观测量的解释作为两个步骤。先检查同一数值设置是否可重复，再比较不同设置下的变化，最后才讨论输运或动力学意义。若不同观测量给出不一致的趋势，示例分析保留这种差别，而不会为了得到单一结论而将它们简单合并。',
    'Computing an observable and interpreting it are treated as separate stages. The workflow first checks reproducibility under the same numerical settings, then compares changes across settings, and only afterward discusses transport or dynamical meaning. When observables suggest different trends, the illustrative analysis retains that disagreement rather than combining them into a single attractive conclusion. This distinction also clarifies what an additional calculation should resolve: a numerical instability, an observable-dependent effect, or a limitation of the proposed physical interpretation.',
  ),
  text(
    '主要结论受到已检验条件的约束。示例没有提供精确的指数值、性能倍数或统计显著性，因此总结只描述能够从现有材料支持的趋势。这样既说明作者观察到了什么，也保留结果尚不能回答的问题，避免把有限模型的行为说成普适结论。',
    'The conclusions remain bounded by the conditions actually examined. The fictional source provides no exact scaling exponent, performance multiplier, or statistical significance level, so the summary describes only the trends supported by the available material. It also separates observations from unresolved questions. A finite model’s behavior does not automatically establish a universal law, and the absence of a visible change does not prove that an effect is absent at all larger sizes or later times.',
  ),
  text(
    '机制解释还需要与可观测现象区分：相似的传播图像可能由不同过程产生，同一个模型也可能让不同观测量表现出不同时间尺度。文章中的对照有助于缩小解释范围，但并不自动排除所有竞争机制。进一步推广时应保留这一层不确定性。',
    'Mechanistic interpretation remains distinct from the observable pattern. Similar spreading profiles may arise from different processes, while different observables in the same model can exhibit different timescales. The comparisons narrow the space of explanations without automatically excluding every competing mechanism. A careful extension preserves that uncertainty and identifies a discriminating measurement. This is more informative than naming a mechanism solely because the result resembles a familiar example or because one fitted quantity has a plausible value.',
  ),
  text(
    '局限主要来自可达到的规模、计算精度和观察时长，也包括示例材料未给出的实验或数值细节。后续工作应优先检验当前结论最敏感的条件。如果趋势对尺寸或拟合区间明显变化，应先解决稳定性问题，再讨论更广泛的应用。',
    'Limitations include accessible scale, numerical precision, observation time, and experimental or computational details absent from the fictional material. Follow-up work should target conditions to which the current interpretation is most sensitive. If a trend changes substantially with size or fitting interval, establishing stability takes priority over proposing a broad application. If it remains stable, the next step is to test the nearest alternative explanation rather than assuming that numerical consistency alone proves the preferred mechanism.',
  ),
];
const agentNotes = [
  text(
    '任务被限定在输入、工具权限和参考答案可明确描述的场景中。这使不同流程能在相近条件下比较，减少因为任务难度或外部信息不同而出现的混淆。但这种控制也限制了结论范围：受控任务中的改进不能直接当成对真实开放科研的能力证明。',
    'Tasks are restricted to settings where inputs, tool permissions, and reference answers can be clearly described. This lets workflows be compared under similar conditions and reduces confounding from different task difficulty or access to external information. Such control also limits the conclusion. An improvement on a controlled task cannot by itself establish capability in open-ended scientific research. The paper therefore treats the setting as a way to inspect particular behaviors, not as a substitute for evaluating the full range of decisions needed in real research.',
  ),
  text(
    '流程比较尽量固定任务描述和可用工具，单独改变计划或验证的组织方式。记录中需要保留工具输入与输出，因为一个正确执行的计算仍可能回答了错误的问题。只有把调用前的假设和调用后的解释连起来，才能看清工具实际支持了哪一条判断。',
    'Workflow comparisons keep task descriptions and available tools aligned while changing how planning or verification is organized. Tool inputs and outputs are retained because a correctly executed computation can still answer the wrong question. Connecting assumptions before a call to interpretation afterward shows which claim the tool actually supports. This avoids crediting tool use simply because an execution completed successfully, and it gives a reviewer a place to distinguish a planning error from an implementation error or a mistaken reading of valid output.',
  ),
  text(
    '执行过程不是只保存最终回答，而是保留中间推导、调用参数、异常情况和修订记录。这样能够回溯错误首次出现的位置，以及后续步骤是否发现并纠正它。对于没有完成的任务，失败过程本身也提供评价信息，而不是从结果集中删去。',
    'Execution records include intermediate reasoning, call parameters, exceptions, and revisions rather than only the final response. A reviewer can trace where an error first appeared and whether later steps detected and repaired it. Incomplete tasks also remain informative: their failure traces reveal bottlenecks that a success-only collection would hide. Retaining those traces does not make the system automatically reliable, but it makes claims about reliability more inspectable and helps define what a targeted improvement would need to change.',
  ),
  text(
    '结果呈现分别讨论答案、过程和可检查性。正确答案可能来自不可靠的步骤，详尽日志也可能记录了错误假设，因此这些指标不应相互替代。示例没有提供真实评测集规模或效果提升数字，不能据此声称超过其他系统。',
    'Results distinguish answer correctness, process quality, and inspectability. A correct answer may emerge from unreliable steps, while detailed logs can faithfully record an incorrect assumption. These dimensions should not substitute for one another. The fictional fixture provides no real benchmark size or improvement figures and therefore cannot support a claim of outperforming another system. Instead, it illustrates how a more informative evaluation can describe what changed, where the change helped, and which failure modes remained.',
  ),
  text(
    '文章强调人能够检查并挑战关键依赖：某个结论用了哪份证据，某个计算检验了哪个假设，以及什么时候应该改变计划。它的贡献是让这些关系显式化，帮助区分没有证据的合理叙述与经过具体检查的判断。可追溯性提供检查入口，正确性仍需独立验证。',
    'The paper emphasizes a person’s ability to inspect and challenge dependencies: which evidence supports a claim, which hypothesis a computation tests, and when a result should change the plan. Its contribution is to make these relationships explicit. This helps distinguish plausible narrative from a judgment that has undergone a concrete check. Traceability supplies an entry point for inspection, while correctness still requires independent verification. A well-organized record cannot compensate for missing evidence or an inappropriate test.',
  ),
  text(
    '主要局限包括任务覆盖范围、工具可用性、人工检查成本和未被触发的失败模式。更复杂的研究问题可能包含无法自动验证的假设，或需要示例中没有的实验数据。因此，推广工作需要重新定义检验标准，而不能仅把流程原样迁移过去。',
    'Limitations include task coverage, tool availability, human inspection cost, and failure modes not triggered by the chosen examples. More complex research can depend on assumptions that cannot be checked automatically or on experimental data unavailable in the demonstration. Extending the workflow therefore requires redefining verification criteria rather than simply copying the steps. The relevant question is not only whether the agent can execute more actions, but whether the resulting evidence supports a claim at the level of confidence required by the new scientific setting.',
  ),
];

export function buildSummaryPreview(paper: Paper, subscription: Subscription) {
  const language = subscription.language;
  const d = details[paper.id];
  const notes = paper.tags.includes('AI') ? agentNotes : scienceNotes;
  const heads = [
    text('研究背景与问题', 'Background and question'),
    text('研究对象与方法', 'System and method'),
    text('具体完成的工作', 'What the study does'),
    text('主要结果与证据', 'Results and evidence'),
    text('贡献与适用范围', 'Contribution and scope'),
    text('局限与尚未解决的问题', 'Limitations and open questions'),
  ];
  const base = [
    paper.question,
    paper.method,
    paper.overview,
    paper.result,
    text(
      `研究围绕${paper.topic.zh}展开，贡献需要结合所测试的条件理解。`,
      `The contribution concerns ${paper.topic.en.toLowerCase()} and remains conditional on the tested setting.`,
    ),
    paper.limitation,
  ];
  const middle = [
    d?.background,
    d?.work,
    d?.work,
    d?.findings,
    d?.interpretation,
    undefined,
  ];
  const sections: SummarySection[] = heads.map((h, i) => ({
    id: `section-${i}`,
    title: h[language],
    paragraphs: [base[i][language]],
  }));
  // Add whole, non-repeated paragraphs. A demo never pads text or invents an exact AI response.
  const additions: { index: number; body: string }[] = [];
  const seen = new Set(sections.flatMap((s) => s.paragraphs));
  for (const i of [0, 2, 3, 4, 1, 5]) {
    const paragraph = middle[i]?.[language];
    if (paragraph && !seen.has(paragraph)) {
      additions.push({ index: i, body: paragraph });
      seen.add(paragraph);
    }
  }
  notes.forEach((n, i) => {
    if (!seen.has(n[language])) {
      additions.push({ index: i, body: n[language] });
      seen.add(n[language]);
    }
  });
  let count = countSummaryText(
    sections.flatMap((s) => s.paragraphs).join('\n'),
    language,
  );
  const { min, max } = subscription.summaryLength;
  const target = Math.round((min + max) / 2);
  for (const addition of additions) {
    const size = countSummaryText(addition.body, language);
    if (count + size > max) continue;
    if (count >= min && count + size - target > target - count) continue;
    sections[addition.index].paragraphs.push(addition.body);
    count += size;
  }
  return {
    sections,
    count,
    min,
    max,
    withinRange: count >= min && count <= max,
  };
}
