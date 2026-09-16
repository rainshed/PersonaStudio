export const personaUiCatalog: Record<string, string> = {
  'AI Persona 连接状态': 'AI Persona connection status',
  '正在检查连接…': 'Checking connection…',
  连接状态暂不可用: 'Connection status unavailable',
  '尚未连接个人知识库，请前往设置连接 AI Persona。':
    'Your knowledge library is not connected. Connect AI Persona in Settings.',
  '暂时无法确认连接状态，请重试或检查连接设置。':
    'Unable to confirm the connection. Retry or check connection settings.',
  去连接: 'Connect',
  连接设置: 'Connection settings',
  已查阅知识与材料: 'Knowledge and materials consulted',
  'Persona 查询记录': 'Persona query record',
  原始资料图片: 'Original source image',
  '查询结果不属于所选范围。': 'The query result is outside the selected scope.',
  '查询结果的 Persona 版本已变化。':
    'The Persona version of the query result has changed.',
  '记录不属于所选标签范围。': 'The record is outside the selected tag scope.',
  '记录版本已变化。': 'The record version has changed.',
  '来源文件版本已变化。': 'The source file version has changed.',
  '检索结果不属于指定来源。':
    'The search result is outside the requested sources.',
  '返回内容不属于指定文件。':
    'The returned content does not belong to the requested file.',
  '当前 Persona 连接没有提供查询接口。':
    'The current Persona connection does not provide query tools.',
  '原始运行没有保存这项查询的结果；固定回放不能读取当前 Persona。':
    'The original run did not save this query result. Frozen replay cannot read the current Persona.',
  'persona_evidence_ids 只能使用已返回的 source_ref 或 citation_ref。':
    'persona_evidence_ids must use a returned source_ref or citation_ref.',
  '宿主未提供图片附件读取能力。':
    'The host does not provide image attachment support.',
  已连接: 'Connected',
  '连接 AI Persona': 'Connect AI Persona',
  '连接你的本机知识库，为论文推荐提供个人知识背景。':
    'Connect your local knowledge library to personalize paper recommendations.',
  '本机连接在运行 Paper Radar 的电脑上配置。演示页面不读取本机知识库。':
    'Configure the connection on the computer running Paper Radar. This demo does not access your local library.',
  已配置: 'Configured',
  尚未配置: 'Not configured',
  当前知识库: 'Current library',
  '等待切换到：{0}': 'Waiting to switch to: {0}',
  '排队和运行中的任务完成后自动生效，期间继续使用当前连接。':
    'The change takes effect after queued and running tasks finish. The current connection remains in use until then.',
  取消这次修改: 'Cancel pending change',
  以下订阅需要重新选择知识标签:
    'Choose knowledge tags again for these subscriptions',
  '相关订阅和自动推荐已暂停。选择新标签并重新启用后即可继续。':
    'These subscriptions and automatic recommendations are paused. Select new tags and enable them again to continue.',
  连接名称: 'Connection name',
  知识库位置: 'Library location',
  '填写 AI Persona 文件夹的完整路径': 'Full path to the AI Persona folder',
  '选择包含 persona-data 和 persona-state 的文件夹。路径属于运行 Paper Radar 的电脑，手机访问时也一样。':
    'Use the folder containing persona-data and persona-state on the computer running Paper Radar, even when visiting from a phone.',
  'AI Persona 程序位置': 'AI Persona executable',
  留空以自动查找: 'Leave blank to detect automatically',
  '通常无需修改；自动识别失败时，填写 ai-persona-mcp 程序的完整路径。':
    'Usually detected automatically. If needed, enter the full path to the ai-persona-mcp executable.',
  测试连接成功: 'Connection test passed',
  '已读取 {0} 个可用标签。': 'Read {0} available tags.',
  '连接成功，知识库尚无可用标签。': 'Connected. This library has no tags yet.',
  '这是另一个知识库。生效后，原知识库的相关订阅将暂停并需要重新选择标签。':
    'This is a different library. Related subscriptions will pause when the change takes effect and will need new tag selections.',
  '受影响的订阅：{0}': 'Affected subscriptions: {0}',
  测试连接: 'Test connection',
  '正在测试连接…': 'Testing connection…',
  保存并连接: 'Save and connect',
  '测试成功后即可保存。用于推荐的标签仍在订阅或单篇分析中选择。':
    'Save after a successful test. Choose recommendation tags in each subscription or paper analysis.',
  放弃修改: 'Discard changes',
  '已取消待生效的连接修改。': 'Pending connection change cancelled.',
  '设置已保存，等待当前任务完成后生效。':
    'Settings saved. Waiting for existing tasks to finish.',
  '连接已保存并生效。': 'Connection saved and active.',
  '连接设置已更新。': 'Connection settings updated.',
  '正在读取连接设置…': 'Loading connection settings…',
  重新读取: 'Reload',
  '无法读取 Persona 设置。': 'Could not load Persona settings.',
  '连接操作未完成，请重试。':
    'The connection operation did not finish. Please try again.',
  '知识库连接已更换，请重新选择标签并启用订阅。':
    'The library has changed. Choose new tags and enable this subscription again.',
  '请检查连接名称、知识库位置和程序位置。':
    'Check the connection name, library location and executable path.',
  '请填写这台电脑上的完整本机路径。':
    'Enter a full local path on this computer.',
  '知识库位置无效，请选择包含 persona-data 和 persona-state 的 AI Persona 文件夹。':
    'Invalid library location. Choose the AI Persona folder containing persona-data and persona-state.',
  '请选择名为 ai-persona-mcp 的 AI Persona 程序。':
    'Choose the AI Persona executable named ai-persona-mcp.',
  '未找到可运行的 AI Persona 程序，请检查程序位置。':
    'Could not find a runnable AI Persona executable. Check its path.',
  选择文件夹或输入完整路径: 'Choose a folder or enter its full path',
  选择文件夹: 'Choose folder',
  选择程序: 'Choose executable',
  '选择包含 persona-data 和 persona-state 的 AI Persona 文件夹，也可以输入完整路径。':
    'Choose the AI Persona folder containing persona-data and persona-state, or enter its full path.',
  '选择 ai-persona-mcp 文件（通常在 .venv/bin 内），也可以输入完整路径；留空时自动查找。':
    'Choose the ai-persona-mcp file (usually in .venv/bin), or enter its full path. Leave blank to detect automatically.',
  '选择窗口会在运行 Paper Radar 的电脑上打开。':
    'The picker opens on the computer running Paper Radar.',
  '此系统暂不支持选择窗口，请输入完整路径。':
    'The picker is not available on this system. Enter the full path instead.',
  '请选择知识库文件夹或 AI Persona 程序。':
    'Choose a library folder or the AI Persona executable.',
  '已有一个选择窗口，请先完成或取消选择。':
    'A picker is already open. Complete or cancel that selection first.',
  '选择窗口已超时，请重新选择或输入完整路径。':
    'The picker timed out. Choose again or enter the full path.',
  '无法完成选择，请重试或输入完整路径。':
    'Could not complete the selection. Try again or enter the full path.',
  '请在弹出的系统窗口中选择。': 'Choose a location in the system window.',
  取消选择: 'Cancel selection',
  '原连接配置无法读取，请重新测试并保存本机连接。':
    'The existing configuration could not be read. Test and save the local connection again.',
  '连接设置已改变，请刷新后重新测试。':
    'Connection settings changed. Reload and test again.',
  '连接配置文件已在其他位置修改，请重启 Paper Radar 后重试。':
    'The connection file was changed elsewhere. Restart Paper Radar and try again.',
  '连接设置未能保存，请检查 Paper Radar 数据目录是否可写。':
    'Could not save connection settings. Check write access to the Paper Radar data directory.',
  '知识库位置的内容已变化，请重新测试连接。':
    'The library at this location has changed. Test the connection again.',
  'AI Persona 返回的标签目录无效，请更新后重试。':
    'AI Persona returned an invalid tag directory. Update it and try again.',
  '测试结果已过期或设置已改变，请重新测试连接。':
    'The test expired or the settings changed. Test the connection again.',
  '任务状态暂时不可用，连接将在重新测试后切换。':
    'Task status is unavailable. Test again before switching the connection.',
  '连接未能生效，请重新测试并保存。':
    'The connection could not be activated. Test and save it again.',
  '此服务尚不支持本机连接设置，请更新 Paper Radar。':
    'This service does not support local connection settings yet. Update Paper Radar.',
};
