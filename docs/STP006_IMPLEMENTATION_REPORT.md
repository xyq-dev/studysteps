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

## 12. 本批：按需 task-horizon（2026-09-17）

实施前 HEAD：`9274f2e`（基线 `main@9274f2e`，与 `origin/main` 一致）。保留工作区既有未提交文件；本批只提交 horizon 相关改动。

原因：把 `POST /v1/students/:id/task-horizon` 从 `409 TASK_HORIZON_NOT_AVAILABLE` 换成真实、受授权控制的按需补齐，复用确认事务同一套展开／去重，而不是另写任务展开器。不接 worker／Outbox，不做范围编辑、改期、拆分、打卡、计时、通知或运营发布。

结构：现有 `task_occurrences` 唯一约束与 `idempotency_records` 足够；幂等成功体写入 `resourceId` JSON，避免跨日同键再生成。**未新增第八条迁移**。七条已发布迁移 checksum 与 test-v2 未改。写入仅隔离测试库／CI。原库与四→六、六→七夹具保持原范围。

接口：`POST /v1/students/:id/task-horizon`。沿用 `TASK_ADJUST`、当前同意、CSRF、幂等 `tasks.horizon`、7.7 锁序、锁内重验计划状态、成功 heartbeat。监护人 step-up 与其他学习写入相同，不要求共同制定。锁内读 `clock_timestamp()` 映射档案时区今日…今日+13。只 INSERT 缺失 key；`GET` 零补齐。返回 `from`／`to`／`insertedCount`／`skipped`。无新增为 200，授权失败为 4xx。

页面：S05／S08「更新未来任务」；处理中禁用；成功后重新读取任务。无 `useEffect` 自动 POST。

### 验收映射

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 已满窗口再补齐新增为零 | 通过 | HTTP T06-P-OK 后续 horizon `insertedCount=0` + `ALREADY_EXISTS` |
| 跨日夹具只补新窗口边，原行不变 | 通过 | HTTP 将 `occurrence_key`／开始日左移一日后只插入 `today+13`；未改系统时钟、无公开调时接口 |
| 结束日／非重复日／过去日不误补 | 通过 | HTTP 手动 DAILY 截止今日、WEEKLY_DAYS、跨日夹具不插入昨日 |
| 两重叠 POST 不重复实例 | 通过 | 并发：独立连接、`pg_blocking_pids`、每 `(seriesId, occurrenceKey)` 一行，两响应 `insertedCount` 之和为 1 |
| PAUSED／ARCHIVED 不生成，取消不复活 | 通过 | HTTP 200 + `PLAN_PAUSED`／`PLAN_ARCHIVED` skip；`USER_CANCELLED` 行保持 |
| 补齐与暂停／归档双提交顺序 | 通过 | 并发 pause-first／horizon-first 与 archive 对称；状态先提交时 `insertedCount=0`；补齐先提交后新行被正确取消 |
| 同意／会话撤销后写入与重放拒绝 | 通过 | HTTP 4xx；无计划 200+`NO_PLAN` 与 403／404／401 区分；GET 不补齐 |
| 升年级后新行新快照、旧行不变 | 通过 | HTTP 删缺口后 PROMOTE 再 POST：新年级只在新行 |
| Chromium 点击补齐，刷新一致 | 通过 | `stp006-horizon-walkthrough.spec.ts`；导入／S06／状态 walkthrough 仍绿 |
| 无第八条迁移 | 通过 | 仍 7 条；本批无新 migration 文件 |

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 10、domain 32、ui／admin／web 各 1、api **149 passed / 0 failed / 0 skipped** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| Playwright `apps/web` e2e | 0 | **9 passed / 0 failed**（含模板导入、S06、状态、horizon walkthrough） |
| GitHub Actions | push 后按完整 SHA 跟踪 | CI 未配置 Playwright，不宣称已执行；日志 403 时只写证据边界 |

用户可见：S08／S05 可点「更新未来任务」；已满窗口提示无需补齐；失败不假成功。STP 006 **整个阶段仍未完成**。STP 004／005 完成状态不变。未 pack／部署。未宣称 worker 验收。

## 13. 本批：仅本次任务改期（2026-09-18）

