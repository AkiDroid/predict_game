# 部署到单台 Ubuntu

用 Docker 在一台云服务器上跑三件事：Caddy 负责 80/443，Node 同时提供页面和 API，Redis 保存登录会话。账户和对局在宿主机的 `data/app.sqlite`，行情在 `data/processed/`。

```text
浏览器 -- :80 / :443 --> Caddy --> 应用 :5173 --> Redis
                              |
                              +--> 宿主机 data/（SQLite 与行情）
```

仓库根目录的 `docker-compose.yml` 只给本地开发起 Redis。生产用 `deploy/docker-compose.yml`，不要在服务器上执行根目录那个文件。

## 服务器

- Ubuntu 22.04 或 24.04
- 内存建议 4 GB。启动时会把 ES、NQ 的分钟线载入内存，2 GB 机器容易在启动阶段被系统杀掉
- 磁盘建议 20 GB 以上。当前行情文本加预处理文件大约 1 GB，另加镜像和系统
- 安全组只放行 22、80、443。不要放行 6379 或 5173

5173 只绑在服务器本机，给健康检查用。Redis 不映射到宿主机。

## 安装 Docker

在服务器上：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker
```

重新登录后，`docker compose version` 应能输出版本。需要的是 Compose v2（`docker compose`），不是旧的 `docker-compose`。

防火墙在确认 SSH 已放行后再开：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 上传代码和行情

在服务器上放一份仓库，例如 `/opt/predict-game`。`data/` 不在 Git 里，需要单独同步。

在你自己的电脑上，于项目根目录执行（把 `user` 和地址换成你的）：

```bash
rsync -a --delete \
  --exclude '.git' \
  --exclude node_modules \
  --exclude dist \
  --exclude data \
  --exclude deploy/.env \
  ./ user@SERVER:/opt/predict-game/

rsync -a \
  --exclude app.sqlite \
  --exclude app.sqlite-wal \
  --exclude app.sqlite-shm \
  --exclude backups \
  ./data/ user@SERVER:/opt/predict-game/data/
