# 自托管部署

本文说明如何把 Codex 随行部署到自己的 Linux 服务器。示例域名统一使用 `your-domain.example`，请替换成你自己的域名。

## 前置条件

- Linux 服务器，能安装 Docker Engine 和 Docker Compose。
- 一个解析到服务器的域名。
- 服务器开放 80/443，或已有反向代理能够转发 WebSocket 和 SSE。
- 电脑安装 Node.js 24+、Codex，并能访问你的 HTTPS 域名。

## 生成配置

在源码目录执行：

```sh
npm ci --ignore-scripts
npm run setup
node tools/prepare-deploy.mjs https://your-domain.example
```

生成的文件位于 `.data/deploy/`：

- `server.json`：服务端私密配置。
- `.env`：Compose 使用的域名配置。

先保管好 `.data/login.md` 中的登录密码。初始化不会覆盖现有配置。`.data` 目录只保存在私有环境，不要提交 Git 或上传到公开仓库。

## Docker Compose

在 Linux 服务器克隆源码，再把本机生成的两个配置文件单独传到下列位置（不要上传整个 `.data/`）：

```sh
git clone https://github.com/wang1733238039/codex-phone.git
cd codex-phone
mkdir -p data
```

| 本机文件 | 服务器文件 |
| --- | --- |
| `.data/deploy/server.json` | `codex-phone/data/server.json` |
| `.data/deploy/.env` | `codex-phone/.env` |

确认文件到位后启动：

```sh
sudo chown -R 1000:1000 data
sudo chmod 700 data
sudo chmod 600 data/server.json
chmod 600 .env
docker compose up -d --build
curl -fsS https://your-domain.example/healthz
```

默认 Compose 使用 Caddy 自动申请证书。若服务器已有 Nginx 或 Caddy，使用 `deploy/compose.nginx.yaml`，并把 `deploy/nginx.conf` 中的域名和证书路径改成实际值。

## 电脑连接

在每台电脑的连接程序目录执行：

```sh
node tools/pair.mjs --server https://your-domain.example --name "我的电脑"
npm run remote-agent
```

先登录网页的电脑菜单生成配对码。配对码只使用一次，连接程序会把设备令牌保存在本机 `.data/agent.remote.json`；`npm run remote-agent` 读取这份公网配置。不要复制其他电脑的配置文件，不要把令牌提交到 Git。

0.6.0 支持同一实例内的独立账号。客户必须登录自己的账号生成配对码，不能使用管理员的配对码。用户邀请、续期和到期规则见 [托管账号与运营](hosted-accounts.md)。反向代理应按该文档配置可信代理地址，避免所有客户共享同一限流计数。

Windows 可执行：

```powershell
.\install-remote-autostart.ps1
```

它会安装当前用户登录自启和连接进程守护。电脑必须保持开机、联网并运行连接程序，手机才能发送新任务。

## 备份与升级

从 0.5.0 升到 0.6.0 时，原登录账号会自动迁移为长期有效的管理员。设备令牌和主电脑 ID 保留，现有 0.5.0 连接程序无需重新配对。迁移后密码由数据库管理，旧配置不再覆盖密码；回滚需要恢复匹配的数据库，详细规则见托管账号文档。

升级前：

1. 停止或确认没有正在执行的手机任务。
2. 备份 `data/`、`.env` 和 `data/server.json`。
3. 保留旧源码和旧镜像，以便回退。

备份期间先停止 `phone` 服务，再复制完整数据目录，这样可以保全 SQLite 数据库及其 WAL。不要对运行中的数据库只复制主文件。也可由熟悉 SQLite 的维护者使用其在线备份接口。

在已经确认没有手机任务执行的维护窗口，默认 Compose 的备份示例为：

```sh
docker compose stop phone
umask 077
backup="backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp -a data "$backup/"
cp .env "$backup/.env"
git rev-parse HEAD > "$backup/revision.txt"
docker compose start phone
```

妥善保管备份，它含有设备凭据和会话内容。源码更新后执行：

```sh
git pull --ff-only
docker compose up -d --build
curl -fsS https://your-domain.example/healthz
```

使用 Nginx 的实例将所有 `docker compose` 命令统一改为 `docker compose -p codex-phone -f deploy/compose.nginx.yaml`。回退时先保全升级后新增的数据，再停服务并恢复相互匹配的源码、配置和数据，勿把旧程序直接指向已升级的数据库。

## 卸载

先停止电脑端本安装的连接程序及自启项，然后在服务器执行 `docker compose down`。默认命令保留 `data/`、`.env` 和证书卷；确认备份与删除范围后再自行清理。电脑上的 Codex 会话和已下载的附件仍保留。

## 数据清理

用户会话、任务状态和附件缓存位于服务器 `data/`。删除账号或实例前先确认备份策略，再按需要删除数据目录和 Docker 卷。服务器日志不应记录完整对话正文、附件内容、密码或设备令牌。