实施前 HEAD：`ca0edb6`（基线 `main@ca0edb6`，与 `origin/main` 一致）。保留工作区既有未提交文件；本批只提交单次改期及必要联动。

原因：落地「仅本次」改期——只改已有实例的实际安排日，不改重复规则、不重建实例、不覆盖同日另一实例。RESUME 从「窗口内 PLAN_PAUSED」扩到「今日及之后所有 PLAN_PAUSED」，否则改到 14 天外的任务暂停后会永久遗漏。不做范围编辑、拆分、worker／Outbox、打卡、计时或通知。

结构：`scheduled_local_date` 已独立于 `occurrence_key`。第八条最小增量只加 `task_occurrences.version`（默认 1），以支持实例乐观锁。七条已发布迁移 checksum 与 test-v2 未改。历史夹具 `stp006_six_to_seven` 保持七条、无 version 列。合法非空七→八在隔离库 `stp006_seven_to_eight` 用 `migrate deploy` 验证。写入只打隔离测试库／CI。

接口：`POST /v1/students/:id/tasks/:occurrenceId/reschedule`。沿用 `TASK_ADJUST`、当前同意、监护人 step-up、CSRF、幂等 `tasks.reschedule`、实例 `expectedVersion`、7.7 锁序、锁内重验、成功 heartbeat。改期与 `plan_adjustments`（`TASK_RESCHEDULED`）同一事务。无变化请求 200 且不写审计。horizon 仍按原始 key 去重。

页面：S05 任务卡「改期」→ 选择新日期 → 显示改期前后 → 确认；处理中防重复提交；取消不写库；失败保留输入；成功后按旧日＋新日重读列表。

### 验收映射

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 改期后 id／key／快照保持，安排日与审计正确 | 通过 | HTTP 真实 POST，不改夹具 key |
| 撞日不覆盖、不合并 | 通过 | HTTP `TASK_DATE_CONFLICT`，两行保持 |
| 改期后再 horizon 不重生原 key | 通过 | HTTP 计数仍 1 |
| 过去／非法状态／越权／旧版本拒绝 | 通过 | HTTP 400／409／404／401 |
| 同键重放不重复审计，同键异体冲突 | 通过 | HTTP 幂等 |
| 改期与暂停／归档、同意撤销真实竞争 | 通过 | 并发独立连接 + `pg_blocking_pids` |
| 超出 14 天改期后暂停再恢复仍正确 | 通过 | HTTP 真实改期后再 PAUSE／RESUME |
| Chromium 改期、确认、取消、刷新一致 | 通过 | `stp006-reschedule-walkthrough.spec.ts` |
| 合法七→八升级 | 通过 | `stp006_seven_to_eight` + `migrate deploy`；`stp006_six_to_seven` 仍 7 条且无 version 列 |

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 11、domain 33、ui／admin／web 各 1、api **160 passed / 0 failed / 0 skipped** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| Playwright `apps/web` e2e | 0 | **10 passed / 0 failed**（含模板导入、S06、状态、horizon、改期 walkthrough） |
| GitHub Actions | push 后按完整 SHA 跟踪 | CI 未配置 Playwright，不宣称已执行；日志 403 时只写证据边界 |

用户可见：S05 可改期并看到确认前后日期。STP 006 **整个阶段仍未完成**。STP 004／005 完成状态不变。未 pack／部署。范围编辑仍待办。

## 14. 本批：仅本次任务内容编辑（2026-09-18）

实施前 HEAD：`1f3a4df`（基线 `main@1f3a4df`，与 `origin/main` 一致）。保留工作区既有未提交文件；不把 `docs/handoffs/STP004_PG_ISOLATION.md` 的本地 PID 变化纳入提交。

原因：落地「仅本次」内容编辑——只改选中实例的正文快照，不改 series 默认内容与重复规则，不改安排日。未来规则编辑、拆分、worker／Outbox、打卡、计时、通知不做。

撞日 409：核对后**不修正**。`TASK_DATE_CONFLICT` 只在同一 `TaskSeries` 的另一实例已占用目标 `scheduledLocalDate` 时返回；实际安排日不是 `occurrence_key`，也不是全局唯一键。依据 `STP006_DESIGN` §4.2／4.3「同规则已有安排日」。不同系列可以同日并存。

