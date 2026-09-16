# STP 004 实施报告（Codex 审查第 1–8 项修复；整体仍未完成）

日期：2026-09-14  
授权来源：按审查第 1–8 项实施；不开始 STP 005；不 commit／push／pack／部署。

2026-09-14 晚间补记：不得把下文第 3 节历史表读成“第 1–8 项均已关闭”。当时第 3 项仍缺独立 step-up-first；第 6 项仍在 CSRF 后隐式 touch，且 TIME-2 只覆盖 idle／absolute 与节流刷新，不覆盖锁等待越期或授权失败禁心跳。本轮关闭证据只写第 9 节实际通过的子项。STP 004 仍进行中。

2026-09-16 文档归档见第 11 节。四项修复与第四条迁移复核通过；原库污染／既定延期／非阻塞补强分册登记。STP 004 仍进行中。

## 1. 目录与 Git

| 项 | 结果 |
| --- | --- |
| 工作目录 | `D:\Program Files\PycharmProjects\studysteps` |
| origin | `https://github.com/xyq-dev/studysteps.git` |
| 分支 | `main` |
| 实施前 HEAD | 不存在 |
| 实施后 HEAD | 不存在 |
| 工作区 | 全部 untracked；已有改动均保留 |
| 前置快照 | `docs/handoffs/STP004_PRE_IMPLEMENTATION_SNAPSHOT.md` |

commit / push / pack / 部署：**未执行**。STP 005：**未启动**。

## 2. 本阶段是否满足验收

**不满足“本阶段应执行项均已通过”。** STP 004 **整体仍不得标为完成**。

- T02-D 属 STP 005；T11-D 属后续通知 worker。
- T11-3、CON-3 为 **部分通过**：学生会话／撤销竞态已补测；**学习写入仍未实现**，不以替代接口冒充。
- 环境检查通过不能代替业务验收。

证据：`docs/handoffs/STP004_ACCEPTANCE_TRACE.md`。

## 3. 审查第 1–8 项

| # | 问题 | 修复位置 | 测试证据 | 迁移 | 剩余 |
| --- | --- | --- | --- | --- | --- |
| 1 | 撤回只数“剩余当前同意”，跨年龄后旧 CHILD 同意会挡住限制 | `students.service.ts` 撤回后按当前年龄重算必要政策；缺失则限制并撤销学生会话／pairing | `stp004.review.spec.ts` 项 1：撤回 MINOR 后 `RESTRICTED`、学生 401，CHILD 行仍在 | 无 | 学习写入拒绝仍延期 |
| 2 | StudentSession 未每请求检查档案、关系、当前必要同意 | `identity.service.ts` `assertStudentSessionLive`；load／写锁内 `assertSessionCurrent` | review 项 1／2：政策升级后学生 GET 401 且 lastSeen 不变；监护人仍可读 | 无 | 政策升级不自动撤销行，靠实时校验 401 |
| 3 | step-up 锁后不重读绑定会话，`updateMany` count=0 仍签发 GuardianSession | `identity.service.ts` consume：锁后重验绑定会话／同意／digest，条件撤销必须 1 行 | concurrency：revoke-first step-up 401，不另签发家长会话；`pg_blocking_pids` 重叠 | 新 migration `20260914170000_stp004_step_up_bound_session`（trigger）；已应用隔离库 | 双序中的 step-up-first 未单列用例；revoke-first 已覆盖复活路径 |
| 4 | 锁内不查 idle／absolute／authVersion；签发硬编码 `authVersion=1` | `assertWritableSession` 走完整 `assertSessionCurrent`；签发读取已锁账号当前版本 | review 项 4：旧会话 401，bump 后新会话 `accountAuthVersionAtIssue`>1；concurrency：等待中 bump 后 patch 401、昵称不变 | 无 | 无 |
| 5 | 幂等 REPLAY 在锁和重鉴权前返回资源 | 各写路径：begin → 锁 → `reauthorize` → 才 REPLAY | review 项 5 顺序 404；concurrency 项：revoke-first 重放 404，不泄露档案 | 无 | 学习待同步重放仍延期 |
| 6 | lastSeen 非 CAS；失败请求先心跳 | 条件 `UPDATE`：`revoked_at IS NULL` 且 `last_seen_at <= cutoff`，`CURRENT_TIMESTAMP`；写路径 CSRF 后再 `touchLastSeen` | TIME-2：`<60s` 不写、absolute／idle 不写；review 项 6：缺 CSRF／authVersion／撤销不写；concurrency：双 GET 只 `version+1` 且随后节流窗口不写 | 无 schema 变更 | 无 |
| 7 | 学生可读同意历史和全部设备 | `authorize` 学生仅 `PROFILE_READ` | review 项 7：自身档案 200；consents／device-sessions 403 | 无 | 无 |
| 8 | 矩阵／报告过度声明 | 本文件与 `STP004_ACCEPTANCE_TRACE.md`、`CURRENT_STATUS.md`、`TASKS.md`、`ACCEPTANCE.md` | CON-3 标部分通过；T11-3 标部分通过；删除“均已通过” | 无 | 见下 |

