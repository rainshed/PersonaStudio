# 从其他设备访问 AI Persona 网页

本指南描述通过本机 HTTPS 代理访问 Studio 的通用配置。AI Persona 保持本地单用户模式：能够访问入口的设备可以操作同一套 Persona。将入口限制给自己的设备和账号。

## 配置来源与后端

本例显式将后端固定在 `127.0.0.1:8765`，让代理目标保持一致。启动前设置 `AI_PERSONA_PUBLIC_ORIGIN` 为外部入口的准确协议、域名与端口，不含结尾斜杠或页面路径：

```sh
# 在 PersonaStudio 仓库根目录执行；替换为自己的入口域名。
AI_PERSONA_PUBLIC_ORIGIN='https://my-device.example.ts.net:8443' \
  ./scripts/ai-persona start --no-open --port 8765
```

显式端口被占用时会报错；可为本应用选择其他空闲端口，并同步修改下方代理目标。普通本地使用中，`setup` 和 `start` 不指定 `--port` 时会自动避开占用，无需停止其他 Studio 或网关；前台 `serve` 仍使用固定端口。

为同一工作区更改外部来源配置时，等任务结束后重启该服务。单纯重新运行 `start` 会复用同工作区的现有健康进程，不能替换其环境变量。数据、附件与模型操作继续在运行 Studio 的机器上处理。

应用检查页面、API、附件和表单的 Host、请求来源与连接端，不把客户端提供的转发头当作身份凭据。JSON 写入仍要求 `X-AI-Persona: 1` 和正确的 Content-Type；普通表单和文件上传保留各自格式。

## Tailscale Serve 示例

在已配置 Tailscale 的本机上，将自己的 HTTPS 入口转发到 Studio：

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8765
tailscale serve status
```

示例 `my-device.example.ts.net` 不是项目提供的地址，需替换成实际主机名。访问权限遵循自己的 tailnet 规则。命令和平台配置参考 [Tailscale Serve 文档](https://tailscale.com/docs/reference/tailscale-cli/serve)。

只关闭这一个端口的转发：

```sh
tailscale serve --https=8443 off
```

不要用全局重置代替单个应用的停止操作，以免删除其他应用的转发配置。其他 HTTPS 代理也应遵守相同的 loopback 后端与精确来源约束。

## 验证与排错

1. 在目标设备连接自己的网络后，打开配置的 HTTPS 入口。
2. 检查概览、知识、材料、偏好、反馈审核、评测与设置页面。
3. 在 Demo 或独立测试工作区验证表单保存、上传预览和附件读取。
4. 若需要 AI，在明确的测试请求中检查模型任务状态与结果。
5. 确认未授权来源被拒绝，并验证休眠或断网后的提示。

```sh
./scripts/ai-persona status
./scripts/ai-persona logs
```

403 通常需要核对 `AI_PERSONA_PUBLIC_ORIGIN` 与访问地址是否完全一致；502 或无法连接时，检查机器是否开机、联网、唤醒，以及 Studio 和代理状态。锁屏与睡眠不同，睡眠或关机会使服务不可用。开机自启动依赖自己的系统服务配置，本仓库不宣称已为你的机器安装或验证该配置。

Prompt Workbench 属于单独运行的本机服务，默认端口 4318；手机的 localhost 并不是运行 Studio 的电脑。远程 Studio 不会把这种本机链接当作可用手机入口。AI Persona 自身的编辑、模型设置、审核和评测继续使用当前 HTTPS 入口。
