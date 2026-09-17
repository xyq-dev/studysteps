# STP 005 实施报告（本地验证；未标产品验收）

日期：2026-09-17（续作；2026-09-16 正文保留为历史）
授权来源：用户授权 STP 005 代码、Schema 及新增迁移；按已确认 `docs/STP005_DESIGN.md` 执行。2026-09-17 仅授权修复三个已证实行为阻塞，不重新设计架构。
未执行：commit、push、pack、部署、生产迁移、STP 006／009。

STP 004 **仍进行中，不得标完成**。不得宣称 M0／STP 002／接口已冻结。

## 1. 目录与 Git

| 项 | 结果 |
| --- | --- |
| 工作目录 | `D:\Program Files\PycharmProjects\studysteps` |
| origin | `https://github.com/xyq-dev/studysteps.git` |
| 分支 | `main` |
| 实施前 HEAD | `576da3da1e8083305b644ddc8fe16bf582b50648` |
| 实施后 HEAD | `576da3da1e8083305b644ddc8fe16bf582b50648`（未 commit） |
| 基线说明 | `main@576da3d` |

保留既有文档改动（含此前 `STP005_DESIGN.md`、`PAGES.md` 等未提交设计稿）。原库 `stp004_identity` **只读未升级**。2026-09-16 迁移曾打在 `stp004_identity_fresh`；该库及旧夹具 `stp005_four_to_six` 仍为旧第五／第六条账本，本轮 **未 deploy、未 reset**。2026-09-17 修订只打在独占库 `stp005_rev_fresh` 与夹具 `stp005_rev_four_to_six`（`127.0.0.1:6260`）。

## 2. 本阶段是否满足验收

**本地检查已跑通，不等于产品验收完成，也不等于 CI 已验证。**

- T02-D 目录／教育写、遗留快照、无映射禁止导入：本地隔离库与 Playwright 已执行。
- T02 整体仍受 STP 004 进行中项与 CI 未跑本轮约束，不得把 T02 写成已冻结通过。
- GitHub Actions 未跑本轮（未 push）。CI 工作流仍无 Playwright。
- 学习计划导入返回 `TEMPLATE_IMPORT_NOT_AVAILABLE`（409），不创建计划（STP 006）。

## 3. 已落地的已确认方案

| 项 | 落地 |
| --- | --- |
| 39 条模板 | 13 个 `catalogEntryKey` × DAILY／READING_REVIEW／WEEKLY；五四初四独立 `JUNIOR_G4`，不套初三 |
| 教育与年龄独立 | `AGE` 与 `EDUCATION` 分 `kind`；年级不推导年龄 |
| 统一 EDUCATION PATCH | 无 `POST .../education-changes`；历史只读 GET |
| 建档教育全空 | `createStudentSchema` 拒绝非空 education |
| 5 分钟 step-up | `timing.stepUpMs = 5 * 60 * 1000`；EDUCATION 事务外 `requireStepUp` + 事务内 `reauthorize(..., true)` |
| 种子发布 | 目录与模板在第五条迁移内发布；A02 只读、无发布按钮 |
| STP 002 优先页 | S04、S05、S06、S08–S11、S15、P02、A03；**不含 S07／A02** |
| 无合法映射 | `TEMPLATE_IMPORT_NOT_ALLOWED` 400；有映射亦不创建计划 |
| 7.7 锁序 | Student `FOR UPDATE` → GradeConfig `FOR SHARE` → Policy `FOR UPDATE`；事务内鉴权与幂等保留 |

## 4. 迁移

