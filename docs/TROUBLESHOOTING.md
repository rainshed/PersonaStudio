# Troubleshooting / 常见问题

Run `./scripts/ai-persona doctor` from the repository root, or add `--demo` for the isolated Demo. Include relevant, redacted diagnostics when reporting a problem.

| Symptom / 现象 | What to check / 排查 |
| --- | --- |
| `uv` is missing | Install uv and restart the terminal so it is on `PATH`. / 安装 uv 后重新打开终端。 |
| Python package cannot be imported after an editable install | Use the root `./scripts/ai-persona` launcher, which requests a regular installation. For development tests use the documented `PYTHONPATH=src` command. / 普通使用改用根启动器，源码测试按贡献指南运行。 |
| No workspace is configured | Run `setup`, or pass `--workspace` to the required command. Use `--demo` to explore sample data. / 运行设置向导、显式选择工作区，或使用 Demo。 |
| Browser shows an older version | A healthy service for the same workspace is reused. To load changed code, finish its active work and restart that workspace with the root launcher. Global installations and this checkout are separate. / 同工作区健康服务会复用；需要加载新代码时，等任务结束再用根启动器重启该工作区。 |
| Demo or Studio opens on a different port | Without `--port`, `setup` and `start` prefer real-workspace port 8765 or Demo port 8766 and automatically choose an available port if occupied. Follow the opened address or check `status`; another Studio or gateway can keep running. / 未指定端口时会自动避开占用，使用实际打开的地址或查看 status，无需停止其他 Studio 或网关。 |
| An explicit port or `serve` reports a conflict | Choose an available `--port`, or use `start` without `--port` for automatic selection. Explicit ports and foreground `serve` remain fixed. Gateway ports require their own configuration; they do not switch automatically. / 显式端口和前台 serve 保持固定；选择空闲端口，或改用不指定端口的 start。网关端口需单独配置，不会自动切换。 |
| `runtime_missing` | Install Node.js 22.19+ and npm, run `models-install`, then retry. Do not delete model accounts to repair missing dependencies. / 安装合格 Node/npm 并执行模型依赖安装，无需删除账号。 |
| Model authentication or test fails | Check the selected account, model, provider access, and the actual error in Settings. A provider's subscription and API access can differ. / 核对当前连接、模型权限和实际错误。 |
| First semantic search is slow | The local embedding model may be downloading or building the workspace index. Allow a longer client timeout; inspect reported retrieval coverage. / 首次模型下载和索引可能较慢，检查超时与覆盖状态。 |
| Learning is not triggered | Verify the real host application, Hook trust, source scope, learning switch, model-processing setting, and worker state. / 检查真实宿主、Hook 信任、范围、各项开关与后台状态。 |
| Remote web page returns 403 | Match `AI_PERSONA_PUBLIC_ORIGIN` exactly to the external URL and keep the backend behind the configured local proxy. / 核对外部协议、域名、端口与代理。 |
| Prompt Workbench is unavailable | The compatible external service is not bundled. Start your separately installed workbench on the expected local endpoint. / 本仓库不包含工作台应用，需单独运行兼容服务。 |
| Backup or restore refuses an operation | Stop active writers, choose a new archive/destination, and address the reported issue. Do not bypass protection by deleting the source. / 停止写入，选择新目标，按错误信息处理，不删除原数据绕过保护。 |

Studio logs can include personal paths or request details. Inspect them locally with `./scripts/ai-persona logs`, then share only the relevant redacted excerpt. Never attach an entire workspace, model store, or conversation archive to a public issue.

日志可能包含私人路径或请求细节。请本地查看后只分享必要的脱敏片段，不上传整库、模型账号存储或对话备份。

Model setup now includes an in-page environment check and explicit component installer. Use **Settings → Models → Install model components**, or follow [model authentication](MODEL_CONNECTIONS.md) for supported API-key/account-login paths and the final account-owned verification.

### Long material analysis times out / 长材料分析超时

Foreground maintenance and material analysis allow up to 420 seconds per model attempt (480 seconds for the logical request). High reasoning effort and large sources can need longer than the old 180-second material limit. The stage history reports the first content event and duration; a first content event is not a completed result. Continue retries the unfinished stage while reusing valid completed checkpoints. If repeated timeouts persist, reduce reasoning effort in model settings or narrow the source/task. Changing the model configuration can invalidate earlier analysis checkpoints.

前台维护／材料分析单次模型调用最多等待 7 分钟，逻辑请求总预算 8 分钟。材料较长、思考强度较高时，原来的 3 分钟上限可能不足。阶段记录中的首内容事件只表示开始返回，并不表示已形成完整结果。点击“继续分析”重试未完成阶段，复用仍有效的完整检查点；持续超时可降低维护助手的思考强度，或缩小材料／任务范围。更改模型配置可能让旧检查点失效。

New errors outside the viewport are brought into view, including errors inside expandable sections. Maintenance errors appear beside the analysis area. Identical polling updates do not repeatedly scroll the page. / 新错误位于屏幕外时会自动定位；折叠区内的错误会展开显示。维护助手错误放在分析区域附近，相同错误的轮询刷新不会反复滚动。