结构：GET 已读 `nameSnapshot`／`subjectSnapshot`／`completionStandardSnapshot`／`durationMinutesSnapshot`／`stepsSnapshotJson`，无需第九条。八条已发布迁移与 test-v2 未改。历史夹具保持各自原范围。

接口：`PATCH /v1/students/:id/tasks/:occurrenceId`。字段与预览同一套长度。沿用 `TASK_ADJUST`、同意、step-up、CSRF、幂等 `tasks.edit`、实例 `expectedVersion`、锁序、锁内重验、成功 heartbeat。与 `plan_adjustments`（`TASK_CONTENT_EDITED`）同一事务。无变化 200 且不写审计。与改期共用实例 version，不得静默覆盖。

页面：S05「编辑本次」；标明仅影响本次；保存中禁用；取消不写库；失败保留输入；版本冲突提示重新加载。不展示「本次及未来」。

### 验收映射

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 本次编辑后 sibling／series 不变 | 通过 | HTTP：`edits only the selected occurrence snapshots and keeps series plus siblings` |
| id／key／安排日／年级快照保持 | 通过 | 同上；PATCH 不写 identity／日期／年级／来源列 |
| horizon 新行用原规则，已编辑行不被覆盖 | 通过 | HTTP 删缺口后再 POST；新行用 series，已编辑快照保留 |
| 暂停后恢复仍保留内容 | 通过 | HTTP pause／resume 后快照仍为编辑值 |
| 非法／越权／撤回／非法状态／旧 version | 通过 | HTTP：`rejects invalid, unauthorized, stale and paused content edits` |
| 幂等与审计数量 | 通过 | 同键同摘要不重复审计；无变化 200 且不写审计 |
| 编辑与改期同 version 并发；编辑与暂停／撤回 | 通过 | 独立连接 + `pg_blocking_pids`；败者 `VERSION_CONFLICT` 或锁内重验拒绝 |
| Chromium 编辑、取消、保存、刷新、另一实例不变 | 通过 | `stp006-edit-walkthrough.spec.ts` |

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 12、domain 34、ui／admin／web 各 1、api **164 passed / 0 failed / 0 skipped** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| Playwright `apps/web` e2e | 0 | **11 passed / 0 failed**（含模板导入、S06、状态、horizon、改期、本次内容 walkthrough） |
| GitHub Actions | push 后按完整 SHA 跟踪 | CI 未配置 Playwright，不宣称已执行；日志 403 时只写证据边界 |

用户可见：S05 可「编辑本次」。STP 006 **整个阶段仍未完成**。STP 004／005 完成状态不变。未 pack／部署。未来规则编辑仍待办。

## 15. 本批：006-A 本次及未来内容修改（2026-09-18）

实施前 HEAD：`9703303edbcde6d32940bbc805a83a08c939bb4b`。保留 Codex 未提交定稿文档；不把 `docs/handoffs/STP004_PG_ISOLATION.md` 的本地 PID 纳入提交。

原因：按 §15 落地稳定 series + 双轴 revision、真实例外指针、CONTENT 预览／确认，以及 revision-aware horizon。SCHEDULE 入口未启用。第九条一次铺双轴。

切点：只读锚点 `occurrenceKey`（含）。`scheduledLocalDate` 只管日历、历史资格与撞日。例外只认 `PlanAdjustment` 指针，改回默认值仍保护。CONTENT 不改日期、原始 key、身份、年级快照或学生确认。