- **未改写** 既有四条：`20260914000000`、`20260914170000`、`20260914233000`、`20260915160000`。工作区 SHA-256 与 `HEAD` blob 一致。
- **修订（未 commit、未推送）** 第五／第六条，原地改写，**无第七条补丁**。修订前 SQL 与 SHA-256 已写入被忽略目录 `.local/stp005-migration-backup/20260917-pre-rev/`。
- 原第五／第六条 SHA-256：`3f20970f504893ad64fdbac84ca70ac47ba33780434decda255da2f3cfdd61cf`／`fbb1a0e79b1b53b5770440257460378257e5dd01fa80f46c569f47d80d15b990`（仍在 `stp004_identity_fresh`、`stp005_four_to_six` 账本中，未改）。
- 修订第五／第六条 SHA-256：`6f51d8e5525865d24b1a3c3f00e477e23b5ac9c4a89b80cc8e234b0e2c6db601`／`93ffc8d077ad2909843f1160554bc9c300c0041acea85f2ac3056e9196d4d013`（仅 `stp005_rev_fresh`、`stp005_rev_four_to_six`）。提交前为通过 `git diff --cached --check` 去掉第五条文件末多余空行，SQL 语义未改；该库账本仍记录修剪前 checksum `2e765521…`。
- 修订第五条：同一事务 `LOCK TABLE student_profiles IN ACCESS EXCLUSIVE MODE`；捕获既有非空教育行 ID＋五字段原元组到密封表 `stp005_trusted_legacy_allowlist`；触发器拒绝 INSERT／UPDATE／DELETE。`created_at` 不是来源。目录／39 模板种子不变。
- 修订第六条：只消费该 allowlist；若表缺失则拒绝（不把旧第六条指纹表当来源）。**任何** `grade_config_version_id` 回填之前预检：名单外／改写 leftover、未发布或跨 config current、assigned 快照不一致或学期非法 → 明确失败，不修正标签、不猜测映射。预检通过后才 ADD COLUMN／回填／安装复合 FK 与 guard。禁止新建 leftover、改写原元组、SET 后退回 leftover。
- **无** 对原库或旧 fresh／旧 four-to-six 的 deploy／reset／账本改写。`scripts/stp005-recreate-test-fresh.mjs` 现拒绝重建 `stp004_identity_fresh`。
- 2026-09-17 仅应用到 `stp005_rev_fresh`（6 条）与夹具 `stp005_rev_four_to_six`（allowlist 1 行）。原库 `stp004_identity` 未应用（只读：仍缺 expand／第四／第五／第六条）。
- 前滚：仅独占／CI 库 `prisma migrate deploy`。CI prepare 在空库 deploy 后另跑 `scripts/stp005-four-to-six-upgrade.mjs`（现写 `stp005_rev_four_to_six`）。
- 回滚：有历史后禁止 drop table 常规回滚，使用前滚修复。未授权生产。

CI：`scripts/stp004-ci-prepare.mjs` 对照 `prisma/migrations` 目录计数（现为 6），并调用 four-to-six 夹具。**GitHub Actions 本轮未跑**。

## 5. 修改文件

新增：

- `apps/api/src/catalog/catalog.controller.ts`
- `apps/api/src/catalog/catalog.service.ts`
- `apps/api/src/stp005.http.spec.ts`
- `apps/api/src/stp005.db.spec.ts`
- `apps/api/src/stp005.concurrency.spec.ts`
- `apps/api/src/stp005.upgrade.spec.ts`
- `apps/web/e2e/stp005-ui.spec.ts`
- `packages/domain/src/grade.ts`
- `packages/domain/src/grade.test.ts`
- `packages/domain/src/education-transition.ts`
- `packages/domain/src/education-transition.test.ts`
- `packages/domain/src/activation.ts`
- `prisma/migrations/20260916120000_stp005_grade_catalog_templates/migration.sql`
- `prisma/migrations/20260916180000_stp005_legacy_fingerprint_and_version_fks/migration.sql`
- `scripts/stp005-four-to-six-upgrade.mjs`
- `scripts/stp005-recreate-test-fresh.mjs`
- `scripts/stp005-rev-fresh.mjs`
- `docs/STP005_IMPLEMENTATION_REPORT.md`

修改（含保留的既有文档改动）：