锁序 7.7 与撤回规则保留：撤回不带 `expectedStudentVersion`；只动目标 consent 行；WD-2 重放 C1 不得毁掉 C2。失败次数仍在独立事务提交后返回 401。

## 4. 迁移

- **未改写** 已应用 migration `20260914000000_stp004_identity_profiles_consents`。
- 新增 `prisma/migrations/20260914170000_stp004_step_up_bound_session/migration.sql`。
- 预检：`prisma migrate status` 显示仅该条 pending（exit 1 表示有未应用项，属预期）。
- 仅对既有隔离库 `stp004_identity` 执行 `prisma migrate deploy`，exit 0。
- 前滚：deploy 该 SQL。回滚：`DROP TRIGGER ss_auth_challenges_step_up_bound_trg ON auth_challenges; DROP FUNCTION ss_auth_challenges_step_up_bound();` 并删除 `_prisma_migrations` 对应行（仅隔离库，未授权生产）。
- db.spec 覆盖 mismatched digest 插入拒绝。

## 5. 实际命令与退出码

### 5.1 本轮启动

| 动作 | 退出码 | 说明 |
| --- | --- | --- |
| `node scripts/stp004-pg-instance.mjs ensure` | 0 | 未轮换密钥 |
| `node scripts/stp004-with-env.mjs pnpm exec prisma migrate status` | 1 | 预检：新 migration pending |
| `node scripts/stp004-with-env.mjs pnpm exec prisma migrate deploy` | 0 | 仅隔离库应用 `20260914170000` |

### 5.2 测试与根检查

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `pnpm lint` | 0 | |
| `pnpm typecheck` | 0 | 先因 `locked.studentIds` 可能 undefined 失败，已修后通过 |
| `node scripts/stp004-with-env.mjs pnpm test` | 0 | 77 passed（api 59，domain 9，contracts 6，ui 1，web 1，admin 1） |
| `pnpm build` | 0 | |
| `pnpm prisma:validate` | 0 | schema valid |
| `node scripts/stp004-with-env.mjs pnpm --filter @studysteps/web test:e2e` | 0 | Chromium 1 passed（约 3.4s 用例；首次因隔离库已有 8301 档案走 P05 失败，随后可从 P05 进入 S02 再建档） |

### 5.3 本轮回收

| 动作 | 退出码 | 说明 |
| --- | --- | --- |
| `node scripts/stp004-pg-instance.mjs stop` | 0 | 仅停止本轮 `ensure` 拉起的隔离库 |
| `node scripts/stp004-pg-instance.mjs status` | 0 | `postmaster.pid` 不存在；pg_ctl 提示无服务进程 |
| Playwright webServer（API 3000／Web 5173） | 随 e2e 结束 | 未另留长驻进程 |
| commit／push／pack／部署 | **未执行** | |

## 6. 用户可见变化

- 家长端 P05 增加“创建档案”，便于已有档案账号再开通。
- 学生会话不能再打开同意历史或设备列表（403）。
- 撤回当前年龄必要同意后，即使旧年龄段同意仍在，档案进入受限且旧学生会话立即失败。
- Admin 未改。学习计划仍不可用。

