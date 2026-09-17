# STP 006 实施报告（第一批；整个阶段未完成）

日期：2026-09-17
授权来源：用户授权 STP 006 第一批实现、独占隔离库、隔离 test-v2 同意、第七条增量迁移；本轮另授权普通 commit／push。
未执行：pack、部署、生产迁移、STP 006 后续批次、STP 009、Playwright 进入 CI。GitHub Actions 在 push 后按新 SHA 跟踪，不以 CI #5（`9118468`）代替。

STP 004 **仍进行中，不得标完成**。STP 005 **产品验收未完成**（完成状态保持）。STP 006 **不宣称整个阶段完成**。

## 1. 目录与 Git

| 项 | 结果 |
| --- | --- |
| 工作目录 | `D:\Program Files\PycharmProjects\studysteps` |
| origin | `https://github.com/xyq-dev/studysteps.git` |
| 分支 | `main` 跟踪 `origin/main` |
| 实施前 HEAD | `911846895adcba9ad2958f2b4c707655903cd56a` |
| 基线 | `main@9118468` |
| 本轮提交 | 将第一批与已验证的 P05／A02 纳入 `origin/main`；自身 SHA 见提交后 `git log` |

保留既有未提交的 P05／A02、STP 005 E2E／文档改动。原库 `stp004_identity` 只读。未 drop 既有 `stp005_rev_*`、`stp005_four_to_six` 或 PostgreSQL 进程。

## 2. 改动原因与范围

原因：在已定稿设计上落地第一批计划闭环——从 S07 预览（S03）确认写入计划并生成窗口内任务，而不提前做 S06／改期／horizon 工人。

本批修改：第七条结构迁移与四表；domain 重复展开／同意用途；契约 preview／import／plans／tasks／horizon；API 真写入；H5 S07／S03／只读 S05／S08；隔离库脚本与 CI prepare；test-v2 由应用种子发布（不在结构迁移内）。

## 3. 新测试库、政策版本与迁移

| 项 | 事实 |
| --- | --- |
| 空库全量迁移 | `stp006_fresh` @ `127.0.0.1:6260`；`prisma migrate deploy` 应用 7 条；`study_plans`／`task_occurrences` 存在 |
| 六→七夹具 | `stp006_six_to_seven`；先 SQL 1–6 并插入基线学生「六到七基线」，再 SQL 7；目录计数保持；`(series_id, occurrence_key)` 重复写入被拒 |
| 仍保留 | `stp004_identity`、`stp005_rev_fresh`、`stp005_rev_four_to_six`、four-to-six 夹具脚本（继续只验四→六） |
| 政策 | 同一 `TEST_CHILD_CORE_SERVICE`／`TEST_MINOR_CORE_SERVICE`；`test-v1` 正文／scope／hash 未改；启动时 `ensureTestV2` 追加非正式 `test-v2`（计划／导入／实例／年级快照／操作者审计）。无公开政策发布接口 |
| 权限集 | `PRIMARY_GUARDIAN_V1` 仍为权限集 key，只补 PLAN_* 动作 |

回滚：第七条仅新表；有生产数据后禁 drop，前滚只加表。本轮未对生产或历史测试库 migrate。

## 4. 第一批完成范围

已做：

- S07 模板入口与学生侧入口；S03 预览／调整／确认／取消
- preview 不 INSERT 计划／规则／实例；取消无残留
- import 真实确认写入；监护人 `GUARDIAN_ASSISTED`、操作者、默认未勾选 `coCreationAttested`；step-up ≠ `studentConfirmedAt`
- GET plans／plan／tasks／task 只读；GET 不补齐
- 确认事务按规则展开档案时区今日至今日+13（再受计划日期约束）；去重 `(task_series_id, occurrence_key)`
- 年级快照固化；升年级不改写历史实例
- `POST .../task-horizon` 保留契约并返回 `409 TASK_HORIZON_NOT_AVAILABLE`

未做（后续批次）：范围编辑、改期、拆分、horizon 真补齐与 Outbox 工人、打卡、计时、通知、运营发布、B04 正式文案。S06 与暂停／恢复／归档已在后续小节落地。

## 5. 业务含义冲突（最小处理）

已配合法年级的 `POST .../templates/:id/import` 空 body 不再返回占位 `409 TEMPLATE_IMPORT_NOT_AVAILABLE`，而因确认契约校验返回 `400 VALIDATION_ERROR`。无映射仍先返回 `400 TEMPLATE_IMPORT_NOT_ALLOWED`。STP 005 HTTP 断言已按该真实确认语义调整，未 skip。

import 控制器不再先走会持锁的 `students.get` 再开第二事务，避免同意撤回插在两次事务之间；映射检查改为非锁定读取，锁内仍重验。

## 6. 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 7、domain 28、ui 1、admin 1、web 1、api **131 passed / 0 failed / 0 skipped** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| Playwright `apps/web` e2e | 0 | **6 passed / 0 failed**（STP004 UI、STP005 UI、STP005 walkthrough 3、STP006 walkthrough）；代码未再改业务路径，本轮未整套重跑 |
| CI 夹具门闸（本轮） | 0 | `stp005`／`stp006` upgrade-gate 与 isolation loader **13 passed** |
| GitHub Actions | push 后跟踪 | 不以 CI #5 绿灯代替 |

## 7. 用户可见变化

监护人在 S07 对合法映射模板进入 S03 预览，默认不勾选双方约定；确认后写入计划并生成窗口内任务，S08／S05 只读查看。学生视图有独立模板入口。无映射模板仍禁止导入。取消预览不创建业务数据。