- `prisma/schema.prisma`
- `packages/contracts/src/students.ts`、`errors.ts`、`index.test.ts`
- `packages/domain/src/index.ts`、`permissions.ts`
- `apps/api/src/common/lock-order.ts`、`lock-order.spec.ts`
- `apps/api/src/students/students.service.ts`、`students.controller.ts`、`students.module.ts`、`student-authorization.ts`
- `apps/api/src/stp004.http.spec.ts`、`stp004.matrix.spec.ts`、`stp004.concurrency.spec.ts`、`stp004.review.spec.ts`
- `apps/web/src/app.tsx`、`apps/admin/src/app.tsx`、`apps/admin/src/app.test.tsx`
- `scripts/stp004-ci-prepare.mjs`
- `docs/STP005_DESIGN.md`、`PAGES.md`、`CURRENT_STATUS.md`、`TASKS.md`

## 6. 用户可见变化

- S02 建档不再提交教育快照；P05 必须显式选择 `changeKind` 与学期后再 PATCH。
- S07 可浏览已发布模板；无 `catalogEntryKey` 禁止导入；有映射时导入仍提示后续任务。
- Admin A02 只读预览，无发布／下架按钮。
- 正式学习记录／计划写入仍未交付。

## 7. 命令与退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm lint` | 0 | eslint . |
| `pnpm typecheck` | 0 | 含 prisma generate |
| `pnpm test`（2026-09-17） | 0 | 见下表；**0 skipped** |
| `pnpm build` | 0 | packages + 三应用 |
| `pnpm prisma:validate` | 0 | schema valid |
| `pnpm test:e2e` | 0 | Playwright 2 passed |

`pnpm test` 分项（全部执行，无 skip 冒充通过）：

| 包 | 通过 | 跳过 |
| --- | --- | --- |
| packages/domain | 22 | 0 |
| packages/contracts | 7 | 0 |
| packages/ui | 1 | 0 |
| apps/admin | 1 | 0 |
| apps/web | 1 | 0 |
| apps/api | 107 | 0 |
| **合计** | **139** | **0** |

2026-09-16 历史计数（已被第 11 节声明推翻，仅作对照）：domain 21、api 105、合计 136。

api 分套（2026-09-17）：`stp004.concurrency` 27、`stp004.matrix` 17、`stp004.review` 10、`stp004.db` 14、`stp004.http` 3（STP004 回归 71）；`stp005.http` 11、`stp005.db` 4、`stp005.concurrency` 2、`stp005.upgrade` 3；其余 health／lock／config／csrf／loader（含拒绝旧库目标）。相对 CI #1 的 api **84**，本工作区 api 为 **107**。

Playwright：`stp004-ui` 1 passed；`stp005-ui` 1 passed。覆盖建档全空、显式 SET＋FULL_YEAR、有映射导入延期、SYSTEM_SWITCH＋学期后自定义无映射禁止导入。STP004 浏览器回归未 skip。

遗留教育：`stp005_rev_fresh` 上新建／改写 leftover 被拒。合法非空 leftover 只存在于 `stp005_rev_four_to_six`：四→修订五捕获 allowlist，修订六消费该名单且不猜补 `grade_config_id`；已配齐行只回填 `grade_config_version_id`。伪造更早 `created_at` 与脏 assigned／未发布 current 在一次性负例库阻断第六条，且未出现 `grade_config_version_id` 列。历史 UPDATE／DELETE 负例通过。

## 8. 本轮进程

- Playwright `webServer` 拉起的 API（`:3000`）与 Vite（`:5173`）已随 `pnpm test:e2e` 退出；仅剩 `TIME_WAIT`，无 Listen。
- 隔离 PostgreSQL `127.0.0.1:6260`（pid 2796）**未停**。未触碰原库。
- 一次性负例库 `stp005_rev_forged`／`stp005_rev_dirty` 已在夹具脚本内删除。独占库 `stp005_rev_fresh` 与升级夹具 `stp005_rev_four_to_six` 保留（后续本地复跑目标，不是既有库）。
- 既有 `node` 进程（06:52 起）未回收。未回收无关 MCP／编辑器进程。

