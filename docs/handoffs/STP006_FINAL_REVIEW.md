# STP 006 既定范围最终复核

日期：2026-09-20
结论基线：`main@8389a928500a4f1b0707913c13bfd69a67a795ea`

## 1. 结论

**STP 006 既定范围仍有具体阻塞，当前不能通过整体验收。**

当前 SHA 的完整浏览器套件与公开 bounded worker 命令均实际通过；模板／手动创建、计划状态、显式 horizon、单次编辑／改期、CONTENT／SCHEDULE future、拆分等主流程也有对应行为证据。但是，本轮在独占审计库确认了以下反例：

1. 同一陈旧预览使用不同 `Idempotency-Key` 可连续创建两套不同计划，档案 version 不变，未满足双确认的幂等或 `VERSION_CONFLICT`。
2. 旧 worker 在租约被接管后进入异常处理，可清掉新 worker 的 token 并消耗新租约的 attempt。
3. `FAILED/RETRY_EXHAUSTED` 可经暂停→恢复（同意撤回→重授同理）变成 `READY`，绕过唯一允许的显式 requeue。
4. 第十一条迁移的实际 CHECK 接纳 `BLOCKED／FAILED／RETIRED + state_reason=NULL`。
5. 对不存在 plan 执行公开 requeue 命令返回退出码 4，而定稿契约要求 3。

另有锁后时钟与处理范围的静态实现偏差，见第 5 节。CI 绿灯、206 个 API 测试或 14 条浏览器通过均不能覆盖上述反例。

## 2. 现场与证据边界

| 项 | 本轮事实 |
| --- | --- |
| 工作目录 | `D:\Program Files\PycharmProjects\studysteps` |
| 分支 | `main` |
| HEAD | `8389a928500a4f1b0707913c13bfd69a67a795ea` |
| origin/main | 同一完整 SHA；ahead/behind=`0/0` |
| origin | `https://github.com/xyq-dev/studysteps.git` |
| 初始工作区 | 仅 `docs/handoffs/STP004_PG_ISOLATION.md` 的既有 PID 变化；未混入本报告改动 |
| CI #16 | 按任务给定事实为当前报告 SHA success；本轮未用 CI 代替 Playwright 或反例验证 |
| 原库／历史库 | 未写入；`runtime.env` 未覆盖 |
| 本轮写库 | 仅独占临时库 `stp006_final_review`；从空库实际应用 11 条迁移 |

复用同一 SHA 实施报告和 CI 的 lint／typecheck／unit／build／Prisma 证据，本轮没有为凑数量重跑完整根检查。临时探针位于忽略目录，不含 Cookie、凭证或儿童正文。

## 3. 要求—实现—证据—结论矩阵

| 要求 | 实现 | 行为证据 | 结论 |
| --- | --- | --- | --- |
| 模板导入与手动创建 | 两类 preview／confirm、授权、同意、共同制定、年级快照、幂等和确认事务已实现 | 当前 SHA 的 `STP 006 S07 preview confirm and student entry`、`STP 006 S06 fill preview confirm refresh and template still works` 均实际通过；既有 HTTP 用例覆盖取消零写、合法创建、陈旧预览、失权与快照 | **主流程通过，但双确认反例阻塞**，见 B1 |
| 暂停、恢复、归档 | 状态、未来实例协调、审计、乐观锁与幂等同事务 | 当前 SHA 的 `pause resume archive and archived history remain visible` 通过；既有 DB 并发证据覆盖状态与 horizon 线性化 | 通过项；不抵消 worker FAILED 状态机反例 |
| 显式 horizon | 人类 Cookie／Origin／CSRF／step-up／幂等／heartbeat adapter 调共享核心 | 当前 SHA 的 horizon walkthrough 通过；既有 HTTP/并发用例覆盖缺口、no-op、取消保护和真实 plan 锁 | 通过项 |
| 单次内容编辑与改期 | occurrence version、显式 exception adjustment、原始 key 保持 | 当前 SHA 的 edit 与 reschedule walkthrough 均通过；既有 API/DB 用例覆盖撞日、幂等、版本与 horizon 后不重生 | 通过项 |
| CONTENT／SCHEDULE future | 稳定 series、双轴 revision、原始 key 切点、例外保护 | 当前 SHA 的两条 future walkthrough 均通过，包含内容例外、排期例外和撞日阻断 | 主行为通过；组合竞争仍有非阻塞证据不足 |
| 单次拆分 | 父行 `CANCELLED/SPLIT`，每个子任务为同 plan 的 ONCE series，`sourceOccurrenceId` 追溯 | 当前 SHA 的 split walkthrough 通过；迁移 10 与既有 DB 用例覆盖同 plan、一层和不可变 | 通过项 |
| 后台 horizon worker | standing-job、独立进程、共享核心、租约/generation、执行锁内资格 | 本轮公开命令可无 HTTP 实际补回缺口并退出；静态调用链确认授权对象与共享核心 | **租约和状态机阻塞**，见 B2/B3；命令契约另有 B5 |
| 年级快照、权限、幂等和迁移 | 新行取当前合法教育；旧行不改；人类与 SYSTEM adapter 分离；迁移 11 增量 job 表 | 当前浏览器回归、既有 API/DB 证据、物理 catalog 与本轮约束反例 | 迁移 1–10 保持；**迁移 11 CHECK 阻塞**，见 B4 |

