# Agent Hub 安卓版与 Codex 网页端：功能对比及升级

核查日期：2026-11-08。上游固定提交：`17c72d02babff81db08ebeaebc9a6a50fa530df1`。本文依据该提交的源码与文档，未操作用户手机上的 Agent Hub 安装，也不将上游源码等同于所有安卓机型已验收。

本次再次通过 GitHub API 核实，上述提交仍是公开 `main` 的最新提交，提交时间为北京时间 2026-11-08 10:10:33，说明为 `chore: sync source from Gitea main`。近期公开记录包含 Windows 升级路径、主机安装及文档预览跟进，也有尚未闭环后撤回候选改动的记录；因此以下逐项依据当前保留的源码判断能力，不将开发记录标题当作已发布功能。

## 先说结论

消息、模型、子对话、图片、表格和缓存都能通过网页实现。当前网页的主要差距来自实现与传输链路，不能归因于“网页天生不支持”。原生 App 的优势集中在系统分享入口、文件应用交接、通知管理和后台生命周期。

用户此前已确认手机网页、服务器和电脑连接程序的结构。本次延续该结构，修复返回文件打不开的问题；不更换桌面适配器，不修改模型路由。

## 从实际使用区分能力

| 使用场景 | 网页能做到什么 | 安卓原生的优势 | 我们当前及后续动作 |
|---|---|---|---|
| 查看会话、状态、最终回复 | 可以实现，与是否原生无关 | 原生列表和滚动组件便于保持稳定帧率 | 已有；继续减少无效刷新和整页重建 |
| 新建、续聊、补充、模型选择、子对话 | 可以实现，权限取决于电脑连接程序与原桌面接口 | App 本身不会额外获得桌面控制权限 | 保留既有原桌面通道和回执约束，避免另开执行任务 |
| 点开会话立即看到最近内容 | 内存缓存、IndexedDB、分页和增量刷新都可实现 | 原生有更完整的本地存储生命周期 | 当前已有页面内阅读缓存与服务端缓存；跨次打开的持久缓存列为下一阶段 |
| 图片放大、表格横滑、文件预览 | 可以实现 | 可利用系统查看器；非所有格式均由 App 内置渲染 | 本次补齐图片、XLSX/CSV、Markdown、下载 |
| 语音输入和朗读 | 手机输入法可直接使用；网页还可接录音、服务端转写及朗读 | 系统语音与原生录音生命周期集成更完整 | 不将语音视为必须开发 App；网站当前权限策略禁用麦克风，独立录音入口须另行调整并测试 |
| 锁屏、切到其他 App 后持续联网 | 普通网页可能被冻结或丢弃；恢复后可重新同步 | 可使用符合系统规则的前台服务，但仍受系统省电与后台限制 | 网页以前台阅读、恢复后对账为主，不承诺锁屏永久长连接 |
| 完成通知 | HTTPS + Service Worker + Web Push 可做，需权限及浏览器支持 | 通知渠道、私有锁屏显示、自定义声音、通知点击路由更可控 | 当前网页仅有页面内提示；Web Push 是独立下一阶段 |
| 从微信、相册“分享给本产品” | 支持的安卓浏览器安装 PWA 后可用 Web Share Target；普通标签页没有等价统一入口 | Android Intent、ContentResolver 和文件授权原生集成更完整 | 先保留网页选择附件；PWA 分享入口需单独做浏览器兼容验收 |
| 一键指定 WPS 等应用打开文件 | 网页可提供下载/分享，但不能保证所有浏览器直接唤起指定应用 | FileProvider、ACTION_VIEW、系统应用选择器 | 本次提供原件下载，由手机系统决定后续打开方式 |
| 电脑上的原生面板或任意窗口 | 需要电脑侧明确支持的接口 | 原生手机界面本身不绕过电脑接口限制 | 不把复刻手机界面当作已经实现桌面全部能力 |

“网页很卡”和“App 很流畅”不能直接等同于平台能力差距；应分别测首屏缓存、请求等待、重复传输、重建消息 DOM、宽表格布局、图片下载与解析对主线程的影响。

## 上游值得移植的功能点

1. **按电脑和会话保存完整快照，再独立更新变化。** 上游 `NativeHistoryCache.kt` 用目标身份和分代索引防止混合缓存。网页可借鉴目标隔离、整代提交与失效规则，使用 IndexedDB 实现，不直接复制 Kotlin 存储层。
2. **未知发送结果保留原 ID 和回执查询。** 上游阶段95明确不把旧 `failed/attempted=false` 直接当作“未发送”。网页应保留已有未知结果保护，并补充更清晰的“查询结果”和“结束本地等待”，不自动重新提交。
3. **内容解析与文件访问分开。** 上游 `FilePreviewRegistry` 的渲染器只接收已经授权的本地副本。我们的预览器只接收经过账号、电脑、会话和原回复核验的文件。
4. **区分文件已删除、权限不足、离线、格式不支持。** 上游 `attachment-files.ts` 明确区分读取错误，并复查文件身份和内容。网页同样应给出可操作提示。
5. **图片手势、文档目录、搜索、阅读点恢复。** 都可在网页移植；本次先复用图片放大及阅读窗口，目录/文档内搜索和持久阅读点留待后续。

