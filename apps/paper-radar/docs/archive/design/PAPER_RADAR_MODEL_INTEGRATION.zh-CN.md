> 历史设计或验证记录。当前结构与运行方式以 [项目说明](../../../README.md) 为准；独立模型功能已移除。

# Paper Radar 模型接入

版本：0.1 · 2026-09-06

本模块已经实现 Web 配置页面和可独立运行的本地模型服务。在线 Demo 用于体验设置；实际密钥、账号授权和模型调用在本机服务中进行。论文抓取、Persona 检索和每日生成流水线尚未接入该服务。

## 接入平台

| 平台 | 本次提供的认证方式 | 计费与说明 |
|---|---|---|
| OpenAI API | API Key | 开发者平台用量 |
| ChatGPT / Codex | 账号授权 | 账号支持的模型与额度 |
| Claude | API Key | Claude Console 用量；不把 Pro / Max 视为通用 API 额度 |
| Gemini | API Key | Gemini API 套餐和用量 |
| DeepSeek | API Key | 开放平台用量 |
| OpenRouter | API Key、账号授权 | 两种方式均使用 OpenRouter 余额 |
| Kimi 开放平台（国际） | API Key | `https://api.moonshot.ai/v1` |
| Kimi 开放平台（中国） | API Key | `https://api.moonshot.cn/v1` |
| Kimi For Coding | 专用 API Key、账号授权 | `https://api.kimi.com/coding`；Kimi Code 计划与额度 |
| 自定义兼容服务 | API Key、无需认证 | 支持 OpenAI Chat Completions、Responses、Anthropic Messages |

账号授权不等于任何订阅都能充当通用 API。授权和调用能否成功，由平台对该账户、模型及用途的支持决定。开放平台与 Coding 的账户、密钥和用量分别配置。服务以 Paper Radar 标识请求，不伪装其他客户端；平台拒绝时返回明确失败。

模型目录来自固定版本的 Pi，各账户实际权限可能不同。目录不代表已购买权限或剩余额度。未被平台提供的额度和费用显示为未知。目录外模型可通过自定义服务填写模型 ID。

## 用户流程

1. 打开本地 Web UI，进入“模型设置”，添加平台连接。
2. 选择模型，输入密钥或发起账号授权；同一平台可保存多个连接。
3. 点击“测试连接”，实际发送一个简短请求。测试会消耗所选平台的用量。
4. 选择默认连接。可为每日论文筛选、详细研究总结、材料联系与潜在交叉分别覆盖默认连接。
5. 如有需要，明确选择备用连接。默认不启用自动切换；切换后记录实际使用的平台和模型。
6. 可以编辑、删除、断开授权和重新授权。删除连接时同步清除引用它的配置。

授权支持平台跳转、设备验证码和手动验证码。用户可随时取消；未完成会话在 15 分钟后过期。刷新授权凭据由 Pi 处理，保存操作串行执行，避免并发刷新丢失凭据。

## 本地运行

需要 Node.js 22.19 或更新版本。在 `paper-radar/web` 中运行：

```sh
npm install
npm run build
npm run models:start
```

打开 `http://127.0.0.1:4317`。同一个本地进程提供前端静态文件及模型接口，无需额外配置代理。`npm run dev` 只用于前端开发，默认仍显示交互演示。

可设置 `PAPER_RADAR_PORT` 更改端口，`PAPER_RADAR_DATA_DIR` 更改数据目录。默认目录为 `~/.local/share/paper-radar/models`，应保留在本机而非源码或同步目录。

本版本面向单人本地使用，只监听回环地址，并限制请求 Host、Origin 和写入请求头。它没有面向公网的用户登录与多租户隔离；云端实际调用需要单独设计托管凭据、账户隔离及授权回调部署。

## 实现划分

- `lib/model-config.ts`：平台、连接、任务路由、验证与公开字段定义。
- `lib/model-catalog.json`：前端演示用的模型目录快照。
- `components/radar/model-settings.tsx`：统一设置页面，根据是否连接本地服务切换演示与实际操作。
- `server/engine.mjs`：封装 `@earendil-works/pi-ai@0.85.1`，统一文本生成、授权、用量及错误。
- `server/service.mjs`：管理连接、任务路由、测试、授权会话及调用记录。
- `server/store.mjs`：本地加密存储和串行凭据刷新。
- `server/index.mjs`：同源 HTTP 服务。