## 8. 保留的既有改动

P05 刷新回填、A02 只读目录、STP 005 walkthrough／browser evidence、`apps/web/playwright.config.ts`、`apps/admin` 相关未提交改动均保留。

## 9. 未解决问题

- STP 006 后续：范围编辑、改期、拆分、horizon 工人
- B04 正式告知／经营主体
- STP 004 整体未完成；STP 005 产品验收未完成
- Playwright 不在 CI
- GitHub Actions 结果见 push 后的 run，不以本地 passed 数量写成 CI 数量

## 10. 第二批 S06 空白创建（2026-09-17）

实施前 HEAD：`f0ffa10903e0a87dec7c2b736cf6083ef059d3b1`（`main@f0ffa10`）。

原因：按定稿补 S06 填写 → 预览／确认 → 计划与任务可见，不提前做改期或 horizon。

结构：第七条已允许 `source_template_version_id` 为空；**未新增第八条迁移**。`origin` 仍为 `GUARDIAN_ASSISTED`／`STUDENT`，避免用 `MANUAL` 绕过双方约定 CHECK。test-v2 未改。

接口：`POST /v1/students/:id/plans/preview`（200，零 INSERT）；`POST /v1/students/:id/plans`（201，确认事务复用 14 天窗口与去重键）。自定义年级无映射禁止模板导入，手动创建按教育／同意／`PLAN_CREATE`。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 8、domain 29、ui／admin／web 各 1、api **137 passed / 0 failed / 0 skipped** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| Playwright | 0 | **7 passed / 0 failed**（含 S06 walkthrough） |
| GitHub Actions | push 后跟踪 | 不以 CI #6 代替；日志 403 时不编造 CI 测试数 |

用户可见：P05／S05／学生视图「自己添加」进入 S06；取消不写库；确认中禁用按钮；刷新后仍可打开计划。模板导入路径未删。

## 11. 本批：计划暂停／恢复／归档（2026-09-17）

实施前 HEAD：`9a2c46fca1e91977f59de48322a0f761f9c2b6e6`（基线 `main@9a2c46f`，与 `origin/main` 一致）。工作区无未提交业务改动。

原因：按 `docs/STP006_DESIGN.md` §3.5 落地计划状态控制，使暂停／归档计划不再生成新实例，且页面不再把已暂停计划显示为可继续执行。不做范围编辑、改期、拆分、horizon worker、Outbox、打卡、计时、通知或运营发布。

结构：现有 `study_plans.status`、`task_occurrences.status`／`cancel_reason`、`plan_adjustments` 足够；**未新增第八条迁移**。七条已发布迁移 checksum 与 test-v2 未改。写入仅隔离测试库／CI。原库与四→六、六→七夹具保持原范围。

接口：`PATCH /v1/students/:id/plans/:planId`（`action=PAUSE|RESUME|ARCHIVE`，`expectedVersion` 为计划 version）。沿用 `PLAN_UPDATE`、test-v2、CSRF、幂等 `plans.patch`、乐观锁、锁内重验、成功 heartbeat。监护人 step-up；不要求共同制定字段；不覆盖 `origin`／`studentConfirmedAt`。状态与审计同一事务。GET 仍不补齐。horizon 仍 `409 TASK_HORIZON_NOT_AVAILABLE`，本批不宣称工人运行效果。

归档为终态，无取消归档。S08 列表仍可查看归档记录。

### 验收映射

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 合法 PAUSE／RESUME／ARCHIVE 与非法转换 | 通过 | HTTP：pause resume archive persist… |
| 状态＋审计持久化，刷新一致 | 通过 | 同上；S08 `lastAdjustment` |
| 已生成实例 id／key／年级快照／历史保持 | 通过 | HTTP fingerprints；resume 不增行 |
| 同键同摘要不重复审计；同键异体／过期版本拒绝 | 通过 | HTTP idempotent… |
| 未授权／同意撤回／会话失效写入与重放拒绝 | 通过 | HTTP unauthorized… |
| 两状态变更竞争 | 通过 | T07：独立连接、`pg_blocking_pids`、败者 `VERSION_CONFLICT` |
| 状态写入与撤销竞争 | 通过 | CON-3 pause vs withdraw |
| 共用生成逻辑拒绝暂停／归档 | 通过 | domain `datesToMaterializeForPlan`；HTTP GET／horizon 后行数不变。**不是** worker 端到端 |
| S05／S08 按钮、归档确认、防重复、失败不假成功 | 通过 | Playwright status walkthrough |
| 模板导入与 S06 回归 | 通过 | 既有 walkthrough 仍绿 |
| GET 不补齐 | 通过 | 暂停后两次 GET 行数不变 |
| 无第八条迁移 | 通过 | db spec 仍断言 7 条 |

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 9、domain 32、ui／admin／web 各 1、api **142 passed / 0 failed / 0 skipped** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| Playwright `apps/web` e2e | 0 | **8 passed / 0 failed**（含模板导入、S06、本批状态 walkthrough） |
| GitHub Actions | push 后按完整 SHA 跟踪 | CI 未配置 Playwright，不宣称已执行；日志不可读时只写证据边界 |

用户可见：S08／S05 对 ACTIVE 计划可暂停／归档，对 PAUSED 可恢复／归档；归档前说明并确认；归档后只读查看历史。S05 显示「计划已暂停」且任务不可继续执行。STP 006 **整个阶段仍未完成**。STP 004／005 完成状态不变。未 pack／部署。

