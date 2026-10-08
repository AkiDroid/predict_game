# 项目部署约定

- 用户要求部署到服务器时，先读取项目根目录 `.env`，使用 `SERVER_HOST`、`SERVER_USER`、`SERVER_PORT`（默认 22）和 `SERVER_DEPLOY_PATH`（默认 `/opt/predict-game`）。
- 部署只使用本机 SSH 私钥或 SSH Agent，不要求、不存储、不使用 `SERVER_PASSWORD`。`SERVER_SSH_KEY` 可选；留空使用 Agent 和 `~/.ssh/` 中的默认私钥，填写时使用指定私钥。对应公钥应预先加入服务器用户的 `~/.ssh/authorized_keys`；加密私钥先通过 `ssh-add` 加入 Agent。
- 已填写的连接信息直接复用，不重复询问服务器地址或用户名。只在文件缺失、必需字段为空或连接信息失效时询问缺失或需要更新的信息。
- 按 dotenv 格式解析本地配置，保留字面值；不要通过 shell source、eval 或变量展开执行文件内容。
- 不在聊天、日志或命令行参数中输出私钥或口令，不把真实凭据写入示例或版本控制。私钥放在项目目录之外，不上传到服务器。
- 根目录 `.env` 仅用于本机 SSH 连接；`deploy/.env` 是服务器上的应用运行配置，使用方法见 `DEPLOY.md`。
- 上传代码或制作部署包时排除所有 `.env` 和 `.env.*` 文件（包括本地凭据的副本），保留服务器已有的 `deploy/.env`。确需初始化服务器应用配置时，单独处理无凭据的 `deploy/.env.example`。
- Docker 构建上下文必须排除本地环境配置和 `.ssh/`；不向容器或前端传入 SSH 私钥或口令。
