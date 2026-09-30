# K线预测终端

基于 ES / NQ 历史分钟线的 Web 预测游戏：根据截止时刻之前的行情，判断下一根 K 线涨跌。界面为简体中文，风格接近期货交易终端。

## 安装与运行

```bash
npm install
npm run preprocess   # 首次必需：将 data/*_1min.txt 重采样为紧凑二进制
npm run dev          # 前端 http://localhost:5173 ，API http://127.0.0.1:3001
```

开发时 Vite 把 `/api` 代理到 Fastify。浏览器只打开前端地址。

其他脚本：

- `npm run dev:api` / `npm run dev:web` — 只启动后端或前端
- `npm run build` — 类型检查并构建前端
- `npm start` / `npm run preview` — 由后端在 http://127.0.0.1:5173 同时提供页面和 API（需先有 `dist/`，`preview` 会先构建）
- `npm test` — 单元测试（重采样、截断、评分、统计、SQLite）

环境变量（都有默认值）：

| 变量 | 默认 | 作用 |
|------|------|------|
| `PORT` | 开发 3001，`start`/`preview` 5173 | API 端口 |
| `HOST` | `127.0.0.1` | API 监听地址 |
| `DATABASE_PATH` | `data/app.sqlite` | SQLite 文件 |
| `CORS_ORIGIN` | `http://localhost:5173` | 允许的前端来源 |
| `VITE_API_BASE` | 空 | 前端直接请求的 API 源；空则走同源 `/api` |

## 数据说明

| 文件 | 说明 |
|------|------|
| `data/ES_1min.txt` / `data/NQ_1min.txt` | 1 分钟 OHLCV，约 2009-09 → 2026-09 |
| `data/ES_daily.txt` / `data/NQ_daily.txt` | 日线（参考用；图表日线由 1 分钟重采样生成） |

1 分钟格式（无表头）：

```text
MM/DD/YYYY,HH:mm,open,high,low,close,volume
```

**时区：** 时间戳按 `America/Chicago`（CME）解释。界面显示此时区。

**会话 / 日线：** Globex 风格交易日在 **17:00 CT** 换日。日线聚合该交易日开盘（前一日 17:00）至收盘（当日 17:00，不含）内的全部 1 分钟 bar。不跨会话空洞伪造 K 线。

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

## 统计维度

对局写入 `localStorage`，统计分析页包含：

- 总体：局数、胜负、胜率、当前/最长连胜连败、近 20/50/100 局胜率
- 按品种、预测周期、答题时图表周期
- 按小时（Chicago）、时段（亚洲 / 欧洲 / 美洲 RTH / 美洲 ETH）、星期
- 按预测方向、实际方向（暴露偏好）
- 按先验波动分位（ATR% 三分位）、揭晓后实体大小（标注为事后分析）
- 权益曲线（+1/−1）与滚动胜率、最近对局表、文字读数（n≥30 才比较强弱；附近似 Wilson 95% 区间）

## 架构

前端（`src/`）只负责展示和对局交互。后端是独立的 Node.js 进程，使用 [Fastify](https://fastify.dev/) 提供同一套 API：

- `GET /api/health`、`GET /api/meta`、`GET /api/bars`
- `POST /api/round/next`、`POST /api/round/reveal`、`POST /api/round/reveal-bracket`

K 线仍放在 `data/processed/*.bin`。启动时载入内存做随机抽题、ATR 和防泄漏截断；这些是整段数组扫描，不按行查询。SQLite（`data/app.sqlite`，Node 内置 `node:sqlite`）保存应用状态：

- `rounds`：服务端回合密钥（预测目标的下标）。答案不会返回给前端。`user_id` 目前为空
- `series_catalog`：已加载行情序列的根数和时间范围
- `users`、`sessions`：账户和登录预留表，本次没有注册、登录或鉴权路由

`request.userId` 现恒为 `null`。以后做登录时，在 `backend/src/modules/auth/plugin.ts` 里校验会话并写入这个字段；出题接口已经会把它记进 `rounds.user_id`。个人胜率统计仍在浏览器 `localStorage`，避免在没有用户身份时把所有人的记录混在一起。

## 技术栈

前端：Vite + React + TypeScript + lightweight-charts。后端：Fastify + SQLite。图表按窗口向 API 取 K 线，不把原始文本送进浏览器。