## 7. 未解决问题

- T02-D、T11-D 不得记为通过
- 学习写入未实现，T11-3／CON-3 学习路径保持延期
- 通知 worker 未实现
- step-up 请求仍要求客户端 installationId 与绑定会话摘要一致（与新 trigger 对齐）；未把 Plato 原 9–10 项扩成独立任务
- 凭证与 `runtime.env` 保持忽略

## 8. 下一步

不要开始 STP 005。commit／push 需另行授权。供 Codex 按本报告第 3 节逐项复审。

## 9. 2026-09-14 晚间复审补记（未关闭项）

工作目录仍为 `D:\Program Files\PycharmProjects\studysteps`。分支 `main`，无 HEAD，全部 untracked；未改写已应用迁移 `20260914000000`、`20260914170000`；未执行旧报告回滚 SQL；未 commit／push／pack／生产迁移；未进入 STP 005。

### 9.1 本轮实际改动（代码／DDL）

- 五态权限：`packages/domain/src/permissions.ts` 使用 `ONBOARDING | ACTIVE | RESTRICTED | DELETION_PENDING | DELETED`。ONBOARDING／ACTIVE 既定读取；RESTRICTED 保留 Guardian 最小修复路径、Student 401；DELETION_PENDING／DELETED 从 Guardian 列表剔除、精确路径同形 404、StudentSession 401；失败不得 heartbeat。已移除 `identity.service.ts`／`students.service.ts` 把非 RESTRICTED 折算为 ONBOARDING 的逻辑。
- 会话替换：共用 `apps/api/src/auth/session-lineage.ts` 与 `apps/api/src/students/student-authorization.ts`。Guardian→Student 与 Student→Guardian 均预生成 successor ID、先创建 successor，再条件撤销 predecessor 并写 `replacedBySessionId`。设备撤销递归锁定并撤销活动后继；REPLAY 验证完整链。link／consent 撤销不误撤账号级 Guardian successor。
- GUARDIAN_STEP_UP 锁序：identity advisory → Identity → Lookup → Account → StudentProfile → ConsentPolicy → GuardianLink → ConsentRecord → AuthChallenge → DeviceSession。锁后完整重读；缺锁则 `IncompleteLockSetError` 整事务重试。普通 SIGN_IN 保留认证子序列。
- 时间：`readLockedNow(tx)` 使用 PostgreSQL `clock_timestamp()`，只在全部锁及 `assertLockSetComplete` 后读取；challenge、session idle／absolute、pairing、消费、撤销、签发、TTL 与 serverTime 均用 `lockedNow`；事务重试重新读取。
- heartbeat：`loadSession` 与 controller guard 不再隐式 touch。顺序为 Origin／session／CSRF／解析 → service 事务 → 锁 → `lockedNow` → session 及对象／action 重验 → 业务成功 → `touchLastSeenLocked` → 提交。400／401／403／404／409／422／429 不改变 `lastSeenAt`／`version`。GET 与写入使用同一授权事务；session 轮换只给新 session 设置 `lockedNow`。
- 数据库：新增 expand `prisma/migrations/20260914233000_stp004_expand_lookup_replacement/migration.sql`。AuthChallenge→AuthIdentityLookup 五列 MATCH SIMPLE 复合 FK（ON UPDATE／DELETE RESTRICT）。首次 SIGN_IN 允许 identity／account 为 null，成功消费在创建 lookup 后回填。step-up 使用实际 lookup alias。step-up 绑定 trigger 与设计术语对齐；DeviceSession 签发事实不可变；`replacedBySessionId` 一对一及 pointer 状态 CHECK、账号／设备／scope 方向与防环 trigger。expand **不**强制“replacement reason 必有 pointer”。

### 9.2 迁移预检与隔离库

