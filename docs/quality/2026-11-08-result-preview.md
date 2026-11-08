# 返回文件与手机阅读验收

版本候选：0.6.12。状态：本地已验证，未部署公网。

## 自动验证

- 113 项 Node 自动测试通过，0 失败、0 跳过。
- `tools/browser-results-check.mjs`：真实临时电脑文件通过 WebSocket → HTTP → 手机尺寸浏览器完成读取；不使用模型、不向用户原会话发消息。
- 验证 Markdown 宽表格全屏阅读、含多行单元格的中文 CSV、220 行/40 列 XLSX 的 200 行/30 列预览边界、工作表切换、图片放大、Markdown 文档、未支持格式下载入口。
- 下载的 XLSX 与电脑原文件逐字节一致，中文下载文件名正确。
- 删除文件、越界文件、离线状态、过期内容摘要、未登录请求、其他会话/账号/电脑访问均按各自边界拒绝。
- 正文 HTML 不执行，表格单元格作为文本显示；测试没有发出第三方网络请求或任务写入。
- 320、390、760、1440 像素宽度无页面整体横向溢出，宽表格仅在阅读区内部滚动。
- 原有上传、草稿图片预览、历史图片预览和会话列表/未读/新建对话浏览器回归通过。
- 子对话浏览器回归通过，包含切换、迟到响应隔离、新建、消息控制及离线读取。
- 连接包包含54个文件，36个相对模块引用全部闭合；未包含私有配置或浏览器表格库。ZIP SHA-256：`09cfe4aae9f574c2cf0ae1b76e374c680acdaf78d10eb4204e0d90fc8f5a79f0`。
- 浏览器表格库为官方 SheetJS CE 0.20.3 原件，SHA-256：`cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`；附带完整 Apache-2.0 许可。
- 截图与报告位于忽略的 `artifacts/results/`，测试文件和独立接收服务已清理。

## 界面质量核对

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 01 | Point of view, not a template | 通过 | 阅读：延续现有会话，仅在点击文件/表格时进入阅读窗口 |
| 02 | Typography works | 通过 | 复用 Bahnschrift/Avenir Next 与 Segoe UI/中文系统字体；标题16px、正文14–16px、说明12px |
| 03 | Restrained palette | 通过 | 复用背景 #f4f6fb、表面 #fbfcff、文字 #18263c、辅助 #53647b、操作 #254edb |
| 04 | Hierarchy breathes | 通过 | 内容为主体，文件名/状态在顶部，下载位于底部；模型设置不增加占位 |
| 05 | Images are meaningful | 通过 | 只展示当前回复返回的真实图片，测试使用明确的1px PNG夹具，无装饰图 |
| 06 | Motion whispers | 通过 | 文件按钮150ms边框/背景反馈，遵从 reduced-motion；阅读页无入场动画 |
| 07 | Mobile is designed, not squeezed | 通过 | 手机全屏阅读、安全区、44px触控按钮；表格局部横滑；桌面限制窗口最大宽度 |
| 08 | The invisible is expensive | 通过 | 原生dialog、关闭/键盘操作、文本单元格、Worker按需解析、错误/重试/下载回退；目标/摘要复核 |

未安装独立的 `ui-ux-pro-max`、`impeccable`、`taste-skill`、`soft-skill`、`emil-design-eng` 和 `redesign-skill`；本次采用项目现有设计，不引入新组件服务或图片生成。

## 尚未验收

未在实体安卓手机/夸克浏览器上操作；模拟采用本机 Edge 的移动视口。未证明所有 XLS/ODS、超大文件、PDF 原生查看器或 WPS 唤起兼容性。未替换生产服务，也未声称本次完成任务运行中的连接程序无缝迁移。
