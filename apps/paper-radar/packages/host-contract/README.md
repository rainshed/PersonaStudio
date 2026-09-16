# Paper Radar host contract

应用与 DSH 插件共用的通信协议、能力描述、选择参数校验和结果结构。

此包不连接网络、不读取本机路径、不执行任务、不依赖宿主 SDK。
`transport` 导出稳定协议标识与传输错误结构；`routing` 定义任务标识与选择格式；
`execution` 定义支持的宿主及能力协议版本；`agent-contract` 定义初筛工具和提交结构。

应用传输实现在 `web/server/hosts/transport.mjs`，插件传输实现在
`plugins/dsh/src/transport.mjs`。模型选择优先级由插件实现，执行池与能力装配由应用实现。
现有 wire version 保留以读取历史任务并兼容已安装的 DSH 插件。
