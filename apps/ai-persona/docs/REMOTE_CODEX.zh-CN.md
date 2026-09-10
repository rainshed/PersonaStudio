# 在 SSH 远端 Codex 中使用 AI Persona

本指南使用通用示例，不包含任何个人机器配置。Persona 数据保存在本机，远端 Codex 通过令牌认证的 HTTP MCP 与统一 Hook，经 SSH 反向隧道访问本机网关。

## 前置条件

- 本机已有可运行的真实工作区；源码位于 PersonaStudio，使用根 `scripts/ai-persona` 启动器。
- 已有能到达真正运行 Codex 的主机的 SSH 别名；后台重连需要非交互认证。
- 当前安装器面向 POSIX 环境，远端使用 `bash -lc` 与 `/usr/bin/python3`，Python 需满足安装器的 3.11+ 要求。
- 确认实际 Codex 的 `CODEX_HOME`、会话目录、容器或计算节点网络，以及宿主支持的 MCP/Hook 机制。
- 默认本机网关使用 8766，远端使用 18766；网关端口按配置固定，不自动切换，安装隧道时需检查相应端口是否可用。

已有网关或 Studio 运行时，无需停止它们来体验 Demo。未指定 `--port` 的 `setup` 与 `start` 首选真实工作区 8765、Demo 8766，被占用时自动选择空闲端口，同工作区健康服务会复用。显式 `--port` 冲突仍报错，前台 `serve` 保持固定端口行为。

多个远端、共享 HOME、非默认解释器、自定义启动方式或端口冲突，请先使用[详细执行指南](REMOTE_CODEX_AGENT_RUNBOOK.zh-CN.md)进行环境核对。本指南不代表所有集群布局都可以直接安装。

## 安装与启动

以下命令在 PersonaStudio 仓库根目录运行。将 `my-server` 替换为自己的 SSH 别名：

```sh
PERSONA_WORKSPACE="$HOME/PersonaWorkspaces/main"
./scripts/ai-persona remote setup \
  --ssh-host my-server \
  --workspace "$PERSONA_WORKSPACE"
./scripts/ai-persona remote start
./scripts/ai-persona remote status
```

`setup` 会在选定远端安装客户端与接入配置，并保存连接凭据。保留安装前的配置备份和工具返回的实际路径，不把它们提交到公共仓库。已有同名连接或共享配置时先检查，避免覆盖其他接入。

安装后，在真实远端 Codex 的宿主信任流程中检查 Hook。回到本机 Studio 的「设置 → 应用接入」核对来源、范围、前文与信任策略，再按需启用对话学习或偏好应用。这些功能独立开关，不因隧道连通而自动获得授权。

## 验证真正的使用链路

1. 在真实远端 Codex 会话中发现 MCP 工具并完成一次只读查询。
2. 从同一个真实会话发送新的测试请求，在本机确认相应 Hook 事件。
3. 按已启用范围验证偏好匹配及未命中路径，核对本轮上下文。
4. 已启用学习时确认事件入队、来源策略与候选审核流程；同一轮不重复生成事件。
5. 检查一次重新登录或隧道重连后的行为。

健康检查、手动调用客户端和旧的“已验证”状态只能证明局部步骤，不能代替实际 Codex 触发。127.0.0.1 只表示当前网络环境；登录节点连通不代表计算节点或容器中的 Codex 连通。

## 停止与维护

```sh
./scripts/ai-persona remote stop
./scripts/ai-persona remote status
```

默认配置在 `~/.config/ai-persona/remote.json`，可通过 `--config` 选择另一个配置文件。持续运行或多主机接入要按实际系统的服务管理方式配置，并验证来源、端口与账号隔离。停止隧道不会自动移除远端客户端配置；卸除时只移除属于 AI Persona 的条目，保留其他 Hook 与 MCP 服务。

网页手机访问属于另一条链路，详见[远端网页访问](REMOTE_ACCESS.zh-CN.md)。提示词工作台仍为[独立外部服务](../../../docs/INTEGRATIONS.md)。
