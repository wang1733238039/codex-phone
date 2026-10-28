# Codex 随行

Codex 随行是一个免费开源的自托管网页工具：用手机浏览器查看多台电脑上的 Codex 会话，并在目标电脑在线时继续会话。每台电脑继续使用自己的 Codex、中转站配置和项目文件，服务器只负责网页、登录、消息中继与缓存。

本仓库对应免费自托管版。你需要准备自己的 Linux 服务器、域名、HTTPS 和备份策略。托管服务可以使用同一套代码部署，但由服务提供方负责服务器和运维；本仓库不包含任何生产账号、密钥、会话或托管配置。

当前服务端版本为 **0.6.6**，支持同一实例内的独立账号、自助注册、账号数据隔离、设备归属和服务期限管理。新用户在首页点击“注册”，填写账号和密码即可创建账号并自动登录，无需邀请码或管理员审批。账号和加盐密码哈希保存到 SQLite，新账号默认开通 30 天服务、最多绑定 3 台电脑（上限可由服务端配置）。管理员可以查看、续期和停用用户；尚未接入在线支付或自动扣款。现有 0.5.0 电脑连接程序兼容，无需重新配对。Windows 连接程序已有实机验证；macOS 提供安装分支但尚未实机验收，Linux 连接端暂未验证。

项目名称统一为“GitHub 网页端”（本仓库）、“本地网页端”（部署实例）与“Codex 手机版”（独立原生 App）。见[项目定义](docs/project-definitions.md)。连接程序 **0.6.0** 引入基于 Agent Hub 的原桌面适配；能力和当前验证范围见[桌面适配](docs/desktop-adapter.md)。

```text
手机浏览器 → 你的 HTTPS 服务器（网页、登录、缓存）
                         ↑ 出站 WebSocket
                电脑 A / 电脑 B 连接程序
                         ↓
                 各自本地 Codex 与项目
```

## 功能

- 一个账号绑定多台电脑，按电脑切换项目、会话、缓存和连接状态。
- 按 Codex 项目分类、置顶、归档、搜索和折叠会话。
- 只向手机展示用户输入和 Codex 最终回复，隐藏思考过程、进度和工具调用。
- 电脑在线时发送消息、续聊、新建对话和上传材料；电脑离线时查看已缓存内容。
- 支持模型选择、排队、结果状态、未读结果和网络不确定状态提示。
- 设备配对、改名、解绑、独立设备令牌、CSRF、来源校验和登录限流。
- 同一服务承载多个独立账号；按账号隔离电脑、项目、会话、附件、实时事件和命令回执。
- 管理员创建用户、生成一次性邀请、设置电脑上限、续期、停用、重置密码和删除用户。
- 到期后保留登录和自己的历史缓存，暂停电脑接入、配对、上传和新任务；续期后恢复。

## 托管版开通用户

不需要为每位用户部署独立服务器或独立实例：

1. 用户打开网站首页，点击 **注册**，填写账号、密码并确认。
2. 服务端直接创建普通账号并自动登录，无需邀请或管理员审批；默认开通 **30 天、3 台电脑**。
3. 用户在自己的账号内生成电脑配对码，安装连接程序并配对，然后用手机登录使用。
4. 管理员在 **账户与套餐 → 管理用户与邀请** 查看新用户、设置电脑上限、续期或停用。
5. 默认注册不校验支付；后续确认收款后，在管理页给对应用户增加服务天数。自动支付不是本版本的功能。

也可直接创建账号。管理员界面只显示账号状态和电脑数量，不提供读取他人对话的入口。完整流程、期限规则和迁移说明见 [托管运营](docs/hosted-accounts.md)。

## 快速开始（本机）

需要 Node.js 24 或更高版本，以及已安装并可运行的 Codex。

```powershell
git clone https://github.com/wang1733238039/codex-phone.git
cd codex-phone
npm.cmd ci --ignore-scripts
npm.cmd run setup
npm.cmd run local
```

初始化后，浏览器访问 `http://127.0.0.1:3819`。登录资料保存在本机 `.data/login.md`，不会进入 Git。

局域网访问需要电脑和手机网络互通，并允许入站 3819 端口；公网 HTTPS 部署后可以使用手机流量。HTTP 仅用于可信局域网试用。

## 部署到自己的服务器

1. 在本机克隆仓库、安装依赖并初始化，再生成私密部署配置：

   ```sh
   npm ci --ignore-scripts
   npm run setup
   node tools/prepare-deploy.mjs https://your-domain.example
   ```

2. 将源码上传到自己的 Linux 服务器。不要上传 `.data`、`node_modules`、Codex 配置、会话目录或日志。
3. 将生成的 `.data/deploy/server.json` 复制为服务器项目的 `data/server.json`，将 `.data/deploy/.env` 复制为项目根目录 `.env`。
4. 设置数据目录权限，然后启动：

   ```sh
   sudo chown -R 1000:1000 data
   sudo chmod 700 data
   sudo chmod 600 data/server.json
   docker compose up -d --build
   ```

5. 在每台电脑上配对连接程序：

   ```sh
   node tools/pair.mjs --server https://your-domain.example
   npm run remote-agent
   ```

   先登录网页生成一次性配对码。Windows 配对后执行 `node tools/install-connector.mjs`，会创建桌面和开始菜单的“Codex 随行 - 电脑连接”入口并配置当前用户登录自启。双击入口可启动连接、查看运行状态或勾选/取消自启；关闭窗口后后台连接继续运行。也可用 `start-remote-agent.ps1` 启动，用 `install-remote-autostart.ps1` 配置登录自启。`src/agent.mjs` 和 `start-agent.ps1` 默认使用本地试用配置，不用于上述公网配对配置。

服务器已有 Nginx 或 Caddy 时，可复用反向代理；必须转发 WebSocket/SSE，后台服务只监听内网。Nginx 示例中的 `your-domain.example`、证书路径和日志路径都需要替换成你的实际域名。

完整说明：

- [部署与备份](docs/deployment.md)
- [接入另一台电脑](docs/CONNECT-ANOTHER-COMPUTER.md)
- [附件与材料](docs/attachments.md)
- [数据与结果展示设计](docs/conversation-results-design.md)
- [托管账号与运营管理](docs/hosted-accounts.md)
- [版本记录](CHANGELOG.md)

## 数据与隐私边界

服务器会处理中继所需的消息、Codex 回复和附件，并缓存会话内容。服务端不是端到端加密节点；请使用自己的 HTTPS、主机访问控制、备份和数据删除策略。

模型 API、中转站密钥、Codex 配置和项目文件留在用户电脑。服务器不会读取这些密钥，也不会把用户电脑上的项目目录整体上传。

默认附件清理策略是未发送附件 24 小时、已发送缓存 7 天；正式使用前应根据自己的备份和容量策略复核配置。

## 开发与验证

```sh
npm ci --ignore-scripts
npm test
npm run check
```

项目使用 Node.js 原生模块、SQLite、WebSocket 和静态前端，无前端构建步骤。

## 许可证

本项目许可证为 **AGPL-3.0-only**，完整文本见 [LICENSE](LICENSE)。第三方依赖及其原有许可证见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

本项目为独立社区项目，与 OpenAI 没有隶属或官方合作关系。

## 安全问题

不要在公开 Issue 中提交密码、设备令牌、会话内容、服务器配置或日志。安全问题请先按 [SECURITY.md](SECURITY.md) 联系维护者。