### 验收映射

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 切点前后、改期锚点、其他系列不受影响 | 通过 | `stp006.http.spec.ts` FUTURE：改期锚点仍用原始 key；切点前实例与其他 series 名称不变 |
| 单次例外及改回默认值仍保护 | 通过 | HTTP 先改后改回仍保留指针；八→九夹具 `reverted` 行 name 已回基线但指针仍是首次 audit |
| CONTENT 不影响日期／SCHEDULE 解析 | 通过 | 改期实例日期／原始 key 保持；公开 schema 拒绝 `kind=SCHEDULE` |
| 连续修订与 horizon 选对版本 | 通过 | 第二切点后缺口 POST horizon 用第二次正文；第一切点行仍用第一次正文 |
| 新年级只进新行 | 通过 | 既有 promote／horizon 回归：旧行一年级，新行二年级 |
| 预览取消、陈旧 digest、无变化、幂等 | 通过 | preview 不写 revision；陈旧 digest `TASK_FUTURE_PREVIEW_STALE`；no-op 无 adjustment；同键同体 200、异体 409 |
| 失权重放拒绝 | 通过 | 撤回同意后同键确认非 200 |
| 五分钟配置不变，锁等待跨过 step-up | 通过 | 独立连接 + `pg_blocking_pids`；admin 事务内 `SET LOCAL session_replication_role=replica` 回写 `step_up_verified_at`，不改 `stepUpMs`；拒绝后无 FUTURE revision／audit |
| 与单次编辑／改期／状态竞争 | 通过 | 单次编辑先提交则 FUTURE 409；`pg_blocking_pids` 证明等待 |
| 第九条约束与八→九保留 | 通过 | fresh 9 条；合法非空八→九 digest 不变、例外指针回填、legacy／撞日／不可变拒绝 |
| Chromium 预览、取消、确认、例外、刷新 | 通过 | `stp006-future-content-walkthrough.spec.ts`；整包 e2e 12 passed |
| SCHEDULE 调整入口 | **未执行（006-B）** | 公开 schema 只接受 `CONTENT` |

