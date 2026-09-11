# 接入说明

[English](INTEGRATIONS.md) · [仓库首页](../README.zh-CN.md)

所有接入都是可选的，并且必须指向明确的工作区。安装 AI Persona 不等于授权采集对话、调用模型或自动应用偏好。

## 本地 MCP

Release 提供固定的 stdio 入口：

```sh
ai-persona-mcp --workspace "$HOME/PersonaWorkspaces/main"
```

MCP 客户端可能不会继承交互式终端的 `PATH`。请使用 `command -v ai-persona-mcp` 返回的绝对路径，并保留其他服务配置：

```json
{
  "command": "/Users/you/.local/bin/ai-persona-mcp",
  "args": ["--workspace", "/path/to/your-workspace"]
}
```

本地和远端公共服务都只提供六个只读工具：

| 工具 | 用途 |
| --- | --- |
| `get_knowledge_map`、`search_knowledge`、`get_persona_records` | 查找和读取已审核的知识、课程、材料、关系和个人状态。 |
| `list_source_files`、`search_source_content`、`read_source` | 浏览并读取可见材料来源清单中的文件。 |

查询会严格检查范围，并返回版本与覆盖信息；公共 MCP 不能发布修改。偏好维护与触发、对话接收、提案和审核都属于内部流程。语义搜索使用本地多语言嵌入模型，首次调用可能需要下载模型文件；设置 `AI_PERSONA_SEMANTIC_SEARCH=0` 只会关闭语义通道。

需要辅助配置时，打开「设置 → 应用接入 → 复制 MCP 接入指令」，把生成的内容粘贴给 Codex。指令包含当前工作区和随包的 [MCP 接入指南](../apps/ai-persona/src/ai_persona/static/guides/CODEX_MCP_SETUP.md)。服务自检只确认服务和六个工具，不读取个人记录；仍需从真实客户端完成一次查询。

## Codex Hook

一条 `UserPromptSubmit` Hook 支持两项独立功能：

- 「自动应用偏好」为当前请求选择已审核的全局和场景偏好。
- 「对话学习」把范围内的用户消息持久入队，在后台生成待审核候选。

在「设置 → 应用接入」配置 Codex 来源：

1. 选择指定项目或会话，或者明确选择所有本机 Codex 会话。
2. 决定是否允许读取有界的会话前文。
3. 安装或合并生成的 Hook，并保留其他 Hook。
4. 在 Codex 中审核并信任新增或变化的 Hook。
5. 从真实且符合范围的 Codex 会话发送生成的测试消息。
6. 在「自动功能」中分别启用偏好应用或对话学习。

来源信任、采集、模型处理、学习、偏好应用和每日预算都是独立控制。连接探针不能证明真实宿主已经加载 Hook；配置变化后旧验证会失效。Demo 不安装 Hook，也不采集真实会话。

可使用「复制 Hook 接入指令」交给 Codex 辅助安装。随包的 [Hook 接入指南](../apps/ai-persona/src/ai_persona/static/guides/CODEX_HOOK_SETUP.md)说明合并、信任和真实消息验证。

## 通过 SSH 接入远端 Codex

AI Persona 可以通过 SSH 反向隧道提供带令牌认证的 HTTP MCP 网关。Persona 数据保存在本机，远端客户端和 Hook 通过隧道访问网关。

使用已有 SSH 别名：

```sh
ai-persona remote setup \
  --ssh-host my-server \
  --workspace "$HOME/PersonaWorkspaces/main"
ai-persona remote start
ai-persona remote status
```

示例别名必须替换。默认本机网关端口为 8766，远端端口为 18766；网关端口保持固定，配置前需要确认可用。共享 HOME、容器、登录节点与计算节点分离、非默认解释器及自定义服务管理方式都需要按实际环境验证。

请从真正运行 Codex 的远端进程完成验收：

1. 发现六个 MCP 工具并执行一次读取。
2. 新发一条消息，在本机 Studio 确认 Hook 事件。
3. 如果已启用，分别验证偏好提供与对话学习。
4. 检查隧道重新连接后的行为。

健康检查或手动调用只能证明其中一层正常。登录节点的回环地址不一定等于真实 Codex 容器或计算节点看到的回环地址。

```sh
ai-persona remote stop
ai-persona remote status
```

停止隧道不会删除远端客户端配置。卸载时只移除属于 AI Persona 的条目。

## 从其他设备访问网页

Studio 继续监听回环地址，在前面配置私有 HTTPS 反向代理。启动前将 `AI_PERSONA_PUBLIC_ORIGIN` 设置为准确的外部协议、主机和端口：

```sh
AI_PERSONA_PUBLIC_ORIGIN='https://my-device.example.ts.net:8443' \
  ai-persona start --no-open --port 8765
```

例如，在已经配置 Tailscale 的机器上：

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8765
tailscale serve status
```

结束后只关闭这一条转发：

```sh
tailscale serve --https=8443 off
```

项目不提供示例中的外部地址，访问权限由代理或 tailnet 规则控制。能够访问已授权 Studio 入口的设备可以操作这个单用户工作区；这不是公开多用户托管。网页远端访问与 SSH/Codex 隧道彼此独立。

## Prompt Workbench

评测改进链接可以连接兼容的 Prompt Workbench 服务，默认地址为 `127.0.0.1:4318`。本仓库不包含该应用；工作台不可用时，AI Persona 的数据、人工编辑、模型设置、审核和内置评测仍可正常使用。在其他设备上，`localhost` 指向该设备，而不是运行 Studio 的电脑。