## 9. 待 CI 验证

未 push，下列项 **未执行**：

1. GitHub Actions `check` 对第五／第六条迁移 `migrate deploy`。
2. `stp004-ci-prepare.mjs` 断言 applied 数等于目录迁移数（应为 6）并跑修订版 four-to-six 夹具（`stp005_rev_four_to_six`）。
3. CI 上 `pnpm lint`／`typecheck`／`test`／`build`／`prisma:validate`（api 用例数将高于 CI #1 的 84；本机现为 107）。
4. Playwright **不在** `.github/workflows/ci.yml` 中，CI 不会自动跑 e2e。

## 10. 未解决问题

- STP 004 仍进行中（T11-D、学习写入、原库污染分册仍有效）。
- STP 001／STP 002／M0 未冻结。
- 模板导入与任务实例年级快照属 STP 006。
- A02 运营发布属 STP 009。
- 原库 `stp004_identity` 仍只读，未打 expand 及之后的迁移。

## 11. 四项阻塞修复（2026-09-16 历史；声明已被推翻）

先固化 domain／HTTP／DB 反例，再改约束与谓词。**本节“已修复”结论不成立**，见第 12 节反例与修订。保留原文以便对照。

| 阻塞 | 修复 | 证据 |
| --- | --- | --- |
| 1 leftover 仅接纳可证明迁移前原元组 | 第六条预检：leftover 且 `created_at >=` 第五条 `finished_at`（或第五条记录缺失）则 `unknown leftover origin`。指纹表只插入预检通过行。禁止新建 leftover、改写元组、SET 后回退 leftover。不把当前所有 NULL 行当 leftover。 | `stp005-four-to-six-upgrade.mjs` leftover digest `1ce55f5ac232d07a29584a638b9f6cb9` 四→五→六不变；未知来源库预检阻断第六条（`blocked: true`）；`stp005.db`／HTTP 负例；`stp005.upgrade` 指纹相等 |
| 2 版本同属复合 FK、当前版本已发布、快照精确一致 | `(current_version_id, id)→(id, grade_config_id)`；学生 `(grade_config_version_id, grade_config_id)`；`grade_configs_current_published`；guard 要求快照字段＝已发布当前版本且学期 ∈ allowed JSON | `stp005.db` 未发布 current／跨 config current／改 label 均拒；upgrade 夹具约束对象存在 |
| 3 统一锁内 fail-closed activation | `evaluateActivation` 忽略 stored ACTIVE；覆盖 EDUCATION 写、同意恢复、GET、list。SET→publishNext→GET/list 为 `CONSENT_REQUIRED`。锁序仍 Student→GradeConfig→Policy | HTTP SET→政策升级；CON-2 grant-first 配齐教育后 GET 为 `CONSENT_REQUIRED`；STEP：独立连接 `FOR UPDATE` 学生，`pg_blocking_pids` 等待中缩短 `stepUpMs`，提交后 403 `STEP_UP_REQUIRED`；LOCK：教育写等待 Policy，publish 不等待 Student |
| 4 集中转换表 | `evaluateEducationChange`：空档案拒 LEAVE／无 LEAVE 历史的 RESUME；SKIP 拒跨学制／倒退／当前档／下一档；REPEAT 拒改学期。UI 必选 `changeKind` 与 `term` | domain 反例；HTTP T02-D-REJ；E2E 先 SET 再 SYSTEM_SWITCH；YR：连续 GET 年级不变、无自动升年级作业 |

夹具：合法非空四→五→六当时在 `stp005_four_to_six`；CI prepare 已挂钩。原库只读 status 仍显示四条未应用。fresh 当时仅重建 `stp004_identity_fresh`。

**推翻点（2026-09-17 证实）：**