| 动作 | 退出码 | 说明 |
| --- | --- | --- |
| `node scripts/stp004-expand-precheck.mjs`（原库 `stp004_identity`） | 2 | 3 条 identity-stamped challenge 缺匹配 lookup alias。停止；未删除、改写或猜测回填 |
| `node scripts/stp004-fresh-isolation.mjs` | 0 | 另建可丢弃库 `stp004_identity_fresh`；未清空 `stp004_identity`；`runtime.env` 测试 URL 指向 fresh，原库 URL 保留为 `STP004_UPGRADE_DATABASE_URL` |
| fresh `prisma migrate deploy` | 0 | 三条迁移均已应用（含 expand） |
| upgrade-path `prisma migrate status`（`stp004_identity`） | 1 | expand **pending**（脏 alias，未应用） |
| fresh `pg_catalog` | 0 | `auth_challenges_lookup_alias_fkey` MATCH SIMPLE (`s`) ON UPDATE/DELETE RESTRICT (`r`/`r`); `device_sessions_replaced_pointer_ck`; unique `device_sessions_replaced_by_session_id_key`; triggers `ss_auth_challenges_step_up_bound_trg`、`ss_device_sessions_issue_immutable_trg`、`ss_device_sessions_replacement_guard_trg` |

未对原库执行 expand。需要 clean deploy 时只用 fresh，不清空现有库。

### 9.3 本轮根检查与测试（保留第 5 节历史表）

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `pnpm lint` | 0 | 曾因未使用变量失败后已修 |
| `pnpm typecheck` | 0 | |
| `node scripts/stp004-with-env.mjs pnpm test` | 0 | domain 10、contracts 6、ui 1、admin 1、web 1、**api 70** |
| `pnpm build` | 0 | |
| `pnpm prisma:validate` | 0 | schema valid |
| `node scripts/stp004-with-env.mjs pnpm --filter @studysteps/web test:e2e` | 0 | Chromium 1 passed（约 3.4s）。E2E 只做既有 UI 回归，**不作为并发证据** |

新增／独立用例（均在隔离 fresh 库、真实 `pg.Client`／`pg_blocking_pids` 处标明）：

- DEL：五态列表／404／401，失败不 heartbeat（`stp004.review.spec.ts`）
- LOCK-1 device step-up-first：撤销沿 S0→G1，新 Guardian cookie 401
- device revoke-first：既有 CON-3 用例保留（独立连接／observer／等待链）
- link revoke-first／step-up-first：后者证明 G1 仍有效但目标档案 404
- consent revoke-first／step-up-first：后者证明 G1 只保留 RESTRICTED 最小路径
- TIME-3：challenge／pairing／idle／absolute 在锁等待中越过到期边界
- HB-1／HB-2：成功才 touch；authVersion／link／policy／session 失效与 GET 心跳竞态不改 lastSeen
- DB-7：lookup FK、父字段回填、签发不可变、替换链约束及 `pg_catalog` 实物
- 首次 SIGN_IN 双 challenge 并发（AUTH-3）保留；首次登录 challenge 无 identity、消费回填 lookup

TIME-2 **不**改写为覆盖本轮 heartbeat-in-tx 或锁等待越期；那两项分别记 HB-1／HB-2 与 TIME-3。不得写“step-up 已覆盖”；关闭的是上列六个独立双序用例。

### 9.4 仍未关闭

- STP 004 **始终进行中**，不得标完成。
- T02-D 全量学制映射仍归 STP 005。
- T11-D 通知 worker 仍属后续阶段。
- T11-3／CON-3 **学习写入**仍延期；不以替代接口冒充。
- 原库 `stp004_identity` 因缺 lookup alias **未应用** expand；合同层“replacement reason 必有 pointer”待旧写入者退出且预检为零后再处理。
- Plato 原 9–10 项仍未扩成独立任务。

## 10. 2026-09-15 复审补记

原库 `stp004_identity` **只读**，未应用任何本轮 DDL。未改写 `20260914000000`、`20260914170000`、`20260914233000`。未猜测回填历史 lookup。未 commit／push／pack／生产迁移。未进入 STP 005。

### 10.1 本轮修复