注意：上游当前 Android 的内置专门文档渲染器注册项为 Markdown；其他格式还存在系统打开/分享回退。因此“App 可以打开 Excel”不等于“App 自己实现了 Excel 编辑器”。

## 本次文件升级已经实现什么

版本候选：0.6.12。本地实现与测试完成，不代表公网已部署。

### 原因

旧网页只打通手机上传附件到电脑的方向，未打通电脑返回文件到手机的方向。助手回复中的非 HTTP 链接被移除 `href`，图片标签被过滤，导致文件名看得见但不能打开，Markdown 图片可能消失。

### 用户看到的行为

- 回复中的 Markdown 表格可在原位置左右滑动，也可点击“放大表格”进入全屏阅读。
- Codex 最终回复里的项目内图片链接可打开大图、放大、下载原图。
- `.xlsx`、CSV 可在网页只读预览；Excel 支持切换工作表。下载保留原文件，不生成另一个格式的副本。
- Markdown 文件可查看排版、表格；UTF-8 普通文本可直接阅读。
- Word、PPT、PDF、压缩包等提供原件下载；不声称已实现在线编辑或所有格式内置预览。
- 文件被删除、电脑离线、连接程序过旧时显示原因和重试入口。
- 阅读会话时不自动传输全部返回文件，表格解析库只在点击表格文件后于 Worker 加载，不进入初次页面的主线程。

### 范围及限制

- 只读取 Codex **最终回复中明确链接**的文件；不会把用户输入、思考、工具输出或任意 URL 参数当作电脑文件访问授权。
- 文件须在对应项目目录内，或由电脑管理员明确配置的 `resultFileRoots` 中。链接跳出授权目录、指向私有配置/密钥或经符号链接逃逸均拒绝。
- 不同账号、电脑、会话分别核对，网页不能提交任意电脑路径。临时侧栏仅在原桌面仍能核实归属时读取。
- 文件直接经已有连接程序分块传回，不新增第三方文件托管；每块 256 KiB，传输核对大小与 SHA-256。
- 文件下载上限 200 MB；表格预览上限 8 MB、最多 10 个工作表、每表前 200 行/30 列；文本/Markdown 预览上限 2 MB；图片预览上限 20 MB。超过上限提供下载。
- 表格显示单元格值，不执行公式、宏或 HTML，不保留原 Excel 完整样式、图表和编辑能力。
- 外网图片链接可显式打开外部网页，不代理访问任意外网/内网图片；嵌套 Markdown 的电脑相对文件链接暂不新增授权。
- 电脑离线时已有聊天缓存仍可读，本次返回文件不新增离线缓存。

## 下一阶段顺序

1. **本次文件升级发布**：服务端新增只读路由、前端资源、电脑连接程序须配套更新；仅刷新手机网页不够。先验证完整版本，再安排生产切换，不中断正在执行的用户任务。
2. **流畅度**：跨次打开的最近15条 IndexedDB 缓存、先展示后刷新、消息按 ID 更新、减少后台无效轮询、断线恢复后合并刷新。
3. **任务回执与状态**：清楚展示发送中/已接收/执行中/已结束/结果未知，保留原 ID 查询及手动结束本地等待。
4. **PWA 体验**：主屏幕入口、Web Push、受支持浏览器的分享接收。每项分别做安卓实体手机验收。

本次没有改动上游 Host、其他电脑、安卓 App 仓库或生产服务。0.6.12 的本地测试不能当作公网发布或实体安卓浏览器验收。

## 核查来源

固定上游：

- `https://github.com/easyaigc/agent-hub/tree/17c72d02babff81db08ebeaebc9a6a50fa530df1`
- `apps/android/src/main/kotlin/com/agenthub/android/NativeHistoryCache.kt`
- `apps/android/src/main/kotlin/com/agenthub/android/FilePreview.kt`
- `apps/android/src/main/kotlin/com/agenthub/android/NativeResourcePreview.kt`
- `apps/android/src/main/kotlin/com/agenthub/android/NativeExternalAttachments.kt`
- `apps/android/src/main/kotlin/com/agenthub/android/NativeChatNotificationPlatform.kt`
- `packages/codex-adapter/src/attachment-files.ts`
- `packages/mobile-core/src/commonMain/kotlin/com/agenthub/core/FilePreviewRules.kt`
- `docs/plans/android-alignment-20261022/records/stage95-legacy-reply-safety.md`

平台及预览库：

- `https://developer.chrome.com/blog/page-lifecycle-api`
- `https://developer.chrome.com/docs/capabilities/web-apis/web-share-target`
- `https://developer.android.com/develop/background-work/services/foreground-services`
- `https://docs.sheetjs.com/docs/getting-started/installation/standalone/`
- `https://docs.sheetjs.com/docs/api/parse-options`
