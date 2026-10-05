# K线预测终端

基于 ES / NQ 历史分钟线的 Web 预测游戏：根据截止时刻之前的行情，判断下一根 K 线涨跌。界面为简体中文，风格接近期货交易终端。

## 安装与运行

```bash
npm install
docker compose up -d          # 启动 Redis（会话存储）
npm run preprocess            # 首次必需：将 data/*_1min.txt 重采样为紧凑二进制
npm run dev                   # 前端 http://localhost:5173 ，API http://127.0.0.1:3001
```

开发时 Vite 把 `/api` 代理到 Fastify。浏览器只打开前端地址。未登录会跳转到登录页。

其他脚本：

- `npm run dev:api` / `npm run dev:web` — 只启动后端或前端
- `npm run build` — 类型检查并构建前端
- `npm start` / `npm run preview` — 由后端在 http://127.0.0.1:5173 同时提供页面和 API（需先有 `dist/`，`preview` 会先构建）
- `npm test` — 单元测试（重采样、截断、评分、统计、鉴权、SQLite）

单台 Ubuntu 上的 Docker 部署（Caddy、应用、Redis）见 [DEPLOY.md](DEPLOY.md)。上面的 `docker compose up -d` 只启动本机开发用的 Redis。

环境变量（都有默认值）：

| 变量 | 默认 | 作用 |
|------|------|------|
| `PORT` | 开发 3001，`start`/`preview` 5173 | API 端口 |
| `HOST` | `127.0.0.1` | API 监听地址 |
| `DATABASE_PATH` | `data/app.sqlite` | SQLite 文件 |
| `CORS_ORIGIN` | `http://localhost:5173` | 允许的前端来源 |
| `VITE_API_BASE` | 空 | 前端直接请求的 API 源；空则走同源 `/api` |
| `REDIS_HOST` | `127.0.0.1` | Redis 主机；测试可用 `memory` 走内存会话 |
| `REDIS_PORT` | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | 空 | Redis 密码（可选） |
| `REDIS_DB` | `0` | Redis DB 序号 |
| `SESSION_TTL_SEC` | `604800`（7 天） | 会话过期时间 |
| `COOKIE_SECURE` | 未设置 | 设为 `1` 时 session cookie 带 `Secure`（HTTPS） |

## 数据说明

| 文件 | 说明 |
|------|------|
| `data/ES_1min.txt` / `data/NQ_1min.txt` | 1 分钟 OHLCV，约 2009-09 → 2026-09 |
| `data/ES_daily.txt` / `data/NQ_daily.txt` | 日线（参考用；图表日线由 1 分钟重采样生成） |

1 分钟格式（无表头）：

```text
MM/DD/YYYY,HH:mm,open,high,low,close,volume
```

**时区：** 原始文本里的时间是**美东时间**（`America/New_York`）：每天 17:00–17:59 ET 缺数据（CME 16:00–17:00 CT 休市），09:30 与 15:59 成交量突增（现货开收盘），周日首根 18:00。预处理按美东解析并存成 UTC 秒；之后的交易日、时段、K 线边界都按 `America/Chicago`（CME）计算，界面默认显示 Chicago 时间。

**会话 / 日线：** Globex 风格交易日在 **17:00 CT** 换日。日线聚合该交易日开盘（前一日 17:00）至收盘（当日 17:00，不含）内的全部 1 分钟 bar。4 小时线从 17:00 CT 起算（17、21、01、05、09、13 点），其余周期按整点对齐。不跨会话空洞伪造 K 线。

**时段（Chicago 时间，按目标 K 线开盘时刻判断）：** 亚洲 17:00–02:59，欧洲 03:00–08:29，美洲 RTH 08:30–14:59（现货 08:30–15:00），美洲 ETH 15:00–16:59（现货收盘后到 16:00 休市）。日线题都在 17:00 开盘时决策，时段过滤对日线不生效；日线的星期按交易日算。

