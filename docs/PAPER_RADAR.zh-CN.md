# Paper Radar：本机使用与验收

[English](PAPER_RADAR.md) · [PersonaStudio](../README.zh-CN.md)

Paper Radar 已作为 PersonaStudio 的第二个应用迁入本仓库。目前是本机测试版本，尚未制作或发布包含 Paper Radar 的安装包。现有 `install.sh` 和已发布版本仍用于 AI Persona。

## 安装与启动

本阶段正式验证 macOS，需要 Node.js 22.19 或更新版本及 uv。首次从 PersonaStudio 仓库根目录运行：

```sh
npm run setup:radar
npm start
```

安装命令准备 AI Persona、Paper Radar 与插件的锁定依赖，并构建网页；不会把插件装入正在使用的 DSH，也不会创建模型任务。

`npm start` 在后台运行 Paper Radar 并打开浏览器。默认使用端口 4317；默认端口被占用时选择可用端口。重复启动同一数据目录会复用已验证的服务。明确指定被占用的端口时会报错。

```sh
npm run radar -- status
npm run radar -- stop
npm run radar -- doctor
npm run radar -- logs
npm run persona -- start
```

退出浏览器不会停止后台任务。更新本地源码后先完成或取消任务，再停止、重新构建并启动。

## 首次使用

1. **接入 AI Persona**：自动读取已配置的工作区和本仓库中的程序。确认知识库位置，测试连接，再保存。程序路径放在高级连接设置中。
2. **创建订阅**：选择 arXiv 学科分类、Persona 知识标签、报告语言和调用预算。学科分类需要由用户选择。
3. **连接分析工具**：订阅保存后，在工作台连接 Codex 或 DSH，即可生成日报和详细报告。

普通启动直接进入这个流程，没有“体验示例”步骤。已有订阅或研究记录的用户直接进入原工作台。历史用户删除最后一份订阅后，也不会反复进入首次设置。

没有 Persona 时，可以从引导页打开 AI Persona 创建知识库，再返回 Paper Radar。两边的侧栏都提供应用切换入口。Paper Radar 只读取用户所选的知识范围；不会写入正式 Persona 数据。

## 保留的页面与功能

- 每日论文：日期、订阅与推荐结果过滤、批次历史、论文详情和按需详细分析。
- 论文分析：单篇任务、历史记录、结果阅读、来源和证据。
- 我的订阅：多学科范围、标签、语言、长度、预算、归档与自动检查。
- 关注作者：作者列表、已存档公告匹配、最新公告检查。
- 评测与反馈：反馈、测试集、实验配置和评测报告。
- 设置：Codex、DSH、Persona、提示词、语言和数据维护。
- 后台：来源检查、自动调度、任务排队、取消、恢复和通知。

当前版本已下线的论文讨论继续保持下线，历史讨论数据继续保留。历史独立模型任务的查看与重试限制沿用原规则。

## 数据位置与隔离测试

默认继续识别原来的 `~/.local/share/paper-radar/`，研究数据位于其 `data/` 子目录。源码迁移不会自动移动真实数据。原版与新版不能同时写入同一研究数据目录。

要从空白环境测试首次使用，指定独立目录：

```sh
npm run radar -- start --home "$HOME/.local/share/personastudio/paper-radar-review"
npm run radar -- status --home "$HOME/.local/share/personastudio/paper-radar-review"
npm run radar -- stop --home "$HOME/.local/share/personastudio/paper-radar-review"
```

`--home` 隔离研究数据、宿主配置和运行状态。`--data-dir` 仅选择研究数据目录，适合打开已有数据或恢复副本。

## 备份、恢复与诊断

在“设置 → 数据与偏好”中可以：

- 打开本机数据目录。
- 创建并下载备份；运行中的任务完成后才允许备份。
- 验证备份并恢复到新目录，随后单独打开恢复副本。
- 导出诊断信息，仅包含版本、平台、连接状态与记录数量，不包含账号、私人路径、论文、提示词或日志。

备份包含研究数据库、提示词数据库、论文缓存、Persona 连接和首次设置状态。两份数据库使用一致的 SQLite 快照；恢复会校验文件清单、哈希和数据库完整性。备份不包含宿主登录凭据、Persona 知识库本身及浏览器偏好。

恢复不会覆盖当前数据。恢复副本中的自动检查暂停；通过网页单独打开副本时，分析工具使用独立配置，需要重新连接。确认内容后再启用自动检查。

从已下载的备份恢复到自己选择的新目录：

```sh
npm run radar -- restore "/path/to/backup.tar.gz" --data-dir "/path/to/new-data"
npm run radar -- start --data-dir "/path/to/new-data"
```

数据管理与应用启动入口只支持本机访问。现有远端研究页面和访问保护继续保留。

## 开发与检查

```sh
npm run check:radar
```

检查包含应用类型检查、代码规范、业务与界面渲染测试、DSH 插件测试、真实 AI Persona 只读接口联调、生产构建，以及隔离环境中的启动、备份、恢复和重启。Persona 联调在此入口中必须执行，不能因依赖缺失而静默跳过；检查不调用真实模型。

仅改网页时，从 `apps/paper-radar/web` 使用现有开发命令。完整本机功能以构建后的 `npm start` 为准。

可选的静态示例保留供开发使用，通过 `VITE_PAPER_RADAR_MODE=demo` 明确选择；它不属于普通用户的首次使用流程，也不会因为本机服务故障而自动启用。

## 建议的人工验收

1. 空白环境按“接入 Persona → 创建订阅”完成设置，中英文切换正常。
2. Codex 和 DSH 分别执行一篇论文分析及一批推荐。
3. 检查订阅、作者、历史报告、来源、反馈、评测和提示词页面。
4. 检查任务取消、预算暂停和恢复；确认切换默认宿主不改变在途任务。
5. 创建备份，打开恢复副本，核对历史和提示词；确认自动检查保持暂停。

用户验收后再决定统一安装包、版本号和 GitHub 分发；本轮没有上传、创建 Release 或部署在线服务。
