# StudySteps 当前状态

更新日期：2026年9月17日

## 状态摘要

文档交接已经完成。STP 003 已在本地建立可重复安装、检查、测试和构建的 TypeScript 工作区骨架。这不等于完成 M0、STP 001 或 STP 002，也不等于接口已冻结或业务功能已验收。

STP 004 **继续进行中，不得标为完成**。GitHub Actions **CI #5**（run [`35179504850`](https://github.com/xyq-dev/studysteps/actions/runs/35179504850)，SHA `9118468`）**success**。STP 005 代码与 CI 夹具已在该 SHA。2026-09-17 走查曾记录 A02 目录无法展示、P05 刷新不回填；随后仅改 web／admin 前端，Chromium 复测两项已关闭，见 `docs/handoffs/STP005_BROWSER_EVIDENCE.md`。STP 005 **产品验收未完成**（完成状态保持）。STP 006 **第一批已在 `f0ffa10` 落地，S06 空白创建已在 `9a2c46f` 落地，暂停／恢复／归档已在 `9274f2e` 落地，按需 task-horizon 已在 `ca0edb6` 落地，单次改期已在 `1f3a4df` 落地，仅本次内容已在 `9703303` 落地，006-A 本次及未来内容与第九条已在 `72d02b2` 落地，006-B 本次及未来重复安排见实施报告第 16 节**；**不宣称整个 STP 006 阶段完成**。旧文「STP006 未授权实现」不再作为阻塞。GitHub Actions **CI #12**（run [`35311343207`](https://github.com/xyq-dev/studysteps/actions/runs/35311343207)，SHA `72d02b2`）在「Prepare isolated PostgreSQL」**failure**。基线 `f6f8652` 已冻结七→八夹具。本轮开放 SCHEDULE，push 后按新 SHA 跟踪 Actions。日志 API 403 时不编造远端测试数量。原库 `stp004_identity` 只读。测试目标为 `stp006_fresh`（第九条）；夹具 four-to-six／six-to-seven／seven-to-eight 保持各自原范围，`stp006_eight_to_nine` 停在九。`Implementation Gate = LOCAL_CODE_AUTHORIZED` 覆盖 STP 004／005 及 **STP 006 第一批＋S06＋计划状态＋horizon＋改期＋仅本次内容＋006-A＋006-B**（仍不覆盖拆分／horizon 工人或 STP 009）。

下文「STP 004 实现前审查」是 **2026-09-13 代码开始前快照**（当时 API 仅 `/health`、无业务 Prisma 模型）。它不是当前代码状态。当前实现状态以本段、`docs/TASKS.md` 的 STP 004 条目和上述报告为准。

## 2026-09-16 Git 与 CI

