# Paper Radar · DSH 插件

此插件加载进 DSH（DeepSeek Harness）进程，提供 Paper Radar 查询与业务操作工具、任务卡片，以及应用调用 DSH Agent 的本机通道。

应用管理论文、日报、提示词、知识范围和业务数据。插件使用 DSH 的模型目录与认证；Paper Radar 不管理独立模型账号或 API Key。

0.6.0 移除论文讨论草稿、会话跳转及所有讨论业务操作。插件继续提供论文分析、日报、反馈和证据查询。原有本机讨论数据不删除。

## 开发安装

先从 Paper Radar 根目录运行 `node scripts/setup.mjs --verify`。
插件兼容 DSH `0.1.5-rc.1`。在本目录执行：

```sh
node scripts/install.mjs --runtime-root "/实际 DSH 安装目录/node_modules"
```

安装器将插件与共享协议复制到 `~/.local/share/paper-radar/dsh-plugin/`，核对宿主版本，并备份及更新所选 DSH profile。默认 profile 为 `web`，可用 `--profile` 指定。`--link-only` 仅检查兼容性。

代码和安装步骤使用 DSH 命名。已有安装的 socket 及 wire protocol 继续兼容；旧 `harnessUrl` 配置也可读取，新配置使用 `dshUrl`。

更新插件后，等待当前任务结束再重启 DSH、刷新页面；应用更新后重启本机 Paper Radar 服务。源码安装与测试不会自动执行这些操作。

## 依赖与验证

`src/` 中的代码在宿主进程运行，`scripts/` 提供安装及人工集成验证，`tests/` 提供隔离测试。
共享包 `@paper-radar/host-contract` 只包含通信定义；socket 传输和模型选择实现留在插件内部。

Persona 的六个查询工具与业务服务共享定义。原文图片通过 DSH 的 `attachments` 服务保存并作为图片内容块传给模型；插件和共享包需同时更新。偏好和 Persona 写入接口不提供给论文 Agent。

运行 `npm test` 进行插件测试。真实宿主的验证脚本接受实际宿主路径，会执行其说明中的真实任务；普通安装检查不会调用模型。


[整体架构](../../docs/architecture.md) · [兼容版本](COMPATIBILITY.md) · [历史插件记录](../../docs/archive/dsh/VALIDATION.zh-CN.md)
