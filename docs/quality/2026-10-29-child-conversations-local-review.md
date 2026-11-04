# 子对话切换：本地验收

日期：2026-10-29。状态：本地实现与测试通过，等待用户确认发布。

## 本次行为

- 左侧保持主会话列表及原有数量；子对话从主会话标题旁的按钮进入。
- 手机通过底部抽屉切换主对话、子对话及嵌套子对话；桌面为居中弹窗。
- 子对话只显示任务输入和最终回复，隐藏输入区；返回主对话恢复草稿、阅读位置。
- 每个子对话展示来自历史记录的完成、失败、中断或状态未确认标记，不把关联表的 open 状态解释为执行中。
- 上传、发送、停止、排队修改、审批在前端、服务器、连接程序均受只读保护。
- 父会话复制进子会话的历史不作为子对话输出，guardian、孤立关系和循环关系不进入列表。

## 测试证据

| 检查 | 结果 |
|---|---|
| `npm test` | 79 项通过 |
| `npm run check` | 通过，包含新增前端和关系模块 |
| `tools/browser-children-check.mjs` | 12 组场景通过，无页面异常、无控制请求转发 |
| `tools/browser-inbox-check.mjs` | 通过，未读、创建、布局回归正常 |
| `tools/browser-devices-check.mjs` | 通过，设备切换、独立草稿、晚到响应和离线缓存回归正常 |
| 真实本机只读链路 | SQLite → 连接快照 → 本地 WebSocket → HTTP → 手机尺寸浏览器通过 |
| 真实历史内容 | 本机有历史文件的 4 个子对话均成功读取，均有最终回复 |
| 设备与账号隔离 | 相同 thread ID 跨账号、跨设备不能读取他人子对话及其关联列表 |
| 旧连接兼容 | 缺少 childThreads 的快照正常，清除旧子对话入口 |
| 375、390、1440px | 无横向溢出，按钮高度 44px，弹窗不超屏 |

浏览器证据位于 `artifacts/children/`，包括 `browser-report.json`、`picker-390.png` 和 `child-390.png`。截图使用本地构造数据，真实历史内容的截图仅保存在被 Git 忽略的 `.data/local-child-preview/`。

## 界面质量检查

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 01 | Point of view, not a template | ✅ | 阅读优先：切换入口沿用标题区域，子对话隐藏输入区释放阅读空间 |
| 02 | Typography works | ✅ | 沿用现有 Bahnschrift / Segoe UI 及中文系统字体；标题 14–16px、辅助 11–12px、正文 16px |
| 03 | Restrained palette | ✅ | `#fbfcff` 表面、`#18263c` 正文、`#53647b` 辅助、`#254edb` 当前入口；状态复用现有色值 |
| 04 | Hierarchy breathes | ✅ | 正文为主、标题与切换为次、状态和项目为辅助；手机实测头部约 84px |
| 05 | Images are meaningful | ✅ | 此功能不需要装饰图片；截图直接展示切换抽屉与子对话页，头像入口沿用现有 SVG |
| 06 | Motion whispers | ✅ | 复用现有 160ms 交互颜色反馈与原生 dialog；继承 prefers-reduced-motion |
| 07 | Mobile is designed, not squeezed | ✅ | 手机上使用底部抽屉，桌面居中；三个宽度无溢出，触摸入口 44px，底部安全区留白 |
| 08 | The invisible is expensive | ✅ | 原生模态焦点管理、Escape 关闭、aria-current、键盘焦点可见；实测文字对比度 5.59–5.89:1；无新依赖 |

本机未安装 ui-ux-pro-max、impeccable、taste-skill、soft-skill、emil-design-eng 或 redesign-skill，21st 组件工具未提供。使用项目现有设计变量及 frontend-design-skill/reference.md 完成检查，没有引入外部组件或字体下载。

## 注意事项与边界

- 本机共识别到 52 条有效关联，48 条对应的历史文件不在本机；仍展示关系并标记“历史不在此电脑”，打开时解释无法读取并允许返回主对话。
- 子对话当前只读。发送、停止、审批和桌面实时 owner 控制不在本轮验收范围内。
- 未在真实安卓手机运行；手机交互证据来自 Chromium 手机尺寸模拟。真实历史通过本机独立验收服务读取，没有发送真实任务。
- 本地预览仅监听 `127.0.0.1:3821`，不对外开放；使用独立测试数据库与临时身份。
- 没有部署服务器、推送 GitHub、发布连接包，也没有重启线上连接程序。后续由用户确认后再执行发布。
