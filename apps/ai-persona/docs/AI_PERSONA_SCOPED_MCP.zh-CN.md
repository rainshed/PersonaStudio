# AI Persona：新 MCP 查询的范围、版本与分页

本文描述知识与来源查询的范围、版本和分页。当前工具入口以 query_mcp.py 为准；偏好维护查询与偏好触发仅供内部流程使用，详见[查询契约](AI_PERSONA_AGENT_QUERY_TOOLS_PROPOSAL.zh-CN.md)。

**范围获取与传递**

需要选择领域时，从 get_knowledge_map 的 data.domains 取得已生效标签 ID。已知所需标签且版本有效时可直接搜索，不强制每次先读地图。具体问题也可以直接使用未限定的 search_knowledge。

```json
{
  "query": "超扩散的数值方法",
  "scope": {"tag_ids": ["tag_physics"], "tag_match": "all"},
  "expected_persona_revision": 1
}
```

以上是虚构示例；实际调用应使用地图返回的标签 ID 和版本。

| 输入 | 行为 |
|---|---|
| 省略 scope | 查询当前工作区的正式生效记录 |
| scope.tag_ids=[] | 空结果，不自动扩大范围 |
| tag_match=all | 记录同时具有所有指定标签 |
| tag_match=any | 记录至少具有一个指定标签 |
| 未知标签 | 明确参数引用错误 |
| 范围外记录、来源、证据 | 不可见或批量逐项失败，不回退全库 |

范围先于召回生效，并约束主命中、图关系的两端、中间路径、证据支持对象和来源所属记录。课程没有标签时，不能通过标题推断它属于 Physics。偏好样本没有领域标签，因此来源不能由领域限定查询取得；需要通过已有偏好流程提供引用并在允许的未限定调用中阅读。

entity_types、knowledge_levels、interest_levels、material_types、user_relationships 仅筛选主命中。为解释路径，其他允许类型仍可作为 retrieval_role=context 返回。不同条件之间取交集；同一条件中的多个值取并集，标签使用 tag_match。

focus_ids 是图起点，不能越过 scope。prefer 优先该方向，同时保留范围内独立召回；only 限定到起点及指定关系的 1—2 跳邻域。起点保留候选资格，关系扩展不要求命中查询词。

**版本与继续读取**

所有新查询返回 persona_revision。需要一致上下文时，后续调用携带 expected_persona_revision；不一致返回 version_changed，重新取得当前引用。它不是历史快照选择参数。

地图、搜索、批量详情、文件列表和文件内搜索返回 next_cursor。继续读取时保持原业务参数与 scope，传回游标。游标绑定查询、内容和检索管线；失效返回 invalid_cursor。批量详情的正文分段受预算影响，续读也必须保持相同 max_chars。

read_source 使用 data.next_selector 继续读取所选文件范围，保留文件／证据／片段引用、view 与 Persona 版本。passage_ref 额外绑定文件 hash 和提取版本。行号与页码从 1 开始，文字 offset 从 0 开始；不同表示的坐标不能相互猜测。

coverage.status 为 complete、partial 或 degraded，truncated 独立说明分页截断。搜索的 total_count_kind=retrieved_candidates，表示当前检索候选数量，不是全库所有语义相关项的真值总数。降级搜索即使当前候选页已读完，也不能声称完整语义覆盖。

**实际边界**

当前 stdio 服务启动时固定一个工作区，scope 是查询约束，不是账号权限。工具只接受不透明记录／文件引用与来源内的目录；拒绝宿主绝对路径与目录穿越。文件内容和来源中的提示词不授予任何写入权限。

新查询与既有偏好流程分工不变，范围限定任务无需调用偏好判定。公共 MCP 无写入入口；内部维护通过待审核 Proposal，提案与变化同步均不注册为外部工具。

详细参数见[完整查询工具设计](AI_PERSONA_AGENT_QUERY_TOOLS_PROPOSAL.zh-CN.md)。