| 项目 | 事实 |
| --- | --- |
| 分支 | `main` 跟踪 `origin/main` |
| HEAD | `576da3da1e8083305b644ddc8fe16bf582b50648` |
| origin | `https://github.com/xyq-dev/studysteps.git` |
| Actions | [CI #1](https://github.com/xyq-dev/studysteps/actions/runs/35049218151) success；job `check` 1m 36s |
| 迁移 | CI #1 日志：四条 STP 004 迁移均 `Applying migration` 后成功；`stp004_api` nosuperuser。工作区现有六条迁移。旧第五／第六条仍只存在于 `stp004_identity_fresh` 与 `stp005_four_to_six`（checksum `3f20970f…`／`fbb1a0e7…`），**未 reset、未改账本**。修订版仅应用到 `stp005_rev_fresh` 与 `stp005_rev_four_to_six`（当时 checksum `2e765521…`／`93ffc8d0…`）。提交文件第五条为去掉末尾多余空行后的 `6f51d8e5…`。GitHub Actions **未跑本轮** |
| `pnpm test`（CI #1） | domain 10、contracts 6、ui/admin/web 各 1、api **84 passed / 0 skipped**；五套 `stp004.{concurrency,matrix,db,review,http}` 均执行 |
| `pnpm test`（本机 2026-09-16，历史） | domain 21、contracts 7、ui/admin/web 各 1、api **105 passed / 0 skipped**。当时宣称的「四项已修复」已被 2026-09-17 反例推翻，见实施报告第 11–12 节 |
| `pnpm test`（本机 2026-09-17 STP 006 第一批） | domain 28、contracts 7、ui/admin/web 各 1、api **131 passed / 0 skipped / 0 failed**；目标库 `stp006_fresh`／夹具 `stp006_six_to_seven`；exit 0 |
| Playwright E2E（本机 2026-09-17 STP 006 第一批） | 6 passed（STP004 UI、STP005 UI、STP005 walkthrough×3、STP006 walkthrough）；exit 0 |
| `pnpm test`（本机 2026-09-17 STP 006 第二批 S06） | domain 29、contracts 8、ui/admin/web 各 1、api **137 passed / 0 skipped / 0 failed**；目标库 `stp006_fresh`；exit 0 |
| Playwright E2E（本机 2026-09-17 STP 006 第二批 S06） | 7 passed（含 STP006 S06 walkthrough）；exit 0 |
| `pnpm test`（本机 2026-09-17 STP 006 计划状态控制） | domain 32、contracts 9、ui/admin/web 各 1、api **142 passed / 0 skipped / 0 failed**；目标库 `stp006_fresh`；exit 0 |
| Playwright E2E（本机 2026-09-17 STP 006 计划状态控制） | 8 passed（含模板导入、S06、状态 walkthrough）；exit 0 |
| `pnpm test`（本机 2026-09-17 STP 006 按需 horizon） | domain 32、contracts 10、ui/admin/web 各 1、api **149 passed / 0 skipped / 0 failed**；目标库 `stp006_fresh`；exit 0 |
| Playwright E2E（本机 2026-09-17 STP 006 按需 horizon） | 9 passed（含模板导入、S06、状态、horizon walkthrough）；exit 0 |
| `pnpm test`（本机 2026-09-18 STP 006 单次改期） | contracts 11、domain 33、ui/admin/web 各 1、api **160 passed / 0 skipped / 0 failed**；目标库 `stp006_fresh`／夹具 `stp006_seven_to_eight`；exit 0 |
| Playwright E2E（本机 2026-09-18 STP 006 单次改期） | 10 passed（含模板导入、S06、状态、horizon、改期 walkthrough）；exit 0 |
| `pnpm test`（本机 2026-09-18 STP 006 仅本次内容） | contracts 12、domain 34、ui/admin/web 各 1、api **164 passed / 0 skipped / 0 failed**；目标库 `stp006_fresh`；exit 0 |
| Playwright E2E（本机 2026-09-18 STP 006 仅本次内容） | 11 passed（含模板导入、S06、状态、horizon、改期、本次内容 walkthrough）；exit 0 |
| `pnpm test`（本机 2026-09-18 STP 006-A 本次及未来） | contracts 13、domain 35、ui/admin/web 各 1、api **173 passed / 0 skipped / 0 failed**；目标库 `stp006_fresh`／夹具 `stp006_eight_to_nine`；exit 0 |
| Playwright E2E（本机 2026-09-18 STP 006-A 本次及未来） | 12 passed（含 FUTURE content walkthrough）；CI 未配置 Playwright |
| `pnpm test`（本机 2026-09-18 STP 006-B 本次及未来重复安排） | contracts 13、domain 36、ui/admin/web 各 1、api **176 passed / 0 skipped / 0 failed**；目标库 `stp006_fresh`／夹具 `stp006_eight_to_nine`；exit 0 |
| Playwright E2E（本机 2026-09-18 STP 006-B 本次及未来重复安排） | 13 passed（含 FUTURE schedule walkthrough）；CI 未配置 Playwright |
| GitHub Actions `72d02b2` | [CI #12](https://github.com/xyq-dev/studysteps/actions/runs/35311343207) **failure**（Prepare isolated PostgreSQL）。日志 403；七→八 `migrate deploy` 会打上第九条 |
| STP 006 | 第一批 `f0ffa10`。S06 `9a2c46f`。暂停／恢复／归档 `9274f2e`。horizon `ca0edb6`。改期 `1f3a4df`。仅本次内容 `9703303`。006-A + 第九条 `72d02b2`。七→八夹具冻结 `f6f8652`。本轮 006-B SCHEDULE。拆分／horizon 工人未做。不得标整个阶段完成 |

下方「已核验的工作区事实」表保留 STP 003／审查时快照，其中“无 HEAD／CI 未跑”不是 2026-09-16 现状。

## STP 004 实现前审查（2026-09-13 历史快照，非当前代码）

| 项目 | 状态 | 证据／边界 |
| --- | --- | --- |
| 数据模型与迁移设计 | 已审查 | 五个核心实体及身份 lookup／challenge、policy／不可变 version、pairing、幂等支撑实体、复合关联与统一锁序已明确；本轮未修改 Schema 或创建 migration |
| 年龄与年级 | 已审查 | 两组字段与规则完全分离；完整学制／年级映射仍归 STP 005 |
| 同意与建档 | 已审查 | 年龄未确认不持久化档案；适用同意、档案和主监护关系要求同一事务；正式 policy 与责任主体仍待确认 |
| 档案隔离与鉴权 | 已审查 | GuardianSession 每个对象检查具体 link；StudentSession 只绑定一个档案；不存在与越权对象响应同形 |
| 二次验证与配对 | 已审查 | 学生会话不能提权；回家长模式重新验证；配对以 `pairingId + code` 定位，短期、单次、摘要存储、限次、并发单成功 |
| 撤销传播 | 已审查 | 设备、关系和必要同意撤销的事务与后续请求拒绝边界已明确；真实通知 worker 留待后续复测 |
| API 与验收矩阵 | 已审查 | 请求响应、错误码、幂等、版本冲突及越权／重放／过期／并发用例已列出，执行状态全部为未执行或延后 |
| Cursor 实施提示词 | 已生成 | `docs/CURSOR_STP004_PROMPT.md`；门禁未解除时只允许核验报告 |

本次审查核验：origin 为 `https://github.com/xyq-dev/studysteps.git`，分支 `main`，HEAD 不存在，远端 heads/tags 为空，全部现有文件均为 untracked。API 仍只有 `/health`，Prisma 仍为空业务 Schema。当前机器无 Docker、`psql` 或 `pg_isready`，不能在本轮提供 PostgreSQL migration、约束或并发证据。

本轮只修改文档；未重跑 STP 003，未运行安装、lint、typecheck、test、build 或 Prisma 命令，未执行迁移、commit、push、pack 或部署。

## 已核验的工作区事实

| 项目 | 核验结果 |
| --- | --- |
| 工作目录 | `D:\Program Files\PycharmProjects\studysteps` |
| Git | 本地已 `git init -b main`；存在 `.git` |
| 分支 | `main`（尚未产生 commit） |
| HEAD | 不存在 |
| origin | `https://github.com/xyq-dev/studysteps.git` |
| 远端历史 | `git ls-remote` 为空，无提交 |
| 包管理器 | pnpm `10.17.0`，根锁文件 `pnpm-lock.yaml` |
| 目标 Node | 22（`engines.node`: `>=22.14.0`；本机执行时为 Node `23.9.0`） |
| 源码骨架 | `apps/web`、`apps/admin`、`apps/api`、`packages/contracts`、`packages/domain`、`packages/ui` |
| Prisma | `prisma/schema.prisma` 仅 PostgreSQL datasource 与 generator；无业务模型；无 `prisma/migrations` |
| CI 配置 | `.github/workflows/ci.yml` 使用与本地相同的冻结安装及根命令；GitHub 上尚未实际跑过 |
| Docker | 本机无 Docker；`docker-compose.yml` 与 `apps/api/Dockerfile` 未执行 |

原始 DOCX 已保留且未修改：

- 文件：`docs/PROJECT_PLAN.docx`
- 大小：71,411 字节
- SHA-256：`259af271f9ea1fe97f137c9c6162c694a39c05143757aae6acc2e8a18ab064e7`

转换稿 `docs/PROJECT_PLAN.md` SHA-256 仍为 `0cda8935d67e6eaf03d2fcb1d9b477f9751ee2999cb6518cd52b0f20d3d9f2c2`。

## STP 003 交付

| 类别 | 状态 | 说明 |
| --- | --- | --- |
| 工作区与锁文件 | 已完成 | pnpm workspace，`packageManager` 固定为 `pnpm@10.17.0` |
| Web / Admin 骨架 | 已完成 | React 19.3.0 + Vite 7.3.6，仅显示应用标识与“工程初始化中” |
| API 骨架 | 已完成 | NestJS 11.1.16，仅 `GET /health` |
| 共享包边界 | 已完成 | contracts / domain / ui 可构建、可测试、可被应用导入 |
| Prisma 空基础 | 已完成 | 静态校验通过，无业务迁移 |
| CI 工作流文件 | 已写入 | 未在 GitHub Actions 实际运行 |
| 文档 | 已更新 | `README.md`、`AGENTS.md` 项目命令、本文件与 `TASKS.md` |

STP 003 选择并写入工作区的版本：

| 工具 | 固定版本 | 理由 |
| --- | --- | --- |
| Node.js | 22（engines `>=22.14.0`） | LTS 基线；不把本机 Node 23 当作项目目标 |
| pnpm | 10.17.0 | 本机可用，写入 `packageManager` |
| TypeScript | 5.9.3 | 与 NestJS 11 兼容；不使用 TypeScript 7 |
| React | 19.3.0 | 当前稳定 React |
| Vite | 7.3.6 | 与 Vitest 3.2.7 配对 |
| NestJS | 11.1.16（CLI 11.0.24） | 稳定 CommonJS 应用线；NestJS 12 为 ESM-only |
| Prisma | 6.19.3 | datasource 留在 schema 内；Prisma 8 仍为 RC |
| ESLint | 9.39.5 | 与 typescript-eslint 8.70.0 兼容；安装时登记处已标 deprecated，未改用 ESLint 10 |

## STP 003 验证证据

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile`（含清空 `node_modules` 后重装） | 0 | 锁文件被采用 |
| `pnpm lint` | 0 | 根 ESLint 覆盖工作区 |
| `pnpm typecheck` | 0 | 三个应用与三个包均检查 |
| `pnpm test` | 0 | 9 个用例通过，无空脚本 / `passWithNoTests` |
| `pnpm build` | 0 | packages 与三个应用均可构建 |
| `pnpm prisma:validate` | 0 | schema 有效，无迁移 |
| `GET http://127.0.0.1:3000/health` | HTTP 200 | `{"status":"ok","service":"studysteps-api"}`，响应不含环境密钥 |
| Web `http://127.0.0.1:5173` | HTTP 200 | Vite 开发服务可启动 |
| Admin `http://127.0.0.1:5174` | HTTP 200 | Vite 开发服务可启动 |
| `docker` / Compose | 未执行 | 本机无 Docker |

STP 003 实施轮未 commit、未 push、未 pack、未执行数据库迁移、未部署。

## 此前文档交接（仍有效）

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `docs/PROJECT_PLAN.docx` | 已保留 | 原始方案，不覆盖、不删除 |
| `docs/PROJECT_PLAN.md` | 已完成 | 按 DOCX 正文顺序转换 |
| `AGENTS.md` | 已更新 | 补充 STP 003 后的项目命令；产品与架构结论未改 |
| `docs/TASKS.md` | 已更新 | STP 003 保持已完成；STP 004 标记为实现前审查完成、代码受阻 |
| `docs/CURSOR_PROMPTS.md` | 已保留 | 首个代码批次提示词 |
| `docs/STP004_DESIGN.md` | 已完成 | STP 004 实现前设计、迁移影响、API、安全边界与验收矩阵 |
| `docs/STP005_DESIGN.md` | 设计基线＋本轮授权后实现对照 | 39 模板、单通道 PATCH、7.7 目录锁；实现证据见 `STP005_IMPLEMENTATION_REPORT.md` |
| `docs/CURSOR_STP004_PROMPT.md` | 已完成 | 独立的条件式 Cursor 实施提示词；当前门禁仍阻塞 |

`PROJECT_PLAN.md` 的转换核验基线：

- 267 个顶层正文块：244 个段落、23 张表；
- 标题层级：1 个文档标题、20 个一级章节标题、52 个二级小节标题；
- 23 张表，共 214 行、643 个单元格；
- 19 个章内导航链接与对应锚点；
- 41 个链接实例，其中 22 个外部链接实例、10 个唯一外部地址；
- 两处分页位置已保留为 Markdown 中的换行标记。

## 已确定且继续沿用的方向

- 独立项目、独立数据库和账号域，不与 Yuwang／渔网杯共用业务数据或权限。
- P0 首发手机优先 H5，管理后台为桌面网页；小程序和原生应用在试点后评估。
- React＋TypeScript＋Vite、NestJS＋TypeScript、PostgreSQL＋Prisma。
- 模块化单体、数据库 Outbox；首期不拆微服务。
- P0 同时交付档案授权、任务计划、完成记录、计时、复盘、家庭协作、后台基础及数据导出／删除能力。
- P0 不接照片、外部 AI、支付、题库、社区或外部通知渠道。
- 对象级档案授权、未成年人同意留痕、幂等、乐观锁、历史快照、UTC 与本地学习日、事务一致性均为验收约束。

## 阶段与任务状态

| 阶段 | 任务 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| 接手 | 文档转换与任务拆分 | 已完成 | 仅代表文档交付完成 |
| M0 | STP 001 固定 P0 规则与页面清单 | 进行中（本阶段范围文档已出；全量 M0 未冻结） | 六份专题文档已按 STP 004 范围抽取，不宣称全量评审完成 |
| M0 | STP 002 关键页面高保真与状态 | 待开始 | 高保真稿未完成 |
| M1 | STP 003 独立仓库与 CI 基础 | 已完成 | 本地骨架、锁文件与根命令已验收；远端 `main@576da3d`；CI #1 run 35049218151 success |
| M1 | STP 004 档案与授权基础 | 进行中 | 隔离库证据见实施报告第 10–11 节；CI #1 五套集成测试 84/0 未 skip；不得标完成；T02-D 本地已在 STP 005 执行、待 CI；不得写“第 1–8 项均修复” |
| 基础内容 | STP 005 学段与模板种子 | 两个页面阻塞已关闭，产品验收未完成 | CI #5 `9118468`；P05／A02 复测见 `STP005_BROWSER_EVIDENCE.md` |
| M2 | STP 006 计划与任务生成 | 第一批＋S06＋状态＋horizon＋改期＋仅本次＋006-A＋006-B 已实施；整个阶段未完成 | 1–9 未改写本批。无第十条。拆分／horizon 工人未做 |
| M2 | STP 007 完成与计时 | 待开始 | 依赖 STP 006 的稳定任务实例模型 |
| M3 | STP 008 报告与家庭协作 | 待开始 | 依赖可靠的完成、调整和计时记录 |
| M4 | STP 009 后台与数据权利 | 待开始 | 依赖前述业务对象和权限边界 |
| M5 | STP 010 试点发布准备 | 待开始 | 依赖 STP 001 至 STP 009 验收完成 |

## 尚未确定的事项

以下业务项由原方案明确留待正式开发前最终确定，不得由实施代理擅自假设：

- 正式品牌名称；
- 实际经营主体与隐私责任主体；
- 首批家庭的实际使用入口；
- 可投入的开发人力。

以下工程细节已在 STP 003 选定一部分，其余仍待对应任务验证：

- 已选定：pnpm workspace、Node 22 目标、上表依赖版本、本地 origin 绑定。
- 仍未选定：认证、验证码、部署、监控等供应商及环境参数；GitHub 分支保护；测试设备、性能测试资源和备份实现。CI 已有 #1 成功记录，不代表分支保护已开。

这些事项不阻塞继续整理页面与纯业务规则。涉及真实第三方、生产环境、真实用户或收费时，必须另行获得明确授权。

## 下一步

1. STP 004 仍进行中。不要把 STP 004 标完成。T11-3／CON-3 已覆盖模板 import、手动 `POST /plans` 与计划状态 PATCH；完成／计时仍延期。
2. STP 005：两个页面阻塞已关闭，产品验收未完成。STP 006 第一批＋S06＋状态＋horizon＋改期＋仅本次＋006-A＋006-B 本轮提交，**不宣称整个阶段完成**。Playwright 不在 CI 工作流中。不得宣称 M0／STP 002／接口已冻结。
3. 006-B 已开放 SCHEDULE。拆分／horizon 工人未做。原库与历史夹具保留。GitHub Actions 按新 SHA 跟踪；日志 403 时不编造远端测试数量。CI 未配置 Playwright。