1. leftover 来源用 `created_at <` 第五条 `finished_at`。迁后写入再伪造更早 `created_at` 仍能通过旧第六条预检。
2. 旧第六条在预检失败前或失败路径上仍可能留下版本列／半成品；脏 assigned／未发布 current 必须以预检失败且无回填来冻结。
3. `missingRequiredConsent` 把非 `CONSENT_REQUIRED` 异常（含 `AGE_BAND_NOT_SUPPORTED`、政策查询失败）当成 consentCurrent，GET／list 可落到 stored ACTIVE。
4. 转换表＋UI 本身未被本轮反例推翻；五分钟 STEP 与转换表沿用已通过证据，不扩大范围。

## 12. 2026-09-17 三阻塞修订（本地验证；未标产品验收）

### 12.1 原因与范围

只修三个已证实行为阻塞：可信 leftover 来源、第六条回填前全量预检、activation 失败关闭。允许修改：未发布第五／第六条、activation 相关代码、必要测试／CI 脚本、状态文档。前四条不变。不新增第七条。不进入 STP 006／009。

第五／第六条核验：`git ls-files --error-unmatch` 失败（未跟踪）；`HEAD`／`origin/main` 仍为 `576da3da1e8083305b644ddc8fe16bf582b50648`；从未 push。仅用于本地隔离库。事实未变化，故允许原地修订。

### 12.2 迁移哈希与库身份

| 项 | 值 |
| --- | --- |
| 原第五条 SHA-256 | `3f20970f504893ad64fdbac84ca70ac47ba33780434decda255da2f3cfdd61cf` |
| 原第六条 SHA-256 | `fbb1a0e79b1b53b5770440257460378257e5dd01fa80f46c569f47d80d15b990` |
| 修订第五条 SHA-256 | `6f51d8e5525865d24b1a3c3f00e477e23b5ac9c4a89b80cc8e234b0e2c6db601`（提交文件；相对复核稿仅去掉末尾多余空行） |
| 修订第六条 SHA-256 | `93ffc8d077ad2909843f1160554bc9c300c0041acea85f2ac3056e9196d4d013` |
| 备份 | `.local/stp005-migration-backup/20260917-pre-rev/`（被忽略） |
| 独占测试库 | `stp005_rev_fresh` @ `127.0.0.1:6260`，applied=6，checksum=修订版 |
| 升级夹具 | `stp005_rev_four_to_six`，applied=6，allowlist=1 |
| 既有库账本 | `stp004_identity` 仍 2 条；`stp004_identity_fresh`／`stp005_four_to_six` 仍为**旧**第五／第六 checksum，未改 |

### 12.3 逐项反例

| # | 必须固化 | 结果 |
| --- | --- | --- |
| 1 | 第五条后伪造更早 `created_at` 仍不能取得 leftover 资格 | **通过**。`stp005_rev_forged`：四＋修订五后插入 leftover 并写 `created_at='2020-01-01'`；修订六 `RAISE` `leftover is outside the trusted allowlist`；`grade_config_version_id` 列未出现。库已丢弃。 |
| 2 | 脏 assigned、未发布 current 导致升级失败，未发生错误回填 | **通过**。`stp005_rev_dirty`：错误 label 的 assigned ＋未发布 current；修订六 `RAISE` `current grade version is unpublished or does not belong`；无版本列。库已丢弃。 |
| 3 | `AGE_18_PLUS` 及政策查询异常均不能得到 ACTIVE／`allowed=true` | **通过**。HTTP：prisma 写入 `AGE_18_PLUS`＋stored ACTIVE 后 GET／list 均为 422 `AGE_BAND_NOT_SUPPORTED`，不是 ACTIVE。domain：`applyConsentProbeFailure({ code: 'AGE_BAND_NOT_SUPPORTED' })` 与 `Error('policy lookup failed')` 均抛出；`consentCurrent: false` 时 `allowed=false`。仅 `CONSENT_REQUIRED` 返回 false 走既定受限。 |
| 4 | 合法非空四→修订五→修订六：原元组指纹保持，真实约束执行 | **通过**。种子 digest `1ce55f5ac232d07a29584a638b9f6cb9` 与 allowlist 一致；assigned 回填 version；allowlist INSERT／UPDATE／DELETE 被拒；旧指纹表计数 0。 |