上层业务只依赖任务名称和统一请求，不绑定某个平台 SDK。服务不会读取 AI Persona 内部存储，也不会自动从其他 CLI 或环境变量借用账号。

## 接口

以下路径均以 `/api/models` 为前缀。写入请求使用 JSON，必须携带 `X-Paper-Radar: 1`，并从本地同源页面发起。

| 方法与路径 | 用途 |
|---|---|
| `GET /config` | 公开连接配置、平台目录、最近调用记录；不返回密钥或授权令牌 |
| `POST /connections` | 保存完整连接配置，API Key 可选；编辑时未提供新密钥则保留原密钥 |
| `POST /remove` | 删除连接、凭据及相关路由引用，参数 `id` |
| `POST /disconnect` | 清除连接的认证，保留配置，参数 `id` |
| `POST /routing` | 保存默认连接、任务覆盖和显式备用连接 |
| `POST /test` | 测试指定连接，参数 `id` |
| `POST /generate` | 按任务路由生成文本 |
| `POST /auth/start` | 开始授权，参数 `id` 为连接 ID |
| `GET /auth/:id` | 查询授权会话状态和当前步骤 |
| `POST /auth/answer` | 提交当前步骤，参数为会话 `id`、`promptId`、`answer` |
| `POST /auth/cancel` | 取消授权，参数 `id` 为会话 ID |

生成请求示例：

```json
{
  "task": "summary",
  "systemPrompt": "根据提供的论文材料生成研究总结，不补造实验结果。",
  "prompt": "由论文流水线准备的论文证据与具体语言、字数要求",
  "maxTokens": 4096
}
```

任务为 `screen`、`summary`、`connections`。成功返回 `text`、`providerId`、`modelId`、`connectionId`、`requestId`、`usage` 和 `stopReason`；发生备用切换时另有 `fallbackFrom`。失败返回经过清理的错误代码及说明，不直接透传可能包含输入或凭据的平台报错。

当前接口返回完整文本。Pi 内部处理平台流式协议，业务层的流式展示、结构化输出验证与任务队列留待论文流水线实现。

## 存储与错误行为

- 在线演示只将公开配置写入独立浏览器存储，不接受真实密钥，不调用平台。
- 本地配置、凭据及调用记录使用 AES-256-GCM 加密；本地目录权限为 0700，密钥文件和数据文件为 0600。解密密钥也存于本机：这不是系统钥匙串，也不能抵御同一系统账户已被控制的情况。
- 同一数据目录只允许一个服务进程。修改平台、认证方式或服务地址会清除旧凭据；运行中的旧配置不能读取修改后连接的新凭据。
- 同时最多运行两个请求；单次平台尝试超时为 120 秒，限流与超时最多自动重试一次。只有用户明确启用备用连接，才对限流、额度不足、平台错误、超时尝试备用连接。认证失败要求重新认证。
- 默认失败直接返回，不把未实现的任务队列描述为“已保留等待”。截断输出、空正文和平台错误不会被标记为成功。
- 保存最近 100 次尝试的时间、任务、实际模型、结果、耗时与用量；页面显示最近 20 次。不保存论文输入、生成正文、密钥或授权验证码到调用日志。

## 已验证与下一步

自动测试覆盖平台目录、输入验证、配置清理、加密持久化、并发凭据更新、任务覆盖、备用切换、授权交互与取消、HTTP 来源限制，以及通过真实 Pi 适配器访问本地模拟模型服务。

没有使用真实平台账户进行端到端认证或付费调用。添加实际账号后，需要逐个测试其模型权限和网络可用性。

下一阶段将论文流水线接入 `generate`：准备论文证据与标签范围内的 Persona 材料，验证输出结构和引用，按用户设定的中英文字数实际计数并修订，再保存版本化结果与独立反馈。模型输出 token 上限不能替代用户要求的总结字数范围。

## 参考

- [Pi 平台接入](https://pi.dev/docs/latest/providers)
- [Pi 自定义平台](https://pi.dev/docs/latest/custom-provider)
- [Pi AI SDK](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)
- [Kimi Code 文档](https://www.kimi.com/code/docs/en/)
- [Kimi Code 常见问题](https://www.kimi.ai/help/kimi-code/faq)
