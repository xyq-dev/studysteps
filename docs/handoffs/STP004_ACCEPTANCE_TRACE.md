# STP 004 第 11 节验收追踪（本阶段）

工作目录：`D:\Program Files\PycharmProjects\studysteps`。分支 `main`，无 HEAD，工作区全部 untracked。本文件把设计第 11 节映射到实际测试与结果。环境检查通过不能代替本表。不得把“已设计／已创建文件”写成功能已验收。

STP 004 **保持进行中**。2026-09-14 日间按 Codex 审查第 1–8 项补测后，**不能**写“本阶段应执行项均已通过”，也 **不得** 写“第 1–8 项均修复”。当时第 3 项缺独立 step-up-first，第 6 项仍隐式 heartbeat；TIME-2 只覆盖 idle／absolute 与节流刷新。晚间复审子项见文末补记。

| 编号 | 本阶段结论 | 测试／入口 | 关键断言 | 最近结果 |
| --- | --- | --- | --- | --- |
| T01-1 | 通过 | `apps/api/src/stp004.http.spec.ts` | UNCONFIRMED 建档 400，无档案 | 通过 |
| T01-2 | 通过 | 同上 | 旧政策版本 422 `CONSENT_REQUIRED` | 通过 |
| T01-3 | 通过 | HTTP + Chromium S02 | 201 建档；页面“档案已创建” | 通过（本轮 Chromium 复测） |
| T01-4 | 通过 | `stp004.concurrency.spec.ts` CON-2 | 发布先完成：旧版本 grant 409；授权先完成：随后 pairing／学生模式 422 | 通过 |
| T02-B | 通过 | HTTP patch EDUCATION | `ageBand` 仍 `UNDER_14`，`gradeCode` 变为 g4 | 通过 |
| T02-D | 后续阶段 | 无本阶段实现 | 全量学制映射归 STP 005 | 后续阶段 |
| AGE-1 | 通过 | `stp004.matrix.spec.ts` | 跨段后 `RESTRICTED`；教育字段不变；旧学生会话 401；未消费 pairing 已撤销 | 通过 |
| T10-1 | 通过 | HTTP 跨监护人 GET | 与不存在 ID 同形 404 | 通过 |
| T10-2 | 通过 | matrix | 学生会话读同胞档案与缺失 ID 同形 404 | 通过 |
| T10-3 | 通过 | contracts + matrix | schema 剥除 `accountId`／`studentId`；建档归属仍为会话账号 | 通过 |
| T10-4 | 通过 | matrix | 跨档案 consent／pairing／device 与缺失 ID 同形 404 | 通过 |
| T11-1 | 通过 | HTTP + Chromium 撤销设备 | 旧学生 cookie／刷新会话 401／未登录 | 通过（顺序撤销；本轮 Chromium 复测） |
| T11-2 | 通过 | matrix 调内部 `revokeGuardianLink` | 该档案 404／学生会话 401／pairing 401；另一档案仍可读 | 通过（顺序关系撤销） |
| T11-3 | 部分通过 | HTTP + review + Chromium 撤回；STP 006 计划写 | 档案 `RESTRICTED`；旧学生会话 401；**计划 import 在撤回后拒绝**（`stp006.http.spec.ts`／concurrency） | 部分通过：同意撤回、学生会话拒绝、**计划写入子项已覆盖**；完成／计时／待同步完成仍延期至 STP 007 |
| T11-4 | 通过 | matrix | 重授后旧学生会话仍 401；新学生模式可读 | 通过 |
| T11-D | 后续阶段 | — | 通知 worker 不在本阶段；`authorize`／`reauthorize` 不是 worker 守卫 | 后续阶段 |
| AUTH-1 | 通过 | matrix | 错码／过期／重放／跨设备／跨用途均为 `AUTH_GRANT_INVALID`；失败 challenge 未消费 | 通过 |
| AUTH-2 | 通过 | HTTP + Chromium | 学生列档案 403；页面二次验证回家长 | 通过 |
| AUTH-3 | 通过 | `stp004.concurrency.spec.ts` | 两有效 challenge 并发首次登录；`pg_blocking_pids` 证明 advisory 等待；1 Account / 1 AuthIdentity；无 500 | 通过 |
| AUTH-4 | 通过 | HTTP + Chromium | 缺 CSRF／错 Origin 失败；页面写请求走 Cookie＋绑定 CSRF | 通过 |
| AUTH-5 | 通过 | matrix | 拼接另一账号 session／device 的 step-up 401；challenge 未被消费；本会话仍可完成 | 通过 |
| PAIR-1 | 通过 | matrix | 错码／锁定后正确码／过期均为 `PAIRING_INVALID`；无存在性差异 | 通过 |
| PAIR-2 | 通过 | concurrency PAIR | 双 HTTP 消费：201+401，仅一个学生会话，失败无残留 | 通过 |
| PAIR-3 | 通过 | matrix | 先撤回同意或撤销关系后，窗口内消费仍 401 | 通过 |
| PAIR-4 | 通过 | concurrency PAIR-4 | 生成 vs 兑换、兑换 vs 撤销均重叠等待；无 500；最多一个学生会话 | 通过 |
| CON-1 | 通过 | concurrency CON-1 | 同 `expectedVersion` 双 patch：一成功一 409；昵称仅为其中之一；version +1 | 通过 |
| CON-2 | 通过 | concurrency CON-2 | 独立连接持锁 + 真实 HTTP 等待；两种提交顺序 | 通过 |
| CON-3 | 部分通过 | concurrency CON-3 + `stp006.concurrency.spec.ts` | 监护人 BASIC vs 撤回；学生心跳／step-up／authVersion／lastSeen／关系撤销；**计划 import vs 同意撤回两种顺序**（独立连接 + `pg_blocking_pids`） | 部分通过。计划写入子项已覆盖。完成待同步写入仍延期至 STP 007 |
| IDEM-1 | 通过 | HTTP | 同 key 重放 201，不同 body 409 | 通过 |
| IDEM-2 | 通过 | matrix | 同 key 重放 `NOT_REPLAYABLE` 无 secret；新 key 签发并撤销旧码 | 通过 |
| DB-1 | 通过 | `stp004.db.spec.ts` | partial unique 拒绝第二主监护 | 通过 |
| DB-2 | 通过 | 同上 | CHECK 拒绝非法 DeviceSession | 通过 |
| DB-3 | 通过 | 同上 | `consent_records_one_current` 拒绝 | 通过 |
| DB-4 | 通过 | 同上 | 复合 FK 拒绝错配 consent／consumed session | 通过 |
| DB-5 | 通过 | 同上 | 已发布正文不可变 | 通过 |
| DB-6 | 通过 | 同上 | 指针不能指向草稿 | 通过 |
| TX-1 | 通过 | db.spec | 建档／消费／撤销事务中途抛错后无半状态 | 通过 |
| TIME-1 | 通过 | domain + matrix | `now >= expiresAt` 时 challenge／pairing／session 均失败 | 通过 |
| WD-1 | 通过 | contracts + matrix | 撤回不带 `expectedStudentVersion`；伪造撤回人／version 不改变服务端主体 | 通过 |
| WD-2 | 通过 | matrix + concurrency | 撤回 C1 → 授予 C2 → 新会话 → 重放 C1：C2 与新会话有效；并发重放保持 ONBOARDING | 通过 |
| FAIL-1 | 通过 | matrix | 连续错码次数落库；达上限后正确码失败；过期不解锁 | 通过 |
| FAIL-2 | 通过 | concurrency | 并发错码次数累加；最后一次错码与正确兑换重叠可线性化，无 500 | 通过 |
| RATE-1 | 通过 | matrix | 同身份同设备 60s 内再发码 429 `RATE_LIMITED`，无第二挑战 | 通过 |
| TIME-2 | 通过（范围仅 idle／absolute／节流刷新） | domain + matrix + review + concurrency | idle／absolute 401 且不回写 lastSeen；`<60s` 不写；并发双刷新只写一次且单调。本行 **不** 覆盖锁等待越期（TIME-3）或授权事务内心跳（HB-1／HB-2） | 通过（上述范围） |
| CFG-1 | 通过 | `config.spec.ts` | production／未知环境拒绝或关闭测试认证 | 通过 |