## 4. 006-D 专项复核

### 4.1 后台授权：实现链成立

- `planning-eligibility.service.ts:43-84` 读取 current policy/document 和未撤回、未 supersede 的准确 ConsentRecord，并检查该记录的 GuardianLink 与 grantor Account 均为 ACTIVE。
- `horizon-worker/service.ts:246-289` 将 consent 对应 link、link account、grantor account、policy、student、plan、series、occurrence 与 job 纳入发现锁集；统一锁序最终以 job 收尾。
- `horizon-worker/service.ts:143-170` 在完整锁集后重发现，读取数据库时间，再重验资格。
- worker module 无 controller，也不注入人类 IdentityService；公开 `task-horizon` 仍走人类鉴权、CSRF、step-up、幂等及成功 heartbeat。worker 未调用 `touchLastSeen`，客户端 DTO 不能提交 SYSTEM capability。

现有真实等待只直接覆盖 ConsentRecord 撤回；准确 GuardianLink revoke 与 grantor Account 失效的逐项 worker 竞争仍属证据不足，但静态锁集未发现绕过路径。

### 4.2 租约、generation、原子性

正常完成路径使用 `planId + leaseToken + claimedGeneration + 未过期` CAS，并把 occurrence 变化与 job 完成放在同一业务事务。处理中 signal 到达后，`requestedGeneration > claimedGeneration` 的成功完成路径会保留新 generation。

上述正确路径被 B2 的异常记录路径破坏：`recordTechnicalFailure` 没有携带旧 token/generation，因而可覆盖接管者。

### 4.3 共享核心

HTTP 在 `planning.service.ts:2258`、worker 在 `horizon-worker/service.ts:192` 调用同一个 `TaskHorizonCoreService.reconcilePlanLocked`。核心已明确：

- 先分类同 series 实际日冲突，返回 `DATE_OCCUPIED`，不再依赖 `skipDuplicates` 静默吞掉；
- 只恢复无 schedule exception 的 `SERIES_RULE_REMOVED`；
- 保留 content/schedule 单次例外、`USER_CANCELLED`、`SPLIT` 及其他终态；
- 以非空 `sourceOccurrenceId` 识别拆分子 series；普通 ONCE 不会因此被跳过。

本轮没有发现该共享语义的新行为反例。

### 4.4 第十一条迁移

- 相对迁移 10 基线 `9b180e1`，Git 对比只新增 `20260919120000_stp006_task_horizon_jobs`，前十条未改写。
- 独占空库实际应用 11 条迁移；catalog 实际得到 15 个约束、5 个索引和 1 个 plan trigger。
- 实际存在 `plan_id` PK、`study_plans(id) ON DELETE RESTRICT` FK、非空 lease token partial UNIQUE、due partial index、expired-lease partial index和 plan `AFTER INSERT` trigger。
- `stp006-ten-to-eleven.mjs` 先物理应用前十条，写入 ACTIVE／PAUSED／ARCHIVED、revision、exception、取消和 SPLIT 等非空第十态，再执行第十一条并比较既有业务 digest；该证据支持“只回填 job，不生成 occurrence、不改 plan 状态”。
- fresh 上界为 11；八→九停 9、九→十停 10 且断言无 job 表。

但 B4 证明实际 reason CHECK 并不符合设计声明的 null-safe 状态一致性，故迁移子项不能通过。

