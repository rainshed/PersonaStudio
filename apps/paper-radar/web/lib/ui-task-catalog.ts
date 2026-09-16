// System-generated task copy, including saved messages from earlier versions.
// Research text, paper titles and user-provided labels are kept outside this catalog.
export const taskUiCatalog: Record<string, string> = {
  'Codex 已结束回答，但没有调用 Paper Radar 工具提交经过校验的结果。':
    'Codex finished its response without submitting a validated result through a Paper Radar tool.',
  'Codex 调用 Paper Radar 工具 {0} 失败：{1}':
    'Codex failed to call Paper Radar tool {0}: {1}',
  失败: 'Failed',
  已等待: 'Waiting',
  已运行: 'Elapsed',
  '模型调用 {0} 次': 'Model calls: {0}',
  任务通知: 'Task notifications',
  '任务通知，{0} 条未读': 'Task notifications, {0} unread',
  '{0} 条未读': '{0} unread',
  '任务完成、部分完成或失败后，通知会保留在这里。':
    'Completed, partially completed and failed tasks are saved here.',
  全部标为已读: 'Mark all as read',
  暂无任务通知: 'No task notifications yet',
  '可以先去做其他事，结果会保存在这里。':
    'Feel free to move on. Your results will be saved here.',
  更早的通知: 'Older notifications',
  未读: 'Unread',
  查看结果: 'View result',
  查看通知: 'View notifications',
  '{0} 个任务有新结果': '{0} tasks have updates',
  任务已更新: 'Task updated',
  每日初筛: 'Daily screening',
  已暂停: 'Paused',
  '无法更新通知，请重试。': 'Could not update notifications. Please retry.',
  '暂时无法读取通知，正在重新连接。':
    'Notifications are temporarily unavailable. Reconnecting…',
  '无法读取更早的通知，请重试。':
    'Could not load older notifications. Please retry.',
  '无法启用桌面提醒，请检查浏览器设置。':
    'Could not enable desktop alerts. Check your browser settings.',
  开启桌面提醒: 'Enable desktop alerts',
  关闭桌面提醒: 'Disable desktop alerts',
  '当前浏览器不支持桌面提醒，通知仍会保存在这里。':
    'This browser does not support desktop alerts. Notifications will still be saved here.',
  '桌面提醒已被浏览器关闭，可以在浏览器设置中开启。':
    'Desktop alerts are blocked. You can allow them in your browser settings.',
  '桌面提醒需要保持页面打开。关闭页面后，可在回来时查看未读通知。':
    'Keep this page open for desktop alerts. If you close it, unread notifications will be here when you return.',
  报告: 'Report',
  'arXiv 未找到所请求的论文或格式。':
    'arXiv could not find the requested paper or format.',
  'arXiv 暂时无法访问，请稍后重试。':
    'arXiv is temporarily unavailable. Please try again later.',
  获取论文元数据并确认版本: 'Loading paper metadata and verifying its version',
  '读取全文、公式、图注和参考文献':
    'Reading the full text, equations, captions and references',
  'HTML 不可用，正在读取 PDF 正文': 'HTML is unavailable. Reading the PDF text',
  '图像未独立分析；正文、公式与图注已抽取。':
    'The text, equations and captions were extracted. Images were not analyzed separately.',
  '未提取到参考文献，引用匹配可能不完整。':
    'References could not be extracted. Citation matching may be incomplete.',
  '图像未独立分析。': 'Images were not analyzed separately.',
  'PDF 文本抽取；双栏顺序、数学符号与参考文献识别可能不完整。':
    'Text was extracted from the PDF. Column order, mathematical symbols and references may be incomplete.',
  '图像未分析。': 'Images were not analyzed.',
  'Agent 正在分析': 'Agent is analyzing',
  自主分析: 'Agent analysis',
  '此任务属于旧流程，请明确重试；旧结果已保留。':
    'This task uses an earlier workflow. Retry to continue; previous results are saved.',
  '引用、格式和个人事实由程序校验；阅读方式由 Agent 决定，未自动执行独立内容复核。':
    'Citations, format and personal facts are validated automatically. The agent chooses how to read; no independent content review was run.',
  复用相同任务条件下的已有分析:
    'Reusing an analysis with matching task settings',
  '本次模型调用已达到预算，已保存内容保留。':
    'The model call budget was reached. Saved content is retained.',
  'DSH 正在整理上下文': 'DSH is organizing the context',
  'Agent 正在思考': 'Agent is thinking',
  'Agent 正在查阅所选知识与材料':
    'Agent is reading the selected knowledge and materials',
  'Agent 正在查阅论文': 'Agent is reading the paper',
  'Agent 正在查阅讨论记录': 'Agent is reading the discussion history',
  'Agent 正在查阅已有分析': 'Agent is reading previous analyses',
  'Agent 正在整理笔记': 'Agent is organizing notes',
  'Agent 正在核对依据': 'Agent is checking evidence',
  '服务中断，已保存内容保留，可重试。':
    'The service was interrupted. Saved content is retained; you can retry.',
  '超过任务时间预算，已保存内容保留，可重试。':
    'The task exceeded its time budget. Saved content is retained; you can retry.',
  '结构不符合输出协议：{0}':
    'The output structure does not match the required format: {0}',
  '总结有重复段落。': 'The summary contains duplicate paragraphs.',
  '不存在的论文引用：{0}': 'Unknown paper citation: {0}',
  '未取得所选标签下的完整知识点依据。':
    'The complete knowledge evidence for the selected tags was not retrieved.',
  '推荐判断必须引用所选标签下的知识点，材料不能代替知识点。':
    'Recommendations must cite knowledge records within the selected tags. Materials cannot replace knowledge records.',
  '无效论文证据：{0}': 'Invalid paper evidence: {0}',
  '无效或越界的个人证据：{0}': 'Invalid or out-of-scope personal evidence: {0}',
  '个人事实与记录不符：{0}': 'A personal fact does not match its record: {0}',
  '个人事实缺少该记录的引用：{0}':
    'A personal fact is missing a citation to its record: {0}',
  '材料不在范围内：{0}': 'Material outside the selected scope: {0}',
  '材料联系缺少该材料的证据：{0}':
    'A material connection is missing evidence from that material: {0}',
  '直接引用缺少已确认参考文献匹配：{0}':
    'A direct citation has no verified reference match: {0}',
  '交叉证据不存在：{0}': 'Unknown crossover evidence: {0}',
  '交叉需要同时引用论文与个人材料。':
    'Crossovers must cite both the paper and personal materials.',
  接口不存在: 'Endpoint not found',
  '反馈筛选条件无效。': 'Invalid feedback filters.',
  '请先在模型设置中选择单篇分析模型。':
    'Choose a single-paper analysis model in settings first.',
  '此任务使用旧推荐流程，请重试以创建新版分析；旧结果保留。':
    'This task uses an earlier recommendation workflow. Retry to create an updated analysis; previous results are retained.',
  '自动检查用于发现结构、引用和内容问题，不能替代科学事实与新颖性的人工核对。':
    'Automatic checks identify structural, citation and content issues. Scientific accuracy and novelty still require human review.',
  '非空白字符（含标点）': 'Non-whitespace characters (including punctuation)',
  非空白字符: 'Non-whitespace characters',
  个性化分析: 'Personalized analysis',
  '内容核对返回格式无效，请重新生成可核对的分析。':
    'The content review returned an invalid format. Regenerate the analysis for review.',
  'Agent 回调协议不兼容。': 'The agent callback protocol is incompatible.',
  'Agent 任务已关闭。': 'The agent task has closed.',
  '未知 Agent 回调。': 'Unknown agent callback.',
  '模型尝试标识重复。': 'Duplicate model attempt identifier.',
  '论文 Agent 执行未完成。': 'The paper agent did not finish.',
  宿主默认: 'Host default',
  '请启动 DSH 并启用 PaperRadar 插件后再发起分析。':
    'Start DSH and enable the PaperRadar plugin before starting an analysis.',
  'DSH 插件版本不兼容。': 'The DSH plugin version is incompatible.',
  '任务设置已改变，请刷新后重试。':
    'Task settings have changed. Refresh and retry.',
  '任务设置无效。': 'Invalid task settings.',
  '设置版本无效。': 'Invalid settings version.',
  '模型方案设置无效。': 'Invalid model preset settings.',
  '启用备用策略前请选择宿主模型。':
    'Choose a host model before enabling fallback.',
  '此旧任务使用独立模型配置，请保留历史并明确重新发起 DSH 任务。':
    'This older task uses independent model settings. Keep its history and start a new DSH task.',
  '未找到该任务引用的 DSH 模型。':
    'The DSH model referenced by this task was not found.',
  '请按当前宿主设置重新创建 Agent 任务。':
    'Create a new agent task using the current host settings.',
  '请在 DSH 中配置该任务使用的模型。':
    'Configure the model for this task in DSH.',
  '宿主默认思考强度已变化，请明确重新发起任务。':
    'The host default reasoning effort has changed. Start the task again.',
  '宿主默认思考强度已变化，请重新发起任务。':
    'The host default reasoning effort has changed. Start the task again.',
  '内容较多，请缩小分页或打开完整页面。':
    'There is too much content. Use a smaller page size or open the full page.',
  '请求标识已用于其他参数。':
    'This request identifier has already been used with different parameters.',
  '每页最多 25 项，请使用有效分页参数。':
    'Use valid pagination parameters, with up to 25 items per page.',
  '不支持的 PaperRadar 操作。': 'Unsupported PaperRadar operation.',
  '请提供查询得到的业务对象 ID。': 'Provide an object ID returned by a query.',
  '写操作需要稳定的请求标识。':
    'Write operations require a stable request identifier.',
  '此前请求结果待核对，请先查看原业务任务。':
    'The earlier request needs verification. Check the original task first.',
  '对象不存在。': 'Object not found.',
  '证据分页无效。': 'Invalid evidence pagination.',
  'Agent 正在处理问题': 'Agent is working on your question',
  '本轮达到模型调用预算，已保存内容保留，可以重试。':
    'This round reached its model call budget. Saved content is retained; you can retry.',
  '本轮回答中断，已保存依据与笔记保留，可以重试。':
    'The answer was interrupted. Saved evidence and notes are retained; you can retry.',
  材料联系: 'Material connection',
  选中段落: 'Selected passage',
  '所选知识点超过本轮讨论容量，请缩小标签范围。':
    'The selected knowledge exceeds the discussion context capacity. Select fewer tags.',
  自由讨论: 'Open discussion',
  '此讨论保留原有依据；使用新版知识点推荐依据请重新分析论文后发起讨论。':
    'This discussion retains its original evidence. To use updated knowledge evidence, analyze the paper again and start a new discussion.',
  '当前任务缺少初筛 Agent 提示词快照，请重新发起。':
    'This task is missing its screening agent prompt snapshot. Start it again.',
  '读取位置无效。': 'Invalid reading position.',
  '日报已停止。': 'The daily task has stopped.',
  '补读论文版本与初筛版本不一致。':
    'The paper version being read differs from the screened version.',
  正文: 'Full text',
  '知识条目不在本次范围内。':
    'This knowledge record is outside the task scope.',
  '论文章节不存在。': 'Paper section not found.',
  '本任务未开放此工具。': 'This tool is unavailable for the task.',
  '初筛字段格式无效：{0}': 'Invalid screening field format: {0}',
  'paper_evidence_ids 必须使用已提供的 source_ref：{0}':
    'paper_evidence_ids must use a provided source_ref: {0}',
  'persona_evidence_ids 只能使用已读取知识卡片的 source_ref，不能使用卡片 id、evidence_refs 或 supporting_evidence。':
    'persona_evidence_ids must use source_ref from a knowledge card that was read, rather than its id, evidence_refs or supporting_evidence.',
  '筛选标准或覆盖引用无效。':
    'Invalid screening criteria or coverage references.',
  '待确认判断需要列出具体未解决问题。':
    'An undetermined decision must list specific unresolved questions.',
  '尚未取得完整所选知识点。':
    'The selected knowledge has not been fully retrieved.',
  '相同依据下已有未完成判断，请明确重试或进一步阅读。':
    'An unfinished assessment already exists for this evidence. Retry it or request further reading.',
  '自动日报服务不可用。': 'The automatic daily service is unavailable.',
  '该初筛尝试已失效。': 'This screening attempt is no longer valid.',
  '条目编号、公告日期、摘要、分类或类型不完整。':
    'The item identifier, announcement date, abstract, categories or type is incomplete.',
  '来源达到可能的条目上限，尚不能证明覆盖完整。':
    'The source may have reached its item limit. Complete coverage cannot be confirmed.',
  '完整闭合的官方 subject ATOM 响应；全部条目已解析、低于容量阈值且无未解决冲突。来源未提供独立总数，覆盖限于本次公开 feed。':
    'The official subject ATOM response was complete. All items were parsed below the capacity threshold with no unresolved conflicts. No independent total was provided; coverage is limited to this public feed.',
  等待读取公告批次: 'Waiting to read the announcement batch',
  '公告范围与订阅不一致。':
    'The announcement scope does not match the subscription.',
  等待自动初筛: 'Waiting for automatic screening',
  '该论文此前未完成，需明确继续；本次更新不会自动重试。':
    'This paper was not completed earlier. Resume it explicitly; this update will not retry it automatically.',
  '单篇重筛按原任务设置执行，无需附加参数。':
    'Rescreening uses the original task settings; no extra parameters are needed.',
  '请先按当前订阅创建 Agent 初筛批次。':
    'Create an agent screening batch using the current subscription first.',
  '本批仍在运行，请等待或取消后重筛。':
    'This batch is still running. Wait or cancel it before rescreening.',
  等待重新判断所选论文: 'Waiting to reassess the selected paper',
  '这份日报的筛选结果仍被其他日报引用，请先删除引用它的日报。':
    'Other daily reports still reference these screening results. Delete those reports first.',
  读取官方公告并核对候选:
    'Reading official announcements and checking candidates',
  '这批任务使用旧推荐依据；请按新规则重新筛选本批，旧结果和反馈保留。':
    'This batch uses earlier recommendation evidence. Rescreen it using the new rules; previous results and feedback are retained.',
  '筛选：{0}': 'Screening: {0}',
  '本批次初筛已完成；详细分析由你按需开启':
    'Screening is complete. Start detailed analyses as needed',
  '部分完成，请查看待处理项或来源缺口':
    'Partially completed. Check pending items and source gaps',
  '未取得所选标签下的完整知识点。':
    'The knowledge for the selected tags was not fully retrieved.',
  '自动日报服务不可用，请重启后明确继续。':
    'The automatic daily service is unavailable. Restart it, then resume the task.',
  '所有所选分类的公告均未能读取，请稍后重试。':
    'Announcements for all selected categories could not be read. Please try again later.',
  '按所选分类读取官方 ATOM 公告，仅合并同一公告日期的论文，按 arXiv 编号去重。各分类的来源、日期和读取缺口分别记录。':
    'Official ATOM announcements are read for the selected categories. Papers are merged only for the same announcement date and deduplicated by arXiv ID. Each category retains its source, date and reading gaps.',
  'AI Persona 查询响应不符合当前接口，请更新两端后重新连接。':
    'The AI Persona query response is incompatible. Update both applications and reconnect.',
  '当前 AI Persona 未提供所需的新查询接口，请更新 AI Persona 并重新连接。':
    'AI Persona does not provide the required query interface. Update AI Persona and reconnect.',
  '该工具不属于 PaperRadar 的只读查询范围。':
    'This tool is outside the PaperRadar read-only query scope.',
  'Persona 内容已变化，需要重新准备同一标签范围的依据。':
    'Persona content has changed. Prepare fresh evidence for the same tag scope.',
  '材料来源已变化，不能混用旧证据。':
    'The material source has changed. Old evidence cannot be mixed with it.',
  '查询分页已失效，需要重新读取。':
    'The query pagination has expired. Read the results again.',
  '所选标签已失效，请重新选择。':
    'The selected tags are no longer valid. Select them again.',
  '记录或来源不可用，或不在选定范围内。':
    'The record or source is unavailable or outside the selected scope.',
  '查询内容超过读取预算，请缩小范围。':
    'The query exceeds the reading budget. Narrow its scope.',
  'Persona 查询暂时不可用，请稍后重试。':
    'Persona queries are temporarily unavailable. Please try again later.',
  'Persona 查询失败。': 'The Persona query failed.',
  'Persona 返回了不同的标签范围。': 'Persona returned a different tag scope.',
  'Persona 返回了不同版本的内容。':
    'Persona returned a different content version.',
  '所选范围的知识点未完整读取，请缩小标签范围后运行。':
    'The selected knowledge was not fully read. Select fewer tags and run again.',
  '请重新读取标签目录。': 'Reload the tag catalog.',
  'Persona 返回的记录不属于所选标签范围。':
    'Persona returned a record outside the selected tag scope.',
  '所选标签下没有知识点，无法进行个性化推荐。材料不会代替知识点。':
    'The selected tags contain no knowledge records, so personalized recommendations are unavailable. Materials do not replace knowledge records.',
  '部分推荐知识点未能完整读取，请重新准备依据。':
    'Some recommendation knowledge was not fully read. Prepare the evidence again.',
  'Persona 已更新，正在重新读取同一标签下的知识点':
    'Persona was updated. Rereading knowledge under the same tags',
  '请选择推荐依据的知识点标签。':
    'Select knowledge tags for recommendation evidence.',
  完整读取所选标签下的推荐知识点:
    'Reading all recommendation knowledge under the selected tags',
  围绕论文与知识点检索相关关系和材料:
    'Searching related connections and materials for the paper and knowledge',
  '关系图仅使用已返回的邻域，部分关系尚未展开。':
    'The graph uses only returned neighborhoods. Some relations have not been expanded.',
  '部分关系的另一端尚未读取，未用作推荐证据。':
    'The other end of some relations has not been read, so those relations were not used as recommendation evidence.',
  '相关材料检索仅采用本次返回的候选，未遍历全部结果。':
    'Material searches use only the returned candidates. Not all results were examined.',
  '所选知识点没有可用的关联材料来源，本次依据为知识点记录。':
    'The selected knowledge has no available linked material sources. Evidence is limited to knowledge records.',
  '相关材料原文达到本次读取预算，部分内容未读。':
    'Reading the source material reached the budget. Some content remains unread.',
  '通过 Persona 来源接口定位并核对材料原文':
    'Locating and checking original material through the Persona source interface',
  '仅检索部分可读来源文件。': 'Only some readable source files were searched.',
  '原文读取与所选文件或来源哈希不一致。':
    'The source text does not match the selected file or source hash.',
  '相关原文片段未读完，不能视为完整原文。':
    'Relevant source excerpts were not fully read and do not represent the full source.',
  '材料原文按问题读取片段，未阅读全文；未检索标签范围外内容。':
    'Source excerpts were read based on the question. The full text and content outside the tag scope were not searched.',
  'Persona 已更新，本轮保留已保存的旧版依据；补读最新资料请重新分析论文后发起讨论。':
    'Persona was updated. This round retains its saved evidence. Analyze the paper again and start a discussion to read the latest sources.',
  '本任务没有选择个人知识范围。':
    'No personal knowledge scope was selected for this task.',
  '正文尚未读取；当前依据为论文元数据与摘要。':
    'The full text has not been read. Current evidence consists of paper metadata and the abstract.',
  '任务缺少当前自主分析提示词，请重新发起。':
    'The task is missing the current agent analysis prompt. Start it again.',
  '个人事实字段尚未提供：{0}': 'Personal fact field not yet provided: {0}',
  'Agent 没有提交经过接口校验的结果。':
    'The agent did not submit a validated result.',
  '已达到本次任务的模型调用预算，已保存的内容保留。':
    'The task reached its model call budget. Saved content is retained.',
  '无法连接 DSH 的 PaperRadar 插件，请检查宿主是否运行。':
    'Could not connect to the PaperRadar plugin in DSH. Check that the host is running.',
  '论文与个人材料组成的完整提示词超过当前接口长度上限；原样重试无法解决，请缩小材料范围。已完成的部分仍可查看。':
    'The combined paper and personal materials exceed the prompt length limit. Narrow the material scope before retrying. Completed content is still available.',
  '宿主中的 Agent 运行已中断，请查看原任务后明确重试。':
    'The agent run in the host was interrupted. Check the original task, then retry.',
  '本篇 Agent 上下文已达上限，读取进度已保留；原样继续不会解决。':
    'The agent reached the model context capacity. Reading progress is saved; continuing unchanged will not resolve this.',
  '模型输出达到上限，任务结果尚未完成。':
    'The model output was truncated before the result was complete.',
  'Agent 未提交可用的结构化结果。':
    'The agent did not submit a usable structured result.',
  'DSH 返回内容过大。': 'The DSH response is too large.',
  'DSH 请求未完成。': 'The DSH request did not finish.',
  'DSH 插件返回格式不兼容。':
    'The DSH plugin response format is incompatible.',
  '论文版本已变化。': 'The paper version has changed.',
  '知识版本已变化。': 'The knowledge version has changed.',
  '知识记录不在本次范围内。':
    'The knowledge record is outside this task scope.',
  '章节或内容标识不存在。': 'Section or content identifier not found.',
  '该记录没有可读取的来源。': 'This record has no readable source.',
  '材料来源标识不一致。': 'The material source identifiers do not match.',
  '来源文件标识不存在。': 'Source file identifier not found.',
  '检索结果不属于所选来源。':
    'The search result does not belong to the selected source.',
  '来源片段标识不存在。': 'Source excerpt identifier not found.',
  '材料来源版本不一致。': 'The material source versions do not match.',
  '证据不在本次任务中。': 'The evidence is not part of this task.',
  '没有对应的已有报告。': 'No matching saved report was found.',
  '笔记大小或格式无效。': 'Invalid note size or format.',
  '本任务没有此工具。': 'This tool is unavailable for the task.',
  关闭: 'Close',
  '；': '; ',
  '提示词工作台仅支持本机访问。': 'Prompt Workbench is available locally only.',
  '请求未完成。': 'The request did not finish.',
  '模型账号与认证由 DSH 管理，请前往宿主设置。':
    'Model accounts and authentication are managed in DSH. Open the host settings.',
  '正文实际 {0} {1}，目标 {2}–{3}。':
    'Actual length: {0} {1}. Target: {2}–{3}.',
  'paper_version 必须是 {0}。': 'paper_version must be {0}.',
  '{0} 条公告无法完整解析，已保存待核验。':
    '{0} announcements could not be fully parsed and were saved for verification.',
  '{0} 的来源公告为 {1}，与本批 {2} 不同，未混入其他日期的论文。':
    'The source announcement for {0} is dated {1}, unlike this batch ({2}). Papers from other dates were kept separate.',
  '{0} 的公告覆盖尚未确认完整。':
    'Complete announcement coverage for {0} has not been confirmed.',
  '论文 {0} 在所选分类中版本不一致，保留 v{1} 并标记来源缺口。':
    'Paper {0} has different versions across the selected categories. Version v{1} was retained and a source gap was recorded.',
  '论文 {0}v{1} 的跨分类元数据不一致，请核对原文。':
    'Metadata for paper {0}v{1} differs across categories. Check the original source.',
  '并行处理数量必须为 1–{0} 的整数。':
    'Concurrent tasks must be an integer from 1 to {0}.',
  '请选择明确操作。': 'Choose an operation.',
  '通知分页参数无效。': 'Invalid notification pagination.',
  '通知编号无效。': 'Invalid notification identifier.',
  '通知参数无效。': 'Invalid notification parameters.',
  '通知设备标识无效。': 'Invalid notification device identifier.',
  '材料 {0} 没有可检索的文本。': 'Material {0} has no searchable text.',
  '材料 {0} 未找到相关原文片段。':
    'No relevant source excerpts were found for material {0}.',
  '材料 {0} 原文未读取：{1}': 'Source text for material {0} was not read: {1}',
  '实验达到模型调用预算。': 'The experiment reached its model call budget.',
  '初筛 Agent 试跑需要载入一条真实初筛运行记录，以固定论文和知识范围。':
    'Load a real screening run to test the screening agent with a fixed paper and knowledge scope.',
  '试跑引用的历史报告已删除，请重新选择样例。':
    'The report referenced by this test was deleted. Choose another example.',
  '试跑引用的历史讨论已删除，请重新选择样例。':
    'The discussion referenced by this test was deleted. Choose another example.',
  '试跑对应的讨论轮次已不存在。':
    'The discussion round for this test no longer exists.',
  结构化初筛任务: 'Structured screening task',
  推荐严格度: 'Recommendation strictness',
  '任务目标、资料引用与输出约定':
    'Task goal, source references and output contract',
  '分段事实引用了未提供的证据。':
    'Extracted facts cite evidence that was not provided.',
  '此提示词需要真实论文与限定知识工具。可在此编辑、预览并启用；请从日报明确发起新筛选来验证，旧任务继续使用原快照。':
    'This prompt needs real papers and scoped knowledge tools. Edit, preview and enable it here, then start a new daily screening to validate it. Existing tasks keep their original snapshots.',
  '请通过使用此规则的功能进行试跑。':
    'Test this rule through the feature that uses it.',
  '已有两个实验运行中，请等待或取消。':
    'Two experiments are already running. Wait or cancel one.',
  '快照不属于当前提示词。':
    'This snapshot does not belong to the current prompt.',
  '自主任务试跑需要已连接的 DSH 和论文工具。':
    'Agent experiments require a connected DSH and paper tools.',
  '请载入一条真实初筛运行记录；它提供试跑所需的固定论文与知识范围。':
    'Load a real screening run to provide the fixed paper and knowledge scope for this test.',
  '一次实验支持一个或两个版本。': 'An experiment supports one or two versions.',
  '模型连接不存在。': 'Model connection not found.',
  '请先在 Paper Radar 模型设置中配置此任务的模型。':
    "Configure this task's model in Paper Radar settings first.",
  '实验输出上限应为 128–8192。':
    'The experiment output limit must be between 128 and 8192.',
  '实验模型连接已改变，请重新开始实验。':
    "The experiment's model connection has changed. Start a new experiment.",
  '实验输入超过当前模型容量。':
    'The experiment input exceeds the model context capacity.',
  '输出校验失败。': 'Output validation failed.',
  '模型调用未完成。': 'The model call did not finish.',
  '请填写不超过 200 字符的样例名称，预期说明不超过 3000 字符。':
    'Use up to 200 characters for the example name and 3000 for the expected outcome.',
  '评价格式无效。': 'Invalid evaluation format.',
  '请等待实验结束。': 'Wait for the experiment to finish.',
  '接口不存在。': 'Endpoint not found.',
  '提示词 ID 重复。': 'Duplicate prompt ID.',
  '提示词不存在。': 'Prompt not found.',
  '模板字段与当前功能不兼容。':
    'The template fields are incompatible with this feature.',
  '模板必须是文本，每段不超过 50000 字符。':
    'Templates must be text, with no more than 50000 characters per section.',
  '修改说明不超过 500 字符。': 'Change notes must not exceed 500 characters.',
  '模板使用了未声明的变量或共用规则。':
    'The template uses undeclared variables or shared rules.',
  '版本不存在。': 'Version not found.',
  '此版本与当前输入协议不兼容，请基于新默认版本合并修改。':
    'This version is incompatible with the current input contract. Merge your changes into the new default version.',
  '请选择不重复的提示词版本。': 'Choose distinct prompt versions.',
  '启用版本已改变，请刷新后比较再操作。':
    'The active version changed. Refresh and compare before proceeding.',
  '变量必须是 JSON 对象。': 'Variables must be a JSON object.',
  '共用规则出现循环引用。': 'Shared rules contain a circular reference.',
  '共用规则选项无效。': 'Invalid shared rule option.',
  '记录类型无效。': 'Invalid record type.',
  '记录过大，请缩小样例。': 'The record is too large. Reduce the example size.',
  '请先取消实验。': 'Cancel the experiment first.',
  '检查记录不存在。': 'Check record not found.',
  '该操作标识已用于其他参数。':
    'This operation identifier was already used with different parameters.',
  '来源更新记录不存在。': 'Source update record not found.',
  '模型尝试标识已使用。': 'This model attempt identifier is already in use.',
  '过去 24 小时自动调用额度已用完，请调整额度后明确继续。':
    'The automatic call allowance for the past 24 hours is exhausted. Adjust it, then resume explicitly.',
  '自动日报设置无效。': 'Invalid automatic daily settings.',
  '自动日报设置已改变，请刷新后保存。':
    'Automatic daily settings have changed. Refresh before saving.',
  '请检查时间、时区和自动调用额度（1–2000）。':
    'Check the time, time zone and automatic call allowance (1–2000).',
  '启用自动日报前，请先启用订阅并选择 Persona 标签。':
    'Enable the subscription and select Persona tags before enabling automatic daily runs.',
  '设置已改变，请刷新后保存。': 'Settings have changed. Refresh before saving.',
  '自动日报服务正在关闭。': 'The automatic daily service is shutting down.',
  '请先启用订阅。': 'Enable the subscription first.',
  '比较基线不可重建，请检查存档。':
    'The comparison baseline could not be reconstructed. Check the archive.',
  '该日报已删除；如需重新生成，请使用手动生成入口。':
    'This daily report was deleted. Use manual generation to create it again.',
  '订阅范围已改变，请按当前设置手动重新筛选。':
    'The subscription scope has changed. Rescreen manually using the current settings.',
  '过去 24 小时自动调用额度不足，请调整后继续。':
    'The automatic call allowance for the past 24 hours is insufficient. Adjust it before continuing.',
  'Agent 任务标识或回调无效。': 'Invalid agent task identifier or callback.',
  'Agent 输入应是简短任务和资料引用。':
    'Agent input must contain a short task and source references.',
  'Agent 任务标识已使用。': 'This agent task identifier is already in use.',
  'Agent 工具定义无效。': 'Invalid agent tool definitions.',
  '缺少结果提交接口。': 'The result submission interface is missing.',
  '本次结果已经提交。': 'This result has already been submitted.',
  '个性化分析已完成；研究总结经复核仍有错误，待修订。':
    'Personalized analysis is complete. The reviewed research summary still contains errors and needs revision.',
  '自动核对后，验收复核发现科学表述错误。':
    'A subsequent review found scientific inaccuracies after the automatic checks.',
  '{0} 的所选分类公告均不可用，未生成日报。':
    'Announcements for all selected categories on {0} are unavailable. No daily report was generated.',
};