Codex 审查第 1–8 项日间补测见 `apps/api/src/stp004.review.spec.ts` 与 concurrency CON-3 用例。学习写入和通知 worker 不以替代用例冒充覆盖。

底层 `stp004.db.spec.ts` 中 pairing／advisory 行锁实验仍保留，只作为锁序辅助，不计入 CON-2／AUTH-3／PAIR 业务通过理由。新增 trigger 用例覆盖 step-up 绑定会话设备摘要。

T02-D、T11-D 保持后续阶段。STP 004 **整体仍不得标为完成**。

## 2026-09-14 晚间补记（复审未关闭项）

不得用本表日间“通过”行吞并下列子项。E2E 只做 UI 回归，不作为并发证据。

| 编号 | 本阶段结论 | 测试／入口 | 关键断言 | 最近结果 |
| --- | --- | --- | --- | --- |
| DEL | 通过 | `stp004.review.spec.ts` | 五态；列表剔除 DELETION_*；精确路径同形 404；Student 401；失败不 heartbeat | 通过 |
| LOCK-1 | 通过 | concurrency device step-up-first | 独立 `pg.Client`＋observer＋`pg_blocking_pids`；撤销沿 S0→G1；新 Guardian cookie 401 | 通过 |
| device revoke-first | 通过 | concurrency CON-3 step-up vs device revoke | 独立连接等待链；revoke-first 不另签发家长会话 | 通过 |
| link revoke-first | 通过 | concurrency | 独立等待链；重叠 step-up 不签发 Guardian | 通过 |
| link step-up-first | 通过 | concurrency | G1 会话仍有效；目标档案 404 | 通过 |
| consent revoke-first | 通过 | concurrency | 独立等待链；重叠 step-up 不签发 Guardian | 通过 |
| consent step-up-first | 通过 | concurrency | G1 只保留 RESTRICTED 最小路径 | 通过 |
| TIME-3 | 通过 | concurrency | challenge／pairing／idle／absolute 在锁等待中越过到期边界 | 通过 |
| HB-1 | 通过 | review | 成功才 `touchLastSeenLocked`；400／401／403／404／409／422／429 不改 lastSeen／version | 通过 |
| HB-2 | 通过（2026-09-15 才拆满四案） | concurrency 四条 | 09-14 行只实测 authVersion。09-15：authVersion／link／policy／session 各自独立连接，GET 等待后失效且 lastSeen 不变 | 通过 |
| DB-7 | 通过 | `stp004.db.spec.ts` | lookup MATCH SIMPLE FK、回填、签发不可变、替换 1:1／方向、`pg_catalog` 实物 | 通过 |
| 首次 SIGN_IN 兼容 | 通过 | review + AUTH-3 | 无 identity 的 challenge 可插入；消费回填；双 challenge 并发仍 1 Account／1 Identity | 通过 |