## 5. 功能阻塞、可复现反例与确定实现偏差

B1–B5 已在本轮独占库或公开进程命令中实际复现。B6–B7 是沿实际调用链即可确定的定稿偏差；为避免制造跨午夜长事务和超大历史数据，本轮没有另造破坏性规模探针，但它们不是仅凭测试数量推测出的覆盖不足。

### B1：同一预览可用不同幂等键创建两套计划

路径：真实 HTTP 鉴权 → 新建 UNDER_14 档案并接受当前同意 → 设置合法教育 → `POST /plans/preview` 一次 → 用同一 body、同一 `expectedStudentVersion=2`、两个不同 `Idempotency-Key` 顺序确认。

实际结果：

```text
first=201/OK
second=201/OK
distinctPlanIds=true
plansAdded=2
studentVersionBefore=2
studentVersionAfter=2
```

原因：`planning.service.ts:313` 校验档案 version，但 `persistConfirmedPlan`（`:2001-2102`）创建 plan/series/occurrence 后不推进该并发令牌。该顺序反例已经足以证明双确认并发串行后也会重复创建，违反设计 `STP006_DESIGN.md:145,237`。

最小修复方向：确认事务必须原子推进预览所依赖的创建版本，或引入等价的学生级 plan-creation revision；第二个不同 key 的陈旧确认返回 `409 VERSION_CONFLICT`。补同 preview／不同 key 的顺序与真实锁等待并发用例；同 key仍应幂等命中。

### B2：旧 worker 的异常记录覆盖新租约

反例使用实际 repository、两个独立 pg 连接及 `pg_blocking_pids`：令 A 租约过期，reaper 回收后由 B 取得新 token；持有 job 行锁，使 A 的迟到 failure 记录真实等待；释放后观察状态。

```text
realWait=true
takeoverTokenChanged=true
finalState=READY
newTokenPreserved=false
attempts=2
```

原因：`horizon-worker/service.ts:123-130` 的 catch 只传 `planId`；`task-horizon-job.repository.ts:316-397` 只按 `plan_id + state='LEASED'` 处理当前行，不校验触发异常的 lease token/claimed generation。现有旧-token测试只覆盖 success CAS，没有覆盖 catch 路径。

最小修复方向：`recordTechnicalFailure` 接收并 CAS `planId + leaseToken + claimedGeneration`；旧 token 更新 0 行时只记录受控日志，不改变当前 job，也不消耗新 generation 的重试预算。

### B3：FAILED 可绕过显式 requeue 复活

实际状态转移：

```text
initial=FAILED/RETRY_EXHAUSTED
pause/block => BLOCKED/PLAN_PAUSED
resume/signal => READY/null
attempts=0
```

原因：`task-horizon-job.repository.ts:423-448` 的 `block()` 仅排除 RETIRED，会改写 FAILED；`planning.service.ts:474-479` 的暂停／恢复随后完成上述链路。同意撤回／重授使用相同 block/signal 机制。

最小修复方向：普通 block 只允许 READY／BLOCKED／LEASED；不得改变 FAILED。归档／删除仍可将其显式转 RETIRED；FAILED 回 READY 只能走带审计和 generation CAS 的 requeue。

### B4：迁移 11 接纳缺失 state reason

`migration.sql:87-106` 的三个分支只写 `state_reason IN (...)`，没有写 `state_reason IS NOT NULL`。PostgreSQL CHECK 对 UNKNOWN 放行。本轮在物理第十一态分别回滚执行反例：

```text
BLOCKED + state_reason=NULL accepted=true
FAILED  + state_reason=NULL accepted=true
RETIRED + state_reason=NULL accepted=true
```

最小修复方向：第十一条已经进入 `main`，不要改写历史；用后续纯增量迁移先只读预检已有 NULL 异常，再重建 null-safe CHECK，并补三类 NULL 反例。非法非空字符串用例不能替代 NULL 用例。

### B5：公开 requeue 的不存在退出码错误

实际命令：

```text
pnpm worker:horizon -- --requeue-failed=00000000-0000-4000-8000-000000000099 --reason=OPERATOR_RETRY_AFTER_DIAGNOSIS
REQUEUE_MISSING_EXIT=4
```

定稿 `STP006_DESIGN.md:941` 要求不存在退出 3、状态/CAS 冲突退出 4。`horizon-worker/main.ts:82` 当前两个分支均写成 4。

