> 历史设计或验证记录。当前结构与运行方式以 [项目说明](../../../README.md) 为准；独立模型功能已移除。

# 通过 Tailscale 在手机上使用 Paper Radar

手机浏览器通过 Tailscale Serve 连接本机 `127.0.0.1:4317`。UI 与 `/api/` 使用同一个入口；订阅、分析、讨论、模型凭据和 Persona 连接仍由 Mac 上的服务管理。

## 配置入口

1. Mac 和手机连接同一个 Tailscale 网络。
2. 在 Mac 执行 `tailscale status`，确认设备已连接。
3. 在启动 Paper Radar 时设置 `PAPER_RADAR_PUBLIC_ORIGIN`，内容为完整的外部来源地址，例如 `https://my-mac.example.ts.net`。地址必须与手机打开的协议、域名及端口一致，不包含页面路径。

```sh
npm run build
PAPER_RADAR_PUBLIC_ORIGIN='https://my-mac.example.ts.net' npm run start:local
```

已有服务占用 4317 时，应重启原服务使环境变量生效，不能另开一个进程同时使用同一份数据库。

4. 在另一终端配置转发：

```sh
tailscale serve --bg http://127.0.0.1:4317
tailscale serve status
```

首次使用可能需要在命令给出的 Tailscale 管理链接登录并启用 Serve/HTTPS。启用完成后，确认 `serve status` 显示 HTTPS 地址及指向 `http://127.0.0.1:4317` 的代理，再在手机浏览器打开该地址。

使用 Serve 的私有网络入口；访问权限遵循 tailnet 的访问规则。本应用是单用户服务，没有独立的用户登录系统，能够访问入口的设备可以操作应用。仅将访问权授予需要使用本应用的账号/设备。

## 访问校验

- 未设置 `PAPER_RADAR_PUBLIC_ORIGIN` 时，只接受原有本机地址。
- 设置后，额外接受该来源的精确 Host 与 Origin；不信任请求提供的 `X-Forwarded-*`，不使用通配符。
- 代理保留外部 Host 或将其重写为本机目标 Host 时均可工作。
- 写入请求仍需 `X-Paper-Radar: 1` 和 JSON Content-Type，跨站来源仍被拒绝。
- HTTP 来源也可显式配置，用于有需要的 Tailscale 私有 HTTP 转发；协议及端口仍须精确匹配。

## 当前 Mac 的后台服务

后台任务配置位于 `~/Library/LaunchAgents/com.paper-radar.local.plist`，包含入口环境变量、Node 绝对路径、项目工作目录和日志路径。它在用户登录后启动，退出后由 launchd 重启。首次从后台访问 iCloud 中的项目时，可能需要解锁 Mac 并处理文件访问提示。

查看状态：

```sh
launchctl print "gui/$(id -u)/com.paper-radar.local"
curl http://127.0.0.1:4317/api/capabilities
```

修改后台配置后重新加载（会中断正在执行的任务，先确认任务已结束）：

```sh
launchctl bootout "gui/$(id -u)/com.paper-radar.local"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.paper-radar.local.plist"
```

日志位于 `~/.local/state/paper-radar/server.log` 和 `server-error.log`。前端修改后需要重新运行 `npm run build`；后端修改后需要重启服务。升级或移动 Node、移动项目目录时，也要更新 plist 中的绝对路径。

`tailscale serve --bg` 只保持转发，不负责启动 Paper Radar。Mac 必须开机、联网并保持唤醒；锁屏和系统睡眠是不同状态。建议接电使用；合盖或系统睡眠会导致远程不可用。后台任务在登录后运行，不保证重启后尚未登录时可用。

## 手机验收

连接 Tailscale 后打开命令输出的 HTTPS 地址，依次检查：能读取真实订阅和历史、能保存订阅设置、能打开单篇分析及讨论界面。实际生成分析或发送问题会使用已配置的模型。

若出现 403，核对手机地址与后台 `PAPER_RADAR_PUBLIC_ORIGIN`，以及修改后是否重启。若无法连接，先检查 Mac 是否唤醒、两端 Tailscale 是否在线、`serve status` 是否有配置，以及本机 capabilities 接口是否正常。

实现验证包含默认本机访问、外部读写路由、代理 Host 的两种形式、跨站/伪造来源拦截及来源配置校验；相关测试为 `tests/remote-access.test.mjs`。

参考：[Tailscale Serve 命令](https://tailscale.com/docs/reference/tailscale-cli/serve)、[Serve 启用说明](https://tailscale.com/docs/features/tailscale-serve)。