1. 两条父键 CHECK：`auth_challenges_identity_parent_ck`（identity／account 全空或全有）、`auth_challenges_lookup_parent_ck`（identity 已盖章则 lookup 别名完整）。替换反环 trigger 按 id 序锁双方并锁后重读，后继链 `FOR UPDATE`。应用层 `lockReplacementPair` 同样覆盖双方。
2. `requestCode` 在 advisory 锁后重查最新未消费 challenge；同身份同设备并发发码 **201+429**，最终仅一个未锁定有效码。
3. `GUARDIAN_STEP_UP` 发码与 logout 校验 Origin＋绑定 CSRF。成功发码在授权事务内 `touchLastSeenLocked`。未登录 `SIGN_IN` 不要求 CSRF、不读取 cookie 会话。
4. 政策发布、OTP／pairing 失败锁定均在锁后读取 `clock_timestamp()`。HB-2 拆成 authVersion／link／policy／session 四条仓库并发测试。测试收件箱拒收未知目的地，不把旧码冒充新码。

新增迁移：`prisma/migrations/20260915160000_stp004_parent_keys_cycle_clock/migration.sql`。

### 10.2 迁移

| 库 | 动作 | 退出码 | 说明 |
| --- | --- | --- | --- |
| `stp004_identity`（原库） | 预检 | 2 | 3 条缺 lookup alias；428 条 identity／account 父键不完整。停止；未删除、改写或猜测回填 |
| 同上 | `migrate status` | 1 | `20260914233000` 与 `20260915160000` **pending** |
| `stp004_identity_fresh` | `migrate deploy` | 0 | 第四条已应用；schema up to date |
| `stp004_two_mig` | 先执行前两条 SQL 并 `resolve --applied`，合法种子，再 deploy 第三、四条 | 0 | 可丢弃非空两迁移旧库；种子 2 条 challenge 保留；`pg_catalog` 含两条父键 CHECK 与反环 trigger |

### 10.3 根检查

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `pnpm lint` | 0 | |
| `pnpm typecheck` | 0 | |
| `node scripts/stp004-with-env.mjs pnpm test` | 0 | domain 10、contracts 6、ui 1、admin 1、web 1、**api 80** |
| `pnpm build` | 0 | |
| `pnpm prisma:validate` | 0 | |
| Chromium `test:e2e` | 0 | 1 passed，约 3.4s。只做 UI 回归，不是并发证据 |

双连接反环、多跳链、锁等待失败锁定、CSRF、并发 201+429 均有隔离库证据。

### 10.4 当时登记（历史，分类见第 11 节）

- STP 004 **始终进行中**。
- T02-D → STP 005；T11-D → 通知 worker；T11-3／CON-3 学习写入仍延期。
- 原库仍因脏 alias／不完整父键未升级。合同层“replacement reason 必有 pointer”仍待旧写入者退出。

以上三项在 2026-09-16 分别记入第 11.3 既定延期、第 11.2 原库污染、第 11.4 非阻塞补强，**不**再混作第 10 节四项修复或第四条迁移的阻塞。

## 11. 2026-09-16 文档归档（未改代码、未重跑）

工作目录：`D:\Program Files\PycharmProjects\studysteps`。分支 `main`，**无 HEAD**（`git rev-parse HEAD` 失败：unknown revision）。远端 `https://github.com/xyq-dev/studysteps.git`。本轮只更新文档；未改业务代码或迁移；未重跑 lint／typecheck／test／build／prisma:validate／e2e；未 commit／push／pack／部署；未进入 STP 005。

### 11.1 本轮四项修复与第四条迁移复核

下列四项及第四条迁移以第 10 节隔离库证据为准，**复核通过**。本文件日不重跑命令，不另造退出码。

