# 机场地面保障作业管理平台

面向航班保障、机位分配、廊桥靠接、摆渡车调度、行李装卸、航油加注、除冰作业与延误处置的一体化机场地面保障作业工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 航班保障 | `flight` | 航班保障任务 | 保障编号、航班号、机型 |
| 机位分配 | `stand` | 停机位 | 机位编号、机位类型、适用机型 |
| 廊桥靠接 | `bridge` | 廊桥作业 | 作业编号、廊桥编号、对应机位 |
| 摆渡车调度 | `shuttle` | 摆渡车 | 车辆编号、核载人数、驾驶员 |
| 行李装卸 | `baggage` | 行李作业 | 作业编号、航班号、行李件数 |
| 机务勤务 | `line` | 勤务任务 | 任务编号、航班号、勤务项目 |
| 航油加注 | `fueling` | 加油作业 | 作业编号、航班号、油品规格 |
| 除冰作业 | `deice` | 除冰任务 | 任务编号、航班号、除冰液型号 |
| 地面电源 | `gpu` | 电源车 | 设备编号、设备类型、功率等级 |
| 航空器牵引 | `tow` | 牵引任务 | 任务编号、航班号、牵引车号 |
| 航空配餐 | `catering` | 配餐作业 | 作业编号、航班号、餐食数量 |
| 客舱清洁 | `cabin` | 清洁作业 | 作业编号、航班号、清洁班组 |
| 保障班组 | `team` | 保障班组 | 班组编号、班组名称、负责区域 |
| 特种车辆维保 | `vehmaint` | 维保记录 | 维保单号、车辆编号、维保类型 |
| 要客保障 | `vip` | 要客保障单 | 保障编号、航班号、要客等级 |
| 延误处置 | `delay` | 延误事件 | 事件编号、航班号、延误原因 |
| 机坪安全巡查 | `apron` | 巡查记录 | 巡查编号、巡查区域、巡查人员 |
| 保障资源调度 | `resplan` | 资源计划 | 计划编号、保障时段、机位需求 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `airport-ground-ops:entries` 这一项，或调用 `resetModule(模块)`。

## 航油加注月度用量（v2 口径）

航油加注历史上有三处数据源：主登记表、加注用量台账（加注量/金额）、油品规格台账、
静电接地检查表。v2 把四处数据在**唯一口径层** `src/data/fueling-domain.ts`
（`reconcileFuelingRows`）按作业编号合并后，再写入新存储键
`airport-ground-ops:entries:v2`：

- 首次打开 v2 会自动迁移旧的 `airport-ground-ops:entries`，迁移审计（去重清单、回填清单、
  原始台账快照）存在 `airport-ground-ops:fueling-reconcile-audit`。
- **存量数据结论：作业明细按新口径重算回填，历史已导出的月度报表留档不改。** 即主数据统一
  重算（漏加的已完成作业按航班日期回填、重复作业去重、加注量与油品规格对齐），已归档报表
  作为历史快照保留，之后导出的报表才代表新口径；审计快照保证可追溯。
- 页面合计与导出文件都只读 `monthlyUsageRows(month)`：当月、`已完成`、按作业编号去重后的
  规范化数据，两处数字必然一致。
- 状态流转走 `runFuelingAction`（必须按 `待加注 → 加注中 → 待确认 → 已完成` 顺序，且确认
  完成前静电接地检查必须合格）；保存时再次经过同一规范化口径。
- 导出走 `exportMonthlyFuelingUsage(month)`：逐行生成、每行落检查点；失败时报告失败步骤
  （准备/逐行写入/生成文件/保存文件/登记导出记录）与失败作业，再次导出从断点续行。若中断后
  源数据被修正，旧分片按签名作废，整体按新值重导，文件里不会出现旧值。检查点键：
  `airport-ground-ops:fueling-export-checkpoint`。
- 其它入口（通用 `listEntries` / `exportEntries` / `runAction`）遇到 `fueling` 会直接报错，
  强制走航油专用口径，保证同一笔记录在任何入口读到的值一致。
