import { runtimeUiCatalog } from './ui-runtime-catalog.ts';
import { evaluationUiCatalog } from './ui-evaluation-catalog.ts';
import { personaUiCatalog } from './ui-persona-catalog.ts';
import { taskUiCatalog } from './ui-task-catalog.ts';
import { promptUiCatalog } from './ui-prompt-catalog.ts';
import { authorUiCatalog } from './ui-author-catalog.ts';

// Interface copy only. User content and generated research retain their own language.
export const uiCatalog: Record<string, string> = {
  '维护操作未能完成，请检查文件、磁盘空间或本机日志。':
    'Maintenance could not finish. Check the file, disk space or local logs.',
  'DSH 连接路径过长，请使用较短的本机连接路径。':
    'The DSH socket path is too long. Use a shorter local connection path.',
  '恢复副本未能启动，请查看本机日志。':
    'The recovered copy could not start. Check its local log.',
  '请等待运行中的任务完成后再备份。':
    'Wait for running tasks to finish before backing up.',
  '请选择有效的备份文件。': 'Choose a valid backup file.',
  '请在运行 Paper Radar 的电脑上管理数据和应用。':
    'Manage data and applications on the computer running Paper Radar.',
  'AI Persona 启动超时，请检查本机安装。':
    'AI Persona startup timed out. Check the local installation.',
  '无法启动 AI Persona，请先完成本机安装。':
    'AI Persona could not start. Complete the local installation first.',
  'AI Persona 未能打开。请检查工作区或已运行的 Persona。':
    'AI Persona could not open. Check the workspace or the already running Persona.',

  ...authorUiCatalog,
  ...runtimeUiCatalog,
  ...promptUiCatalog,
  ...personaUiCatalog,
  ...taskUiCatalog,
  按匹配结果排序: 'Sorted by relevance',

  ...evaluationUiCatalog,
  论文正文: 'Paper body text',
  原文摘录: 'Source excerpt',
  图注文字: 'Figure caption text',
  表格文字: 'Extracted table text',
  公式文字: 'Extracted equation text',
  'Persona 条目': 'Persona record',
  保存的来源文字: 'Saved source text',
  来源文件: 'Source file',
  页码: 'Pages',
  行号: 'Lines',
  章节内字符: 'Characters in section',
  条目版本: 'Record revision',
  本次阅读依据: 'Evidence for this report',
  可读取文本块: 'Available text blocks',
  保存的引用: 'Saved citations',
  '引用位置说明实际依据；提取出的文本数量不代表逐段阅读全文。':
    'Citation locations show the actual evidence. Extracted text counts do not imply every paragraph was read.',
  '本次未验证图像内容，图注、表格与公式仅以提取文字作为依据。':
    'Visual content was not verified for this report. Captions, tables and equations are supported by extracted text only.',
  '此依据来自提取的文字，不代表已理解图像、表格布局或公式的视觉内容。':
    'This evidence comes from extracted text. It does not establish understanding of images, table layout or visual equation content.',
  'Persona 内容已更新，请刷新标签。':
    'Persona content changed. Refresh the tags.',

  初筛与定向补读: 'Screening with targeted reading',
  复用已有筛选: 'Reused screening',
  阅读筛选依据: 'Reading screening evidence',
  补读论文: 'Reading relevant sections',
  校验结果: 'Validating result',
  正在逐篇判断: 'Evaluating this paper',
  已读取知识条目: 'Knowledge records read',
  按原设置重新判断: 'Reassess with original settings',
  重试本篇初筛: 'Retry screening this paper',
  概览: 'Overview',
  完整报告: 'Full report',
  返回列表: 'Back to list',
  恢复分栏: 'Split view',
  展开阅读: 'Expand reader',
  全文分析: 'Full-text analysis',
  报告已保存: 'Report saved',
  论文内容: 'Paper content',
  关闭证据: 'Close evidence',
  阅读全文时关注: 'Questions for the full text',
  阅读完整报告: 'Read full report',
  查看全文分析: 'View full-text analysis',
  报告版本与生成信息: 'Report version and generation details',
  返回引用段落: 'Back to cited passage',
  返回阅读: 'Back to reading',
  推荐判断: 'Recommendation decision',
  材料联系与交叉: 'Connections and crossovers',
  '无法读取反馈。': 'Could not load feedback.',
  '从实际阅读反馈出发，检查问题，再调整提示词。':
    'Review feedback from your reading, investigate issues, then refine prompts.',
  打开提示词工作台: 'Open Prompt Workbench',
  阅读反馈: 'Reading feedback',
  当前浏览器的演示反馈: 'Demo feedback in this browser',
  来自已保存的论文版本: 'From saved paper versions',
  搜索论文或反馈: 'Search papers or feedback',
  反馈维度: 'Feedback dimension',
  全部维度: 'All dimensions',
  反馈结果: 'Feedback result',
  全部反馈: 'All feedback',
  需要改进: 'Needs improvement',
  认可: 'Positive',
  刷新反馈: 'Refresh feedback',
  暂无符合条件的反馈: 'No matching feedback',
  '在论文的判断、总结、理由或联系旁留下反馈后，可以在这里回看。':
    'Leave feedback beside a paper’s decision, summary, reasons or connections to review it here.',
  条反馈: 'feedback entries',
  初筛版本: 'Screening version',
  报告版本: 'Report version',
  提示词改进与后续评测: 'Prompt refinement and future evaluations',
  '提示词工作台用于查看现有提示词、捕获样本和单次实验。请先在本机启动工作台。':
    'Use Prompt Workbench to inspect prompts, captured samples and individual experiments. Start the workbench locally first.',
  '批量测试集和 A/B 评测将在下一轮接入。当前反馈不会自动修改提示词或模型。':
    'Batch datasets and A/B evaluations are planned for the next round. Feedback does not automatically change prompts or models.',
  '无法读取 Persona 状态。': 'Could not load Persona status.',
  '管理模型、个人知识连接和界面偏好。':
    'Manage models, personal knowledge connections and interface preferences.',
  设置分类: 'Settings categories',
  数据与偏好: 'Data and preferences',
  '推荐使用你在订阅或单篇分析中选定的知识标签。':
    'Recommendations use the knowledge tags selected in your subscription or paper analysis.',
  '演示模式使用虚构的 Persona 材料。真实连接由本机服务提供。':
    'Demo mode uses fictional Persona materials. Real connections are provided by the local service.',
  'Persona 已连接': 'Persona connected',
  'Persona 未连接': 'Persona not connected',
  '正在检查连接…': 'Checking connection…',
  检查连接: 'Check connection',
  连接详情: 'Connection details',
  界面语言: 'Interface language',
  '界面语言即时生效。报告的生成语言由任务设置决定。':
    'UI language changes immediately. Report language is determined by task settings.',
  数据保存: 'Data storage',
  '演示订阅与反馈保存在当前浏览器。':
    'Demo subscriptions and feedback are saved in this browser.',
  '论文、报告和反馈保存在本机服务。界面偏好保存在当前浏览器。':
    'Papers, reports, and feedback are saved locally. Interface preferences are saved in this browser.',
  '报告删除在对应内容页操作。': 'Delete reports from their content pages.',
  提示词工作台: 'Prompt Workbench',
  管理订阅: 'Manage subscriptions',
  查看运行详情: 'View run details',
  详细分析需要重试: 'Full-text analysis needs a retry',
  选择一篇论文开始阅读: 'Select a paper to start reading',
  '在这里阅读概览和完整报告。': 'Read the overview and full report here.',

  设置已保存: 'Settings saved',
  放弃修改: 'Discard changes',

  '演示内容不调用模型。请在本机工作台中讨论真实论文。':
    'Demo content does not call a model. Discuss real papers in the local workspace.',
  打开本机工作台: 'Open local workspace',
  查看使用范围: 'View scope',
  演示批次: 'Demo batch',
  管理关注作者: 'Manage followed authors',

  评测与改进: 'Evaluations',
  设置: 'Settings',
  '演示内容 · 保存在当前浏览器': 'Demo · Saved in this browser',
  '本机数据 · 研究工作台': 'Local data · Research workspace',
  '选择论文范围，以及用于推荐的知识点标签。保存后可生成日报或配置自动检查。':
    'Choose paper subjects and knowledge tags for recommendations. After saving, generate reports or configure automatic checks.',
  '多个标签取并集，以这些标签下的全部知识点判断推荐；相关材料仅作辅助依据。':
    'Tags form a union. Recommendations use all knowledge points under these tags; related materials supply supporting evidence.',
  '以所选标签下的知识点作为推荐依据，结合相关材料分析。结果和反馈保存在本机。':
    'Use knowledge points under the selected tags to guide recommendations, supported by related materials. Results and feedback stay on this computer.',
  '依据 {0} 下的全部知识点推荐，多标签取并集。':
    'Recommend using all knowledge points under {0}; multiple tags form a union.',
  '判断依据的知识点：': 'Knowledge behind this judgment: ',
  '知识范围：': 'Knowledge scope: ',
  '个人备注：': 'Personal notes: ',
  '材料原文，第 {0} 页': 'Source text, page(s) {0}',
  '依据所选标签下的 {0} 个知识点，使用 {1} 条知识与材料记录。':
    'Based on {0} knowledge points under the selected tags, using {1} knowledge and material records.',
  '本机数据 · 日报服务': 'Local data · Daily reports',
  '选择论文范围和允许使用的个人材料。保存后可生成日报或配置自动检查。':
    'Choose paper subjects and allowed personal materials. After saving, generate reports or configure automatic checks.',
  来源抓取时间: 'Source fetched at',
  最新完成日报: 'Latest completed report',
  打开最新日报: 'Open latest report',
  上一页待处理: 'Previous pending updates',
  下一页待处理: 'Next pending updates',
  '任务保存失败，请重新检查': 'Could not save the task; check again',
  自动日报: 'Automatic daily reports',
  已开启: 'Enabled',
  未开启: 'Disabled',
  '定时检查公告，有更新才分析':
    'Check announcements on schedule; analyze only when they change',
  上次检查: 'Last check',
  下次检查: 'Next check',
  '过去 24 小时自动调用': 'Automatic calls in the past 24 hours',
  尚无记录: 'No record yet',
  立即检查: 'Check now',
  查看本次日报: 'View report',
  自动设置与检查历史: 'Automatic settings and check history',
  开启自动日报: 'Enable automatic reports',
  每天检查时间: 'Daily check time',
  时区: 'Time zone',
  '过去 24 小时调用上限': 'Call limit over the past 24 hours',
  保存自动设置: 'Save automatic settings',
  重新读取设置: 'Reload settings',
  已发现更新待处理: 'Discovered updates awaiting action',
  '继续处理（调用模型）': 'Continue processing (calls model)',
  检查历史: 'Check history',
  打开日报: 'Open report',
  '首次启用检查最新公告；没有更新不调用模型。新公告按单批与自动额度筛选，详细报告由你主动生成。':
    'The first check uses the latest announcements. Unchanged sources make no model calls. New announcements use the batch and automatic limits; detailed reports stay on demand.',
  '电脑需保持开机、联网和唤醒。关闭自动开关不会取消已经提交的日报。':
    'Keep your computer on, online and awake. Disabling automation does not cancel reports already submitted.',
  '额度恢复后也不会自动补跑；请明确选择继续处理。':
    'Pending work stays paused when allowance returns. Choose Continue to process it.',
  自动日报设置已保存: 'Automatic settings saved',
  '检查已提交；仅在发现更新时启动分析':
    'Check submitted; analysis starts only for changed announcements',
  '任务已提交，已完成结果保留':
    'Task submitted; completed results are preserved',
  '正在检查公告…': 'Checking announcements…',
  '已检查，暂无新公告': 'Checked; no new announcements',
  已有任务或日报: 'Existing task or report',
  '来源有变化，无需新增分析': 'Source changed; no new analysis needed',
  已创建自动日报: 'Automatic report queued',
  '发现更新，自动额度不足': 'Update found; automatic allowance exhausted',
  '发现更新，请检查模型或标签设置': 'Update found; check model or tag settings',
  '来源不完整，等待重查': 'Incomplete source; waiting to recheck',
  来源检查失败: 'Source check failed',
  '来源返回旧公告，等待重查':
    'Older announcements returned; waiting to recheck',
  '设置已改变，本次检查已停止': 'Settings changed; check stopped',
  来源比较基线已更新: 'Source comparison baseline updated',
  检查已中断: 'Check interrupted',
  今日论文: 'Daily papers',
  范围内新论文: 'New papers in scope',
  推荐关注: 'Recommended',
  关注作者的新作: 'From followed authors',
  推荐阅读: 'Recommended',
  未推荐: 'Not recommended',
  作者动态: 'Authors',
  与你的关注内容建立联系: 'Connected to your research interests',
  '保留全部结果，方便发现遗漏': 'All remaining results, so nothing is hidden',
  '作者新作独立提醒，可能超出 subject 范围':
    'Author alerts may extend beyond the selected subject',
  搜索论文或作者: 'Search papers or authors',
  没有匹配的论文: 'No matching papers',
  这个范围暂时没有论文: 'No papers in this selection',
  '试试其他标题、话题或作者名。': 'Try another title, topic, or author.',
  '演示数据覆盖 9 月 5 日和 6 日。你也可以修改 subject 或 Persona 标签。':
    'Demo batches are available for September 5 and 6. You can also change the subject or Persona tags.',
  清空搜索: 'Clear search',
  调整订阅: 'Edit subscription',
  作者新作: 'Author update',
  为什么推荐: 'Why this paper',
  筛选说明: 'Screening note',
  查看分析: 'View analysis',
  '仅展示虚构示例 · 没有反馈的项目保持未评价':
    'Fictional examples only · Unrated items remain unknown',
  本次推荐依据: 'Recommendation scope',
  标签: 'TAGS',
  通用推荐: 'General selection',
  范围内示例材料: 'MATERIALS IN SCOPE',
  暂无个人材料: 'No personal materials',
  '仅使用所选标签内的内容。': 'Only content within your selected tags is used.',
  关注作者: 'Followed authors',
  篇示例新作: 'sample new papers',
  尚未关注作者: 'No authors followed yet',
  管理关注: 'Manage authors',
  '四项反馈全部可选。只记录你明确提供的评价，不推断阅读行为。':
    'All four feedback items are optional. Only explicit feedback is recorded; reading behavior is not inferred.',
  论文分析: 'Paper analysis',
  模拟数据: 'Demo data',
  示例批次: 'Demo batch',
  以下论文与分析均为虚构示例: 'Fictional paper and analysis for demonstration',
  暂未推荐: 'Not recommended',
  研究总结: 'Research summary',
  模拟分析: 'Sample analysis',
  推荐理由: 'Recommendation reason',
  本次依据: 'Scope',
  '仅 subject，不使用 Persona': 'Subject only, no Persona',
  已有材料联系与潜在交叉: 'Connections & potential crossover',
  '从所选 Persona 范围出发，连接新论文与已有材料。':
    'Connect this paper with materials in your selected Persona scope.',
  '问题 / 方法联系': 'Problem / method connection',
  一个可以继续探索的方向: 'A direction to explore',
  待验证的联想: 'Hypothesis',
  第一步: 'First check',
  '这是一条示例联想，并非论文已证明的结论；适用条件与已有工作仍需检查。':
    'This is an illustrative hypothesis, not a conclusion established by the paper. Applicability and prior work still need checking.',
  '所选 Persona 范围内没有可用的材料联系。':
    'No material connections are available within the selected Persona scope.',
  '不会使用其他标签补充，也不会生成默认评价。':
    'Other tags will not be used to fill this gap, and no feedback is inferred.',
  '所有反馈可选，理由也可留空。打开或关闭论文不会产生阅读状态。':
    'All feedback and reasons are optional. Opening or closing a paper does not record reading status.',
  '这是虚构示例材料，用于演示关联查看；没有读取你的真实知识库。':
    'This is fictional sample material for demonstrating connections. Your real knowledge base has not been read.',
  本次使用的材料: 'Materials in this scope',
  通用模式: 'General mode',
  份示例材料: 'sample materials',
  '当前范围没有 Persona 材料。':
    'There are no Persona materials in this scope.',
  '多标签按并集使用，标签外材料不参与筛选和关联分析。':
    'Multiple tags are combined. Materials outside these tags are excluded from screening and connections.',
  '这次不推荐的判断准确吗？': 'Was this exclusion accurate?',
  '推荐准确吗？': 'Was this recommendation accurate?',
  '对研究总结满意吗？': 'Satisfied with the summary?',
  '对推荐理由满意吗？': 'Satisfied with the recommendation reason?',
  '对已有材料联系和潜在交叉满意吗？':
    'Satisfied with the connections and potential crossover?',
  准确: 'Accurate',
  不准确: 'Inaccurate',
  满意: 'Satisfied',
  不满意: 'Unsatisfied',
  撤销此项反馈: 'Clear this feedback',
  撤销: 'Undo',
  '补充理由（可选）': 'Tell us why (optional)',
  '哪里不符合你的预期？也可以留空。': 'What could be improved?',
  '已记录 · 不影响其他评价': 'Recorded · independent of other feedback',
  仅研究总结: 'Research summary only',
  本次不优先推荐: 'Not prioritized for this scope',
  '证据不足，暂不判断': 'Insufficient evidence for a decision',
  个性化分析尚未完成: 'Personal analysis not yet complete',
  这篇论文做了什么: 'What this paper does',
  为什么得到这个判断: 'Why this judgment was made',
  与已有材料的联系: 'Connections to existing materials',
  直接引用: 'Direct citation',
  方法比较: 'Method comparison',
  共同问题: 'Shared question',
  '在本次检索范围内未找到有充分依据的材料联系。':
    'No sufficiently supported material connections were found in this search scope.',
  待验证设想: 'Hypothesis to test',
  '本次没有提出可靠的交叉候选。':
    'No sufficiently supported crossover candidates were proposed.',
  '这次分析对你有帮助吗？': 'Was this analysis useful?',
  '每项均可选。不满意时可补充理由，也可撤销。未填写的项目不会记录。':
    'Every item is optional. Explain a negative rating or clear a response. Unanswered items are not recorded.',
  '未选择标签，未进行个性化判断。':
    'No Persona tags selected; no personalized judgment was made.',
  '与 Physics 示例范围相关；参考文献直接引用了 3 篇示例库材料。':
    'Relevant to the Physics demo scope; three sample-library papers are directly cited.',
  '所选示例范围缺少明确联系，仍为你保留完整研究总结。':
    'The selected demo scope does not establish a clear connection. The full research summary remains available.',
  查看原文依据: 'View source evidence',
  '预写样例依据论文文字、公式和图注，未独立检查图像或复现实验。原论文：Poboiko 等，CC BY 4.0。':
    'Prewritten preview based on paper text, equations and captions. Figure images and calculations were not independently verified. Original paper: Poboiko et al., CC BY 4.0.',
  研究问题直接相关: 'Directly relevant research question',
  '本文讨论测量诱导的信息超扩散、衰减率节点和纠缠标度，与 Physics 示例范围中的超扩散研究相符。这里没有读取或推断你真实的兴趣等级。':
    'Measurement-induced information superdiffusion, decay-rate nodes and entanglement scaling connect to the Physics demo scope. No real personal interest levels were read or inferred.',
  有可核对的直接引用: 'Verifiable direct citations',
  '参考文献 [48]–[50] 对应下方的三篇示例材料。直接引用是已知关系；方法是否可以迁移，仍需要进一步判断。':
    'References [48]–[50] correspond to the three example materials below. Citation is established; whether their methods transfer requires further analysis.',
  查看三篇材料: 'View the three materials',
  '阅读时重点区分量子信息和纠缠的超扩散，与粒子密度的扩散。不能仅因都存在节点就认为两种动力学相同。':
    'Distinguish superdiffusive information and entanglement from diffusive particle-density dynamics. A shared momentum-space node does not make the dynamics equivalent.',
  示例知识库: 'Example library',
  '以下论文真实存在，并被目标论文引用。这里将它们作为示例库材料，不读取你的实际 Persona。':
    'These are real papers cited by the target paper, presented here as sample-library materials. Your actual Persona is not accessed.',
  核对参考文献: 'Verify reference',
  '哪些测量扰动会破坏节点保护？':
    'Which measurement perturbations break nodal protection?',
  '可比较不同微小测量扰动如何改变衰减率零点及纠缠的交叉尺度，再与节点退相干模型作对照。这是用于展示的研究设想，并非本文已经证明的结论。':
    'Compare how small changes to the measured orbitals modify decay-rate nodes and entanglement crossover scales, then contrast them with nodal dephasing models. This is an illustrative research hypothesis, not an established result of the paper.',
  '先检查正文、补充材料与已有文献是否覆盖该扰动；再在同一模型中分别计算衰减率、密度响应和纠缠，避免混淆传播对象。':
    'Check whether the paper, supplement or prior work already covers the perturbation. Then calculate decay rates, density response and entanglement separately in the same model.',
  '每项都可选。不满意时可补充理由，也可以撤销；未填写的项目不会记录。':
    'Every item is optional. You may explain a negative rating or clear any response. Unanswered items are not recorded.',
  '反馈仅对应这条演示记录，不记录阅读状态。':
    'Feedback applies only to this demo record. Reading status is not tracked.',
  目标: 'Target',
  本示例: 'This example',
  调整字数: 'Set length',
  'Paper Radar 每日论文': 'Paper Radar daily papers',
  每日论文: 'Daily papers',
  单篇分析: 'Single paper analysis',
  我的订阅: 'My subscriptions',
  模型设置: 'Model settings',
  新建订阅: 'New subscription',
  示例知识范围: 'Sample knowledge scope',
  '仅使用模拟论文、作者和材料': 'Sample papers, authors and materials only',
  设置与反馈保存在当前浏览器: 'Settings and feedback are saved in this browser',
  '当前入口未提供真实日报服务，请确认后端已更新并转发完整页面和 API。':
    'The daily paper service is unavailable here. Check that the backend is updated and both the page and API are forwarded.',
  '无法连接后台。': 'Unable to connect to the backend.',
  正在连接研究工作台: 'Connecting to your research workspace',
  研究服务未连接: 'Research service disconnected',
  '已有订阅和分析保存在电脑上，连接恢复后即可查看。':
    'Your subscriptions and analyses are saved on this computer and will be available when the connection returns.',
  刷新连接: 'Reconnect',
  订阅已保存到当前浏览器: 'Subscription saved in this browser',
  工作台: 'Workspace',
  分析与数据说明: 'About analysis and data',
  '每日论文 · 模拟数据': 'Daily papers · Demo data',
  切换内容语言: 'Content language',
  中文: 'Chinese',
  '本地数据无法完整读取或保存。当前操作仍然可用，但刷新后可能无法保留。':
    'Some local data could not be loaded or saved. You can continue, but changes may not survive a refresh.',
  关闭提示: 'Dismiss notice',
  '为「{0}」整理的每日研究线索': 'Daily research leads for “{0}”',
  '用不同的范围，关注不同的研究方向。':
    'Follow different research directions with separate scopes.',
  '为「{0}」选择关注的研究者。': 'Choose researchers to follow for “{0}”.',
  论文批次日期: 'Paper batch date',
  论文列表: 'Paper list',
  搜索论文: 'Search papers',
  清空论文搜索: 'Clear paper search',
  '关联 {0} 份 Persona 材料': 'Connected to {0} Persona materials',
  编辑当前订阅: 'Edit current subscription',
  '查看 {0} 份材料的使用范围': 'View the scope of {0} materials',
  编辑: 'Edit',
  位作者: 'authors',
  '研究总结 ·': 'Research summary ·',
  字: 'characters',
  词: 'words',
  查看每日论文: 'View daily papers',
  关注一个新方向: 'Follow a new direction',
  '选择 subject 和 Persona 标签': 'Choose a subject and Persona tags',
  '作者关注属于当前订阅：': 'Authors followed in this subscription:',
  '新作跨 subject 提醒；论文、作者身份与单位均为虚构示例。':
    'New papers trigger alerts across subjects. These papers, authors and affiliations are fictional examples.',
  查看作者动态: 'View author updates',
  '示例作者目录 · 已关注': 'Sample author directory · Following',
  位: 'authors',
  搜索作者或研究方向: 'Search authors or research topics',
  搜索作者: 'Search authors',
  清空作者搜索: 'Clear author search',
  查看本订阅中的新作: 'View new papers in this subscription',
  '已关注 · 取消': 'Following · Unfollow',
  没有找到这位示例作者: 'No matching sample author',
  '可以搜索 Maya、Alex、Lin，或“量子输运”。':
    'Try Maya, Alex, Lin, or “quantum transport”.',
  关闭论文分析: 'Close paper analysis',
  体验你的论文工作台: 'Explore your research workspace',
  '当前是可交互的前端演示。': 'This is an interactive frontend demo.',
  '每日论文使用虚构数据。单篇分析在本机服务中支持真实 arXiv 读取、模型分析与限定标签的 Persona 材料；在线静态版本保留演示。':
    'Daily papers use fictional data. The local service reads real arXiv papers, runs model analysis and retrieves Persona materials within selected tags. The online version remains a demo.',
  '你可以编辑订阅、查看作者动态，或输入 arXiv 链接体验单篇分析的设置、进度、历史记录与四项可选反馈。':
    'Edit subscriptions, view author updates, or enter an arXiv link to explore analysis settings, progress, history and four optional feedback items.',
  '真实单篇分析的结果和反馈保存在本机服务中，并使用配置的模型额度。演示数据仍保存在浏览器，示例和真实结果分别管理。反馈不会自动修改 Persona。':
    'Real analysis results and feedback are stored by the local service and use your configured model allowance. Demo data stays in the browser, separate from real results. Feedback does not automatically change Persona.',
  '演示暂采用：多标签取并集、作者跨 subject 提醒、语言按订阅保存。这些规则仍可继续讨论。':
    'Demo rules: tags are combined, author alerts cross subjects, and content language is saved per subscription. These rules can still be revised.',
  '反馈未保存。': 'Feedback was not saved.',
  '正在保存反馈…': 'Saving feedback…',
  '反馈未保存：': 'Feedback was not saved:',
  重试: 'Retry',
  '无法读取论文详情。': 'Unable to load paper details.',
  '无法读取证据。': 'Unable to load evidence.',
  证据: 'Evidence',
  '正在读取论文…': 'Loading paper…',
  读取已保存的分析与证据: 'Loading saved analysis and evidence',
  全文判断: 'Full-text assessment',
  摘要初筛: 'Abstract screening',
  判断未完成: 'Assessment incomplete',
  来自: 'From',
  '初筛推荐 · 详细分析保留列表归属':
    'Recommended at screening · Detailed analysis preserves list placement',
  初筛未推荐: 'Not recommended at screening',
  '关联待确认，可按需分析或讨论':
    'Relevance uncertain; analyze or discuss as needed',
  初筛尚未完成: 'Screening incomplete',
  '· 复用已有初筛': '· Reused previous screening',
  '正在提交详细分析…': 'Submitting detailed analysis…',
  讨论这篇论文: 'Discuss this paper',
  文章介绍: 'Paper overview',
  初筛理由: 'Screening reason',
  查看原始摘要: 'View original abstract',
  '· 实际 {0}': '· Actual {0}',
  '正在生成详细研究总结…': 'Generating detailed research summary…',
  '研究总结尚需核对。': 'The research summary needs review.',
  讨论这一节: 'Discuss this section',
  全文补充意见: 'Additional full-text assessment',
  '个性化分析尚未完成。': 'Personalized analysis is incomplete.',
  讨论这项意见: 'Discuss this assessment',
  已有材料联系: 'Connections to existing materials',
  相关材料: 'Related materials',
  讨论这项联系: 'Discuss this connection',
  '本次尚无有充分依据的材料联系。':
    'No sufficiently supported material connections were found.',
  潜在交叉: 'Potential crossover',
  '待验证：': 'To verify:',
  '第一步检查：': 'First check:',
  讨论这个问题: 'Discuss this question',
  '本次尚无有充分依据的交叉建议。':
    'No sufficiently supported crossover suggestions were found.',
  '个人材料仅使用选定标签范围。已有模型检查不能替代科学结论的核对。':
    'Personal materials are limited to selected tags. Model checks do not replace verification of scientific conclusions.',
  '全文分析已提交，完成的内容将自动显示；可以继续浏览其他论文。':
    'Full-text analysis was submitted. Completed content will appear automatically; you can keep browsing other papers.',
  '已有初筛结果保留，可以重试详细分析。':
    'Screening results are preserved. You can retry detailed analysis.',
  '研究总结、材料联系和潜在交叉需要进一步读取全文。':
    'Research summaries, material connections and potential crossover require reading the full text.',
  '正在提交…': 'Submitting…',
  重试详细分析: 'Retry detailed analysis',
  生成详细分析: 'Generate detailed analysis',
  重新生成详细报告: 'Regenerate detailed report',
  打开单篇任务: 'Open single paper task',
  分析依据: 'Analysis evidence',
  查看本次结果引用的原始证据: 'View the original evidence cited in this result',
  打开来源: 'Open source',
  'arXiv subjects（可多选）': 'arXiv subjects (select multiple)',
  '已选 {0} 个分类 · 点击添加或移除':
    '{0} subjects selected · Click to add or remove',
  请选择分类: 'Select subjects',
  '正在读取分类…': 'Loading subjects…',
  '搜索 arXiv 分类': 'Search arXiv subjects',
  输入代码或英文名称: 'Enter a code or English name',
  '没有匹配的分类，请尝试代码或英文名称。':
    'No matching subject. Try a code or English name.',
  已选: 'Selected',
  个: 'items',
  完成选择: 'Done',
  '移除分类 {0}': 'Remove subject {0}',
  '分类取并集，同一篇论文只推荐一次。':
    'Subjects are combined. Each paper is recommended only once.',
  '请至少选择一个分类。': 'Select at least one subject.',
  '公告日期 · 查看或生成日报': 'Announcement date · View or generate a report',
  '选择公告日期：{0}': 'Select announcement date: {0}',
  '最新 {0}': 'Latest {0}',
  最新: 'Latest',
  '最新 · {0}': 'Latest · {0}',
  最新公告: 'Latest announcement',
  '圆点表示已有日报，下划线表示有完整公告存档。选好日期后，点击“生成所选日期日报”。未存档且已不在官方当前公告中的日期暂不可补查。':
    'Dots mark saved reports; underlines mark complete announcement archives. After choosing a date, click “Generate selected date”. Dates without an archive that are no longer in the current official feed cannot be retrieved yet.',
  返回最新: 'Back to latest',
  排队中: 'Queued',
  生成中: 'Generating',
  已完成: 'Completed',
  部分完成: 'Partially completed',
  未完成: 'Incomplete',
  预算暂停: 'Paused at budget limit',
  已取消: 'Cancelled',
  已中断: 'Interrupted',
  待筛选: 'Awaiting screening',
  初筛中: 'Screening',
  待深入分析: 'Awaiting detailed analysis',
  全文分析中: 'Analyzing full text',
  待核对: 'Needs review',
  版本动态: 'Version updates',
  '本机数据 · 手动日报': 'Local data · Manual reports',
  '请至少从列表选择一个有效的 arXiv subject。':
    'Select at least one valid arXiv subject from the list.',
  '订阅未保存。': 'Subscription was not saved.',
  编辑订阅: 'Edit subscription',
  '选择论文范围和允许使用的个人材料。保存后可手动生成日报。':
    'Choose the paper scope and permitted personal materials. Generate daily reports manually after saving.',
  订阅名称: 'Subscription name',
  '例如：量子信息与测量': 'For example: Quantum information and measurement',
  'AI Persona 标签': 'AI Persona tags',
  '多个标签取并集。筛选、推荐理由和材料联系只依赖这些标签中的内容。':
    'Tags are combined. Screening, recommendation reasons and material connections use only content within these tags.',
  '保存的标签已失效或尚未加载，请重新选择。':
    'Saved tags are unavailable or have not loaded. Please select them again.',
  刷新标签: 'Refresh tags',
  '正在获取真实标签…': 'Loading Persona tags…',
  推荐严格程度: 'Recommendation strictness',
  '调整相关性门槛，不固定每天的数量或比例。保存后用于新一轮筛选；当前日报可显式重新筛选。':
    'Adjusts the relevance threshold, with no fixed daily count or ratio. Applies to new screening after saving; you can explicitly rescreen the current report.',
  输出语言: 'Output language',
  '中文叙述 · English 术语': 'Chinese narrative · English terminology',
  订阅状态: 'Subscription status',
  可运行: 'Enabled',
  草稿: 'Draft',
  停用: 'Disabled',
  归档: 'Archive',
  '研究总结长度（': 'Research summary length (',
  至少: 'Minimum',
  最多: 'Maximum',
  '仅在主动开启详细分析后使用；推荐理由和材料联系不占用总结字数。':
    'Used only when you request detailed analysis. Recommendation reasons and material connections do not count toward the summary length.',
  将更新版本也纳入推荐筛选:
    'Include updated versions in recommendation screening',
  '默认筛选新作和新跨分类，更新版本单列为动态。':
    'By default, new papers and new cross-listings are screened; updated versions appear separately.',
  每批最多模型请求次数: 'Maximum model requests per batch',
  '仅用于本批初筛及其重试。全文分析单独计量；达到预算后保留未筛选项，可继续。':
    'Applies to this screening batch and its retries. Full-text analysis is counted separately; unscreened papers are kept for continuation when the budget is reached.',
  '正在保存…': 'Saving…',
  保存订阅: 'Save subscription',
  取消: 'Cancel',
  '无法读取订阅。': 'Unable to load subscriptions.',
  '标签数量超过读取上限。': 'The tag count exceeds the loading limit.',
  'Persona 未连接。': 'Persona is disconnected.',
  '记录不存在。': 'Record not found.',
  '无法更新日报。': 'Unable to update the daily report.',
  '操作未完成。': 'Operation incomplete.',
  '继续处理未完成的候选。': 'Resuming unfinished candidates.',
  '日报已取消，已完成内容保留。':
    'Daily report cancelled. Completed content is preserved.',
  '已加入详细分析队列。': 'Added to the detailed analysis queue.',
  打开导航菜单: 'Open navigation menu',
  本机服务: 'Local service',
  重试读取订阅: 'Retry loading subscriptions',
  关闭错误提示: 'Dismiss error',
  '正在检查 {0} 的公告…': 'Checking the {0} announcement…',
  '正在检查最新公告…': 'Checking the latest announcement…',
  '作者身份匹配和新作提醒将在后续阶段接入。现在可以按 subject 订阅，或分析单篇论文。':
    'Author matching and new-paper alerts are planned for a later stage. For now, subscribe by subject or analyze individual papers.',
  管理论文订阅: 'Manage paper subscriptions',
  '按研究方向保存论文范围、Persona 标签和输出设置。':
    'Save paper scope, Persona tags and output settings for each research direction.',
  显示已归档订阅: 'Show archived subscriptions',
  已归档: 'Archived',
  '尚未选择 Persona 标签': 'No Persona tags selected',
  '· 总结': '· Summary',
  包含更新版本: 'Includes updated versions',
  新作及新跨分类: 'New papers and new cross-listings',
  '· 每批初筛上限': '· Screening limit per batch',
  次请求: 'requests',
  查看日报: 'View daily report',
  创建你的第一个订阅: 'Create your first subscription',
  '选择一个 subject 和允许使用的 Persona 标签，开始筛选真实论文。':
    'Choose a subject and permitted Persona tags to start screening real papers.',
  '为「{0}」整理的研究线索': 'Research leads for “{0}”',
  '保存关注范围，生成你的论文日报。':
    'Save your research scope and generate daily paper reports.',
  '正在检查…': 'Checking…',
  查看正在生成的日报: 'View report in progress',
  生成所选日期日报: 'Generate selected date',
  生成最新一批: 'Generate latest batch',
  当前订阅: 'Current subscription',
  '＋ 新建订阅': '＋ New subscription',
  收起历史: 'Hide history',
  生成历史: 'Generation history',
  此订阅为: 'This subscription is',
  '状态。编辑并启用后可以生成新的日报，历史仍可查看。':
    '. Edit and enable it to generate new reports. History remains available.',
  公告获取中: 'Fetching announcement',
  '· 第 {0} 版': '· Version {0}',
  上一页历史: 'Previous history page',
  下一页历史: 'Next history page',
  '正在读取日报…': 'Loading daily report…',
  '正在更新所选日期和论文列表。': 'Updating the selected date and paper list.',
  '日报暂时无法读取，请重试。':
    'The daily report could not be loaded. Please retry.',
  重新读取日报: 'Reload daily report',
  正在确认公告日期: 'Confirming announcement date',
  '· 按需总结': '· On-demand summary',
  '· 初筛 revision {0}': '· Screening revision {0}',
  这份日报使用订阅第: 'This report uses subscription version',
  '版，当前订阅已更新。历史内容保持原设置。':
    '. The subscription has since changed. History keeps its original settings.',
  '分类范围已改变，请点击“生成最新一批”收集新范围的论文；这份历史日报保留原范围。':
    'The subject scope has changed. Click “Generate latest batch” to collect papers in the new scope. This report keeps its original scope.',
  筛选候选: 'Candidates',
  推荐: 'Recommended',
  初筛未完成: 'Screening incomplete',
  关联待确认: 'Relevance uncertain',
  初筛完成: 'Screening complete',
  '· 按需报告': '· On-demand reports',
  份: 'reports',
  已完成初筛比例: 'Screening completion',
  模型请求: 'Model requests',
  输入: 'Input',
  '/ 输出': '/ Output',
  费用未提供: 'Cost unavailable',
  '费用 ${0}': 'Cost ${0}',
  取消本批任务: 'Cancel this batch',
  继续未完成部分: 'Resume unfinished work',
  按当前订阅重新筛选本批: 'Rescreen with current subscription',
  删除日报: 'Delete daily report',
  已有: 'Available:',
  '篇推荐可查看。': 'recommended papers.',
  查看推荐论文: 'View recommended papers',
  '公告来源与覆盖 ·': 'Announcement sources and coverage ·',
  已完整读取本次来源: 'Source fully loaded',
  存在覆盖缺口: 'Coverage gaps found',
  条公告: 'announcements',
  合并重复: 'Duplicates merged:',
  '条 · 版本动态': '· Version updates:',
  条: 'items',
  跨分类合并重复: 'Cross-listing duplicates merged:',
  '条；同一篇论文只筛选一次。': '; each paper is screened only once.',
  日期未确认: 'Date unconfirmed',
  读取失败: 'Load failed',
  '日期不同，未纳入': 'Different date; excluded',
  已纳入: 'Included',
  '已纳入，覆盖有缺口': 'Included with coverage gaps',
  查看官方来源: 'View official source',
  搜索本批论文标题或作者: 'Search this batch by title or author',
  搜索标题或作者: 'Search title or author',
  篇: 'papers',
  新作: 'New paper',
  新跨分类: 'New cross-listing',
  更新: 'Update',
  更新并跨分类: 'Update and cross-listing',
  '本订阅未将更新版本纳入筛选。':
    'This subscription excludes updated versions from screening.',
  '初筛尚未完成。': 'Screening is incomplete.',
  '原始摘要（旧版结果）': 'Original abstract (legacy result)',
  初筛依据摘要: 'Screened from abstract',
  依据全文: 'Based on full text',
  单独记录版本变化: 'Version changes tracked separately',
  尚未完成判断: 'Assessment incomplete',
  讨论: 'Discuss',
  详细分析: 'Detailed analysis',
  详细分析中: 'Detailed analysis in progress',
  查看报告: 'View report',
  查看详情: 'View details',
  上一页: 'Previous page',
  第: 'Page',
  页: '',
  下一页: 'Next page',
  该公告日期没有已保存的日报: 'No saved report for this announcement date',
  还没有生成日报: 'No daily reports yet',
  '点击“生成所选日期日报”，读取 {0} 的公告存档或日期匹配的官方当前公告。缺少来源时会明确提示。':
    'Click “Generate selected date” to read the {0} archive or the matching official current announcement. Missing sources will be reported.',
  '点击“生成最新一批”，先查看文章介绍和推荐理由，再按需生成详细报告。':
    'Click “Generate latest batch” to review paper overviews and recommendation reasons, then request detailed reports as needed.',
  从一个研究方向开始: 'Start with a research direction',
  '选择 arXiv subject 和 Persona 标签，设置你希望看到的总结长度。':
    'Choose arXiv subjects and Persona tags, then set your preferred summary length.',
  '订阅已保存到本机服务。': 'Subscription saved to the local service.',
  继续这份日报: 'Resume this daily report',
  '保留原订阅和模型设置，只重试未完成项。已完成的判断和反馈保留。':
    'Keeps the original subscription and model settings, retrying only unfinished items. Completed assessments and feedback are preserved.',
  这份日报的总模型请求上限: 'Total model request limit for this report',
  已使用: 'Used:',
  '次；额度是整个日报的累计上限。':
    'requests; this is the cumulative limit for the whole report.',
  继续处理: 'Resume',
  '删除这份日报及其所有版本？': 'Delete this report and all its versions?',
  '会删除该日报的运行历史、显式反馈和独占个人分析。订阅和公共论文来源保留。':
    'Deletes this report’s run history, explicit feedback and exclusive personal analyses. Subscriptions and public paper sources are preserved.',
  保留: 'Keep',
  '日报已删除。': 'Daily report deleted.',
  请选择: 'Select an option',

  正在检查连接方式: 'Checking connection mode',

  关闭错误: 'Dismiss error',

  个模型: 'models',

  管理账号: 'Manage account',

  默认: 'Default',
  测试: 'Test',

  选择模型: 'Choose model',

  模型使用方式: 'Model usage',
  默认模型: 'Default model',
  尚未选择: 'None selected',

  模型: 'Model',

  备用模型: 'Fallback model',

  结果: 'Result',

  完成: 'Done',
  未知: 'Unknown',

  使用的模型: 'Model',

  高级设置: 'Advanced settings',

  讨论这一点: 'Discuss this point',
  '请先选中报告中不超过 2000 字的一段文字。':
    'First select a passage of up to 2,000 characters in the report.',
  讨论选中文字: 'Discuss selected text',
  '请核查并讨论这里的问题与前提：{0}':
    'Please examine and discuss the question and assumptions here: {0}',
  '无法打开讨论。': 'Unable to open discussion.',
  '连接中断，回答仍会保存在本机。':
    'Connection interrupted. The answer will still be saved locally.',
  '证据读取失败。': 'Unable to load evidence.',
  论文讨论: 'Paper discussion',
  关闭论文讨论: 'Close paper discussion',
  '基于论文、所选标签和当前讨论问题':
    'Based on the paper, selected tags and current question',
  会话: 'Conversation',
  切换论文讨论: 'Switch paper discussion',
  '正在读取…': 'Loading…',
  新会话: 'New conversation',
  删除当前讨论: 'Delete current discussion',
  '删除本会话的消息和证据快照？':
    'Delete this conversation’s messages and evidence snapshots?',
  删除会话: 'Delete conversation',
  '限定所选 Persona 标签': 'Limited to selected Persona tags',
  仅论文: 'Paper only',
  '· 报告': '· Report',
  '把这里的结论作为待核查内容；讨论不会修改原报告。':
    'Treat these conclusions as claims to verify. Discussion does not change the original report.',
  '正在读取讨论…': 'Loading discussion…',
  从报告里的这个问题继续: 'Continue from this question in the report',
  从你关心的一个问题开始: 'Start with a question that interests you',
  '可以解释方法、核查前提，或讨论与已有材料的联系。无需先生成详细报告。':
    'Explain methods, check assumptions or discuss connections to existing materials. A detailed report is not required.',
  '这个问题的前提是否成立？论文是否已经回答了它？':
    'Is this question’s premise valid? Has the paper already answered it?',
  '请解释这里的方法和成立条件。':
    'Please explain this method and the conditions under which it holds.',
  '如何设计一个最小的验证步骤？':
    'How could we design a minimal verification step?',
  '这篇论文具体解决了什么问题？':
    'What specific problem does this paper solve?',
  '请解释核心方法及它的局限。':
    'Please explain the core method and its limitations.',
  '它与所选材料有哪些实质联系？':
    'What substantive connections does it have to the selected materials?',
  你: 'You',
  依据: 'Evidence',
  证据边界与待验证事项: 'Evidence limits and open questions',
  取消本轮: 'Cancel this turn',
  '本轮已取消。': 'This turn was cancelled.',
  '本轮尚未完成。': 'This turn is incomplete.',
  本轮按问题选取: 'This turn used',
  '个证据片段，未覆盖全文所有内容。':
    'evidence excerpts selected for the question, rather than the entire paper.',
  向模型提问: 'Ask the model',
  '继续追问，或核查报告中的结论…':
    'Ask a follow-up or verify a conclusion in the report…',
  '每轮提问后调用模型；关闭窗口后回答仍会保存。':
    'Each question calls the model. Answers are saved even after you close this window.',
  回答中: 'Answering',
  发送: 'Send',
  讨论依据: 'Discussion evidence',
  本轮引用的原始证据: 'Original evidence cited in this turn',
  '当前入口未提供单篇分析服务，请检查转发地址。':
    'No single paper analysis service is available here. Check the forwarding address.',
  '后台暂时无法连接。': 'Unable to connect to the backend.',
  单篇论文分析: 'Single paper analysis',
  正在连接分析服务: 'Connecting to the analysis service',
  分析服务未连接: 'Analysis service disconnected',
  '已有记录保留在电脑上，连接恢复后即可继续查看。':
    'Existing records are saved on this computer and will be available when the connection returns.',
  在运行服务的电脑上打开: 'Open on the computer running the service',
  重新连接: 'Reconnect',
  分析中: 'Analyzing',
  '内容正在准备中，完成后会显示在这里。':
    'Content is being prepared and will appear here when ready.',
  '未选择 Persona 标签，本次仅生成研究总结。':
    'No Persona tags selected. Only a research summary will be generated.',
  '这部分内容尚需核对。': 'This content needs review.',
  '标签过多，请在 AI Persona 中整理后重新连接。':
    'Too many tags. Organize them in AI Persona and reconnect.',
  '无法更新进度。': 'Unable to update progress.',
  '请填写有效的 arXiv 链接或编号。': 'Enter a valid arXiv link or ID.',
  '字数范围应为 200–3000 内的整数，最少字数小于最多字数。':
    'Use whole numbers from 200 to 3,000, with the minimum below the maximum.',
  '所选 Persona 标签暂不可用，请刷新标签或重新选择。':
    'Selected Persona tags are unavailable. Refresh or select them again.',
  '已打开这次请求的任务。': 'Opened the task for this request.',
  '分析任务已保存，可以离开页面后再回来查看。':
    'Analysis task saved. You can leave and return later.',
  '无法创建任务。': 'Unable to create the task.',
  '反馈尚未保存，请重试。': 'Feedback was not saved. Please retry.',
  '无法读取依据。': 'Unable to load evidence.',
  原文: 'Source text',
  材料: 'Material',
  已选标签: 'Selected tags',
  '读清论文做了什么，找到与你研究的联系。':
    'Understand what the paper does and how it connects to your research.',
  '本机服务 · 真实分析': 'Local service · Real analysis',
  '按所选标签准备个人材料，交给你配置的模型分析。结果和反馈保存在本机。':
    'Personal materials are prepared within the selected tags and analyzed by your configured models. Results and feedback are saved locally.',
  添加论文: 'Add paper',
  'arXiv 链接或编号': 'arXiv link or ID',
  '支持摘要、PDF、HTML 链接': 'Abstract, PDF and HTML links supported',
  填入示例: 'Fill sample',
  '格式有效 · 开始后读取真实论文':
    'Valid format · The real paper will be loaded when analysis starts',
  设置分析范围: 'Set analysis scope',
  沿用订阅设置: 'Use subscription settings',
  '订阅中的示例标签无法唯一对应真实标签，请手动选择。':
    'Sample subscription tags could not be uniquely matched to real tags. Please select them manually.',
  独立设置: 'Custom settings',
  '复制标签、语言和字数；单篇不受订阅 subject 限制。':
    'Copies tags, language and length. Single paper analysis is not restricted by the subscription’s subject.',
  'Persona 标签': 'Persona tags',
  真实知识范围: 'Personal knowledge scope',
  '正在获取标签…': 'Loading tags…',
  '仅使用 {0} 的内容，多标签取并集。':
    'Uses only content in {0}; multiple tags are combined.',
  '未选标签：仅研究总结，不进行个性化判断。':
    'No tags selected: summary only, without personalized assessment.',
  '清空标签，仅生成总结': 'Clear tags; generate summary only',
  内容语言: 'Content language',
  研究总结长度: 'Research summary length',
  总结最少字数: 'Minimum summary length',
  总结最多字数: 'Maximum summary length',
  简要: 'Brief',
  标准: 'Standard',
  详细: 'Detailed',
  '中文按非空白字符计数，英文按单词计数。生成后检查并按需修订。':
    'Chinese counts non-whitespace characters; English counts words. Output is checked and revised as needed.',
  先讨论这篇论文: 'Discuss this paper first',
  '按当前标签范围提问，无需先生成全文报告。中文输出保留 English 专业术语。':
    'Ask within the current tag scope without generating a full report first. Chinese output preserves English technical terms.',
  沿用模型设置: 'Use model settings',
  '总结、材料联系使用各自的任务模型':
    'Summaries and material connections use their assigned task models',
  打开模型设置: 'Open model settings',
  正在提交: 'Submitting',
  开始分析: 'Start analysis',
  '实际调用所配置模型，使用对应平台的额度。':
    'Calls your configured models and uses the corresponding provider allowance.',
  分析记录: 'Analysis history',
  仅总结: 'Summary only',
  '开始一次分析，结果会保存在这里。': 'Start an analysis to save results here.',
  较新的记录: 'Newer records',
  较早的记录: 'Older records',
  分析结果: 'Analysis results',
  研究分析: 'Research analysis',
  等待添加论文: 'Waiting for a paper',
  从一篇论文开始: 'Start with a paper',
  '粘贴 arXiv 链接，选择允许使用的个人知识范围。完成后可查看详细总结、推荐依据，以及与已有材料的联系。':
    'Paste an arXiv link and choose the permitted personal knowledge scope. Once complete, view the detailed summary, recommendation evidence and connections to existing materials.',
  等待读取: 'Waiting to load',
  正在准备论文信息: 'Preparing paper information',
  '打开 arXiv': 'Open arXiv',
  取消任务: 'Cancel task',
  '· 跳过': '· Skipped',
  '任务在本机后台执行。已完成内容会先显示，可以稍后回来查看。':
    'This task runs in the local background. Completed content appears first; you can return later.',
  检查模型设置: 'Check model settings',
  '范围内 {0} 条记录，检索 {1} 条，使用 {2} 条相关记录。':
    '{0} records in scope; {1} retrieved; {2} relevant records used.',
  '本次未使用任何 Persona 材料。': 'No Persona materials were used.',
  '请查看进度或错误说明。': 'See the progress or error details.',
  联系与交叉: 'Connections & crossover',
  反馈: 'Feedback',
  '生成模型：': 'Model:',
  '· 已复用校验结果': '· Reused validated result',
  讨论推荐理由: 'Discuss recommendation reason',
  '尚未生成或未通过校验的内容不收集对应评价。':
    'Feedback is unavailable for content that has not been generated or validated.',
  '反馈仅对应这次分析，不记录阅读状态。':
    'Feedback applies only to this analysis. Reading status is not tracked.',
  '已保存到本机 ·': 'Saved locally ·',
  次模型请求: 'model requests',
  '已载入本次设置，调整后点击开始分析。':
    'Settings loaded. Adjust them and click “Start analysis”.',
  调整设置: 'Adjust settings',
  '重新生成（调用模型）': 'Regenerate (calls model)',
  删除这条分析: 'Delete this analysis',
  '本次还没有可展示的分析结果。设置和任务记录已保留。':
    'No analysis results are available yet. Settings and the task record are preserved.',
  '可以重新尝试该任务，已校验且设置一致的内容会复用。':
    'Retry this task. Validated content with matching settings will be reused.',
  按当前设置再分析: 'Analyze with current settings',
  重试未完成部分: 'Retry unfinished work',
  查看依据: 'View evidence',
  '本次分析所用的 Persona 记录': 'Persona records used in this analysis',
  '材料原文，第 {0}–{1} 行': 'Original material, lines {0}–{1}',
  来自本次分析固定的来源版本: 'From the source version fixed for this analysis',
  打开原文位置: 'Open source location',
  '记录版本 r': 'Record version r',
  '暂时无法读取依据，请关闭后重试。':
    'Evidence is unavailable right now. Close this window and retry.',
  '删除这次分析？': 'Delete this analysis?',
  '将删除本机保存的这次结果及其反馈。AI Persona 中的原始材料不受影响。':
    'Deletes this locally saved result and its feedback. Original AI Persona materials are unaffected.',
  删除分析: 'Delete analysis',
  知识程度: 'Knowledge level',
  兴趣程度: 'Interest level',
  用户关系: 'Relationship to user',
  '共同线索是特殊动量附近的长寿命模。已有材料研究节点杂质下的粒子输运，本文研究测量轨迹中的量子信息传播，二者的观测量不同。':
    'The shared theme is long-lived modes near special momenta. The existing material studies particle transport with nodal impurities, while this paper studies quantum information propagation in measurement trajectories; the observables differ.',
  '可对照节点附近的衰减率与重尾传播机制。退相干模型中的 Lévy walk 与本文的量子信息 Lévy flights 有明确联系，但不能直接等同。':
    'Compare decay rates near the node and heavy-tailed propagation mechanisms. Lévy walks in the dephasing model relate to the quantum-information Lévy flights here, but cannot be directly equated.',
  '两篇工作都利用节点保护的长寿命准粒子。需要区分相互作用体系的电荷输运，与受监测自由费米子的纠缠和信息动力学。':
    'Both works use long-lived quasiparticles protected by nodes. Distinguish charge transport in interacting systems from entanglement and information dynamics in monitored free fermions.',
  字数待调整: 'Length needs adjustment',
  暂无示例: 'No example available',
  '沿用「模型设置」中的默认模型与任务分配':
    'Uses the default model and task assignments from “Model settings”',
  '演示记录无法完整读取。当前仍可体验，新记录将保存在此浏览器。':
    'Demo records could not be fully loaded. You can continue; new records will be saved in this browser.',
  '浏览器暂时无法读取演示记录。':
    'The browser cannot load demo records right now.',
  '浏览器暂时无法保存记录，刷新后可能丢失。':
    'The browser cannot save records right now. They may be lost after a refresh.',
  '已填入示例论文，可调整标签、语言和字数后体验分析。':
    'Sample paper filled in. Adjust tags, language and length to try the analysis.',
  '请先完成或取消正在进行的演示分析。':
    'Complete or cancel the current demo analysis first.',
  '此浏览器已保存50条演示记录，暂时无法新增。':
    'This browser has 50 saved demo records and cannot add more right now.',
  '从一篇论文出发，看清研究内容与它对你的意义。':
    'Start with a paper to understand its research and relevance to you.',
  'UI 演示 · 不调用模型': 'UI demo · No model calls',
  '论文与引用来自公开资料；Persona 范围和分析过程为演示。记录仅保存在当前浏览器。':
    'The paper and citations are public sources; Persona scope and analysis steps are simulated. Records stay in this browser.',
  使用示例: 'Use sample',
  '已识别示例 · 分析 v3': 'Sample recognized · Analyze v3',
  '链接格式已识别 · 暂无演示内容': 'Link format recognized · No demo content',
  '沿用标签、语言和字数；不受订阅 subject 限制。':
    'Copies tags, language and length without restricting the subscription subject.',
  示例: 'Sample',
  '仅使用 {0} 范围内的示例材料，多标签取并集。':
    'Uses only sample materials in {0}; multiple tags are combined.',
  '未选标签：只生成研究总结，不做个性化判断。':
    'No tags selected: research summary only, without personalized assessment.',
  '200–3000；中文按非空白字符计数，英文按单词计数。预写内容不足时会提示。':
    '200–3,000; Chinese counts non-whitespace characters and English counts words. A notice appears if prewritten content is too short.',
  演示分析进行中: 'Demo analysis in progress',
  '开始分析 · 演示': 'Start demo analysis',
  '体验读取、生成与检查过程，不消耗模型额度。':
    'Try loading, generation and validation without using model allowance.',
  仅此浏览器: 'This browser only',
  从第一篇开始: 'Start with your first paper',
  '完成演示后，记录与反馈会保存在这里。':
    'After completing a demo, records and feedback will be saved here.',
  'arXiv 链接 · 暂无标题': 'arXiv link · No title yet',
  未选标签: 'No tags selected',
  '· 演示记录': '· Demo record',
  论文分析结果: 'Paper analysis results',
  示例结果预览: 'Sample result preview',
  预写内容: 'Prewritten content',
  等待读取论文信息: 'Waiting to load paper information',
  '2025-10-26 · v3 · 正文与补充材料':
    '2025-10-26 · v3 · Main text and supplement',
  '链接已保存 · 真实读取待接入': 'Link saved · Real loading is not connected',
  '查看 arXiv': 'View arXiv',
  '未选 Persona 标签': 'No Persona tags selected',
  分析流程示例: 'Sample analysis workflow',
  '· 演示': '· Demo',
  '此过程模拟实际任务，刷新后会恢复演示进度。':
    'This simulates a real task. Demo progress resumes after a refresh.',
  '识别论文版本，准备正文与参考文献':
    'Identify the paper version; prepare text and references',
  '检查选定标签，挑选相关材料':
    'Check selected tags and choose relevant materials',
  '组织研究总结、推荐理由与材料联系':
    'Organize the summary, recommendation reasons and material connections',
  '检查字数、结构和证据引用': 'Check length, structure and evidence citations',
  '完成后查看详细分析，也可以稍后从左侧记录返回。':
    'View detailed analysis when complete, or return later from the history on the left.',
  '先看看结果会如何呈现。使用左侧示例链接开始演示后，可以保存记录和填写反馈。':
    'Preview how results will appear. Start with the sample link on the left to save a record and leave feedback.',
  预写总结为: 'The prewritten summary has',
  '，未满足': ', outside the target of',
  '的范围。本版不会自动续写；可调整范围后再次预览。':
    '. This version does not automatically extend it; adjust the range and preview again.',
  '当前选择 {0}。演示材料未建立这篇量子物理论文与该范围的明确联系，因此暂不优先推荐。这不影响你查看论文做了什么。':
    'Current selection: {0}. The demo materials do not establish a clear connection between this quantum physics paper and that scope, so it is not prioritized. The research summary remains available.',
  未进行个性化分析: 'No personalized analysis',
  '选择 Persona 标签后重新分析，才会判断论文是否与你的研究相关。':
    'Select Persona tags and reanalyze to assess relevance to your research.',
  调整分析设置: 'Adjust analysis settings',
  所选范围暂无示例联系: 'No sample connections in this scope',
  尚未使用个人材料: 'No personal materials used',
  '完整研究总结仍可查看。选择 Physics 可体验引用联系与交叉分析。':
    'The full summary remains available. Select Physics to try citation connections and crossover analysis.',
  '没有选择标签，本次仅提供研究总结。':
    'No tags selected. This analysis provides only a research summary.',
  '请先从左侧开始一次演示分析，再对该记录提供反馈。':
    'Start a demo analysis on the left before leaving feedback on that record.',
  '未生成的个性化内容不收集对应评价。':
    'Feedback is unavailable for personalized content that has not been generated.',
  '预览 · 尚未保存': 'Preview · Not saved',
  已保存到此浏览器: 'Saved in this browser',
  字数范围满足: 'Length within range',
  '已载入这次分析的设置，调整后点击“开始分析”。':
    'Analysis settings loaded. Adjust them and click “Start analysis”.',
  调整并重新分析: 'Adjust and reanalyze',
  演示已取消: 'Demo cancelled',
  这个链接暂无演示内容: 'No demo content for this link',
  '设置和记录仍然保留，可以重新体验分析流程。':
    'Settings and records are preserved. You can restart the analysis demo.',
  '链接格式有效，但本版尚未接入真实论文读取。目前提供 2501.12903v3 的完整预写样例，不会为其他论文编造分析。':
    'The link format is valid, but real paper loading is not connected in this version. A complete prewritten example is available for 2501.12903v3; analyses are not fabricated for other papers.',
  重新开始演示: 'Restart demo',
  填写示例论文: 'Fill sample paper',
  已有相同设置的分析记录: 'An analysis with these settings already exists',
  '这篇论文已按相同标签、语言和字数范围完成过演示。可以直接查看，也可以保存一次新的分析。':
    'This paper was already analyzed in the demo with the same tags, language and length. View the existing result or save a new analysis.',
  重新分析: 'Reanalyze',
  查看已有结果: 'View existing result',
  '定义论文范围，以及用于推荐的 Persona 内容。':
    'Define the paper scope and Persona content used for recommendations.',
  '例如：量子动力学与输运': 'For example: Quantum dynamics and transport',
  '可选 · 多选取并集': 'Optional · Multiple tags are combined',
  '仅使用 {0} 份标签内的示例材料':
    'Uses only {0} sample materials within selected tags',
  '通用推荐：不使用 Persona 内容':
    'General recommendations: no Persona content',
  '该标签没有示例材料，匹配结果可能为空。不会改用其他标签。':
    'This tag has no sample materials, so matches may be empty. Other tags will not be used instead.',
  '依据 subject 展示领域精选，不生成个性化材料联系。':
    'Shows subject-based selections without personalized material connections.',
  可选: 'Optional',
  '演示中，作者新作跨 subject 提醒，单独列在作者动态。':
    'In the demo, new papers by followed authors trigger alerts across subjects and appear under author updates.',
  按订阅保存: 'Saved per subscription',
  '讲清研究问题、具体方法、关键工作、主要结果与局限。':
    'Explain the research question, methods, key work, main results and limitations.',
  最少: 'Minimum',
  常用总结字数范围: 'Common summary length ranges',
  '中文按正文非空白字符计数（含标点），不含小标题。':
    'Chinese counts non-whitespace body characters, including punctuation, excluding headings.',
  '英文按正文词数计数，不含小标题。':
    'English counts body words, excluding headings.',
  '支持 200–3000': 'Supports 200–3,000',
  '。该设置只影响研究总结。':
    '. This setting affects only the research summary.',
  '当前按范围展示预写示例；AI 按字数生成将在接入后端后实现。':
    'Prewritten samples are shown within the range where possible. Model generation to length will be available after backend integration.',
  配置仅保存在当前浏览器: 'Configuration saved in this browser only',
  '预写示例按完整段落调整；AI 按范围生成功能尚未接入。':
    'Prewritten demo, adjusted by whole paragraphs. Model generation is not connected yet.',
  '当前预写示例未达到目标范围。设置已保存，接入 AI 后将按范围生成；演示不凑字数或截断句子。':
    'This prewritten example does not meet the target range. Your target is saved for future generation; the demo does not pad or cut sentences.',
  '{0} 的日报': 'Daily report for {0}',
  日报: 'Daily report',
  '已打开已有的{0}。': 'Opened existing {0}.',
  '正在初筛论文，结果会陆续显示，离开页面后任务仍会继续。':
    'Screening papers. Results will appear progressively, and the task continues after you leave this page.',
  '正在检查 {0} 的公告，请稍候。':
    'Checking the {0} announcement. Please wait.',
  '正在检查最新公告，请稍候。':
    'Checking the latest announcement. Please wait.',
  '{0}已完成，可查看推荐结果。':
    '{0} is complete. Recommendation results are ready.',
  '任务已取消。点击“继续未完成部分”后才会继续。':
    'Task cancelled. Click “Resume unfinished work” to continue.',
  '任务因请求额度暂停，可调整额度后继续。':
    'Task paused at the request limit. Adjust the limit to continue.',
  '任务未全部完成，请查看状态并重试未完成部分。':
    'Task incomplete. Check its status and retry unfinished work.',
  '请修改搜索词，或清空搜索查看本分类。':
    'Change the search terms or clear the search to view this category.',
  '正在读取 {0} 的公告': 'Loading the {0} announcement',
  正在读取最新公告: 'Loading the latest announcement',
  '正在核对公告日期与论文范围，候选数量尚未确定。':
    'Checking the announcement date and paper scope. The candidate count is not yet known.',
  本批任务已取消: 'This batch was cancelled',
  '已完成内容仍可查看；未完成部分需要点击“继续未完成部分”后才会处理。':
    'Completed content remains available. Click “Resume unfinished work” to process the rest.',
  本批任务尚未完成: 'This batch is incomplete',
  本批没有符合订阅范围的候选:
    'No candidates in this batch match the subscription scope',
  '本次公告读取已结束，可以查看公告来源与版本动态。':
    'Announcement loading is complete. View the sources and version updates for details.',
  正在筛选推荐论文: 'Selecting recommended papers',
  '推荐结果会陆续显示，无需等待全部完成。':
    'Results appear progressively; you do not need to wait for the entire batch.',
  本批暂无推荐论文: 'No recommended papers in this batch',
  本批暂无未推荐论文: 'No non-recommended papers in this batch',
  本批没有关联待确认的论文: 'No papers with uncertain relevance in this batch',
  本批初筛已全部完成: 'Screening is complete for this batch',
  本批没有待处理论文: 'No pending papers in this batch',
  本批没有单列的版本动态: 'No separate version updates in this batch',
  本分类暂无论文: 'No papers in this category',
  '可以切换分类查看其他论文。': 'Switch categories to view other papers.',
  尚未请求详细分析: 'Detailed analysis not requested',
  详细分析排队中: 'Detailed analysis queued',
  正在详细分析: 'Analyzing in detail',
  详细报告已就绪: 'Detailed report ready',
  详细报告部分完成: 'Detailed report partially complete',
  详细分析失败: 'Detailed analysis failed',
  详细分析已取消: 'Detailed analysis cancelled',
  详细分析已中断: 'Detailed analysis interrupted',
  版本变化: 'Version changes',
  未推荐原因: 'Reason for exclusion',
  初筛进度: 'Screening progress',
  模型认为值得关注: 'The model considers this worth following',
  模型认为与当前研究范围关联较弱:
    'The model finds limited relevance to the current research scope',
  模型尚不能确定相关性: 'The model cannot yet determine relevance',
  已保留在推荐列表: 'Kept in the recommended list',
  保留初筛时的列表归属: 'Original screening list placement preserved',
  '全文补充意见：{0}。{1}。': 'Full-text assessment: {0}. {1}.',

  详细研究总结: 'Detailed research summary',

  材料联系与潜在交叉: 'Material connections & potential crossover',

  额度不足: 'Insufficient allowance',

  聚焦: 'Focused',
  '只推荐明确贴近研究问题或能直接使用的方法。':
    'Recommends only clearly relevant research or directly usable methods.',
  均衡: 'Balanced',
  '兼顾明确的主题关联、有依据的方法迁移和材料联系。':
    'Balances clear topical relevance, supported method transfer and material connections.',
  探索: 'Exploratory',
  '也考虑有具体依据的邻近方向，明确说明探索性和前提。':
    'Also considers supported neighboring directions, with explicit assumptions and exploratory context.',
  旧版标准: 'Legacy criteria',
  '访问入口没有返回后台数据（HTTP {0}）。请刷新连接；远程转发需要同时包含页面和 API。':
    'The entry point did not return backend data (HTTP {0}). Reconnect; remote forwarding must include both the page and API.',
  '后台返回格式无法识别，请刷新连接。':
    'Unrecognized backend response. Please reconnect.',
  '后台请求失败（HTTP {0}），请重试。':
    'Backend request failed (HTTP {0}). Please retry.',
  读取论文: 'Read paper',
  获取相关材料: 'Retrieve relevant materials',
  生成分析: 'Generate analysis',
  检查内容: 'Check content',
  '请填写有效的 arXiv 链接或论文编号，例如 2501.12903。':
    'Enter a valid arXiv link or paper ID, such as 2501.12903.',
  '语言或标签设置无效。': 'Invalid language or tag settings.',

  请求过大: 'Request too large',
  请求格式无效: 'Invalid request format',
  'PAPER_RADAR_PORT 无效': 'Invalid PAPER_RADAR_PORT',
  'PAPER_RADAR_PUBLIC_ORIGIN 必须是完整的 HTTP/HTTPS 来源地址，不得包含账号、路径、查询参数或片段':
    'PAPER_RADAR_PUBLIC_ORIGIN must be a complete HTTP/HTTPS origin without credentials, path, query or fragment',
  连接不存在: 'Connection not found',

  任务已取消: 'Task cancelled',
  '已有两个模型请求运行中，请稍后再试':
    'Two model requests are already running. Please retry later',

  '模型存储已锁定；请检查 server.lock':
    'Model storage is locked; check server.lock',
  另一个模型服务正在使用此存储: 'Another model service is using this storage',
  模型凭据密钥无效: 'Invalid model credential key',
  模型存储版本不支持: 'Unsupported model storage version',
  '论文来源地址无效。': 'Invalid paper source URL.',
  '论文来源超过本机读取大小限制。':
    'Paper source exceeds the local download size limit.',
  '论文来源重定向过多。': 'Too many paper source redirects.',
  'arXiv 网络请求失败或超时。': 'arXiv network request failed or timed out.',
  'arXiv 编号无效。': 'Invalid arXiv ID.',
  'HTML 正文不完整。': 'Incomplete HTML paper text.',
  '下载结果不是可解析的论文 PDF。': 'The download is not a readable paper PDF.',
  '未获得足够的可读正文；不会仅凭摘要生成全文分析。':
    'Insufficient readable text. Full-text analysis will not be generated from the abstract alone.',
  'arXiv 元数据未包含确定的论文版本。':
    'arXiv metadata does not identify a definite paper version.',
  '返回的论文版本与请求不一致。':
    'The returned paper version differs from the requested version.',
  '未找到可识别的论文摘要页面。': 'No recognizable paper abstract page found.',
  '无法确认所请求的论文版本。':
    'Unable to confirm the requested paper version.',
  '论文标识与请求不一致。': 'Paper ID differs from the request.',
  'PDF 超过 300 页，请使用可读 HTML 或更短文献。':
    'PDF exceeds 300 pages. Use readable HTML or a shorter document.',
  'PDF 无法提取可用正文，可能是扫描件或受限格式。':
    'No usable text could be extracted from the PDF. It may be scanned or restricted.',
  '分析未能完成，可重试；详情见任务阶段。':
    'Analysis incomplete. Retry or check the task stages for details.',
  '请检查标签、语言及总结字数设置。':
    'Check tags, language and summary length settings.',
  '总结最少字数应小于最多字数。':
    'Minimum summary length must be below the maximum.',
  '选定标签时必须连接 AI Persona。': 'Connect AI Persona when selecting tags.',
  '模型返回的 JSON 格式不完整。': 'The model returned incomplete JSON.',
  分析数据目录已锁定: 'Analysis data directory is locked',
  另一个分析服务正在使用此目录:
    'Another analysis service is using this directory',
  分析数据库版本高于当前应用:
    'Analysis database version is newer than this app',
  '服务中断，可从已完成步骤重试。':
    'Service interrupted. Retry from completed steps.',
  '分析结果不存在。': 'Analysis result not found.',
  '该报告关联了讨论，请先删除相关讨论。':
    'This report has linked discussions. Delete them first.',
  '请先取消运行中的任务。': 'Cancel running tasks first.',
  '该分析仍被日报引用，请先删除相关日报。':
    'A daily report still references this analysis. Delete the related report first.',
  '分页参数无效。': 'Invalid pagination parameters.',
  '个人材料超过原文读取限制。':
    'Personal material exceeds the source reading limit.',
  '尚未配置 AI Persona 本机连接；可以不选标签先生成总结。':
    'No local AI Persona connection configured. You can generate a summary without selecting tags.',
  'Persona 连接配置无效。': 'Invalid Persona connection configuration.',
  'AI Persona 需要支持严格标签范围的新版接口，请更新并重连。':
    'AI Persona needs a newer API with strict tag scope. Update and reconnect.',
  '无法连接 AI Persona 本机服务。':
    'Unable to connect to the local AI Persona service.',
  '该 Persona 工具不在只读分析范围内。':
    'This Persona tool is outside the read-only analysis scope.',
  'Persona 查询未完成，请检查服务连接。':
    'Persona query incomplete. Check the service connection.',
  'Persona 返回结构无法识别。': 'Unrecognized Persona response structure.',
  'Persona 连接已变化，请刷新标签后重新分析。':
    'Persona connection changed. Refresh tags and reanalyze.',
  '标签数量超过本轮读取限制。':
    'Tag count exceeds this request’s reading limit.',
  '所选标签已失效，请刷新后重新选择。':
    'Selected tags are no longer valid. Refresh and select again.',
  'Persona 返回范围或版本与请求不一致。':
    'Persona scope or version differs from the request.',
  '请选择 Persona 标签。': 'Select Persona tags.',
  'Persona 返回了标签范围外的记录。':
    'Persona returned records outside the selected tag scope.',
  '所选范围超过本轮完整读取上限，请缩小标签范围后运行。':
    'Selected scope exceeds this run’s full reading limit. Reduce the tag scope and retry.',
  '所选标签没有可用记录，无法进行个性化筛选。':
    'Selected tags contain no usable records for personalized screening.',
  'Persona 原文哈希不匹配。': 'Persona source text hash does not match.',
  '服务正在关闭，请稍后重试。': 'Service is shutting down. Please retry later.',
  '缺少有效的请求幂等标识。': 'A valid request identifier is required.',
  '该请求标识已用于不同的分析设置。':
    'This request identifier was already used with different analysis settings.',
  '请先在模型设置中选择研究总结模型。':
    'Select a research summary model in Model settings first.',
  '请先选择材料联系任务使用的模型。':
    'Select a model for material connections first.',
  '任务队列已满，请等待当前任务完成。':
    'Task queue is full. Wait for current tasks to finish.',
  等待分析: 'Waiting for analysis',
  '任务不存在。': 'Task not found.',
  '结果不存在。': 'Result not found.',
  '该结果没有此证据。': 'This result does not contain that evidence.',
  '本次任务已取消，可重试。': 'Task cancelled. You can retry.',
  '该任务属于日报，请对这篇论文使用详细分析入口重试。':
    'This task belongs to a daily report. Retry through the paper’s detailed analysis action.',
  '任务尚在运行。': 'Task is still running.',
  '评价维度无效。': 'Invalid feedback dimension.',
  '该内容尚未完成，不能提交此项评价。':
    'This content is incomplete and cannot accept feedback yet.',
  '反馈内容无效。': 'Invalid feedback content.',
  '已达到本次模型请求预算，可重试未完成部分。':
    'Model request budget reached. Retry unfinished work.',
  '所选模型容量不足以容纳当前证据，请选择更大上下文的模型。':
    'The selected model cannot fit the current evidence. Choose a model with a larger context.',
  '论文较长，正在逐段提取事实与条件':
    'This is a long paper. Extracting facts and conditions section by section',
  '单个正文块超过模型容量，请更换模型。':
    'A single text chunk exceeds model capacity. Choose another model.',
  '全文分段处理超出当前任务预算，请选择更大上下文模型。':
    'Full-text chunk processing exceeds the current task budget. Choose a model with a larger context.',
  '提取论文第 {0}/{1} 部分的事实':
    'Extracting facts from paper section {0}/{1}',
  '分段事实提取返回了未知引用。':
    'Chunk extraction returned unknown citations.',
  '完整事实提纲仍超出模型容量。':
    'The full fact outline still exceeds model capacity.',
  复用已校验的分析内容: 'Reusing validated analysis content',
  '核对重要结论、引用支持和表述条件':
    'Checking key conclusions, citation support and conditions',
  '生成结果仍有待核对问题。': 'The generated result still needs review.',
  '请检查订阅名称、范围、字数和请求预算。':
    'Check the subscription name, scope, length and request budget.',
  '请至少选择一个有效的 arXiv subject。':
    'Select at least one valid arXiv subject.',
  '启用个性化订阅前，请选择至少一个 Persona 标签。':
    'Select at least one Persona tag before enabling a personalized subscription.',
  '初筛结果的论文版本或证据引用无效。':
    'The screened paper version or evidence citations are invalid.',
  '初筛使用了没有证据支持的个人事实。':
    'Screening used unsupported personal facts.',
  '初筛没有提供范围内个人依据，尚不能完成个性化判断。':
    'Screening provided no personal evidence within scope; personalized assessment is incomplete.',
  '公告来源不是完整的 ATOM 文档。':
    'The announcement source is not a complete ATOM document.',
  '公告 XML 结构损坏，无法确认来源完整性。':
    'Announcement XML is damaged. Source completeness cannot be confirmed.',
  '公告分类与订阅不一致。':
    'Announcement subject differs from the subscription.',
  '公告条目嵌套异常，来源结构不完整。':
    'Announcement entries are incorrectly nested; source structure is incomplete.',
  '来源没有可确定日期的公告条目；不能据此判断今天没有论文。':
    'No announcement entries have a definite date. This does not establish that no papers were published today.',
  '请选择有效且不晚于今天的公告日期。':
    'Choose a valid announcement date no later than today.',
  '{0} 的 {1} 公告尚未存档，且本次官方来源读取失败；请稍后重试。':
    'The {1} announcement for {0} is not archived, and the official source could not be loaded. Please retry later.',
  '未找到 {0} 的 {1} 公告：本机尚未存档，官方当前 feed 也未提供该日期。该日可能未发布或已不在 feed 中，不能据此生成空日报；请选择有存档的日期或返回最新公告。':
    'No {1} announcement found for {0}: no local archive exists, and the current official feed does not include that date. It may have had no release or left the feed; an empty report cannot be inferred. Choose an archived date or return to the latest announcement.',
  '该请求标识已用于其他参数。':
    'This request identifier was already used with other parameters.',
  '日报已暂停或取消。': 'Daily report paused or cancelled.',
  '已达到日报模型请求预算，可增加预算后继续。':
    'Daily model request budget reached. Increase the budget to continue.',
  '已打开同一设置的既有日报。':
    'Opened the existing daily report with the same settings.',
  '服务中断，可以继续未完成部分。':
    'Service interrupted. Resume unfinished work.',
  '订阅已被修改，请刷新后重试。': 'Subscription changed. Refresh and retry.',
  '服务正在关闭。': 'Service is shutting down.',
  '日报创建参数无效；公告日期须是真实日期且不晚于今天。':
    'Invalid report parameters. Announcement date must be valid and no later than today.',
  '订阅已修改，请刷新后重新生成。':
    'Subscription changed. Refresh before generating again.',
  '请先选择有效标签并启用订阅。':
    'Select valid tags and enable the subscription first.',
  '请先配置每日筛选使用的模型。': 'Configure a daily screening model first.',
  '日报仍在运行。': 'Daily report is still running.',
  '重试参数无效。': 'Invalid retry parameters.',
  '新预算应不低于已使用次数，最多 2000。':
    'New budget must be at least the requests already used and no more than 2,000.',
  等待继续未完成部分: 'Waiting to resume unfinished work',
  '全文分析参数无效。': 'Invalid full-text analysis parameters.',
  '版本动态请从单篇入口分析。':
    'Analyze version updates through single paper analysis.',
  '初筛只有判断和理由可供评价。':
    'Screening supports feedback only on its assessment and reason.',
  '反馈格式无效。': 'Invalid feedback format.',
  '该日报关联了讨论，请先删除相关讨论。':
    'This daily report has linked discussions. Delete them first.',
  '存档批次与订阅分类不一致。':
    'Archived batch subjects differ from the subscription.',
  '公告来源日期与所选日期不一致，未生成日报。':
    'Source announcement date differs from the selected date. No report was generated.',
  获取限定标签的筛选依据: 'Retrieving screening evidence within selected tags',
  '服务中断，可继续未完成部分。':
    'Service interrupted. Resume unfinished work.',
  '未取得完整的标签范围记录。':
    'Could not retrieve all records in the tag scope.',
  '筛选上下文超过模型容量，请缩小标签范围或换用更大上下文模型。':
    'Screening context exceeds model capacity. Reduce the tag scope or choose a larger-context model.',
  '详细分析尚未全部完成，可以重试。':
    'Detailed analysis is incomplete. You can retry.',
  '请检查公告存档或稍后重试。':
    'Check the announcement archive or retry later.',
  '未能读取该分类公告。': 'Unable to read this subject’s announcement.',
  '公告来源返回的分类不一致。':
    'Source returned a different announcement subject.',
  '讨论引用了本轮未提供的证据。':
    'Discussion cited evidence not provided for this turn.',
  '讨论中的个人事实缺少原始字段依据。':
    'Personal facts in the discussion lack original field evidence.',
  '请先选择一份报告，再讨论其中的问题。':
    'Select a report before discussing its questions.',
  '所选文字不属于这份报告，请重新选择。':
    'Selected text does not belong to this report. Select it again.',
  '报告中不存在这个章节或问题。':
    'This section or question does not exist in the report.',
  '已切换为按需全文分析；已有内容保留。':
    'Switched to on-demand full-text analysis. Existing content is preserved.',
  '旧版初筛已完成；详细分析改为按需开启。':
    'Legacy screening completed. Detailed analysis is now on demand.',
  '讨论不存在。': 'Discussion not found.',
  '讨论消息不存在。': 'Discussion message not found.',
  '请求标识已用于其他消息。':
    'Request identifier was already used for another message.',
  '服务中断，可以重试本条消息。': 'Service interrupted. Retry this message.',
  '讨论来源或锚点无效。': 'Invalid discussion source or anchor.',
  '请选择一个讨论来源。': 'Choose a discussion source.',
  '日报服务不可用。': 'Daily report service unavailable.',
  '报告不属于这篇日报论文。': 'This report does not belong to the daily paper.',
  '报告不存在。': 'Report not found.',
  '请输入 1–12000 字的问题。': 'Enter a question of 1–12,000 characters.',
  '请等待或取消当前回答，再继续提问。':
    'Wait for or cancel the current answer before asking another question.',
  '讨论队列已满，请稍后重试。': 'Discussion queue is full. Please retry later.',
  '请在 AI 模型设置中配置讨论模型。':
    'Configure a discussion model in Model settings.',
  等待回答: 'Waiting for an answer',
  '这条消息不需要重试。': 'This message does not need a retry.',
  '请在当前会话末尾重新提问，或等待当前任务结束。':
    'Ask again at the end of the current conversation or wait for the current task to finish.',
  等待重新回答: 'Waiting to answer again',
  '本轮讨论没有此证据。':
    'This discussion turn does not contain that evidence.',
  读取限定标签的讨论依据: 'Retrieving discussion evidence within selected tags',
  '讨论材料超出了固定标签范围。':
    'Discussion materials exceed the fixed tag scope.',
  读取论文上下文: 'Reading paper context',
  '本会话上下文已较长，请开启新会话并明确要继续的问题。':
    'This conversation is getting long. Start a new one and specify the question to continue.',
  '正在回答；本轮只处理你的问题': 'Answering the current question',
  '论文与讨论上下文超过当前模型容量，请选择更大上下文模型或新开会话。':
    'Paper and discussion context exceed model capacity. Choose a larger-context model or start a new conversation.',
  '本轮讨论达到重试上限，可手动重试。':
    'Discussion retry limit reached. You can retry manually.',
  回答已保存: 'Answer saved',
  '服务中断，可以重试。': 'Service interrupted. You can retry.',
  '本轮回答超时，可以重试。': 'This answer timed out. You can retry.',
  研究总结与校验: 'Research summary and validation',
  个性化分析与校验: 'Personalized analysis and validation',
  分析完成: 'Analysis complete',
  '部分完成，请检查提示': 'Partially complete; review the notices',
  分析尚未通过检查: 'Analysis has not passed validation',
  '服务中断，可重试。': 'Service interrupted. You can retry.',
  '任务超过执行时间预算，可保留已完成内容并重试。':
    'Task time limit reached. Completed content is preserved for retry.',
  '推荐理由、材料联系和交叉':
    'Recommendation reasons, material connections and crossover',
  '生成{0}': 'Generating {0}',
  '修订{0}（第 {1} 次尝试）': 'Revising {0} (attempt {1})',
  '删除账号 {0}': 'Delete account {0}',
  请设置总结字数范围: 'Set a summary length range',
  字数上下限必须为整数: 'Length limits must be whole numbers',
  '总结范围支持 200–3000 字 / 词':
    'Summary length supports 200–3,000 characters or words',
  字数下限必须小于上限: 'Minimum length must be below the maximum',
  请填写订阅名称: 'Enter a subscription name',
  '订阅名称请控制在 50 个字符以内':
    'Keep the subscription name within 50 characters',
  '请选择有效的 arXiv subject': 'Select a valid arXiv subject',
  '请选择有效的 Persona 标签': 'Select valid Persona tags',
  请选择有效的作者: 'Select a valid author',
  请选择中文或英文: 'Choose Chinese or English',
  '）': ')',
  '（': '(',

  '「': '“',
};