### 12.4 检查退出码

| 命令 | 退出码 |
| --- | --- |
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test` | 0（139 passed / 0 skipped） |
| `pnpm build` | 0 |
| `pnpm prisma:validate` | 0 |
| `pnpm test:e2e` | 0（2 passed） |
| GitHub Actions | **未执行**（未 push） |

### 12.5 复用证据与非阻塞补证

复用已通过的五分钟 STEP（`stp005.concurrency` T02-D-STEP：独立连接 `FOR UPDATE`，`pg_blocking_pids`，提交后 403 `STEP_UP_REQUIRED`）与转换表／UI（domain 反例、HTTP T02-D-REJ、E2E 先 SET 再 SYSTEM_SWITCH）。本轮不扩大范围。

非阻塞补证（单列，未扩范围）：Playwright 日志出现 `Internal error: step id not found: fixture@95`（此前复跑为 `fixture@94`），两用例仍 passed；未作为本轮阻塞。

### 12.6 遗留项

- 未 commit、未 push、未 pack、未部署。
- GitHub Actions 未跑修订第五／第六条与 `stp005_rev_*` 夹具。
- 旧 fresh／旧 four-to-six 仍为被推翻实现的账本，禁止对其 deploy 修订版。
- STP 004 仍进行中。不得宣称 M0／STP 002／接口冻结／产品验收完成。
- 模板导入与任务实例年级快照属 STP 006；A02 运营发布属 STP 009。

## 13. 2026-09-17 真实浏览器走查（本轮）

授权：页面走查、隔离库测试数据、补充 E2E；禁止改业务代码／Schema／六条迁移；禁止 commit／push。

| 项 | 结果 |
| --- | --- |
| HEAD | `911846895adcba9ad2958f2b4c707655903cd56a` |
| 库 | `stp005_rev_fresh` @ 6260；六条已应用；25 年级／39 模板 |
| `pnpm --filter @studysteps/web test:e2e` | 退出码 0；**4 passed / 0 skipped** |
| 证据 | `docs/handoffs/STP005_BROWSER_EVIDENCE.md` |

家庭侧 P05 SET／PROMOTE／TERM_SWITCH／SYSTEM_SWITCH 与 S07 39 条浏览已点击。A02 现有访问目录读取失败。学生视图无 S07 入口。刷新不回填年级。

**可开始 STP 006 设计。不得标 STP 005 产品验收或 STP 004 完成。**

## 14. 2026-09-17 页面两项阻塞修复（本轮）

授权：只改 `apps/web`、`apps/admin` 及相关 E2E／验收记录。未改 API 鉴权、业务规则、Schema、六条迁移；未 commit／push。

| 项 | 结果 |
| --- | --- |
| HEAD（未提交） | 仍为 `911846895adcba9ad2958f2b4c707655903cd56a` |
| 库 | `stp005_rev_fresh` @ 6260；六条已应用；25 年级／39 模板 |
| `pnpm --filter @studysteps/web test:e2e` | 退出码 0；**5 passed / 0 failed / 0 skipped** |
| 证据 | `docs/handoffs/STP005_BROWSER_EVIDENCE.md` 修复验证节 |

A02：Admin Vite 补 `/v1` 代理，复用家庭端 Cookie 读已发布目录；未登录引导现有登录，列表为空。P05：初始化 `GET /v1/auth/session` 恢复会话，按学生详情回填 `gradeConfigId`／学期／目录版本；刷新后断言实际选项值。

**两项走查阻塞已关闭。仍可开始 STP 006 设计。不得标 STP 005 产品验收或 STP 004 完成。**
