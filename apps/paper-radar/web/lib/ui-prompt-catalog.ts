export const promptUiCatalog: Record<string, string> = {
  英文: 'English',
  '仅在任务生成语言为中文时加载，控制中文解释中的英文术语表达。':
    'Loaded only for Chinese task output; controls how English terminology appears in Chinese explanations.',
  '（仅中文任务加载，保留占位符）':
    ' (Chinese tasks only; keep this placeholder)',
  预览生成语言: 'Preview output language',
  '仅改变示例预览；实际任务使用各自选择的生成语言。术语表达规则仅在中文任务中加载。':
    'Changes the example preview only. Real tasks use their own output language. Terminology rules load only for Chinese tasks.',
  '请选择中文或英文预览。': 'Choose Chinese or English for the preview.',
  提示词: 'Prompts',
  提示词设置: 'Prompt settings',
  '管理模型、提示词、个人知识连接和界面偏好。':
    'Manage models, prompts, personal knowledge connections and interface preferences.',
  '调整分析重点、推荐标准和回答风格。保存后用于新任务；进行中的任务继续使用原版本。':
    'Adjust analysis priorities, recommendation criteria and response style. Saved changes apply to new tasks; ongoing tasks keep their original version.',
  '论文资料、个人知识、当前问题和输出格式由任务自动填入。预览使用虚构示例，不调用模型。':
    'Tasks automatically supply paper sources, personal knowledge, the current question and the output format. Previews use synthetic examples without calling a model.',
  '演示页面不连接本机提示词。请在本机应用的设置中编辑。':
    'The demo does not connect to local prompts. Edit them in the local application settings.',
  '正在读取提示词…': 'Loading prompts…',
  选择提示词: 'Choose a prompt',
  任务提示词: 'Task prompt',
  共用规则: 'Shared rules',
  单篇完整分析: 'Complete paper analysis',
  独立研究总结: 'Standalone summary',
  独立个性化分析: 'Standalone personal analysis',
  按需内容复核: 'Content review on request',
  '论文讨论 Agent': 'Paper discussion',
  '每日初筛 Agent': 'Daily screening',
  术语表达规则: 'Terminology rules',
  推荐严格度规则: 'Recommendation strictness rules',
  '形成研究总结，并在选择个人知识范围时给出推荐理由、材料联系和潜在交叉。':
    'Summarize the research and, when a personal knowledge scope is selected, explain recommendations, material connections and potential crossovers.',
  '围绕论文给出符合用户要求的研究总结。':
    'Summarize the paper according to the user’s requirements.',
  '结合所选知识范围说明推荐理由、材料联系与潜在交叉。':
    'Explain recommendations, material connections and potential crossovers within the selected knowledge scope.',
  '针对用户指定的已有内容和疑问给出复核结果。':
    'Review existing content and questions specified by the user.',
  '回答用户当前问题，结合该话题已有约束和所需依据。':
    'Answer the current question using the topic’s constraints and relevant evidence.',
  '逐篇 Agent 的任务约定；可编辑、预览和启用。支持载入真实运行记录后进行带工具的独立试跑。':
    'Instructions for screening each paper. Edit, preview and activate them here. The workbench also supports tool-assisted trials from captured runs.',
  角色与工作要求: 'Role and working instructions',
  共用规则内容: 'Shared rule text',
  '严格度：聚焦': 'Strictness: focused',
  '严格度：平衡': 'Strictness: balanced',
  '严格度：探索': 'Strictness: exploratory',
  有未保存修改: 'Unsaved changes',
  使用默认提示词: 'Using default prompt',
  使用自定义提示词: 'Using custom prompt',
  '影响任务：': 'Used by: ',
  '当前启用版本与新版任务不兼容。请载入默认提示词，合并修改后保存。':
    'The active version is incompatible with the current task. Load the default prompt, merge your changes and save.',
  自动填入的内容与共用规则: 'Automatic inputs and shared rules',
  '请保留必需占位符；可以在前后补充要求。保存时会检查遗漏或拼写错误。':
    'Keep required placeholders and add instructions around them. Saving checks for missing or misspelled placeholders.',
  '任务目标、资料引用与输出约定':
    'Task goal, source references and output contract',
  结构化初筛任务: 'Structured screening task',
  '（必需）': ' (required)',
  '（可选）': ' (optional)',
  '此共用规则没有必需占位符。':
    'This shared rule has no required placeholders.',
  '修改说明（可选）': 'Change note (optional)',
  保存并启用: 'Save and activate',
  预览完整提示词: 'Preview full prompt',
  恢复默认: 'Restore defaults',
  撤销本次修改: 'Discard edits',
  载入历史版本: 'Load a previous version',
  选择版本以载入草稿: 'Select a version to load as a draft',
  当前启用: 'Currently active',
  项目默认版本: 'Project default',
  '正在处理提示词…': 'Processing prompt…',
  '已载入草稿，保存并启用后生效。':
    'Loaded as a draft. Save and activate to apply it.',
  '已保存并启用，将用于新任务。': 'Saved and activated for new tasks.',
  '提示词操作失败，请重试。': 'The prompt operation failed. Please retry.',
  '其他页面已修改启用版本。读取最新版本会保留你的草稿，比较后可再次保存。':
    'Another page changed the active version. Load the latest version to compare; your draft will be kept.',
  读取最新启用版本: 'Load latest active version',
  '已读取最新启用版本，草稿已保留。请比较后再保存。':
    'Loaded the latest active version and kept your draft. Compare before saving again.',
  查看当前启用的提示词: 'View the currently active prompt',
  提示词预览: 'Prompt preview',
  '以下内容由当前草稿、已启用的共用规则和虚构示例组成；实际任务会填入真实资料。':
    'This combines your draft, active shared rules and a synthetic example. Actual tasks supply real source material.',
  '启用版本已改变，请刷新后比较再操作。':
    'The active version changed. Refresh and compare before trying again.',
  '模板缺少必要变量或共用规则：{0}':
    'The template is missing required variables or shared rules: {0}',
  '模板使用了未声明的变量或共用规则。':
    'The template uses an undeclared variable or shared rule.',
  '模板字段与当前功能不兼容。':
    'The template fields are incompatible with this feature.',
  '模板必须是文本，每段不超过 50000 字符。':
    'Each template must be text with at most 50,000 characters.',
  '修改说明不超过 500 字符。': 'Change notes must not exceed 500 characters.',
  '为每种生成语言维护共用规则和任务提示词。':
    'Maintain shared rules and task prompts for each output language.',
  '各语言独立保存，切换保留草稿。':
    'Languages are saved independently. Switching keeps your drafts.',
  '为每种筛选规则维护独立提示词。':
    'Maintain a separate prompt for each screening rule.',
  '自动应用于当前生成语言的所有任务，可以留空。':
    'Applied automatically to all tasks in this output language; may be empty.',
  '仅用于选择此筛选规则的每日筛选任务。':
    'Used only by daily tasks with this screening rule.',
  编辑或预览: 'Edit or preview',
  编辑: 'Edit',
  组合预览: 'Combined preview',
  筛选规则: 'Screening rule',
  '此处切换编辑与预览，实际执行规则由订阅决定。':
    'This selects what to edit and preview. Subscriptions choose the rule used for execution.',
  '{0}提示词': '{0} prompt',
  聚焦提示词: 'Focused prompt',
  平衡提示词: 'Balanced prompt',
  探索提示词: 'Exploratory prompt',
  每日通用要求: 'Daily common instructions',
  每日筛选通用要求: 'Daily screening common instructions',
  自动加入当前语言的共用规则:
    'Shared rules for the current language are added automatically',
  查看并编辑: 'View and edit',
  工作要求: 'Working instructions',
  规则内容: 'Rule text',
  '自动应用于当前语言的所有每日筛选任务。':
    'Applied to every daily screening task in the current language.',
  '仅用于所选筛选规则，每日通用要求自动加入。':
    'Used only for the selected rule. Daily common instructions are added automatically.',
  '共用规则也可以留空，按你的需要自由维护。':
    'Shared rules are yours to edit and may be left empty.',
  '共用规则会自动加入，这里只需填写当前任务的要求。':
    'Shared rules are added automatically. Enter task-specific instructions here.',
  任务输入模板: 'Task input template',
  '保留 {{task}}，任务资料会自动填入。':
    'Keep {{task}}; task material is filled in automatically.',
  恢复此项默认: 'Restore this default',
  版本与修改说明: 'Versions and change note',
  预览任务: 'Preview task',
  '使用当前草稿 · 不调用 AI': 'Uses current drafts · No AI call',
  '正在生成预览…': 'Preparing preview…',
  '本次仅加入「{0}」筛选规则': 'Only the {0} screening rule is included',
  '当前语言的共用规则为空，本次不加入。':
    'Shared rules for this language are empty and are omitted.',
  '来源：{0}': 'Source: {0}',
  草稿: 'Draft',
  本次任务资料: 'Task material',
  '来源：虚构示例': 'Source: synthetic example',
  查看完整输入: 'View full input',
  '预览使用相关草稿；请分别保存需要生效的修改。':
    'The preview uses related drafts. Save each change that should take effect.',
  '保存后用于新任务；进行中的任务和原任务重试继续使用原版本。':
    'Saved changes apply to new tasks. Ongoing tasks and retries keep their original versions.',
  '生成语言与当前提示词不一致。':
    'The output language does not match this prompt.',
  '请选择有效的预览任务。': 'Choose a valid preview task.',
  '请选择聚焦、平衡或探索。': 'Choose focused, balanced, or exploratory.',
  '预览草稿无效。': 'Invalid preview drafts.',
  '预览只能使用当前语言和筛选规则的草稿。':
    'Preview drafts must match the current language and screening rule.',
  每日筛选: 'Daily screening',
  单篇分析: 'Paper analysis',
  研究总结: 'Research summary',
  个性化分析: 'Personal analysis',
  内容复核: 'Content review',
  论文讨论: 'Paper discussion',
  提示词与任务输入: 'Prompts and task inputs',
  '查看 Agent 会收到什么、内容来自哪里，以及哪些要求可以修改。':
    'See what the agent receives, where it comes from, and which instructions you can edit.',
  提示词与输入: 'Prompts and inputs',
  发送预览: 'Input preview',
  运行记录: 'Run history',
  运行环境: 'Runtime',
  使用当前模型设置: 'Use current model settings',
  预览资料: 'Preview material',
  示例资料: 'Example material',
  未命名任务: 'Untitled task',
  载入可选的真实任务资料: 'Load recorded task sources',
  示例中选择个人知识范围: 'Include a personal knowledge scope in the example',
  '所选任务资料 + 当前草稿；这是重新组合预览，不是历史输入。':
    'Selected task sources + current drafts. This is a recomposition, not the historical input.',
  '旧记录没有工具定义，本预览使用当前工具与输出协议重新组合。':
    'This legacy record has no tool definitions. The preview uses the current tools and output contract.',
  '示例资料 + 当前草稿；只展开，不调用模型。':
    'Example material + current drafts. Assembly only; no model call.',
  保存当前组合并启用: 'Save and activate this composition',
  '本次保存：{0}': 'Saving: {0}',
  '共用提示词的修改会影响当前语言的全部任务。':
    'Changes to shared instructions affect every task in this output language.',
  'Agent 输入组成': 'Agent input composition',
  自动加入的输入: 'Automatically included inputs',
  未选择运行环境: 'No runtime selected',
  启动时: 'At start',
  运行中: 'During execution',
  已加入: 'Included',
  未加入: 'Omitted',
  满足条件后加入: 'Included when triggered',
  已准备: 'Prepared',
  已完成: 'Completed',
  失败: 'Failed',
  已中断: 'Interrupted',
  旧记录: 'Legacy record',
  可编辑: 'Editable',
  只读: 'Read only',
  共用提示词: 'Shared instructions',
  本次筛选规则: 'Selected screening rule',
  本次任务参数: 'Task parameters',
  当前问题与所选内容: 'Current question and selected content',
  论文资料: 'Paper material',
  所选个人知识: 'Selected personal knowledge',
  '已有分析、讨论与笔记入口': 'Prior analysis, discussion and note references',
  输出结构与校验要求: 'Output structure and validation',
  可用工具的完整定义: 'Full available tool definitions',
  运行环境加入的内容: 'Runtime additions',
  工具返回与校验反馈: 'Tool results and validation feedback',
  仅加入本次选中的筛选规则: 'Only the selected screening rule is included',
  '当前生成语言；留空时不加入': 'Current output language; omitted when empty',
  当前任务与生成语言: 'Current task and output language',
  '当前语言的共用提示词为空，本次不加入':
    'Shared instructions in this language are empty and are omitted',
  示例任务表单: 'Example task form',
  '任务表单 / 订阅设置': 'Task form / subscription settings',
  '当前任务 / 讨论': 'Current task / discussion',
  固定版本论文的元数据与摘要: 'Fixed paper version metadata and abstract',
  '启动时提供实际资料；正文通常在工具调用后追加':
    'Initial material is included at start; body passages are usually added by tool calls',
  本次所选知识范围: 'Selected knowledge scope',
  仅提供本任务选择的范围及已返回资料:
    'Only this task’s selected scope and returned material are supplied',
  当前论文与讨论: 'Current paper and discussion',
  '入口和正文分别标注；正文在读取后加入':
    'References and full text are distinguished; text is added when read',
  应用的结果接口: 'Application result interface',
  本任务实际注册的工具: 'Tools registered for this task',
  'Paper Radar 运行环境适配层': 'Paper Radar runtime adapter',
  实际工具调用: 'Actual tool calls',
  '调用后加入；在运行记录中查看实际内容':
    'Added after a tool call; inspect actual content in run history',
  '输出字段与章节结构由程序校验；提示词不能覆盖这些约束。语言、长度和知识范围在任务设置中修改。':
    'Output fields and section structure are validated by the application. Prompts cannot override them. Change language, length and knowledge scope in task settings.',
  '修改入口：{0}': 'Edit in: {0}',
  每日筛选的订阅设置: 'daily screening subscription settings',
  单篇任务的输入设置: 'single-paper task input settings',
  任务中的个人知识范围选择: 'the task’s personal knowledge scope selector',
  论文讨论的消息与内容选择: 'paper discussion messages and selected content',
  '查看实际消息、工具和结果接口':
    'Inspect messages, tools and result interfaces',
  消息: 'Messages',
  工具定义: 'Tool definitions',
  运行环境的完成回执格式: 'Runtime completion receipt format',
  '展示 Paper Radar 提供给运行环境的内容；模型服务内部指令与未开放的压缩内容不可获取。':
    'Shows content Paper Radar supplies to the runtime. Provider-internal instructions and undisclosed compaction content are unavailable.',
  运行环境已接收输入: 'Runtime received input',
  工具调用: 'Tool call',
  工具返回: 'Tool result',
  工具或校验反馈: 'Tool or validation feedback',
  追加消息: 'Additional message',
  上下文压缩: 'Context compaction',
  切换备用模型: 'Fallback model restart',
  记录不完整: 'Incomplete recording',
  刷新记录: 'Refresh history',
  '查看当时保存的输入与追加内容；后续提示词修改不会改变历史记录。最近保留 30 次运行输入。':
    'Inspect the recorded inputs and additions. Later prompt edits do not change history. The most recent 30 run inputs are retained.',
  '正在读取运行记录…': 'Loading run history…',
  '当前任务和语言暂无运行记录。新任务执行后会在这里显示。':
    'No runs for this task and language yet. New executions will appear here.',
  选择运行记录: 'Select a run',
  '正在读取运行输入…': 'Loading recorded inputs…',
  '旧记录仅保存了初始提示词；当时的工具定义、运行环境补充和工具返回未记录。':
    'Legacy records contain initial prompts only. Tool definitions, runtime additions and tool results were not recorded.',
  查看当时的初始提示词: 'Inspect original initial prompts',
  启动输入与版本快照: 'Initial input and version snapshot',
  '记录达到存储上限，部分运行内容未保存。':
    'The recording limit was reached; some runtime content was not saved.',
  '此内容已返回运行环境；后续是否进入模型请求由运行环境管理。':
    'This content was returned to the runtime, which controls its inclusion in subsequent model requests.',
  '此消息已加入运行环境的消息队列。': 'This message was queued in the runtime.',
  '运行环境已接收这些内容。': 'The runtime accepted this content.',
  加载更多记录: 'Load more events',
  '此页已保存应用侧输入；当前运行环境尚未提供接收确认记录。':
    'Application inputs were recorded, but the runtime has not supplied a receipt event.',
  '运行输入记录不存在或已过期。': 'The run input record is missing or expired.',
  '请选择当前任务和语言的运行记录。':
    'Choose a run for the current task and language.',
  '该记录未保存可重新组合的任务资料。':
    'This run has no saved material available for recomposition.',
  '请选择支持的运行环境。': 'Choose a supported runtime.',
  '知识范围条件无效。': 'Invalid knowledge scope condition.',
  '运行记录分页位置无效。': 'Invalid run history cursor.',
  '请选择不重复的提示词修改。': 'Choose distinct prompt edits.',
  刷新可选资料: 'Refresh available sources',
};