最小修复方向：MISSING 返回 3，并补根 package 公开命令的进程级退出码测试。

### B6：锁后数据库时间没有贯穿下一次调度

worker 已在 `horizon-worker/service.ts:149` 取得锁后 DB now，但 `completeSuccess`、`completeBlocked` 和业务 `block` 又在 `task-horizon-job.repository.ts:150,199,426` 使用 `new Date()`。事务跨档案本地午夜时，核心可能按 D 日补到 D+13，而完成调度按 D+1 计算到 D+2 才复查，使 D+14 在一个本地日内缺失。

最小修复方向：把同一个锁后 DB now（或由它预计算的 nextAt）传入完成／阻断方法；不要在 repository 重新读取应用时钟。补跨本地午夜锁等待用例。

### B7：有界处理仍会先全量加载历史

`horizon-worker/service.ts:162-165,250-258` 两次加载 plan 下全部 occurrences/revisions；核心的 5,000 上限只统计窗口相关锁行。`task-horizon-job.repository.ts:120-133` 的过期租约 reaper 也没有 LIMIT，每次 claim 前可锁取并逐行处理全部过期 job。

最小修复方向：发现和执行查询只取根 series、有效 revisions、14 日候选 key/实际日所需行；reaper 使用有上限的 `SKIP LOCKED` 子批。补多年历史和超量过期 lease 的有界退出证据。

## 6. 本轮运行验证

### 6.1 完整 Playwright

实际发现：12 个 spec 文件、14 条用例。实际执行：

```text
14 passed
0 failed
0 skipped
0 flaky
duration=47.1s
exit=0
```

覆盖了 STP004 UI、STP005 UI/目录，以及 STP006 模板导入、手动创建、状态、显式 horizon、单次内容、改期、CONTENT future、SCHEDULE future、拆分。Playwright 在总结后打印了 reporter 内部 `step id not found` 诊断，但 JSON 结果仍为 expected=14、unexpected/skipped/flaky=0，进程退出 0；记录为非阻塞工具诊断，不伪装成测试失败。

### 6.2 对外交付 bounded worker 命令

在 API、Web、Admin 端口均未监听时，从审计库删除一个安全的重复任务实例，随后实际执行：

```text
pnpm worker:horizon -- --once --max-jobs=20 --max-ms=60000
```

结果：退出码 0；目标 `(seriesId, occurrenceKey)` 从 0 行恢复为 1 行；job=`READY`、`lastOutcome=GENERATED`、`lastExecutorKey=HORIZON_WORKER_V1`、`lastInsertedCount=1`、lease 已清空。命令后没有遗留 horizon worker，也没有通过 HTTP 发补齐请求。

这证明公开 bounded 命令的正常生成和退出路径可用，但不修复 B2/B3/B5。

## 7. 非阻塞证据不足

以下未发现对应行为反例，不与上述功能阻塞混为一谈：

- worker 与准确 GuardianLink revoke、grantor Account 失效的逐项真实锁等待未覆盖；现有动态等待主要是 ConsentRecord。
- 既有“双 worker”主要以并行执行加唯一结果证明防重；generation 中途 signal 主要是 repository 顺序调用。它们不能替代 B2 所需的接管后迟到异常测试。
- 两个不同时区和 DST 的 worker 动态日界证据不足；当前主要运行证据使用 `Asia/Shanghai`。
- 真实 StudentSession 确认后 `origin=STUDENT` 缺 API/E2E 行为证据；现有浏览器只证明学生能进入 S07。
- FUTURE／拆分与 archive、link、session 等每个方向的全部组合未逐项制造真实等待；已有统一锁序和主要竞争证据，没有据此发现新反例。
- 十→十一夹具的“旧年级”行只改变部分标签／catalog 字段，不能单独作为语义一致的跨年级快照证据；迁移 11 本身没有更新 occurrence 快照列。

当前 SHA 的“仅一条 horizon E2E”缺口已由本轮完整 14 条执行关闭。

## 8. 延期项与未执行项

既定延期，不作为本轮新增阻塞：

- 通知 worker 与 T11-D；
- STP 007 打卡、完成、计时；
- B04 正式文案、生产启用、生产迁移和部署；
- STP 009 运营发布与通用队列平台。