| 项 | 结论 | 入仓库回归（权威） | 不是权威的临时探针 |
| --- | --- | --- | --- |
| 1. 父键 CHECK + 并发反环双方锁 + 锁后可见性 | 通过 | `stp004.db.spec.ts`：CHECK、双连接反环、多跳链 | `.local/stp004-pg/catalog-check.mjs`、一次性 `pg_catalog` 查询 |
| 2. advisory 后重查最新 challenge；并发发码 201+429 | 通过 | `stp004.concurrency.spec.ts` | 手写并发脚本、临时 inbox 探测 |
| 3. step-up／logout CSRF + 成功心跳；未登录 SIGN_IN 保持无 CSRF | 通过 | `stp004.http.spec.ts`、`stp004.review.spec.ts` | 浏览器手工点按、含 Cookie 的失败附件 |
| 4. 发布／失败锁定锁后时钟；HB-2 四案；未知目的地拒收 | 通过 | concurrency TIME／HB-2；`test-delivery.adapter.ts` | Playwright `fixture@95` 内部噪声、E2E 页面操作 |

第四条迁移 `prisma/migrations/20260915160000_stp004_parent_keys_cycle_clock/migration.sql`：

| 库 | 复核结论 |
| --- | --- |
| `stp004_identity_fresh` | 已 `migrate deploy` 至第四条，schema up to date（第 10.2 节 exit 0） |
| `stp004_two_mig` | 合法非空两迁移旧库依次应用第三、四条；`pg_catalog` 含两条父键 CHECK 与反环 trigger（第 10.2 节 exit 0） |
| `stp004_identity`（原库） | **只读未升级**。预检 exit 2 与 pending 记入第 11.2，**不是**第四条迁移复核失败 |

未改写 `20260914000000`、`20260914170000`、`20260914233000`、`20260915160000`。

### 11.2 原库污染（单独登记，非本轮四项／第四条阻塞）

- 3 条 identity 已盖章但缺 lookup alias。
- 428 条 identity／account 父键不完整。
- `migrate status`：`20260914233000` 与 `20260915160000` pending。
- 处理约定不变：不删除、不改写、不猜测回填；升级路径已由 `stp004_two_mig` 证明。
- 原库污染 **不** 否定 fresh／two-mig 上的第四条迁移复核。

### 11.3 既定延期（单独登记，非本轮阻塞）

- STP 004 **整体仍进行中**，不得标完成。
- T02-D 全量学制映射 → STP 005。
- T11-D 通知 worker → 后续阶段。
- T11-3／CON-3 **学习写入**仍延期；不以替代接口冒充。
- Plato 原 9–10 项仍未扩成独立任务。

### 11.4 非阻塞测试补强（单独登记，非本轮阻塞）

- 合同层“replacement reason 必有 pointer”：待旧写入者退出且原库预检为零后再收紧，不阻塞第 11.1。
- Chromium E2E 只做 UI 回归，不是并发证据。
- `stp004.db.spec.ts` 中 pairing／advisory 行锁实验只作锁序辅助，不计入 CON-2／AUTH-3 业务通过理由。
- Playwright `Internal error: step id not found: fixture@95` 为 runner 噪声，不记失败。
- TIME-2 范围仍仅为 idle／absolute／节流刷新；锁等待越期与事务内心跳分别是 TIME-3、HB-1／HB-2（已在仓库用例关闭）。

### 11.5 已有脱敏证据归档

入仓库、可复查（无口令、无真实儿童信息、无 Cookie 明文）：

- `docs/handoffs/STP004_ACCEPTANCE_TRACE.md`
- `docs/ACCEPTANCE.md`
- `docs/handoffs/STP004_BROWSER_EVIDENCE.md`（界面断言；号码不入文）
- `docs/handoffs/STP004_PG_ISOLATION.md`（无密码、无端口）
- `docs/handoffs/STP004_B01_B09_DECISIONS.md`
- `apps/api/src/stp004.{review,concurrency,db,http,matrix}.spec.ts`
- `apps/web/e2e/stp004-ui.spec.ts`

临时／忽略目录探针（可丢弃，**不能**代替上表回归）：

- `.local/stp004-pg/`（实例、`runtime.env`、一次性 catalog 脚本）
- `.local/stp004-e2e/`（截图、HTML 报告、含会话痕迹的 trace）
- 可丢弃库 `stp004_identity_fresh`、`stp004_two_mig`

第 10.3 节根检查与 E2E 退出码仍为最近一次执行记录；2026-09-16 **未重跑**。
