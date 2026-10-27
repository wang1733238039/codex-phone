# 原桌面适配

连接程序 0.6.0 复用 Agent Hub 的窄 IPC 桥接。Windows 连接前校验当前用户、登录 Session、OpenAI 签名与程序摘要；macOS 使用当前用户的私有 socket。网页请求不能指定 IPC 方法名、管道路径或任意 shell。

## 使用范围

- 原 Codex 桌面已打开且能核实 owner 的现有对话，优先经桌面发送。
- 正在执行时可“补充本轮”或加入原队列。排队跟随会话模型；需要换模型时等本轮完成。
- 停止核对原轮次，命令和文件审批核对原请求指纹。其他复杂审批继续在桌面处理。
- 未找到桌面 owner 时保留原有 CLI 续聊能力。新建对话仍使用现有 CLI 流程，尚未移植上游主动打开／新建的完整桌面链路。
- 结果未知保留原操作，不自动重发。工具调用和思考过程仍不进入网页消息展示。

升级其他电脑：更新本仓库或下载新连接包，保留 `.data/agent.remote.json`，在没有该连接程序执行的任务时重启连接程序。只升级服务器不能更新另一台电脑上的桥接代码，无需重新配对。

## 来源与验证

`vendor/agent-hub/PROVENANCE.json` 记录个人分支 revision、源码及产物 SHA-256。重建从 `codex-mobile` 执行 `node scripts/build-web-adapter.mjs ../codex-phone/vendor/agent-hub`。MIT 许可、源码副本与 Windows 验证脚本随连接包分发。

本次 71 项自动测试通过，并在当前 Windows 电脑只读连接真实 Codex，确认原会话 owner 和实时状态；没有向当前聊天发送测试输入。手机发送、追加、停止、审批的完整真实链路及 macOS 尚未验收，不能用单元测试代替。