本轮未重复执行：`pnpm lint`、`pnpm typecheck`、完整 `pnpm test`、`pnpm build`、`pnpm prisma:validate`；复用当前 SHA 的实施报告、CI #16 success 与已有 206/0 测试证据。本轮没有修改业务代码、Schema、迁移、测试断言或完成状态，没有 commit／push／pack／部署，也没有进入 STP 007。

资源回收：已 drop `stp006_final_review`，删除本轮 `.local/stp006-final-review` 探针／结果目录；API、Vite、bounded worker 均无遗留监听或进程。PostgreSQL 在本轮开始时为停止状态，验证后已恢复为停止状态；其他既有开发进程未终止。`STP004_PG_ISOLATION.md` 恢复为本轮开始时的本地 PID 内容，未混入本报告变更。

## 9. 下一步与复验门槛

1. 修复 B1、B2、B3、B5、B6、B7；第十一条不改写，以后续增量迁移修复 B4。
2. 为每个反例增加行为／数据库测试，其中租约接管必须使用独立连接和真实锁等待。
3. 重跑相关 API/DB/worker 测试、公开 bounded worker 命令及完整 Playwright；再次核对迁移 catalog 和合法非空升级保留。
4. 上述阻塞全部关闭前，不把 STP 006 既定范围、006-D 或整个阶段标为验收通过；通知 worker／T11-D 仍单独延期。

## 10. 2026-09-22 阻塞修复记录（不是独立复审）

本轮按第 5 节反例做最小修复与回归，不改写原始结论。修复自测不能代替另一次独立复审。STP 006 仍进行中。

基线：`main@8389a928500a4f1b0707913c13bfd69a67a795ea`。实施后完整 SHA 见本轮提交，不以 CI #16 代替。

| 项 | 反例 | 修复 | 回归证据 |
| --- | --- | --- | --- |
| B1 | 同预览、同 `expectedStudentVersion`、不同幂等键连续 201，档案 version 不变 | `persistConfirmedPlan` 在同一事务校验并 `updateMany` 推进学生 version；0 行 → `VERSION_CONFLICT`。preview 仍零写 | `stp006.http.spec`：preview 不改 version；第二键 409 且仍 1 个计划；同键重放不推进；刷新 version 后可再建。`stp006.concurrency.spec`：双确认真实学生行锁等待，201+409，1 个计划 |
| B2 | 旧 worker 迟到失败清掉新租约 | `recordTechnicalFailure` CAS `planId+leaseToken+claimedGeneration`；0 行不改当前 job | `stp006.horizon-worker.spec`：A 过期 → B 接管 → 独立连接持锁使 A 延迟失败真实等待；B 的 token／LEASED／attempts 保持，B 可 `completeSuccess` |
| B3 | pause→resume 把 FAILED 变成 READY | `block()` 只改 READY／BLOCKED／LEASED；signal 本就如此 | 真实 PATCH pause／resume、consent withdraw／regrant 后 job 仍 `FAILED/RETRY_EXHAUSTED`；显式 requeue 后 worker 可 GENERATED |
| B4 | 第十一条 CHECK 接纳 BLOCKED／FAILED／RETIRED + NULL reason | 不改写 11；第十二条 `IS NOT NULL` + 合法 reason，只读预检阻断脏行 | `stp006_eleven_to_twelve` 合法 11→12 digest 保留；三类 NULL 写入被拒。`stp006_eleven_dirty` 预检拒绝，仍停 11 且保留 3 条 NULL。十→十一夹具仍停 11、无第十二条账本 |
| B5 | 公开 requeue 不存在 plan 退出 4 | `MISSING → 3`，冲突仍 4，参数／技术错误仍 2 | 对外 `pnpm worker:horizon -- --requeue-failed=00000000-0000-4000-8000-000000000099 --reason=OPERATOR_RETRY_AFTER_DIAGNOSIS` 实际退出 3；错误 reason 退出 2 |
| B6 | complete／block 再用 `new Date()` | 锁后 DB now 传入 `completeSuccess`／`completeBlocked`／`block` | 锁后 `2026-09-21T15:50:00Z`（上海 23:50）的 `next_due_at` 落在 2026-09-22 00:05+jitter，与应用时钟次日调度不同 |
| B7 | include 全量 occurrence／revision；reaper 无 LIMIT | 查询层按窗口 key／实际日／拆分子行与 `effectiveFrom <= window.to` 取 `limit+1`，超限 `SCOPE_LIMIT`；reaper `SKIP LOCKED LIMIT` | 窗口外 key、实际日占今日 → `DATE_OCCUPIED`；切点前＋窗口内 revision 均加载；`reapExpired(1)` 只收 1 条；5001 拆分子行 `SCOPE_LIMIT`，整 plan 不部分提交 |