对既有脏库 `stp006_fresh` 的第九条预检曾失败：9 条历史 `去重` 测试行 `end_local_date='2026-09-17'` 而 `effective_to_local_date` 为空。未猜测回填、未弱化约束。该库是可丢弃测试库，随后按 `scripts/stp006-fresh.mjs` 重建并成功应用九条。原库 `stp004_identity` 未写。

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 13、domain 35、ui/admin/web 各 1、api **173 passed / 0 skipped / 0 failed** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| `node scripts/stp006-fresh.mjs` | 0 | `stp006_fresh` applied=9 |
| `node scripts/stp006-eight-to-nine.mjs` | 0 | 业务 digest 保留；内容／改期例外指针回填；约束反例拒绝 |
| Playwright `apps/web` e2e | 0 | **12 passed**（含 FUTURE content walkthrough） |
| GitHub Actions `72d02b2` | **failure** | [CI #12](https://github.com/xyq-dev/studysteps/actions/runs/35311343207) job `105493855905` 在「Prepare isolated PostgreSQL」失败（约 36s）。日志 API 403，未读取到远端测试数量。根因：`stp006-seven-to-eight.mjs` 在已 resolve 前七条后仍 `migrate deploy`，第九条出现后会连同第八／九条一起应用，脚本随即以「必须仍为 8 条」失败。已改为与六→七相同：只 SQL 第八条并 `resolve --applied`，禁止后续目录骑行。 |

未执行：006-B SCHEDULE 调整、拆分、worker／Outbox、打卡、计时、通知、运营发布。结构测试不等于 006-B 验收。CI 未配置 Playwright，不宣称远端 E2E。

## 16. 本批：006-B 本次及未来重复安排调整（2026-09-18）

实施前 HEAD：`f6f86525c7628ac1c6a61490cda52a714a157d6c`。保留 `docs/handoffs/STP004_PG_ISOLATION.md` 的本地 PID 变化，不纳入提交。无第十条迁移。

原因：按 §15 在既有 future-change 路径开放 `kind=SCHEDULE`，协调已生成未来实例，并让 revision-aware horizon 在窗口外按新排期补齐。CONTENT 轴、单次例外指针和历史身份保持不变。

排期与例外：

- 切点仍是锚点原始 `occurrenceKey`（含）。`scheduledLocalDate` 只用于日历、历史资格和撞日。
- 无 schedule exception 的未来 `PLANNED` 若不再命中 → `CANCELLED/SERIES_RULE_REMOVED`，保留 id／key／原日／快照。
- 再命中同一 `SERIES_RULE_REMOVED` 行则恢复为 `PLANNED`；`USER_CANCELLED` 等其他原因不复活。
- schedule exception 保护实际日期和存在性，即使新规则不再命中原始 key；content exception 保护正文，不阻止排期协调。
- 批量结果写 `SERIES_FUTURE_SCHEDULE_CHANGED`，不伪装成 `TASK_RESCHEDULED`。
- 同 series 任意状态占用目标日 → 预览列出，确认 `409 TASK_DATE_CONFLICT`；不覆盖、不换日、不删终态。合法写入先协调已有行再插入 horizon 新日，避免中间顺序被当成业务撞日。
- 新增日只在锁内 `[today, today+13]` 插入；窗口外由之后 horizon 按有效 CONTENT／SCHEDULE 生成。GET 不补齐。

模型：第九条双轴结构足够完成本批。未改已发布 1–9 与 `test-v2`。未发现必须新增第十条的缺口。adjustment 不可变，因此 audit payload 记录 `addedKeys` 与计数；新行 id 出现在确认响应 `effects.added`，不回写 audit。

### 验收映射

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 真实 SCHEDULE 接口，切点前及其他系列不变 | 通过 | `stp006.http.spec.ts` FUTURE schedule：切点前实例保持 PLANNED；其他 series 不被取消 |
| 锚点改期、日程例外与内容例外分别处理 | 通过 | HTTP：改期行保留实际日与 key；内容例外名保留；schedule exception 不被取消 |
| 新增／移除／再纳入旧日 | 通过 | 每周一天取消同行；再纳入指定星期恢复同一 id／key／年级快照 |
| 同系列不可调整撞日拒绝，无部分更新 | 通过 | 占用窗口外日期后改回每天：预览列出 conflicts，确认 409，revision／series version 不变 |
| 连续 SCHEDULE 与 CONTENT↔SCHEDULE 双轴独立 | 通过 | 先 CONTENT 再 SCHEDULE 名称保留；再 CONTENT 日期／取消状态不变 |
| 调整后多次 horizon，无重复、无错误恢复 | 通过 | 删缺口后再 POST：新行用有效 CONTENT，旧教育快照不改；USER_CANCELLED 不复活 |
| 陈旧 digest、无变化、幂等异体 | 通过 | `TASK_FUTURE_PREVIEW_STALE`；no-op 无 adjustment；同键同体 200、异体 409 |
| 与 horizon／暂停的真实锁等待 | 通过 | 独立连接 + `pg_blocking_pids`；pause-first 后 SCHEDULE 409 且无 SCHEDULE revision |
| Chromium 预览、取消、确认、例外、撞日、刷新、再次补齐 | 通过 | `stp006-future-schedule-walkthrough.spec.ts`；整包 e2e 13 passed |
| 006-A 回归 | 通过 | 原 CONTENT HTTP／concurrency／content walkthrough 仍通过 |

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 13、domain 36、ui／admin／web 各 1、api **176 passed / 0 skipped / 0 failed** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| Playwright `apps/web` e2e | 0 | **13 passed**（含 FUTURE schedule walkthrough） |
| GitHub Actions | push 后按完整 SHA 跟踪 | CI 未配置 Playwright；日志 403 时不编造远端测试数量 |

未执行：拆分、worker／Outbox、打卡、计时、通知、运营发布、远端 E2E。STP 006 **整个阶段仍未完成**。STP 004／005 完成状态不变。

## 17. 本批：006-C 单次任务拆分（2026-09-18）

实施前 HEAD：`beddf9b42db9573f701d97f5613088770c8aac88`。保留 `docs/handoffs/STP004_PG_ISOLATION.md` 的本地 PID 变化，不纳入提交。

原因：按 §16 把尚未开始的一条实例拆成 2–8 条可独立执行的后续实例。子任务不能留在父 series（第九条 `UNIQUE(series_id, scheduled_local_date)` 含取消行，且 key 必须是合法本地日），因此每个子任务是同计划下新建的 `ONCE` series＋一行实例；父行留在原 series，变为 `CANCELLED` 且 `cancel_reason=SPLIT`。

父子与统计：

- 父 `id`／`occurrenceKey`／快照／例外／来源不变；`executable=false`。`GET .../tasks` 排除 `CANCELLED`，父离开日列表分母。
- 子任务各计 1；`sourceOccurrenceId` 指向父。子任务允许仅本次编辑与改期；FUTURE 与再次拆分在 preview／confirm／直接 API 均拒绝。
- 子年级快照取锁内当前合法教育。`TASK_SPLIT` 记录真实操作者，不写 `studentConfirmedAt`。共同制定不适用于拆分。
- 子 ONCE series 走现有 INSERT 触发器生成 `BASELINE` revision 1，occurrence 指针为 1。
- horizon 不重生父、不重复子；父 series 的 CONTENT／SCHEDULE 不覆盖子 series；`SPLIT` 父不得被改成其他取消原因或恢复。

第十条迁移：`20260918180000_stp006_split_parentage`。预检非法 `cancel_reason` 后加 CHECK（含 `SPLIT`）、`source_occurrence_id` 索引、不可变触发器、同计划／一层／禁止自指的延迟约束。未改写 1–9 与 `test-v2`。八→九改为只 SQL 第九条并 `resolve --applied`，避免 `migrate deploy` 追到第十条。新增 `stp006_nine_to_ten` 合法非空升级：业务 digest 保留后，真实违规写入被拒。原库只读。

### 验收映射

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 合法拆分、数量与过去／非法状态拒绝 | 通过 | HTTP：预览零写；1 条子任务 400；过去日期 400；确认后父 `SPLIT`、2 个 ONCE 子任务 |
| 父身份与快照保留；子归属、年级快照和审计 | 通过 | HTTP：父 id／key／名称／年级不变；子 `plan_id` 相同且有 BASELINE；`TASK_SPLIT` 含操作者 |
| 父从分母移除，子各计 1；刷新不重复 | 通过 | GET 日列表不含父、含子 2 条；再次 horizon 子仍为 2，父不复活 |
| 幂等、异体冲突、旧 version、陈旧预览 | 通过 | 同键同体 200；异体 `IDEMPOTENCY_CONFLICT`；旧 version `VERSION_CONFLICT`；错误 digest `TASK_SPLIT_PREVIEW_STALE` |
| 子任务直接 FUTURE／再拆拒绝 | 通过 | HTTP 409 `TASK_NOT_ADJUSTABLE`；H5 子任务无 FUTURE／拆分按钮 |
| 编辑／改期／暂停恢复后 SPLIT 父不复活 | 通过 | 子可 PATCH／reschedule；pause／resume 后父仍 `SPLIT`；SCHEDULE 不改 SPLIT 原因 |
| 跨计划／自引用／多层／指针改写拒绝 | 通过 | 第十条夹具与 `stp006.db.spec.ts` 真实违规写入 |
| 约束失败全部回滚 | 通过 | db 事务：父改 SPLIT 后跨计划子插入失败，父仍 `PLANNED` |
| 拆分与单次编辑的锁等待；重复拆分不生成两组子任务 | 通过 | 独立连接 + `pg_blocking_pids`；二次拆分 409，子任务仍为 2 |
| Chromium 预览取消、确认、刷新、子编辑／改期、入口限制 | 通过 | `stp006-split-walkthrough.spec.ts`；整包 e2e 14 passed |

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 14、domain 36、ui／admin／web 各 1、api **187 passed / 0 skipped / 0 failed** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| `node scripts/stp006-fresh.mjs` | 0 | `stp006_fresh` applied=10 |
| `node scripts/stp006-eight-to-nine.mjs` | 0 | 仍停在九条；未追到第十条 |
| `node scripts/stp006-nine-to-ten.mjs` | 0 | 业务 digest 保留；归属约束反例拒绝 |
| Playwright `apps/web` e2e | 0 | **14 passed**（含 split walkthrough） |
| GitHub Actions | push 后按完整 SHA 跟踪 | CI 未配置 Playwright；日志 403 时不编造远端测试数量 |

未执行：撤销拆分、多级拆分、通知 worker／T11-D、打卡、计时、运营发布、远端 E2E。STP 006 **整个阶段仍未完成**。STP 004／005 完成状态不变。

## 18. STP 006-D：horizon 后台自动补齐（standing-job）

日期：2026-09-19  
授权：用户持续授权实现 006-D、第十一条隔离迁移、普通 commit／push 及该 SHA 的 Actions。  
基线：`main@9b180e1a09a1b83ff1811b588277346e1a56c640`

### 目录与 Git

| 项 | 结果 |
| --- | --- |
| 工作目录 | `D:\Program Files\PycharmProjects\studysteps` |
| origin | `https://github.com/xyq-dev/studysteps.git` |
| 分支 | `main` 跟踪 `origin/main` |
| 实施前 HEAD | `9b180e1a09a1b83ff1811b588277346e1a56c640` |
| 本轮提交 | `feat: add persistent task horizon worker`；完整 SHA 见提交后 `git log` |
| 保留未提交 | `docs/handoffs/STP004_PG_ISOLATION.md` 的本地 PID 变化不提交 |

### 改动原因与共享核心

原因：按 `STP006_DESIGN` 第 17 节补齐独立后台生成，使 ACTIVE 计划不再依赖用户点击 POST；同时修合同意校验、日期冲突被吞和拆分子 series 识别缺口。

共享核心只维护一套 `TaskHorizonCoreService.reconcilePlanLocked`：

- 锁后数据库时间；档案本地今日至今日+13，受计划边界限制。
- CONTENT／SCHEDULE 双轴；新实例用当前教育快照，旧实例保持。
- 原始 `occurrenceKey` 去重；显式识别拆分子 series（`sourceOccurrenceId`），不把普通 ONCE 当拆分。
- 不同原始 key 占同系列实际日整 plan 零写；不再 `skipDuplicates` 或笼统吞唯一键。
- 不复活 `USER_CANCELLED`／`SPLIT` 等受保护行，不重生拆分父任务。

HTTP `taskHorizon` 仍走人类会话、CSRF、step-up、幂等和成功 heartbeat；worker 走内部 `SYSTEM/HORIZON_WORKER_V1`。共享核心不等于共享或绕过两种授权入口。GET 仍不生成。

### 后台授权与失败恢复

worker 不伪造 Cookie／CSRF／step-up／学生确认／共同制定，不刷新人类 `lastSeenAt`。锁后重验 ACTIVE plan、档案与当前合法教育、当前必要 policy／document／consent，以及每条有效 ConsentRecord 对应的准确 GuardianLink 与 grantor Account ACTIVE。logout／会话过期／设备撤销不终止合法持续计划；账号、关系、同意、教育、档案或计划资格失效则 `BLOCKED`／`RETIRED` 且零写。未知查询错误继续失败。

standing-job 每 plan 一行。短事务 `FOR UPDATE SKIP LOCKED` 领取后提交，再开业务事务；job 是统一锁序最后一类。租约 + token CAS；处理中 generation 变化不会被完成清掉。八次有界技术退避后 `FAILED/RETRY_EXHAUSTED`，须 `--requeue-failed` 且固定 reason；业务阻断不计 attempt。旧 token 在租约接管后不能提交。

### 第十一条迁移

`20260919120000_stp006_task_horizon_jobs`。前十条与 `test-v2` 未改写。只读预检后建实际 UNIQUE／FK／CHECK／partial due 与 expired-lease 索引及状态一致性约束。既有计划回填 job，不生成任务、不激活旧计划。fresh 上界 11；九→十冻结在 10 且无 job 表；十→十一独立夹具 `stp006_ten_to_eleven`。原库与历史污染库只读。

### worker 命令

```bash
pnpm build
# 进程环境必须已有 HORIZON_WORKER_ENABLED=true
pnpm worker:horizon -- --continuous
pnpm worker:horizon -- --once --max-jobs=20 --max-ms=60000
pnpm worker:horizon -- --status
pnpm worker:horizon -- --requeue-failed=<planId> --reason=OPERATOR_RETRY_AFTER_DIAGNOSIS
```

导入 `AppModule`、启动 API、普通单测和历史升级夹具不启动后台循环。CI 只用有界 `--once`。本批集成测试用独立 `nest start --entryFile horizon-worker/main -- --once` 进程验收，退出码 0，无常驻 worker。

### 验收映射

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 无 HTTP 时独立 worker 生成缺失任务 | 通过 | `stp006.horizon-worker.spec.ts`：删 PLANNED 后 in-process `runOnce` 与真实 nest 进程均插入 |
| 同日重复、双 worker 不重复 | 通过 | 第二次 runOnce 行数不变；并行两个 worker 的 `(seriesId,occurrenceKey)` 唯一 |
| GET 不生成；日期冲突不再静默吞 | 通过 | GET 计数不变；不同 key 占同日 HTTP `409 TASK_DATE_CONFLICT` |
| logout 不终止合法计划；同意撤回阻断、再授后可补 | 通过 | logout 后仍生成；withdraw → `BLOCKED/CONSENT_REQUIRED`；regrant 后生成 |
| 租约过期旧 token 不能提交；八次后 FAILED 须显式 requeue | 通过 | completeSuccess CAS 拒绝旧 token；第 8 次 `RETRY_EXHAUSTED`，错误 reason 冲突，固定 reason 恢复 READY |
| generation 处理中变化不丢；锁等待中同意失效零写 | 通过 | signal 后 success 保留 requested=2 且立即 due；consent 行锁等待后撤回，planned=0 |
| worker 不刷新 heartbeat；API 不启动循环 | 通过 | `lastSeenAt` 不变；`AppModule` 取不到 `HorizonWorkerService` |
| 新实例当前年级快照 | 通过 | 补出的 PLANNED 行匹配当前档案 `gradeCode`／`gradeConfigVersionId` |
| 真实锁等待 | 通过 | 独立 pg 连接 + `pg_blocking_pids`：plan 锁与 consent 锁 |
| 第十一条与历史夹具上界 | 通过 | `stp006.db.spec` expected=11；nine-to-ten 无 job 表；ten-to-eleven digest 保留与约束反例 |
| HTTP 调用方回归 | 通过 | `stp006.http.spec` 32 与 `stp006.concurrency.spec` 16 全过 |

未在本批单独重跑的历史证据：006-A／B／C 的 FUTURE／拆分 walkthrough 全量、远端 Playwright。本批未弱化断言或 skip。

### 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 14、domain 40、ui／admin／web 各 1、api **206 passed / 0 skipped / 0 failed** |
| `pnpm build` | 0 | 通过；产物含 `apps/api/dist/horizon-worker/main.js` |
| `pnpm prisma:validate` | 0 | schema valid |
| Playwright `stp006-horizon-walkthrough` | 0 | **1 passed**（手动补齐按钮回归）。其余历史 walkthrough 本批未整套重跑；CI 未配置 Playwright |
| GitHub Actions | push 后按完整 SHA 跟踪 | 不编造远端测试数量；不宣称远程跑过 E2E |

未执行：生产启用、生产迁移、通知 worker、T11-D、打卡、计时、运营发布、pack／部署。006-D 实现通过不代表 STP 006 整体验收完成。STP 004／005 完成状态不变。B04 与生产 worker 仍延期。

## 19. 2026-09-22 七项验收阻塞修复

授权：用户持续授权本批修复、必要隔离迁移、测试、普通 commit／push。不进入 STP 007。

| 项 | 结果 |
| --- | --- |
| 实施前 HEAD | `8389a928500a4f1b0707913c13bfd69a67a795ea` |
| 分支 | `main` 跟踪 `origin/main` |
| 第十二条 | `20260922120000_stp006_horizon_job_reason_null_safe`；第十一条未改写 |
| 夹具 | 十→十一仍停 11；十一→十二 `stp006_eleven_to_twelve`；脏基线 `stp006_eleven_dirty` 被预检拒绝 |
| 目标库 | 仅 `stp006_fresh`／上述夹具；原库与历史污染库只读 |

原因：复审 `docs/handoffs/STP006_FINAL_REVIEW.md` 确认 B1–B7。先固化反例再最小修复。未新增“相同内容永远不能创建第二份”的去重。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | 通过 |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test` | 0 | contracts 14、domain 40、ui／admin／web 各 1、api **220 passed / 0 skipped / 0 failed** |
| `pnpm build` | 0 | 通过 |
| `pnpm prisma:validate` | 0 | schema valid |
| 公开 `pnpm worker:horizon -- --requeue-failed=…` 不存在 plan | 3 | 定稿 MISSING |
| 公开 `pnpm worker:horizon -- --reason=WRONG` | 2 | 非法参数 |
| Playwright 完整套件 | 0 | **14 passed / 0 failed / 0 skipped**（修复后代码）；CI 未配置 Playwright |
| GitHub Actions | 跟踪本轮完整 SHA | 不以 CI #16 代替；CI 未配置 Playwright |

未执行：独立复审、生产迁移、pack／部署、STP 007。STP 006 仍进行中。STP 004／005 状态不变。

