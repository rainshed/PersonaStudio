# Paper Radar 应用

本目录包含网页界面和本机业务服务，由 PersonaStudio 仓库统一管理。

首次安装请在 PersonaStudio 根目录执行 `npm run setup:radar`，然后使用 `npm start` 打开完整应用。
安装后可在本目录执行：

- `npm run dev`：开发网页。
- `npm run build`：构建网页。
- `npm run start:local`：启动本机完整应用，默认端口 4317。
- `npm run check`：类型、代码规范与自动测试。

仅支持 Codex 与 DSH 分析宿主，账号与模型能力由宿主提供。

详细说明见 [项目 README](../README.md)、[架构](../docs/architecture.md) 和 [开发验证](../docs/development.md)。
