# Application guides and design references / 应用文档

For current installation and lifecycle commands, start with the repository's [English guide](../../../docs/GETTING_STARTED.md), [中文指南](../../../docs/GETTING_STARTED.zh-CN.md), and [data management guide](../../../docs/DATA_MANAGEMENT.md). The [compatibility matrix](../../../docs/FEATURE_PARITY.md) is the current page and integration inventory.

## Usage guides / 使用说明

- [Codex material extraction and batch graphs / 材料整理与批量知识图](AI_PERSONA_EXTRACTION_USAGE.zh-CN.md)

- [Model connections and AI maintenance / 模型接入](AI_PERSONA_MODEL_INTEGRATION.zh-CN.md)
- [Conversation learning / 对话学习](AI_PERSONA_CONVERSATION_LEARNING_USAGE.zh-CN.md)
- [Preference application / 偏好应用](AI_PERSONA_PREFERENCE_ACTIVATION_USAGE.zh-CN.md)
- [Let Codex install the local Hook / 交给 Codex 的本机 Hook 安装流程](../src/ai_persona/static/guides/CODEX_HOOK_SETUP.zh-CN.md)
- [Let Codex configure local MCP / 交给 Codex 的本机 MCP 配置流程](../src/ai_persona/static/guides/CODEX_MCP_SETUP.zh-CN.md)
- [Feedback and personal test cases / 反馈与样例](AI_PERSONA_FEEDBACK_BENCHMARK_USAGE.zh-CN.md)
- [Remote Codex / 远端 Codex](REMOTE_CODEX.zh-CN.md)
- [Remote setup runbook / 远端接入执行指南](REMOTE_CODEX_AGENT_RUNBOOK.zh-CN.md)
- [Browser access from another device / 其他设备访问](REMOTE_ACCESS.zh-CN.md)
- [Agent-assisted initialization / Agent 辅助初始化](AI_PERSONA_AGENT_INITIALIZATION_GUIDE.zh-CN.md)
- [Material enrichment workflow / 材料整理流程](workflows/AI_PERSONA_MATERIAL_ENRICHMENT_WORKFLOW.zh-CN.md)

## Architecture and design history / 架构与设计历史

- [Codex material extraction / arXiv 与文件的材料、知识和关系提取（设计参考）](AI_PERSONA_CODEX_MATERIAL_EXTRACTION_DESIGN.zh-CN.md)
- [Batch knowledge graph / 第二阶段：多材料整理与统一知识图（设计参考）](AI_PERSONA_BATCH_KNOWLEDGE_GRAPH_DESIGN.zh-CN.md)
- [Storage and projections / 存储与投影](AI_PERSONA_STORAGE_DESIGN.zh-CN.md)
- [Materials / 材料模型](AI_PERSONA_MATERIAL_DESIGN.zh-CN.md)
- [MCP contract / MCP 契约](AI_PERSONA_MCP_DESIGN.zh-CN.md)
- [Unified maintenance / 统一维护](AI_PERSONA_UNIFIED_MAINTENANCE_DESIGN.zh-CN.md)
- [Studio navigation and review / 界面与审核](AI_PERSONA_STUDIO_UI_DESIGN.zh-CN.md)
- [Product requirements / 产品需求](AI_PERSONA_PRD.zh-CN.md)

The remaining design, requirement, and proposal files are retained as implementation context. They may describe earlier stages or future work; dated observations are not release-validation claims. Use the current usage guides and code when these documents differ. The external Prompt Workbench application is not included; its public boundary is documented in the [integration guide](../../../docs/INTEGRATIONS.md).

其余设计、需求与方案文档保留用于理解实现背景，其中可能包含早期状态或后续规划。带日期的记录不代表本版本已完成验收；存在差异时，应以当前使用指南与代码为准。个人机器的部署日志没有作为公共文档发布。