仍未解决（保持第 7 节非阻塞项，不在本批扩大）：

- worker 与 GuardianLink revoke、grantor Account 失效的逐项真实锁等待仍不足。
- HTTP `task-horizon` 为锁完整性仍发现学生下全部 occurrence id；有界加载落在 worker／共享核心。
- 通知 worker、T11-D、STP 007、B04 生产启用仍延期。
- 本文件第 1–9 节的原始复审结论保持；本轮不是另一次独立复审已经通过。

## 11. 2026-09-22 七项修复独立定向复审

### 11.1 结论与现场

**结论：仍不可通过。** B1–B4 的原阻塞已关闭；B5、B6、B7 仍有当前提交可复现的功能反例。因此本轮不能给出“STP006 既定范围可通过”，也不能进入 STP007 设计或修改阶段完成状态。

- 实际目录：`D:\Program Files\PycharmProjects\studysteps`。
- 分支／HEAD／origin：`main@5c7093283ea76de7344867ac8c56988f41ae6aed`，与 `origin/main` 一致；相对报告基线无漂移。
- 复审开始时工作区仅有既存 `docs/handoffs/STP004_PG_ISOLATION.md` PID 行改动；本节是本轮唯一仓库增量，既存改动未覆盖。
- GitHub Actions [CI #17](https://github.com/xyq-dev/studysteps/actions/runs/35676234006) 的 API 元数据为当前完整 SHA、`completed/success`；`Prepare isolated PostgreSQL`、Lint、Typecheck、Test、Build、Prisma validate 均成功。CI 未配置 Playwright；本轮复用修复后本地完整 **14 passed / 0 failed / 0 skipped** 证据，没有把它写成远端数量。

### 11.2 B1–B7 结论矩阵

| 项 | 结论 | 本轮依据 |
| --- | --- | --- |
| B1 创建版本消耗 | **关闭** | 模板导入和手动创建共用 `persistConfirmedPlan`；`planning.service.ts:2103-2109` 在同一事务以 `id + version` CAS 推进档案版本。定向 HTTP 用例 1 passed；真实锁等待并发用例 1 passed，结果 201+409、仅一份计划、version 只加一。同键重放仍先重新鉴权，且不再推进版本；取得新版本后可有意再建一份。 |
| B2 旧 worker 延迟失败 | **关闭** | `horizon-worker/service.ts:123-136` 将原 token/generation 传给失败记录；`task-horizon-job.repository.ts:332-438` 的查询及全部失败 UPDATE 均 CAS `state + token + claimedGeneration`，零行直接返回，无按 planId 兜底。定向用例用独立连接和 `pg_blocking_pids` 复现 A 迟到、B 接管，B 的租约／attempt 保持并可完成。 |
| B3 FAILED 状态 | **关闭** | `signal` 与 `block` 的 WHERE 仅含 READY／BLOCKED／LEASED（repository `:441-495`），故 FAILED 的 state／reason／attempt／requested／processed 均为零行不变；归档可显式 RETIRED，只有 `requeueFailed` 可回 READY。真实 HTTP 暂停／恢复、撤回／重授及 requeue 用例通过。测试没有逐阶段单独打印两个 generation，但生产 SQL 的零行谓词足以确定它们未被更新，记为断言粒度不足而非行为反例。 |
| B4 第十二条迁移 | **关闭** | 1–11 未改写；合法非空 11→12 物理升级后迁移数 11→12，plan／occurrence／job 数为 4／10／4 且业务 digest 相同。约束 `convalidated=true`；6 个 NULL／非法非空组合均由目标 reason CHECK 拒绝，合法 READY／LEASED 接受。脏十一态迁移以 P3018/P0001 失败，3 条 NULL 行 digest、原约束定义 hash 和 validated 状态均保持，成功账本仍为 11。只读核对十→十一历史夹具仍停在 11。 |
| B5 公开 CLI | **未关闭** | 根命令实测：不存在=3、READY 冲突=4、非法参数=2，但 bootstrap 配置错误=**1**，契约要求 2。见 11.3。 |
| B6 锁后时间 | **未关闭** | 生成窗口、`completeSuccess`／`completeBlocked`／业务 `block` 已贯穿同一个锁后 DB `now`；现有午夜证据只是注入时间，不冒充真实跨午夜运行。但 `runOnce` 的进程预算仍用可回拨的 `Date.now()`，不是单调时钟，临时探针已越过 `max-ms` 后继续领取。见 11.4。 |
| B7 有界执行 | **未关闭** | 窗口 key／实际日／拆分子行和 revision 的数据库查询及 reaper LIMIT 已落地；直接核心测试也能返回 SCOPE_LIMIT。但真实 worker 在预锁发现阶段先抛 `VALIDATION_ERROR`，把结构超限误记为技术失败重试，未进入 `FAILED/SCOPE_LIMIT`。见 11.5。 |

### 11.3 B5 反例：bootstrap 错误未映射为退出码 2

实际公开根命令结果：

```text
missing plan = 3
READY/CAS conflict = 4
invalid argument = 2
invalid worker configuration = 1   # 预期 2
```

复现配置错误：

```powershell
$env:HORIZON_WORKER_ENABLED='true'
$env:HORIZON_WORKER_LEASE_MS='1'
pnpm worker:horizon -- --status
```

实际为 pnpm 退出 1，Nest 报 `HORIZON_WORKER_RENEW_MS must be < HORIZON_WORKER_LEASE_MS / 2`。原因是 `apps/api/src/horizon-worker/main.ts:60` 在 `try` 外执行 `NestFactory.createApplicationContext(...)`；RuntimeConfig 或 Prisma bootstrap 失败不会进入 `:92-94` 的 `process.exitCode = 2`。

最小修复：将 application-context 创建纳入最外层 `try/catch/finally`，app／worker 尚未创建时安全关闭；用准确的根 `pnpm worker:horizon` 命令增加配置失败和数据库初始化失败的进程级退出码测试。

### 11.4 B6 反例：`max-ms` 仍依赖墙钟

业务时间链已修正：worker 在 `horizon-worker/service.ts:153` 锁后读取 DB 时间，并把同一对象传给核心、`completeSuccess`、`completeBlocked`；暂停和同意／关系 block 的调用点也把各自锁后 `now` 传到 repository，repository `:165`、`:215`、`:473` 不再创建应用当前时间。`stp006.horizon-worker.spec.ts:742` 使用注入的 `2026-09-21T15:50:00Z` 验证下一上海本地日调度；它不是一次真实跨午夜等待，本复审不把它描述为后者。

但 `horizon-worker/service.ts:54-56` 仍以 `Date.now()` 建立和检查 `runOnce` 截止时间。对当前编译类做无数据库临时探针，将墙钟保持不前进、每批实际等待约 6ms：

```text
B6_BUDGET processed=3 claims=3 maxMs=1 monotonicElapsedMs=19.3
```

这证明墙钟回拨／停滞时会在单调时间已经超过预算后继续 claim，违反 `max-ms` 硬截止。最小修复：只把进程预算改为 `performance.now()` 或 `process.hrtime.bigint()`；业务时间继续使用锁后数据库时间，并增加墙钟回拨的纯进程测试。

### 11.5 B7 反例：真实 worker 将结构超限当技术失败

在独占十二迁移审计库中，复用定向测试产生的计划，确认其有 5,002 条 occurrence（含 5,001 个拆分来源行），把该 plan 的 job 单独置为到期 READY，然后执行对外交付命令：

```text
pnpm worker:horizon -- --once --max-jobs=20 --max-ms=60000

before: READY | reason=NULL | attempt=0 | requested=1 | processed=0 | occurrences=5002
log:    technical_failure / VALIDATION_ERROR
after:  READY | reason=NULL | attempt=1 | requested=1 | processed=0 |
        last_outcome=FAILED | last_error_code=VALIDATION_ERROR | occurrences=5002
exit:   0
```

零 occurrence 写入是正确的，但状态机错误。`horizon-worker/service.ts:280-296` 的预锁 `discoverBusinessLocks` 在 `limit+1` 时抛普通 `AppError`；`processOne` 的 catch（`:123-136`）随后走技术退避。因而直接调用 `TaskHorizonCoreService.loadPlanGraph` 得到 SCOPE_LIMIT 的绿色用例不能代表真实 worker，重复执行最终会是 `FAILED/RETRY_EXHAUSTED`，不是定稿的 `FAILED/SCOPE_LIMIT`。

最小修复：让预锁发现返回明确的 scope-limit 结果，并在 token/generation CAS 下把 job 原子结束为 `FAILED/SCOPE_LIMIT`；不得经过技术 attempt。增加从真实 `HorizonWorkerService.runOnce` 或公开根命令进入的 5,001+ 行测试，断言零业务写、无部分提交、attempt 不增加且最终 reason 精确为 SCOPE_LIMIT。

HTTP `task-horizon` 在 `planning.service.ts:1880-1897,1925-1944` 仍枚举学生全部 occurrence id。它不改变上述真实 worker 反例；按原 B7 的后台 worker／共享核心／reaper 收口范围，本轮将其保留为**非阻塞的显式 HTTP 有界性债务**，不忽略，也不借此扩大为全 planning 性能改造。

### 11.6 实际命令、复用证据与退出

本轮新增定向执行：

- `stp006.http.spec.ts -t "consumes student version..."`：1 passed／32 skipped；
- `stp006.concurrency.spec.ts -t "serializes two confirmations..."`：1 passed／16 skipped，并含真实 `pg_blocking_pids` 等待；
- `stp006.horizon-worker.spec.ts -t "ignores a delayed failure|keeps FAILED|schedules...|loads..."`：4 passed／12 skipped；
- 合法 11→12、脏十一预检和约束组合物理 SQL；
- B5 四类公开退出码、B6 单调预算临时探针、B7 公开 bounded worker 入口反例。

未重复执行完整 lint／typecheck／test／build／prisma validate 或完整 Playwright；复用当前 SHA 的 CI #17 根检查和修复后 14 条本地 Playwright 证据。通知 worker／T11-D、打卡计时、B04、生产启用仍按既定延期，不是本轮新增阻塞。

本轮没有修改业务代码、Schema、已发布迁移、测试断言、CURRENT_STATUS／TASKS 或完成状态，没有 commit／push／pack／部署。三个本轮审计库均已 drop；worker／API／Vite 无遗留进程或监听。开始时已存在的 PostgreSQL 仍监听 `127.0.0.1:6260`（PID 10204），未停止；`STP004_PG_ISOLATION.md` 的既有 PID 改动保持原样。

## 12. 2026-09-22 B5–B7 修复记录（不是独立复审）

本轮只修第 11 节仍打开的 B5／B6／B7。第 1–9 节与第 11 节原文、B1–B4 关闭结论均未改写。本记录是修复自测，不能代替另一次独立复审，也不能把 STP 006 标为完成。

| 项 | 第 11 节反例 | 最小修复 | 本轮证据 |
| --- | --- | --- | --- |
| B5 | `NestFactory.createApplicationContext` 在 try 外，配置错误公开命令退出 1 | 配置加载、Nest context、命令执行纳入同一 try／finally；成功创建后才 close；错误信息不含连接串 | 根命令 `pnpm worker:horizon -- --status` 且 `HORIZON_WORKER_LEASE_MS=1` 退出 **2**；同进程 missing=3、非法 reason=2、READY 冲突=4 |
| B6 | `runOnce` 用 `Date.now()` 做 max-ms，墙钟回拨后继续领取 | 仅进程预算改 `performance.now()`；业务窗口／`next_due_at` 仍用锁后 DB 时间 | `stp006.horizon-worker.spec`：墙钟每读回拨 10s、`maxMs=1`、concurrency=1；`claimReady` 只 1 次，`processed=1`，另 2 个 job 未启动 |
| B7 | 预锁 `discoverBusinessLocks` 抛 `VALIDATION_ERROR`，公开 worker 记技术失败 READY／attempt+1 | 超限返回可识别 SCOPE_LIMIT；短事务按锁序＋token／generation CAS 走 `completeFailed`；不锁 5001+ occurrence，不进共享核心 | 公开 `pnpm worker:horizon -- --once`：5002 行计划 → `FAILED/SCOPE_LIMIT`、attempt=0、occurrence／planAdjustment 零增。旧租约迟到 `executeClaimed` 有真实 job 行锁等待，不改 B 的 token；B 随后仍 `SCOPE_LIMIT`。正常规模公开 `--once` 仍 GENERATED |

未改：Web、业务规则、Schema、迁移 1–12、test-v2、HTTP `task-horizon` 全量锁发现。无 Migration。STP 004／005 完成状态不变，未进入 STP 007。