改过解析规则后必须重新执行 `npm run preprocess`。旧版本（按 Chicago 解析原始文本）存下的对局记录，`cutoff` 比实际晚一小时，小时、时段（4h / 日线还有星期）也随之偏移，统计里这部分不准。

预处理输出：`data/processed/{ES,NQ}/{1m,5m,15m,30m,1h,4h,1d}.bin`（已加入 `.gitignore`）。

图表/预测周期：`1m / 5m / 15m / 30m / 1h / 4h / 1d`，由 1 分钟按时钟边界重采样（OHLCV：首开、最高、最低、末收、量求和）。

## 涨跌规则

- **涨**：下一根预测周期 K 线 `close > open`
- **跌**：`close < open`
- **十字星**（`close === open`）：不进入随机题库，每局必有明确方向

颜色约定：美股指数期货惯例 — **绿涨 / 红跌**（与 A 股红涨绿跌相反）。

## 防未来函数（泄漏规则）

对局中，预测目标是预测周期上开盘时刻为 **T** 的下一根 K 线（T 之前最后一根完整预测周期 K 线已可见）。

- **任意图表周期**只显示周期终点 `≤ T` 的 K 线
- 切到更小周期：不会露出目标 K 线内部的细线
- 切到更大周期：不会显示仍覆盖 T 之后价格的未收盘 K 线
- **浏览行情**模式可看完整历史
- 提交涨/跌后揭晓目标 K 线，截断放宽至该 K 线收盘；「下一题」再随机新的 T

## 用户与统计

需要先注册 / 登录。Session 保存在 **Redis**（httpOnly cookie `sid`），用户账户与对局统计保存在 **SQLite**。

- `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`
- `GET/POST/DELETE /api/stats/rounds`、`POST /api/stats/migrate`（一次性上传旧版 localStorage 记录）。单条记录序列化后不超过 4 KB，每个用户最多 10 万条
- 服务端出题记录（`rounds` 表）揭晓或过期 7 天后自动删除
- 出题 / 揭晓 / K 线接口需登录；未登录返回 401，前端跳转登录页

统计分析页包含：

- 总体：局数、胜负、胜率、当前/最长连胜连败、近 20/50/100 局胜率
- 按品种、预测周期、答题时图表周期
- 按小时（Chicago）、时段（亚洲 / 欧洲 / 美洲 RTH / 美洲 ETH）、星期，均按目标 K 线开盘时刻
- 按预测方向、实际方向（暴露偏好）
- 按先验波动分位（ATR% 三分位）、揭晓后实体大小（标注为事后分析）
- 权益曲线（+1/−1）与滚动胜率、最近对局表、文字读数（n≥30 才比较强弱；附近似 Wilson 95% 区间）

## 架构

前端（`src/`）只负责展示和对局交互。后端是独立的 Node.js 进程，使用 [Fastify](https://fastify.dev/) 提供同一套 API：

- `GET /api/health`、`GET /api/meta`、`GET /api/bars`
- `POST /api/round/next`、`POST /api/round/reveal`、`POST /api/round/reveal-bracket`
- 鉴权与统计见上一节

K 线仍放在 `data/processed/*.bin`。启动时载入内存做随机抽题、ATR 和防泄漏截断；这些是整段数组扫描，不按行查询。SQLite（`data/app.sqlite`，Node 内置 `node:sqlite`）保存应用状态：

- `users`：账号（scrypt 密码哈希）；登录名存在 `email` 列
- `user_rounds`：当前用户的对局统计（JSON payload）
- `rounds`：服务端回合密钥（预测目标的下标）。答案不会返回给前端；已登录时写入 `user_id`
- `series_catalog`：已加载行情序列的根数和时间范围
- `sessions` 表为历史预留；**实际会话只存 Redis**

密码用 Node `scrypt` 哈希。Session id 放在 httpOnly、SameSite=Lax 的 cookie 中。

## 技术栈

前端：Vite + React + TypeScript + lightweight-charts。后端：Fastify + SQLite + Redis。图表按窗口向 API 取 K 线，不把原始文本送进浏览器。
