// Application notices are translated when rendered, including saved failures.
// Prompt bodies, paper text and user-entered names are not interface copy.
export const runtimeUiCatalog: Record<string, string> = {
  '备份 {0} 数量超过上限。': 'The backup contains too many {0} entries.',
  'Codex 模型 {0} 当前不可用。': 'Codex model {0} is currently unavailable.',
  '数据库迁移未完成：{0}': 'Database migration did not complete: {0}',
  收集历史推荐反馈: 'Collect earlier recommendation feedback',
  章节: 'Section',
  '正确答案：应该推荐': 'Correct answer: recommend',
  '正确答案：不该推荐': 'Correct answer: do not recommend',
  试跑: 'Trial run',
  平衡: 'Balanced',
  生成语言: 'Output language',
  需要全文确认: 'Full text needed to decide',
  超时: 'Timed out',
  已删除: 'Deleted',
  论文摘要: 'Paper abstract',
  参考文献: 'References',
  未选择兴趣范围: 'No interest scope selected',
  暂时无法连接: 'Unable to connect',
  输出结构: 'Output structure',
  引用与用户事实: 'Citations and user facts',
  '论文与 Persona 引用、用户事实':
    'Paper and Persona citations, and user facts',
  '原始证据 ID': 'Original evidence IDs',
  '字数、章节与原始引用': 'Length, sections and original citations',
  材料关系与用户事实: 'Material connections and user facts',
  每日推荐: 'Daily recommendations',
  缺少六个章节: 'Six required sections are missing',
  '每日初筛 Agent（旧协议）': 'Daily screening agent (legacy protocol)',
  从原提示词迁移: 'Migrated from the original prompt',
  恢复评测前配置: 'Restore settings from before the evaluation',
  应用推荐评测配置: 'Apply recommendation evaluation settings',
  推荐评测实验: 'Recommendation evaluation experiment',
  '我的推荐测试集 · 新实验': 'My recommendation dataset · New experiment',
  '请更新并重新启动本机 Paper Radar 服务。':
    'Update and restart the local Paper Radar service.',
  'Persona 返回的知识范围与当前任务不一致。':
    'The knowledge scope returned by Persona does not match this task.',
  '请先在宿主设置中选择单篇分析模型。':
    'Choose a single-paper analysis model in the host settings first.',
  '目前仅支持对已完成的推荐或不推荐判断反馈。':
    'Feedback is available only for completed recommend or do-not-recommend decisions.',
  '原始运行未保存全文，固定回放不能在线补读。':
    'The original run did not save the full text. Fixed-input replay cannot fetch it online.',
  '该历史批次使用旧筛选流程，请重新发起筛选。':
    'This earlier batch used the old screening process. Start a new screening run.',
  '本次测试需要原分析未保存的材料。':
    'This test needs material that the original analysis did not save.',
  '所选 Agent 不存在。': 'The selected agent does not exist.',
  '所选 Agent 暂不可用，请先连接。':
    'The selected agent is unavailable. Connect it first.',
  '请等待实验完成后再应用配置。':
    'Wait for the experiment to finish before applying its settings.',
  '没有可以恢复的应用记录。':
    'There are no previously applied settings to restore.',
  '这个历史实验不支持直接应用，请创建新实验。':
    'Settings from this earlier experiment cannot be applied directly. Create a new experiment.',
  '应用后设置已有新修改，请在设置中选择需要恢复的版本。':
    'Settings have changed since they were applied. Choose the version to restore in Settings.',
  '请先查看将要应用的配置。': 'Preview the settings before applying them.',
  '另一项配置正在应用，请稍后重试。':
    'Other settings are being applied. Try again shortly.',
  '配置预览已过期，请重新查看。':
    'The settings preview has expired. Preview it again.',
  '设置已有变化，请重新查看将要应用的内容。':
    'Settings have changed. Preview the changes again before applying them.',
  '配置未完整应用，部分模型设置未能恢复；请到设置中检查。':
    'Settings were not fully applied, and some model settings could not be restored. Check Settings.',
  '只有已完成的推荐或不推荐判断可以加入测试集。':
    'Only completed recommend or do-not-recommend decisions can be added to the test set.',
  '推荐判断不存在。': 'The recommendation decision does not exist.',
  '重复请求标识对应的反馈内容不同。':
    'This request ID was already used for different feedback.',
  '反馈已在其他页面修改，请刷新后保留并重新提交编辑。':
    'Feedback changed in another page. Refresh, then review and resubmit your edits.',
  '该测试样例已删除，不能通过旧反馈请求恢复。':
    'This test case was deleted. An earlier feedback request cannot restore it.',
  '请输入测试集名称。': 'Enter a test set name.',
  '请选择 1–1000 个样例。': 'Select 1–1,000 cases.',
  '测试集用途无效。': 'The test set purpose is invalid.',
  '测试集包含已撤销或无有效标签的样例。':
    'The test set contains withdrawn cases or cases without valid labels.',
  '同一论文不能同时进入开发集和留出集。':
    'A paper cannot be in both the development and holdout sets.',
  '反馈已修改或撤销，请重新冻结测试集。':
    'Feedback was changed or withdrawn. Save a new test set snapshot.',
  '备份格式无效。': 'The backup format is invalid.',
  '输入快照校验失败。': 'Input snapshot validation failed.',
  '样例格式无效。': 'The case format is invalid.',
  '论文分组与原始论文不一致。':
    'The paper group does not match the original paper.',
  '样例论文与冻结输入不一致。':
    'The case paper does not match the saved input snapshot.',
  '期望标签与明确反馈不一致。':
    'The expected label does not match the explicit feedback.',
  '样例与本机原始判断不一致。':
    'The case does not match the original decision on this device.',
  '样例输入引用校验失败。': 'Case input reference validation failed.',
  '样例修订校验失败。': 'Case revision validation failed.',
  '当前样例修订不一致。': 'The current case revision does not match.',
  '修订输入不一致。': 'The revision inputs do not match.',
  '反馈历史校验失败。': 'Feedback history validation failed.',
  '测试集校验失败。': 'Test set validation failed.',
  '测试集编号与已有内容冲突。':
    'The test set ID conflicts with existing content.',
  '测试集包含重复样例。': 'The test set contains duplicate cases.',
  '测试集成员与原始样例修订不一致。':
    'A test set member does not match the original case revision.',
  '实验草稿格式无效。': 'The experiment draft format is invalid.',
  '评测运行配置校验失败。': 'Evaluation run settings failed validation.',
  '评测明细校验失败。': 'Evaluation result details failed validation.',
  '请选择同一个 tag 范围的测试样例。':
    'Select test cases with the same tag scope.',
  '请选择推荐依据的 tag 范围。':
    'Select the tag scope to use for recommendations.',
  '知识库返回的 tag 范围与测试样例不一致。':
    'The tag scope returned by the knowledge base does not match the test cases.',
  '所选 Agent 暂不可用，请刷新配置或到设置中连接。':
    'The selected agent is unavailable. Refresh the configuration or connect it in Settings.',
  '所选模型不可用，请刷新配置。':
    'The selected model is unavailable. Refresh the configuration.',
  '所选模型不支持这个思考强度。':
    'The selected model does not support this thinking effort.',
  '实验只能修改此测试集使用的提示词。':
    'An experiment can only change prompts used by this test set.',
  '请输入实验名称。': 'Enter an experiment name.',
  '草稿已在其他页面修改，请重新打开。':
    'This draft changed in another page. Open it again.',
  '测试答案无效。': 'The test answer is invalid.',
  '评测接口不存在。': 'The evaluation endpoint does not exist.',
  '评测记录不存在。': 'The evaluation record does not exist.',
  '样例已撤销。': 'This case was withdrawn.',
  '请选择一个或两个候选版本。': 'Select one or two candidate versions.',
  '当前模型宿主不支持推荐评测工具，请切换到支持 Agent 的宿主。':
    'The current model host does not support recommendation evaluation tools. Switch to a host that supports agents.',
  '所选提示词不适用于本次评测任务。':
    'The selected prompt does not apply to this evaluation task.',
  '选择的模型连接不存在。': 'The selected model connection does not exist.',
  '所选 Agent 不支持推荐任务所需的工具。':
    'The selected agent does not support the tools required for recommendations.',
  '调用预算应为 1–20000。': 'The call budget must be between 1 and 20,000.',
  '输出上限应为 128–8192。': 'The output limit must be between 128 and 8,192.',
  'Token 预算无效。': 'The token budget is invalid.',
  '开始回测需要有效预览或幂等请求标识。':
    'Starting an evaluation requires a valid preview or request ID.',
  '重复开始请求的配置不同。':
    'This start request ID was already used with different settings.',
  '预览已过期或设置有变化，请重新预览。':
    'The preview expired or settings changed. Preview again.',
  '本次回测超过一小时。': 'This evaluation exceeded one hour.',
  '样例反馈已修改或撤销。': 'Feedback for this case was changed or withdrawn.',
  '所选模型连接已改变，请重新开始。':
    'The selected model connection changed. Start again.',
  '评测已停止。': 'The evaluation has stopped.',
  '评测预算已耗尽。': 'The evaluation budget has been used up.',
  '候选需要原始运行未保存的全文，不能进行同等输入回放。':
    'The candidate needs full text that was not saved by the original run. Replay with equivalent inputs is unavailable.',
  '用户取消评测。': 'The user cancelled the evaluation.',
  '当前评测不能恢复。': 'This evaluation cannot be resumed.',
  '新的调用预算必须不小于原预算。':
    'The new call budget must be at least as large as the original budget.',
  '新的 Token 预算必须不小于原预算，且不超过二十亿。':
    'The new token budget must be at least as large as the original budget and no greater than two billion.',
  '没有可以安全恢复的未执行项；结果未知的请求请在新运行中明确重试。':
    'No unexecuted items can safely be resumed. Explicitly retry requests with unknown results in a new run.',
  '备份缺少此条结果，保留原测试集分母。':
    'This result is missing from the backup. The original test set count is retained.',
  '服务中断；请明确恢复。已发出但未确认的调用不会自动重发。':
    'The service was interrupted. Resume explicitly; unconfirmed calls will not be sent again automatically.',
  '预算已耗尽；可增加预算后明确恢复。':
    'The budget has been used up. Increase it and resume explicitly.',
  '预算使用宿主计量次数：Codex 按任务轮次，Harness 按模型请求，工具往返不一定等于一次计量。Token 阈值在宿主回报用量后检查，可能跨过一个执行单位。按本次配置读取论文和当前 tag 范围的知识库；保存和预览不调用模型。':
    'The budget uses host-reported counts: task turns for Codex and model requests for Harness. Tool calls do not necessarily count as separate units. Token limits are checked after the host reports usage and may be exceeded by one execution unit. Papers and knowledge in the current tag scope are read using this run’s settings. Saving and previewing do not call a model.',
  '无法启动 Codex，请确认本机已经安装 Codex。':
    'Could not start Codex. Check that Codex is installed on this computer.',
  'Codex 服务已经关闭。': 'The Codex service has stopped.',
  'Codex 请求未完成。': 'The Codex request did not complete.',
  'Paper Radar 不允许此交互请求。':
    'Paper Radar does not allow this interaction request.',
  'Codex App Server 尚未连接。': 'Codex App Server is not connected.',
  'Codex 任务已取消。': 'The Codex task was cancelled.',
  'Codex 请求等待超时。': 'The Codex request timed out.',
  'Codex App Server 无法中断任务，已强制停止。':
    'Codex App Server could not interrupt the task and was forcibly stopped.',
  'Codex 未能完成本次任务。': 'Codex could not complete this task.',
  'Codex 隔离检查未通过，任务没有启动。':
    'Codex isolation checks failed. The task did not start.',
  '请先在 Paper Radar 模型设置中登录 Codex。':
    'Sign in to Codex in Paper Radar model settings first.',
  'Codex 隔离检查未通过：Hook、内置能力或未授权 MCP 工具仍然可用。':
    'Codex isolation checks failed: hooks, built-in capabilities or unauthorized MCP tools are still available.',
  '请登录专用于 Paper Radar 的 Codex 账号。':
    'Sign in to the Codex account dedicated to Paper Radar.',
  '启用备用策略前请选择 Codex 模型。':
    'Choose a Codex model before enabling fallback.',
  '所选模型不支持该思考强度。':
    'The selected model does not support this thinking effort.',
  '该任务不是使用当前 Codex 配置创建的，请明确重新发起。':
    'This task was created with a different Codex configuration. Start it again explicitly.',
  '请在 Paper Radar 中配置该任务使用的 Codex 模型。':
    'Configure the Codex model for this task in Paper Radar.',
  '当前 Codex 账号没有可用模型。':
    'No models are available for the current Codex account.',
  '所选模型不再支持该思考强度。':
    'The selected model no longer supports this thinking effort.',
  'Codex 自主任务缺少 Paper Radar 工具定义。':
    'The Codex agent task is missing Paper Radar tool definitions.',
  'Codex 任务意外请求了未授权的交互。':
    'The Codex task requested an unauthorized interaction.',
  'Codex 任务意外触发了 Hook，任务已停止。':
    'The Codex task unexpectedly triggered a hook and was stopped.',
  '运行环境未提供压缩后的完整上下文。':
    'The runtime did not provide the full compacted context.',
  '工具调用未完成。': 'The tool call did not complete.',
  'Codex 尝试使用 Paper Radar 未授权的内置工具。':
    'Codex attempted to use a built-in tool that Paper Radar did not authorize.',
  'Codex 无法确认任务中断，专属 App Server 已停止。':
    'Codex could not confirm that the task was interrupted. The dedicated App Server was stopped.',
  'Codex 任务超过执行时间预算。': 'The Codex task exceeded its time budget.',
  'Codex 工具回调协议不兼容。':
    'The Codex tool callback protocol is incompatible.',
  'Codex 工具任务已经关闭。': 'The Codex tool task is closed.',
  '结果校验重试次数已达到上限。':
    'The result validation retry limit was reached.',
  '缺少 Paper Radar 工具上下文。': 'Paper Radar tool context is missing.',
  '工具响应过大。': 'The tool response is too large.',
  '该历史任务没有可用的 Agent 宿主，请保留历史并重新发起任务。':
    'No agent host is available for this earlier task. Keep its history and start a new task.',
  '分析宿主设置无效。': 'The analysis host settings are invalid.',
  '分析宿主不存在。': 'The analysis host does not exist.',
  '请选择有效的分析宿主。': 'Select a valid analysis host.',
  '分析宿主设置已改变，请刷新后重试。':
    'Analysis host settings changed. Refresh and try again.',
  '所选分析宿主当前不可用。':
    'The selected analysis host is currently unavailable.',
  '该任务的模型宿主当前不可用，请保留历史并明确重新发起。':
    'The model host for this task is unavailable. Keep its history and explicitly start a new task.',
  '任务已取消。': 'The task was cancelled.',
  '请求内容超过上限。': 'The request exceeds the size limit.',
  '请求格式无效。': 'The request format is invalid.',
  '请求必须为对象。': 'The request must be an object.',
  'PAPER_RADAR_MODEL_BACKEND 只支持 dsh 或 codex':
    'PAPER_RADAR_MODEL_BACKEND only supports dsh or codex',
  '阅读由 Agent 自行决定。': 'The agent decides what to read.',
  '独立 Agent 试跑，不写入论文报告或日报。':
    'An independent agent trial run. It does not write to paper reports or daily recommendations.',
  '自动检查不能代替科学内容与推荐价值的人工判断。缺少原始业务上下文时只执行可验证的检查。':
    'Automated checks cannot replace human judgment of scientific content and recommendation value. Without the original task context, only verifiable checks are performed.',
  '服务已重新启动，请重新运行实验。':
    'The service restarted. Run the experiment again.',
  '内置虚构示例；真实任务可从运行记录载入输入。':
    'A built-in fictional example. Load inputs from run history to use a real task.',
  '自主任务试跑需要已连接的分析宿主和论文工具。':
    'An agent trial run requires a connected analysis host and paper tools.',
  '实验记录未能完整保存，请缩小输入后重试。':
    'The experiment record could not be saved completely. Reduce the input size and try again.',
  '请求内容无效。': 'The request content is invalid.',
  '请选择提示词版本。': 'Select a prompt version.',
  '将原有任务目标迁移到可编辑提示词，保留自定义内容。':
    'Migrate the original task goals into editable prompts while preserving custom content.',
  '模板缺少必要变量或共用规则：{0}':
    'The template is missing required variables or shared rules: {0}',
  '缺少变量：{0}': 'Missing variables: {0}',
  '任务缺少提示词快照，请重新发起。':
    'The task is missing its prompt snapshot. Start a new task.',
  '任务缺少共用规则快照，请重新发起。':
    'The task is missing its shared rule snapshot. Start a new task.',
  '记录达到存储上限；后续内容未保存，不能视为完整记录。':
    'The record reached its storage limit. Later content was not saved, so this record is incomplete.',
};
