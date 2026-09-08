# 条形图视频生成工作室 · Bar Chart Video Studio

> 导入一段「时间 × 实体 × 数值」的统计表，自动生成条形图随时间变化的动态视频（bar chart race），一键导出 mp4 用于发布。
> 单机单用户 Web 应用：渲染与录屏全在浏览器完成，零服务器算力。

## 快速开始

```bash
# 需要 Node.js ≥ 20
npm install
npm run dev        # 一键起前后端
```

- 前端：<http://localhost:5173>
- 后端 API：<http://127.0.0.1:8787/api/v1/health>

首次使用：新建项目 → 「数据」页导入 CSV / Excel / 粘贴表格（`packages/frontend/public/示例-全球手机出货量.csv` 可直接试跑）→ 「编辑器」调配置与预览 → 「导出」生成 mp4。

## 功能

- **数据导入**：CSV（自动识别 UTF-8 / GBK 编码）、Excel(.xlsx)、JSON 长表、Excel 区域直接粘贴；支持长表（time/entity/value 三列）与宽表（行=时间列=实体，或转置）自动转换；导入前给出校验报告（无法解析的数值、缺失行）。
- **时间轴回放**：播放 / 暂停 / 0.5×–4× 变速 / 拖动进度 / 单步跳时间点。
- **视觉配置**：标题、副标题、来源角标、条数上限、每段时间、头尾定格、3 套配色、数值小数位、排名序号、时间标签位置与模式（按步切换 / 连续插值）、字号档、背景色、横竖屏分辨率、帧率、码率。
- **一键导出**：浏览器内隐藏画布按 1080p@30fps 重绘录制 → WebM → ffmpeg.wasm 就地转 H.264 mp4（yuv420p + faststart）；Chrome/Edge 126+ 走 mp4 直录免转码；转码失败自动降级交付 WebM。全程进度反馈。
- **作品记录**：成片可回看、下载、上传后端存档（跨设备再下载）。
- **政府公开数据源**：内置常用统计入口备忘 + CSV 直链 URL 抓取导入。

## 架构

```
Vue 3 前端（Vite + TS + Pinia）
  数据管理页 ──► 编辑器（Canvas 预览） ──► 导出页
       │                │                     │
  CSV/XLSX 解析      BarRaceRenderer       隐藏 1920×1080 画布
  宽表→长表          （纯函数 draw）        captureStream + MediaRecorder
       │                │                     │
       ▼                ▼                     ▼
  REST /api/v1   时间轴插值/排序        WebM ─► ffmpeg.wasm ─► mp4
                    （§6.1 算法）            （或 mp4 直录）
                          │
                          ▼
          Node.js 后端（Fastify + SQLite/better-sqlite3）
          项目 / 时序数据 / 配置 / 作品记录 CRUD + 文件存档
```

核心设计（详见 `docs/技术方案.md`）：

- **渲染内核自研**（`packages/frontend/src/renderer/`）：引擎是与 Vue 无关的纯绘制模块，预览画布与录制画布共用，仅尺寸参数不同；
- **动画算法**：值线性插值（lerp）产生平滑增长，Y 位置由插值后的值实时排序决定；相邻两步取 top-N **并集 + 0 值补位**，避免条数变化瞬间整组跳变；
- **录制即二次渲染**：导出在独立隐藏画布 + 独立渲染循环中进行，墙钟时间驱动（暂停/变速不丢时间），`captureStream(0)` + `requestFrame()` 精确控制帧率；
- **后端很薄**：只管数据与存档，永远不碰 ffmpeg/渲染；SQLite 单文件零配置（`packages/backend/data/app.db`）。

## 目录结构

```
bar-chart-video-studio/
├─ docs/技术方案.md            # 完整技术方案（需求/架构/算法/风险）
├─ packages/
│  ├─ shared/                  # 前后端共享：TS 类型 + zod schema
│  ├─ frontend/                # Vue 3 + Vite
│  │  └─ src/
│  │     ├─ renderer/          # ★ BarRaceRenderer（canvas 引擎）+ 插值/排序 + 配色
│  │     ├─ recorder/          # MediaRecorder + ffmpeg.wasm 导出链路
│  │     ├─ importer/          # CSV/XLSX 解析、宽表→长表、列映射猜测
│  │     ├─ stores/ pages/ api/ components/
│  │  └─ public/示例-全球手机出货量.csv
│  └─ backend/                 # Node + Fastify + better-sqlite3
│     ├─ src/routes/           # projects / datasets / records / datasources
│     ├─ src/services/         # 长表入库、time_order 赋值
│     └─ data/ storage/        # SQLite 库文件与产物存档（gitignore）
└─ package.json                # npm workspaces
```

## 使用注意

- 导出录制期间**保持标签页在前台**（浏览器会暂停后台渲染）；
- 期望**无声成片**：音轨/字幕由后期剪辑软件合成（产品决策，见方案 §11）；
- 若浏览器不支持 mp4 直录，首次转码需从 CDN 下载 ~30MB ffmpeg.wasm 内核，之后有缓存；
- AI 增强（DeepSeek 接入：一句话生成示例数据等）为二期插件位点，表结构与转发路由已预留（`ai_tasks` 表 / `/api/ai/*`）。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 同时启动前后端（开发模式，热更新） |
| `npm run build` | 构建前后端产物 |
| `npm start` | 生产模式运行后端（`packages/backend/dist`） |
| `npm run typecheck` | 全仓 TypeScript 类型检查 |