```

第一条会同步代码。`deploy/.env` 被排除，不会覆盖服务器上已经填好的配置。第二条同步 `ES_1min.txt`、`NQ_1min.txt` 和已有的 `data/processed/`。服务器上的账户库和备份会留下来。

用部署用户执行 rsync，不要加 `sudo`。脚本会用这个用户的 uid 跑容器，这样才写得了 `data/`。如果目录已经属于 root：

```bash
sudo chown -R "$USER:$USER" /opt/predict-game/data
```

若服务器上还没有 `data/processed/`，只要两份 `*_1min.txt` 在，首次启动会在容器里生成预处理文件。已有完整 `processed/` 时会跳过这一步。

镜像在服务器上构建。不要在 Mac 上构建再拷过去，架构可能对不上。

## 配置

```bash
cd /opt/predict-game
cp deploy/.env.example deploy/.env
openssl rand -hex 24
```

把生成的密码写进 `deploy/.env` 的 `REDIS_PASSWORD`。只用字母和数字。

有域名时，把 DNS 的 A 记录指到这台服务器，然后：

```bash
SITE_ADDRESS=play.example.com
ACME_EMAIL=you@example.com
COOKIE_SECURE=1
CORS_ORIGIN=https://play.example.com
```

只有 IP 时，Let's Encrypt 不能给纯 IP 签发证书。用 HTTP：

```bash
SITE_ADDRESS=:80
COOKIE_SECURE=0
CORS_ORIGIN=http://203.0.113.10
```

`COOKIE_SECURE=0` 是必须的，否则浏览器不会保存登录 cookie。`CORS_ORIGIN` 要和浏览器地址栏一致，不要加末尾斜杠。

`deploy/.env` 已在 `.gitignore` 里，不要提交。

## 启动

```bash
cd /opt/predict-game
./deploy/up.sh
```

脚本会检查配置和行情，拉取 Caddy / Redis 镜像，构建应用镜像，必要时做预处理，然后启动。行情载入可能要几分钟。成功后按你的 `SITE_ADDRESS` 用浏览器打开站点。

首次用域名时，证书申请要能从公网访问 80 端口。还没签下来可以看：

```bash
cd /opt/predict-game/deploy
docker compose logs caddy
```

注册是开放的。若只想自己用，在云安全组里限制 80/443 的来源 IP。

页面字体来自 Google Fonts。访问不到 Google 时页面仍能用，只是字体回退。

## 更新

代码更新后，在服务器项目根目录：

```bash
git pull   # 若不用 git，就再 rsync 一次代码
./deploy/up.sh
```

`data/` 和 Redis 数据卷会保留。更换 `*_1min.txt` 后要重新预处理，应用才会载入新行情：

```bash
./deploy/preprocess.sh
```

## 备份与恢复

账户和对局在 `data/app.sqlite`。在项目根目录：

```bash
./deploy/backup.sh
```

备份出现在 `data/backups/app-时间戳.sqlite`。这是一份一致的库快照。登录会话在 Redis 里，不包含在这份文件中。

恢复会停掉应用，把当前库改名为 `app-before-restore-时间戳.sqlite`，再换上指定备份，并清掉全部登录态：

```bash
./deploy/restore.sh data/backups/app-YYYYMMDD-HHMMSS.sqlite
```

建议再把 `data/backups/` 拷到服务器以外。Redis 丢了只会让所有人重新登录，账户还在。

不要在应用运行时直接复制 `app.sqlite`，WAL 模式下那样的拷贝可能不完整。用上面的备份脚本。

## 常用命令

以下命令在 `deploy/` 目录执行：

```bash
cd /opt/predict-game/deploy
docker compose ps
docker compose logs -f app
docker compose logs -f caddy
docker compose restart app
docker compose stop
docker compose up -d
docker compose down
```

`docker compose down` 会停容器，但保留 `data/`、Redis 卷和 Caddy 证书。`docker compose down -v` 会删掉 Redis 里的会话和已申请的证书，SQLite 仍在 `data/`。删证书后重新申请可能碰到 Let's Encrypt 频率限制。

服务器重启后 Docker 会按 `restart: unless-stopped` 拉起服务，前提是 Docker 本身已设为开机启动。

## 排错

| 现象 | 处理 |
|------|------|
| `up.sh` 报密码不合法 | `REDIS_PASSWORD` 至少 16 位，只用字母和数字 |
| 登录后一刷新就掉 | 域名部署确认 `COOKIE_SECURE=1` 且用 https；纯 IP 确认 `COOKIE_SECURE=0` 且用 http |
| 浏览器提示 redirected you too many times | 域名走 Cloudflare 且 SSL 为 Flexible 时，源站不能再把 HTTP 跳到 HTTPS。当前 Caddy 在 80 和 443 上都直接提供页面。浏览器可能还记着之前的 308，用无痕窗口再打开 |
| 容器一直重启，日志说缺少预处理行情 | 确认 `data/ES_1min.txt` 和 `data/NQ_1min.txt` 已上传，再执行 `./deploy/preprocess.sh` |
| 启动后进程消失，`dmesg` 里有 OOM | 机器内存不够。换 4 GB，或加 swap 后再启动 |
| 日志里 `JavaScript heap out of memory` | 在 `deploy/docker-compose.yml` 把 `NODE_OPTIONS` 的 `2048` 提高到 `3072`，机器内存仍需至少 4 GB |
| 证书申请失败 | DNS 是否已指向这台机器，安全组是否放行 80。看 `docker compose logs caddy` |
| `data/` 无法写入 | `sudo chown -R "$USER:$USER" data`，然后重新 `./deploy/up.sh` |
| 本机 `http://127.0.0.1:5173/api/health` 的 `ok` 不是 `true` | 看 `docker compose logs app`。`ok: true` 表示行情已载入 |

改过 `deploy/.env` 后重新执行 `./deploy/up.sh`，让容器拿到新配置。