原库 expand 预检 exit 2，未应用；fresh 库三条迁移已部署。T11-3／CON-3 学习写入仍 **未执行／延期**。

## 2026-09-15 补记

| 编号 | 本阶段结论 | 测试／入口 | 关键断言 | 最近结果 |
| --- | --- | --- | --- | --- |
| 父键 CHECK | 通过 | db.spec | identity／account 全空或全有；lookup 父键在 identity 盖章后完整；`pg_catalog` 实物 | 通过 |
| 并发反环 | 通过 | db.spec 双连接 | 双方 `ORDER BY id FOR UPDATE`；锁后可见已提交 pointer；对向更新报 cycle | 通过 |
| 多跳链 | 通过 | db.spec | G0→S0→G1→S1 后再指回 G0 拒绝 | 通过 |
| 并发发码 | 通过 | concurrency | advisory 后重查；201+429；仅一个未锁定有效码 | 通过 |
| step-up／logout CSRF | 通过 | http + review | step-up 缺 CSRF 400 且不心跳；成功发码心跳；logout 缺 CSRF 400；未登录 SIGN_IN 仍可发码 | 通过 |
| 发布／失败锁时钟 | 通过 | policy-publish + concurrency | 发布与 OTP 失败锁定用 `clock_timestamp()`；等待越过到期后 `lockedAt >= expiresAt` | 通过 |

`stp004_two_mig` 已依次应用第三条与 `20260915160000`。原库只读。E2E 1 passed，不是并发证据。STP 004 仍进行中。

## 2026-09-16 归档补记（未改代码、未重跑）

第 10 节四项修复与第四条迁移 `20260915160000_stp004_parent_keys_cycle_clock` **复核通过**（fresh／two-mig）。本文件日不重跑测试。STP 004 **仍进行中**。

权威回归在仓库：`stp004.review.spec.ts`、`stp004.concurrency.spec.ts`、`stp004.db.spec.ts`、`stp004.http.spec.ts`、`stp004.matrix.spec.ts`、`apps/web/e2e/stp004-ui.spec.ts`。`.local/stp004-pg/`、`.local/stp004-e2e/`、一次性 catalog 脚本与 Playwright `fixture@95` 噪声为临时探针，不替代上表。

下列三项 **分别登记**，不混作本轮四项或第四条迁移的阻塞：

| 类别 | 内容 | 对本轮四项／第四条 |
| --- | --- | --- |
| 原库污染 | `stp004_identity` 3 条缺 lookup alias、428 条父键不完整；expand 与第四条 pending；只读不回填 | 不阻塞。升级路径已由 two-mig 证明 |
| 既定延期 | T02-D → STP 005；T11-D → 通知 worker；T11-3／CON-3 学习写入；STP 004 整体未完成 | 不阻塞。矩阵行保持后续阶段／部分通过 |
| 非阻塞补强 | replacement reason 必有 pointer；E2E 非并发证据；db.spec 行锁辅助；TIME-2 范围不变 | 不阻塞 |

不得把原库 pending 写成“第四条迁移复核失败”。不得把既定延期或补强写成“本轮四项未通过”。
