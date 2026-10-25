# 接入另一台电脑

这份文档用于把另一台安装了 Codex 的电脑接入你自己的 Codex 随行服务器。把下面的 `https://your-domain.example` 替换成你的实际网址。

服务端 0.6.0 支持独立账号。请先登录你自己的账号，再生成配对码；不要使用其他用户或管理员的配对码。现有 0.5.0 连接程序仍兼容，服务器升级不要求已绑定电脑重新配对。

## 要求

- Node.js 24 或更高版本。
- 当前电脑已经安装并能运行 Codex。
- 当前电脑能访问你的 HTTPS 网站。
- 不复制其他电脑的 Codex 配置、设备令牌或 `.data` 目录。

## 下载源码

可以直接从 GitHub 克隆本项目，或下载对应版本压缩包：

```sh
git clone https://github.com/wang1733238039/codex-phone.git
cd codex-phone
npm ci --ignore-scripts
```

Windows 连接程序已有实机验证；macOS 提供安装分支但尚未实机验收，Linux 连接端暂未验证。

## 配对

在手机网页的“添加电脑”中生成一次性配对码，然后在这台电脑执行：

```sh
node tools/pair.mjs --server https://your-domain.example --name "办公室电脑"
```

按提示输入配对码。配对成功后，配置保存在本机 `.data/agent.remote.json`。不要把这个文件发给其他人，也不要提交 Git。

若无法自动找到 Codex，可以增加 `--codex-bin` 指定实际可执行文件路径；Windows 必须指定 `codex.exe`。`--codex-home` 可指定本机 Codex 数据目录。支持 `--code-file` 从 UTF-8 临时文件读取配对码，成功后自行删除该文件。已有配对配置会被保留，不会自动覆盖。

启动连接程序：

```sh
node tools/remote-agent.mjs
```

Windows 可运行 `start-remote-agent.ps1`，并用 `install-remote-autostart.ps1` 配置当前用户登录自启。

## 验证

回到手机网页，电脑列表应显示新设备在线。打开一个项目和会话，先只发送一条无副作用的测试消息，确认回复和状态正常后再继续使用。

电脑关机、休眠或连接程序退出时，手机仍可查看服务器已有缓存，但不能取得新的本地会话或执行新任务。

## 更新

更新前先停止本安装目录的连接程序，保留 `.data/agent.remote.json`，再更新源码并执行：

```sh
npm ci --ignore-scripts
node tools/remote-agent.mjs
```

不要删除 `.data` 来解决问题；需要重新绑定时，应先在网页解绑旧设备，再按配对流程生成新令牌。
