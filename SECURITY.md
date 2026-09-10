# Security

AI Persona is a local, single-user application. Its browser interface does not provide separate user accounts or tenant isolation. A device that can reach an authorized Studio origin can operate that workspace. Keep the default loopback binding; configure remote access deliberately using the [integration guide](docs/INTEGRATIONS.md).

## Data and model connections

- Keep personal workspaces and model credentials outside this repository.
- Manual edits are explicit user actions. AI and MCP proposals require human review before becoming effective records.
- Conversation capture, learning, source trust, and preference application are separate controls. Installing the application does not authorize collecting conversations.
- Model requests may send selected input, source material, or context to the provider you configure. Connection tests also make real requests. Local semantic retrieval uses a local embedding model after downloading its model files.
- Backups can contain private sources, conversations, drafts, and feedback. Treat them as personal data; repository sharing is not a backup strategy.
- Do not attach tokens, complete logs, model-store files, workspace archives, or real conversation exports to public issues.

## Reporting a vulnerability

If this repository has GitHub private vulnerability reporting enabled, use **Security → Report a vulnerability**. If that option is unavailable, ask the maintainers for a private reporting channel in a public issue without including exploit steps, credentials, or private data. No private email address or response-time commitment is declared in this repository.

A useful private report describes the affected revision, operating system, minimal reproduction using fictional data, expected boundary, and observed result. Report compromised provider credentials to the provider and rotate them through its normal account controls.

Only the current development revision is maintained here; a release support policy has not been established.

## 中文说明

本应用面向本地单用户使用，不提供多用户隔离。个人工作区、模型凭据、含私人内容的日志和备份不能提交到公共仓库。模型调用可能将所选输入发送给你配置的提供方；对话采集、学习与来源信任需要分别开启。

发现漏洞时，优先使用仓库已启用的 GitHub 私密漏洞报告功能；如果没有该入口，可公开询问维护者的私密报告渠道，但不要公开漏洞利用细节、凭据或私人数据。
