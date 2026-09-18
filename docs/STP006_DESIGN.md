# STP 006 计划与任务实例——实施前设计

实施前设计基线，第一批已按本文落地。STP 004 **仍进行中**。STP 005 **两个页面阻塞已关闭、产品验收未完成**。不得宣称 M0／STP 002／接口冻结。整个 STP 006 阶段未完成。

工作区事实（2026-09-17 核验）：`main` = `origin/main`，HEAD `911846895adcba9ad2958f2b4c707655903cd56a`（报告基线 `main@9118468`）。另有已验证、未提交的 P05 会话回填、A02 `/v1` 代理、walkthrough E2E 与验收记录；**设计以该实际工作区为准**，不得当作「仅有 9118468 树」。

2026-09-17 权限与政策三项已定稿（第 11 节）：监护人协助创建、同意覆盖证据、任务生成窗口。先前「推荐决定」升格为约束。STP 006 **第一批已授权并本地实施**；整个阶段未完成。

## 1. 范围

| 本设计覆盖 | 明确不在本设计实现／验收 |
| --- | --- |
| 选模板 → 预览 → 调整内容和日程 → 确认创建计划 → 查看生成任务 | 打卡完成、计时、通知发送、运营发布、照片 |
| `StudyPlan`／`TaskSeries`／`TaskOccurrence`／调整记录；第七条**增量**迁移（仅设计） | 改写已发布六条迁移；生产部署 |
| T03、T04、T07；T08 的本地日期与时区边界（生成侧）；T02-D-OCC | T05–T06、T09、T12 完成／计时（STP 007）；T14 周报（STP 008） |
| Guardian／Student 对象级授权；确认时重验教育／模板／同意 | 用年级推导监护权限；匿名目录；家长建议队列（STP 008／P03） |
| 自定义年级无 `catalogEntryKey` 时继续禁止模板导入 | 自动套用未映射模板 |

**首选产品闭环（第一批最小实现）：** 已配合法年级且 `learningAccess.allowed=true` 的档案，从现有 S07 进入预览（S03），确认后写入计划并生成任务，在 S05／S08／S04 只读日程查看。S06 手动创建、范围编辑、暂停／归档、改期、拆分、14 天 Outbox 工人**不删**，见第 10 节批次，不得默认为「不做」。

`LOCAL_CODE_AUTHORIZED` 覆盖 STP 004、STP 005 及 **STP 006 第一批**。不覆盖后续批次、STP 009、commit／push／部署。

## 2. 推荐方案（只此一条）

一条学习计划归属一个 `StudentProfile`。计划下有一条或多条 **规则**（`TaskSeries`）。规则按学生时区展开为 **任务实例**（`TaskOccurrence`）。规则与实例分表，禁止把重复规则和某一天的实例混成一条可覆盖行。

创建只在用户点「确认创建」时发生。预览是只读计算，服务端不落草稿计划。确认请求必须重新核验授权、档案状态、教育快照、模板仍已发布且映射仍合法，**不信任预览响应里的指纹之外的任何客户端自报目录／年级**。

生成窗口：确认事务物化「学生时区本地今日起连续 14 个日历日」内、且不超过计划结束日的实例；之后只允许显式 `POST /v1/students/:id/task-horizon` 补窗口。两种写入口共享 `(task_series_id, occurrence_key)` 唯一约束。`GET` 日程**不**创建或补齐业务任务。不引入专用队列或通用调度平台；滚动窗口用既有单体进程 + Outbox 调用同一 POST（批次 C 落地工人）。

## 3. 页面流程

高保真仍属 STP 002（优先页含 S04／S05／S06／S08／S09，**不含 S07**）。本阶段沿用 STP 004／005 的最小可操作页，不以线框冒充 STP 002 完成。

### 3.1 现有 S07 如何进入预览

当前工作区：监护人在 P05「打开模板库」进入 S07；学生视图**仍无** S07 按钮（走查未执行）。导入按钮直接 `POST .../import`，现网返回 409「计划导入属于后续任务」。

本设计固定：

| 角色 | 进入 S07 | 预览 | 确认创建 |
| --- | --- | --- | --- |
| StudentSession 且档案 `ACTIVE`、学习访问允许 | 学生视图新增「打开模板库」（与走查缺口对齐） | 允许 | 允许；`origin=STUDENT` |
| GuardianSession 且有效主监护 | 保持 P05／后续 S17 | 允许 | 允许，但必须 step-up **且** 请求显式记录双方约定；`origin=GUARDIAN_ASSISTED`（见 11.1）。step-up 不等于学生已确认 |
| 自定义年级、无 `catalogEntryKey` | 可浏览 | 可打开说明页 | **禁止**，`TEMPLATE_IMPORT_NOT_ALLOWED` |
| `ONBOARDING`／`RESTRICTED`／学习访问不允许 | 可浏览已发布列表（与 STP 005 一致） | 展示阻塞原因 | 禁止，`LEARNING_ACCESS_BLOCKED` |

S07「导入」改为进入 **S03 预览**，不再直接创建。无映射项的导入按钮保持禁用或点按后只提示禁止，不发确认写。

### 3.2 预览（S03）不创建计划

- **进入：** `POST /v1/students/:studentId/templates/:templateId/preview`（可带用户已改字段）。成功返回规范化任务列表、默认日程、未来 7 日本地日期预估、模板 `version`、教育指纹。**零 INSERT。**
- **可编辑：** 任务名称、完成标准、科目（`Subject.code` 或「自定义」，不自动加入全部学科）、可选预计时长、开始日、重复方式（单次／每天／每周指定星期）、结束日或「持续」、可选步骤。可删除模板中的任务条目，至少保留一条。
- **不可编辑／不可默改：** 年级、学制、年龄、监护关系。年级只展示当前档案快照。
- **取消／返回：** 「取消」丢弃客户端预览状态，回 S07，不调用写接口。浏览器后退同等。刷新预览页：用同一 templateId 重新请求 preview，不恢复未确认的本地改稿（避免当已写入）。
- **确认：** 「确认创建计划」调用现有路径 `POST /v1/students/:studentId/templates/:templateId/import`（第一批把 409 占位换成真实写入）。请求带预览指纹、模板 version、学生 `expectedVersion`、编辑后的任务与日程、`Idempotency-Key`。Guardian 确认另须 `coCreationAttested: true`（双方约定声明）；缺省或 `false` 拒绝，不得靠 `origin` 或 step-up 推断。
- **保存中：** 按钮禁用，文案「正在创建计划」，不显示假成功。
- **失败：** 展示 `message`；表单保留；409 预览过期／模板下架／教育已变时提供「重新预览」，禁止用旧指纹重放当成功。

### 3.3 创建后的最小页面改动

| 页 | 本任务最小改动 | 不做 |
| --- | --- | --- |
| S05 | 计划列表入口；七日日历读 `GET .../tasks?date=`；空状态「选择模板」「自己添加」；显式「更新未来任务」调用 horizon POST | 完成勾选、计时；GET／只读加载不自动 POST |
| S08 | 计划目标、规则列表、未来实例、暂停／归档入口；显式「更新未来任务」 | 执行记录完成态（无完成接口） |
| S04 | 只读今日任务列表；无计划／休息／计划已暂停文案 | 打卡、计时、下一项完成 |
| S09 | 只读完成标准、步骤、安排日期 | 开始学习、直接记录 |
| S06／S12 | 第二批最小：S06 填写 → 预览／确认 → 计划与任务可见。暂停／归档／改期／S12 仍后延 | 本批不做范围编辑 |

## 4. 业务与数据规则

### 4.1 计划、规则、实例

```
StudentProfile 1──n StudyPlan 1──n TaskSeries 1──n TaskOccurrence
                                      └──n PlanAdjustment（改期／范围编辑／拆分说明）
```

| 对象 | 状态 | 本任务谁改 |
| --- | --- | --- |
| `StudyPlan` | `DRAFT` 不采用（预览不落库）。确认即 `ACTIVE`。另有 `PAUSED`、`ARCHIVED` | 确认→ACTIVE；暂停／归档第二批 |
| `TaskSeries` | 有 `version`、`effectiveFromLocalDate`、`effectiveToLocalDate?`。规则变更=截断旧版+新版，不覆盖旧版正文 | 创建时一条；未来范围编辑第二批 |
| `TaskOccurrence` | `PLANNED`／`IN_PROGRESS`／`COMPLETED`／`SKIPPED`／`CANCELLED` | 本任务生成 `PLANNED`，可 `CANCELLED`（暂停／取消／拆分）。`IN_PROGRESS`／`COMPLETED` 由 STP 007 转入 |

P0 重复：`ONCE`、`DAILY`、`WEEKLY_DAYS`（ISO 星期 1–7 的非空子集）。均有 `startLocalDate`，以及 `endLocalDate` 或 `ongoing=true`。不解析自然语言，不做「每周几次」。

模板 `kind`（DAILY／READING_REVIEW／WEEKLY）只表示种子内容类型，**不是**重复规则。预览默认：DAILY／READING_REVIEW → `DAILY`；WEEKLY → `WEEKLY_DAYS` 默认工作日（1–5），用户可改。

同一 `TaskSeries` 每个本地日最多一个实例。同一天两次练习必须两条规则。

### 4.2 时区、日期、窗口、去重

- 时间戳 UTC。学习日为档案当前 `timezone`（未设则 `Asia/Shanghai`）下的本地日历日；实例存 `scheduledLocalDate`、`originalLocalDate` 与生成当时的 `timezoneSnapshot`。窗口计算用**该档案时区**，不用服务器本地时区、不用监护人浏览器时区。
- **14 天闭区间（确认事务与后续 horizon POST 相同）：** 令 `today` = 锁内读取的服务器时间映射到学生时区后的本地日历日。`from = today`（含），`to = today + 13 个日历日`（含），再与规则 `endLocalDate` 取较早者。共最多 14 个本地日；不含 `today - 1`，不含 `today + 14`。`ongoing=true` 且无结束日时只截到 `to`。暂停期间不生成；恢复后从恢复日起向前看，**不补**暂停缺口。
- **去重键**必须同时包含规则／条目身份和原始本地日期，不能仅靠日期：`UNIQUE (task_series_id, occurrence_key)`，其中 `occurrence_key` = 该 `TaskSeries`（一条规则／模板条目）**最初安排**的本地日 `YYYY-MM-DD`。同一天两条练习必须两条 series，不得靠日期全局唯一。
- 改期只改 `scheduledLocalDate`；`id`、`originalLocalDate`、`occurrence_key`、`task_series_id` 不变。`TASK_DATE_CONFLICT`（409）只针对**同一 `TaskSeries`** 已有另一实例占用该实际安排日，禁止覆盖或合并这两行。实际安排日不是 `occurrence_key`，也不是全局唯一键；不同规则／不同系列可以同日并存，horizon 仍按原始 key 去重。这是 4.2／4.3「同规则已有安排日」的既定限制，不是任意任务同日禁止。
- 写入口仅：确认事务、显式 `POST .../task-horizon`、单次改期，以及后续批次在同一 POST 上的 Outbox 工人。`GET .../tasks` **零 INSERT／零补齐**。冲突视为已存在，不改写已有行的快照与状态（已取消的 key 不复活，除非产品明确「恢复计划」——暂停取消的未来实例保留同一 key，恢复时把安排日 ≥ 今日、因暂停取消且无完成记录的行从 `CANCELLED` 拉回 `PLANNED` 仅限 `reason=PLAN_PAUSED`，不新建第二行，不截 14 天窗口。这是支持改期移出窗口后仍能恢复所需的联动）。

### 4.3 修改／暂停／结束对已生成任务

沿用方案 9.2，本任务只定生成侧：

| 动作 | 已 `PLANNED` 且安排日 ≥ 生效日 | 已 `IN_PROGRESS`／`COMPLETED`／`SKIPPED` | 历史完成标准 |
| --- | --- | --- | --- |
| 仅本次 | 只改该实例快照字段或改期 | 禁止用规则编辑覆盖；完成接口未交付前不可出现完成行 | 不改 |
| 从某日起未来 | 截断 series，重写未来 `PLANNED` | 不改 | 不改 |
| 暂停 | 未来 `PLANNED` → `CANCELLED`／`PLAN_PAUSED` | 不改 | 不改 |
| 归档 | 同暂停，且计划 `ARCHIVED`，不再滚动生成 | 不删行 | 不改 |
| 拆分 | 原实例 `CANCELLED`／`SPLIT`，新实例 `sourceOccurrenceId` 指向原 `id` | 原完成不得再算一次（STP 007 约束，表结构本任务预留） | 不改 |

改期撞上同规则已有安排日：提示两项安排，由用户保留或取消其一，**禁止自动覆盖**。

### 4.4 模板与年级快照（T02-D-OCC）

| 时点 | 引用 | 可变？ |
| --- | --- | --- |
| 预览 | 当前已发布 `PlanTemplateVersion` | 用户可改任务正文；不写库 |
| **计划创建** | 写入 `sourceTemplateVersionId`（可空：手动创建）+ `importedContentJson`（确认后的正文快照） | 之后模板下架／改版不改此快照 |
| **任务生成** | 每个 `TaskOccurrence` 复制当时档案教育：`gradeConfigId`、`gradeConfigVersionId`、stage／system／gradeCode／gradeLabel／`termCode`、`catalogEntryKey`，以及规则上的名称／科目／完成标准／时长 | **行级不可变**。随后 `PATCH EDUCATION`、升年级、跨学制只改档案当前值，**不得 UPDATE 已有实例快照** |

确认时重验（全部在同一写事务、锁后重读）：

1. 会话有效；Guardian 有 link；Student 绑定本档案。
2. CSRF／Origin（现有 `guardWrite`）。Guardian 创建另需 5 分钟 step-up（与 EDUCATION 同窗，不缩短）。
3. 档案非 `RESTRICTED`／删除中；`learningAccess.allowed=true`（同意当前且教育完整合法）。
4. `expectedVersion` 匹配档案乐观锁。
5. 模板行仍 `publishedAt != null`，`version` 与预览一致，`catalogEntryKey` 仍等于**当前**档案映射（自定义无 key → 拒绝）。
6. 预览指纹匹配规范化后的确认体；失配 `PLAN_PREVIEW_STALE`。

模板下架（STP 009）只阻新导入；已创建计划与实例保留。

## 5. 写入一致性

复用现有 `IdempotencyRecord`：键绑定 **主体（account 或 student session）+ 路径 + studentId + 请求摘要**。

| 情况 | 结果 |
| --- | --- |
| 同键同体重复确认 | 重放已成功响应；不第二套 plan／series／occurrence |
| 同键异体 | 409 `IDEMPOTENCY_CONFLICT` |
| 预览后模板下架／换 version | 409 `PLAN_PREVIEW_STALE` 或 `TEMPLATE_IMPORT_NOT_ALLOWED`；version 不变 |
| 预览后教育／映射变化 | 同上；不按旧年级写入快照 |
| 预览后撤回同意／撤销关系 | 授权失败；**禁止**把已归档 idempotency 成功体返回给已失权主体（对齐 STP 004 CON-3 重放） |
| 双确认并发 | 档案 `FOR UPDATE` 串行；其一成功，另一要么幂等命中要么 `VERSION_CONFLICT` |
| 并发生成同一窗口 | 唯一约束；后者视为已存在 |
| 失败 | 事务回滚；不出现「有计划无实例」或「有实例无计划」。Outbox 仅在提交成功后可见 |

乐观锁：计划／规则带 `version`。家长与学生同时改同一计划 → 409 + 可解释差异字段，不静默覆盖。

## 6. 授权与锁序

每次写：解析 cookie → 活会话 → 对象级授权 → 7.7 锁序锁齐 → **完整重读再验** → 写 → 成功才 heartbeat（沿用节流）。

不得用 `gradeConfigId`／学段代替 `GuardianLink`。学生会话不能提权改年级或管设备。

### 6.1 动作权限与同意用途（分开定义）

**动作权限**（谁可以调用哪个端点）与 **同意用途**（当前告知文档是否覆盖该处理）不是同一层。不得用权限集名称推定告知覆盖，也不得用已有同意记录推定已具备 `PLAN_*`。

**动作权限（已定）：** 权限集 **key 保持** `PRIMARY_GUARDIAN_V1`（`GuardianLink.permissionSetKey`，不是 ConsentPolicy）。在 `packages/domain` 的 `PRIMARY_GUARDIAN_ACTIONS` 增加：`PLAN_READ`、`PLAN_CREATE`、`PLAN_UPDATE`、`TASK_READ`、`TASK_ADJUST`。不新建名为 `PRIMARY_GUARDIAN_V2` 或 `TEST_*_V2` 的政策／权限集。`RESTRICTED` 不含这些。`ONBOARDING` 不含创建与调整。StudentSession：仅绑定档案；`ACTIVE` 且 `learningAccess.allowed=true` 时可 `PLAN_CREATE`／`PLAN_UPDATE`／`TASK_ADJUST`／读日程；不能 `PROFILE_UPDATE_*`、不能监护人 action。现网 `authorizeLocked` 对学生除 `PROFILE_READ` 一律 403，实现时按上表放开。

**同意用途（已定：现网文档证据不足，本轮不发布新版本）：** 见 11.2。计划写仍须实时重算当前必要同意（STP 004 规则），但不能把 `test-v1` 占位正文解释成已覆盖计划／导入／实例。

### 6.2 锁序

现网：`Idempotency → advisory／Identity／Lookup → Account → StudentProfile → GradeConfig(FOR SHARE) → ConsentPolicy → GuardianLink → ConsentRecord → DevicePairing → AuthChallenge? → DeviceSession`。

本任务新增（全部按 `id` 升序；缺锁整事务重试）：

1. **`PlanTemplateVersion` `FOR SHARE`**：插在 `GradeConfig` 之后、`ConsentPolicy` 之前。理由：确认必须钉住已发布模板行；STP 009 下架若 `FOR UPDATE` 同一行，与 SHARE 相容；**下架不得锁 StudentProfile**（对标政策发布只锁 Policy）。不可变正文不另锁第二套。
2. **`StudyPlan`／`TaskSeries`／`TaskOccurrence` `FOR UPDATE`**：放在 `DeviceSession` **之后**。理由：它们是学生图上的新业务行，必须晚于授权图；创建时尚未有 id 则不锁，插入发生在授权锁之后。后续改计划必须先锁已有 plan／series／occurrence，且仍先完成授权图。

完整序：

`Idempotency → … → Account → StudentProfile → GradeConfig → PlanTemplateVersion → ConsentPolicy → Link → Consent → Pairing → Challenge → Session → StudyPlan → TaskSeries → TaskOccurrence`

`POST .../task-horizon` 与确认写入同一锁序；锁内重验会话、link、当前同意、档案状态、`learningAccess`、教育快照后再 `INSERT … ON CONFLICT DO NOTHING`。禁止先锁 occurrence 再回头锁 Student。`GET .../tasks` 不进入该写锁路径。

## 7. 数据库约束与第七条迁移

**需要第七条增量迁移。** 六条已发布迁移一字不改。本轮**不创建**该文件。

建议表（名称可在实现时按 Prisma 惯例映射）：

| 表 | 关键约束 |
| --- | --- |
| `study_plans` | `student_profile_id` FK Restrict（学生归属）；`created_by_account_id` 可空 Restrict（实际操作监护账号；学生会话创建时为签发该会话的主监护，或空）；`created_by_session_id` 可空；`origin IN (STUDENT, GUARDIAN_ASSISTED, MANUAL)`；`co_creation_attested_at`／`co_creation_attested_by_account_id`；CHECK：`origin=GUARDIAN_ASSISTED` 则上述两列均非空；`student_confirmed_at` 可空（step-up **不得**写入）；`status` 检查；`source_template_version_id` FK 可空 Restrict；`version` |
| `task_series` | `plan_id` FK；`repeat_kind`；`ongoing` 与 `end_local_date` 互斥 CHECK；`version` |
| `task_occurrences` | `series_id` FK；**`UNIQUE (series_id, occurrence_key)`**；`original_local_date`／`scheduled_local_date`；教育快照列 NOT NULL（生成时写入）；禁止 UPDATE 快照列（触发器或应用层+无 snapshot 的 UPDATE 白名单） |
| `plan_adjustments` | 不可变行；指向 plan／series／occurrence；原因码 |

回滚：有生产数据后禁 drop。前滚：新表；无回填历史实例。原库 `stp004_identity` 只读，实现时只打隔离库。

## 8. 最小 API

通用：HTTPS JSON `/v1`；错误 `{ code, message, requestId, fields? }`；越权／不存在同形 404；写接口 CSRF＋Origin；创建／变更 `Idempotency-Key`；可变资源 `version`／`expectedVersion`。列表游标。`Cache-Control: no-store`。

| 方法 | 路径 | 主体 | 请求重点 | 成功 | 幂等／版本 | 主要错误 |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/v1/students/:id/templates/:templateId/preview` | G 读／S 读 | 可选覆盖任务与日程 | 200 规范化预览、7 日估量、`previewDigest`、模板 version、教育指纹 | 无写 | 404 同形；400 映射非法；403 会话范围 |
| POST | `/v1/students/:id/templates/:templateId/import` | G 创建+step-up+双方约定／S 创建 | 确认体＝预览结果；`expectedStudentVersion`；`previewDigest`；Guardian 必带 `coCreationAttested: true` | 201 计划＋规则＋**确认事务内**已生成的 14 日实例摘要；记录 `origin`／操作者／归属；`studentConfirmedAt=null`（Guardian） | Idempotency；学生 version | 403 `LEARNING_ACCESS_BLOCKED`／`STEP_UP_REQUIRED`；400 `TEMPLATE_IMPORT_NOT_ALLOWED`／缺双方约定；409 预览过期／version／异体幂等 |
| GET | `/v1/students/:id/plans` | G／S 读 | 游标、状态过滤 | 计划摘要 | 只读 | 401／404 |
| GET | `/v1/students/:id/plans/:planId` | 同上 | — | 计划＋规则 | 只读 | 404 同形 |
| POST | `/v1/students/:id/plans/preview` | G 读／S 读 | 无模板；`tasks` 至少一条；零 INSERT | 200 规范化预览、7 日估量、`previewDigest`、教育指纹；`template=null` | 无写 | 400 非法条目；403 会话范围；学习访问未开通时 `confirmAllowed=false`，**不得**返回 `TEMPLATE_IMPORT_NOT_ALLOWED` |
| POST | `/v1/students/:id/plans` | 同创建 | 无模板手动确认；`expectedStudentVersion`；`previewDigest`；Guardian 必带 `coCreationAttested: true`；**禁止**伪造 `templateId` | 201 计划＋规则＋确认事务内 14 日实例；`sourceTemplateVersionId=null`；`origin` 仍为 `GUARDIAN_ASSISTED`／`STUDENT`（不用 `MANUAL` 绕过双方约定 CHECK） | Idempotency `plans.create`；学生 version | 403 同意／授权／step-up；400 缺双方约定／非法条目；409 预览过期／version／异体幂等。自定义年级无映射时**允许**本入口 |
| PATCH | `/v1/students/:id/plans/:planId` | G／S 更新 | `expectedVersion`；暂停／恢复／归档 | 新 version | 幂等+version | 409；403 |
| PATCH | `/v1/plans/:planId/series/:seriesId` | 更新 | `scope=THIS_OCCURRENCE\|FUTURE`；`fromLocalDate` | 新 series version | version | 409；禁止改完成行 |
| GET | `/v1/students/:id/tasks?date=` | 读 | 本地日；可 `from`/`to` | 已存在实例；排除取消；跳过仍列出但标未完成 | **只读；不创建、不补齐**。成功请求的会话 `lastSeen` 节流 heartbeat 沿用 STP 004 HB-1，失败不 heartbeat | 401／404 |
| GET | `/v1/students/:id/tasks/:occurrenceId` | 读 | — | 实例＋不可变快照 | 只读；同上 heartbeat | 404 |
| POST | `/v1/students/:id/tasks/:occurrenceId/reschedule` | G／S 调整＋step-up | 新本地日、原因、实例 `expectedVersion` | 同 id／key／快照，只改安排日 | 幂等 `tasks.reschedule`＋实例 version | 409 同规则撞日／不可改／旧版本；403 |
| PATCH | `/v1/students/:id/tasks/:occurrenceId` | G／S 调整＋step-up | 名称、科目、完成标准、时长、步骤、实例 `expectedVersion` | 同 id／key／安排日／年级快照，只改本次正文快照 | 幂等 `tasks.edit`＋实例 version | 409 不可改／旧版本；400 非法字段；403 |
| POST | `/v1/students/:id/task-horizon` | G／S 写＋系统工人 | CSRF／Origin；`Idempotency-Key`；窗口不得超过 4.2 的 14 日闭区间 | 插入缺失实例数 | 幂等；唯一约束；锁内重验 | 403 失权后不得回放旧对象 |

现网 `TEMPLATE_IMPORT_NOT_AVAILABLE` 仅作占位，实现后不再用于成功路径。

**T11-3／CON-3：** 上表 **import／plans 写／horizon／reschedule／series PATCH** 是本阶段可承接的学习写入。同意撤回后学生会话 401、监护人创建 403／404、撤销响应之后不得提交成功、失权后幂等重放不得返回计划。**完成、撤销完成、计时、待同步完成重放仍不存在，继续延期**，不得用计划写入冒充 T05／T06／T09。

## 9. 验收矩阵

执行前一律 **未执行**。设计稿不是通过。

| 编号 | 断言 | 入口 |
| --- | --- | --- |
| T06-P-PREV | 预览不插入 plan／series／occurrence；取消后库仍空 | API＋DB |
| T06-P-OK | 合法映射＋ACTIVE：确认后 1 计划、对应 series、`today`～`today+13`（学生时区）内实例无重复 | API＋DB |
| T06-P-ORIGIN | Guardian：step-up 成功但无 `coCreationAttested` 不落库；有约定则 `origin=GUARDIAN_ASSISTED`、操作者／学生归属落库、`studentConfirmedAt` 仍为空。学生创建 `origin=STUDENT` | API＋DB |
| T06-P-CUSTOM | 无 `catalogEntryKey` 确认 400 `TEMPLATE_IMPORT_NOT_ALLOWED` | API |
| T06-P-IDEM | 同键同体第二次确认不第二套计划 | API＋DB |
| T06-P-BODY | 同键异体 409 | API |
| T06-P-STALE-T | 预览后模板 version／下架再确认失败，无行 | API＋DB |
| T06-P-STALE-E | 预览后 SYSTEM_SWITCH／失去映射再确认失败 | API＋DB |
| T06-P-STALE-A | 预览后撤回同意／撤关系再确认失败；重放不返回计划 | API＋DB |
| T06-P-OCC | 生成后再 PROMOTE：旧实例快照年级不变；新窗口新实例用新年级 | API＋DB（T02-D-OCC） |
| T06-P-UNIQ | 确认生成与 horizon 并发无重复 key | 并发 |
| T06-P-CON | 双确认一成功一 409／幂等 | 并发 |
| T06-P-REV | 当前计划写与同意撤回竞争：只能线性化在撤回前；撤回响应后无晚到提交（CON-3 学习写） | 并发 |
| T03 | WEEKLY_DAYS＋起止日多次生成无重复 | domain＋DB |
| T04 | 仅本次／未来范围；不覆盖不存在的完成记录 | API（第二批） |
| T07 | 两端并发改计划 409 | 并发（第二批） |
| T08-G | UTC 存、本地日、跨时区日界不串日 | domain＋DB |
| T10-P | 猜他人 planId／taskId 404 同形 | API |

页面：合法导入、取消预览、刷新后仍见已保存计划（依赖已修复的 P05 会话恢复，不单测二次 SET）。

## 10. 实施批次（实现授权之后才开工）

| 批 | 内容 | 退出 |
| --- | --- | --- |
| **A 最小闭环（第一批，不扩展）** | 第七条迁移；preview／import 真写入；GET plans／plan／tasks（只读）；学生 S07 入口；S03 确认／取消；S05／S08／S04 只读；确认事务内生成 14 天；`POST .../task-horizon` 端点（供窗口外补齐与 T06-P-UNIQ，无工人）；T06-P-*（含 ORIGIN）、T03 生成、T02-D-OCC、T11-3／CON-3 的**计划写** | 闭环可点；无完成；无新同意文档、无重新同意页 |
| B | S06 手动 `POST /plans` 最小闭环（已落地）；暂停／恢复／归档（已落地）；按需 `task-horizon` POST（已落地）；单次改期（已落地）；仅本次内容编辑（本批）；FUTURE 范围编辑；S12 最小（后延） | 仅本次内容可点；未来规则／拆分／工人未做 |
| C | 拆分；Outbox 工人调用同一 `task-horizon` POST（不经 GET）；S09 只读细节打磨 | TASKS 所列后台任务入口 |

A 未完成不得声称 STP 006 退出门槛已过。B／C 仍属 STP 006，不是 P1。

## 11. 已定稿决定（2026-09-17）

下列三项原为开工前未决；现已锁定。不得再以「推荐」口径实现。本轮仍不编码、不发布政策。

### 11.1 监护人协助创建：`GUARDIAN_ASSISTED`，保留共同制定要求

**原文（不改 `PROJECT_PLAN.md`）：**

- §3.2：「随后与孩子共同选择关注的科目、通常可用的时间段和一个计划模板，预览并修改后保存。」
- §4.3：「家长新增计划时默认作为建议，由孩子在计划页确认；低年级可选择共同制定模式，由家长记录双方约定。」

两条路径不得混成一个来源标签：

| 路径 | 归属 STP | 落库要求 |
| --- | --- | --- |
| 默认：家长新增＝建议，孩子在计划页确认 | STP 008／P03 | `studentConfirmedAt` 由学生明确确认写入。第一批**不**实现建议表 |
| 共同制定：家长记录双方约定 | STP 006 第一批 Guardian import | 正式 `StudyPlan`；`origin=GUARDIAN_ASSISTED` |

**已定：**

1. Guardian 确认写入正式计划（孩子立刻只读可见），不是 P03 建议。
2. 必须记录：**实际操作者**（`created_by_account_id` = 当前 GuardianSession 的 Account）、**学生归属**（`student_profile_id`，只从路径解析，不信请求体）、**来源**（`origin=GUARDIAN_ASSISTED`）。
3. step-up 只证明监护人二次认证，**不得**写入 `studentConfirmedAt`，也不得把 step-up 成功解释为「学生已确认」或「双方已约定」。
4. 「家长记录双方约定」是独立事实：请求必须带 `coCreationAttested: true`；服务端写入 `co_creation_attested_at` 与 `co_creation_attested_by_account_id`。缺字段或 `false` → 400，整笔回滚。仅写 `origin` **不满足**原文共同制定。
5. 学生会话创建：`origin=STUDENT`；不要求双方约定字段；操作者会话为 StudentSession。

第一批不因 Guardian 路径去实现「孩子在计划页确认」。该确认仍是默认建议路径的要求，留给 STP 008。

### 11.2 现有同意覆盖：证据不足，不新建名为 V2 的政策

先区分三层，禁止互相顶替：

| 层 | 现网标识 | 位置 |
| --- | --- | --- |
| 权限集 key | `PRIMARY_GUARDIAN_V1` | `prisma/schema.prisma` `GuardianLink.permissionSetKey` 默认值；`packages/domain/src/permissions.ts` `PRIMARY_GUARDIAN_ACTIONS` |
| 同意政策 code | `TEST_CHILD_CORE_SERVICE`／`TEST_MINOR_CORE_SERVICE` | `packages/contracts/src/index.ts` `TEST_POLICY_KEYS`；`packages/domain/src/age.ts` |
| 告知文档 version | `test-v1` | `apps/api/src/students/policy.seed.ts`；B04：`docs/handoffs/STP004_B01_B09_DECISIONS.md` |

`PRIMARY_GUARDIAN_V1` **不是** ConsentPolicy。不得机械创建政策或权限集名叫 V2。STP 004 设计 8.2 所说「计划权限将在对应 STP 扩充新版本」落实为：**同一权限集 key 上补齐 PLAN_* 动作**，不换 key。

#### 现网文档与种子（不得原地改）

`apps/api/src/students/policy.seed.ts`：仅当 `authTestMode` 且非 production 时 `ensure`。已有 `currentDocumentVersionId` 则直接 return，**不会更新正文或 scope**。

正文实际为两行占位：

- `测试儿童核心服务告知（非正式）` 或 `测试未成年人核心服务告知（非正式）`
- `本文件仅用于隔离测试，不是已批准的正式告知。`

`scopeCanonicalJson` 仅：`nickname`、`avatar`、`age`、`educationSnapshot`、`timezone`、`guardianLink`、`authDevice`、`consentAudit`。测试期望见 `apps/api/src/stp004.db.spec.ts`（政策 key 与「非正式」标题）。授权实现：`learningAccess` 要求当前文档版本有未撤回 ConsentRecord；`PRIMARY_GUARDIAN_ACTIONS` 现网**无** `PLAN_*`。

不得以隔离库／测试模式为由放宽「文档用途必须可核对」；不得 UPDATE 已发布 `test-v1` 行。

#### 三项用途判断（凭正文与 scope，不凭名称）

| 用途 | 覆盖？ | 依据 |
| --- | --- | --- |
| 创建、修改学习计划 | **无法判断／不能视为已覆盖** | 正文无计划、规则、共同制定；scope 无 `studyPlan`／等价键 |
| 模板导入 | **同上** | 正文无模板；scope 无导入。`educationSnapshot` 只覆盖档案教育字段 |
| 生成和保存任务实例 | **同上** | 正文无任务实例／14 天窗口；scope 无 `taskOccurrence` |

结论：不属于「已明确覆盖 → 复用现有同意即宣称用途满足」。动作矩阵仍补齐（6.1）。隔离环境已按授权在同一 policyKey 下追加非正式 `test-v2`（见 11.4）；B04 正式文案与重新同意页面仍不在本批。

#### 推荐的新文档版本范围（仅记录，本轮不实施）

将来若授权发布（独立于 STP 006 第一批功能），应：

- **同一** `policyKey`（`TEST_CHILD_CORE_SERVICE`／`TEST_MINOR_CORE_SERVICE`），新增 `ConsentDocumentVersion`，version 字符串另定（例如 `test-v2`），**不是**新政策 code。
- 新正文须可阅读地写明：创建与修改学习计划；从已发布年级模板导入；生成并保存任务实例。
- 新 `scopeCanonicalJson` 在保留现有键的前提下至少增加计划、模板导入、任务实例对应键。
- 只切换 `ConsentPolicy.currentDocumentVersionId`；旧 `test-v1` 同意随即不满足当前版本（STP 004 §7.5 已有授予接口）。第一批**不**做新同意 UX。
- 正式经营主体文案仍受 B04 阻塞；测试占位不能冒充已批准告知。

### 11.3 任务生成：确认事务 14 天 + 显式 horizon POST

**已定：**

1. 确认 import 的同一事务生成首批窗口实例（4.2 闭区间）。失败整笔回滚。
2. 之后只通过 `POST /v1/students/:id/task-horizon` 补窗口。该 POST 沿用认证、对象级授权、CSRF／Origin、`Idempotency-Key`、7.7 锁序与锁内重验。Outbox 工人（批次 C）只调用该 POST，不另开无 CSRF 入口。
3. `GET /v1/students/:id/tasks` **不**创建或补齐 `TaskOccurrence`／计划／规则。成功 GET 的会话 heartbeat 沿用 STP 004 HB-1（成功节流 `lastSeen`；4xx／409 等不 heartbeat）；heartbeat ≠ 业务补齐。
4. 去重与改期见 4.2。

与原文 §6.3「读取日程时补齐」的差异记入第 12 节；不改 `PROJECT_PLAN.md`。

### 11.4 实现授权（第一批已解除）

2026-09-17 用户已授权 STP 006 第一批实现、独占隔离库、test-v2 隔离同意与第七条迁移。`LOCAL_CODE_AUTHORIZED` 覆盖本批，不再以「未授权」停工。不覆盖后续批次、STP 009、commit／push／部署。

### 11.5 本批之后仍开放的项

第一批功能范围已固定。B04 正式文案／经营主体仍是上线前置，不阻塞隔离开发。生产告知不得用 test-v2 冒充。

后续批次仍开放：未来规则编辑、拆分、Outbox 工人。仅本次内容编辑见 §3.8（本批）。单次改期见 §3.7。按需 `task-horizon` 见 §3.6。暂停／恢复／归档见 §3.5。打卡、计时、通知、运营发布不在本 STP。

### 3.4 S06 空白创建（第二批最小）

- **进入：** S05／P05／学生视图「自己添加」。不经过模板 ID，不创建空白模板行。
- **填写：** 至少一条任务：名称、科目（可「自定义」）、完成标准、重复（单次／每天／每周指定日）、开始日、结束日或持续。计划表无独立名称列，列表展示首条任务名。
- **预览：** `POST /v1/students/:id/plans/preview`。零 INSERT。取消只丢客户端状态。
- **确认：** `POST /v1/students/:id/plans`。复用第一批确认事务、14 天窗口、去重键、年级快照。保存中禁用按钮；失败保留输入。
- **自定义年级：** 无 `catalogEntryKey` 只禁止模板导入；手动创建仍要求教育已配置、当前必要同意、`PLAN_CREATE` 与 test-v2 用途。
- **结构：** 第七条已允许 `source_template_version_id` 为空；本批不新增迁移。

### 3.5 计划状态转换（本批：暂停／恢复／归档）

主体：持有 `PLAN_UPDATE` 的监护人（step-up）或绑定该档案的学生会话。监护人状态变更**不**要求 `coCreationAttested`（该字段只约束创建）；审计写入操作者与状态调整，**不覆盖** `origin`／`created_by_*`／`student_confirmed_at`／共同制定字段。管理员后台不在本批。

乐观锁字段是 **`StudyPlan.version`**（`PATCH` body `expectedVersion`），不是学生档案 version。状态变更与 `plan_adjustments` 同一事务。无第八条迁移：复用 `study_plans.status`、`task_occurrences.status`／`cancel_reason`、`plan_adjustments`。

| 当前状态 | 动作 | 下一状态 | 前置 | 已生成实例 | 后续生成 |
| --- | --- | --- | --- | --- | --- |
| `ACTIVE` | `PAUSE` | `PAUSED` | 权限、必要同意、`expectedVersion` 匹配 | 安排日 ≥ 生效日（学生时区今日）且仍为 `PLANNED` 的行 → `CANCELLED`／`PLAN_PAUSED`。不硬删计划／规则／实例／历史。不改 id、`occurrence_key`、年级快照、完成标准快照。`IN_PROGRESS`／`COMPLETED`／`SKIPPED` 不改（STP 007 前不应出现） | 禁止。共用生成逻辑对非 `ACTIVE` 返回空日期，不 INSERT |
| `PAUSED` | `RESUME` | `ACTIVE` | 同上 | **不**插入暂停缺口的新行，**不**复制已有行。仅把安排日 ≥ 今日、`CANCELLED` 且 `cancel_reason=PLAN_PAUSED`、无完成记录的既有行拉回 `PLANNED` 并清空 `cancel_reason`。不截 14 天窗口，以便改期到窗口外的实例在暂停后仍能恢复。不恢复过去，不恢复其他取消原因。暂停日前的 `PLAN_PAUSED` 行保持取消 | 自恢复日起允许生成。按需 `POST .../task-horizon` 已落地；Outbox 工人仍未实现，不得宣称已验证工人效果。`GET` 仍不补齐 |
| `ACTIVE` 或 `PAUSED` | `ARCHIVE` | `ARCHIVED` | 同上 | 同暂停取消仍为 `PLANNED` 且安排日 ≥ 今日的行，`cancel_reason=PLAN_ARCHIVED`。已因暂停取消的行不改写原因（不重写历史）。不删行 | 禁止生成。归档为终态 |
| `ARCHIVED` | `RESUME`／`PAUSE`／`ARCHIVE` | 非法 | — | 不改 | 仍禁止。 **不提供取消归档** |

重复与冲突：

- 目标状态已成立的再次 `PAUSE`／`RESUME`／`ARCHIVE`（非幂等重放）→ `409 PLAN_STATUS_INVALID`。
- 同 `Idempotency-Key` 且同摘要：重放前重验当前对象 `PLAN_UPDATE`，返回当前计划，不重复写审计。
- 同键异体 → `409 IDEMPOTENCY_CONFLICT`。过期／不匹配 `expectedVersion` → `409 VERSION_CONFLICT`。
- 并发两个状态 PATCH：计划行 `FOR UPDATE` 后第二笔看到新 version，不得静默覆盖。
- 未授权、同意撤回、会话失效：写入与重放均拒绝；不得把已成功体交给失权主体。

可见性：`GET` 计划列表含 `ARCHIVED`（S08 只读查看历史）。`GET` 任务仍排除 `CANCELLED`，且每条带 `planStatus`／`executable`（仅 `ACTIVE` 且 `PLANNED` 为可执行）。暂停／归档后页面不得把该计划展示为可继续执行。归档记录通过 S08 列表「查看」打开详情；无取消归档按钮。

空白补记（不改整体架构）：共同制定约定只约束创建；归档取消原因用 `PLAN_ARCHIVED` 以便与 4.2「恢复仅限 `PLAN_PAUSED`」一致；生效日=锁内 `now` 映射的学生时区今日。恢复语义从「窗口内」扩到「今日及之后」是支持单次改期所需的最小联动，不是缩小改期范围。

### 3.6 按需任务窗口补齐（本批：`POST .../task-horizon`）

主体：持有 `TASK_ADJUST` 的监护人（step-up，与其他学习写入相同，不额外放宽也不另加共同制定）或绑定该档案的学生会话。客户端不能传 `from`／`to` 或指定其他学生；窗口锁内用数据库时间映射到档案时区「今日…今日+13」，再截规则起止与重复。仅 `ACTIVE` 计划生成。只 INSERT 缺失 `(task_series_id, occurrence_key)`，不改已有行、不复活 `CANCELLED`、不清除 `PLAN_PAUSED`／`PLAN_ARCHIVED`、不追补过去日期。新年级快照只写在新行。成功返回实际窗口、`insertedCount` 与正常跳过原因；无新增是 200，不是 403。同键同摘要重放返回首次结果（含跨日本地日仍不得再生成）；同键异体 409；失权后重放仍拒绝。`GET` 与页面只读加载零 INSERT。共用 `fillMissingOccurrences` 留给未来 worker，本批不宣称后台执行时鉴权或工人验收。无第八条迁移：幂等结果缓存在既有 `IdempotencyRecord.resourceId`。

### 3.7 仅本次任务改期（本批）

主体：持有 `TASK_ADJUST` 的监护人（step-up，与其他学习写入相同，不另加共同制定）或绑定该档案的学生会话。仅 `ACTIVE` 计划下仍为 `PLANNED` 的实例可改期。目标日不得早于锁内学生时区今日；允许落到 14 天窗口外或规则结束日之后，因为改期改的是已有行的实际安排日，不改重复规则、不新生成。

保持 `id`、`task_series_id`、`occurrence_key`、`originalLocalDate` 与年级／正文快照不变；只改 `scheduledLocalDate` 并递增实例 `version`。实际安排日不是去重键；目标日若已有同 series 其他实例（任意状态）→ `409 TASK_DATE_CONFLICT`，禁止覆盖或合并。非法状态 → `409 TASK_NOT_ADJUSTABLE` 或 `PLAN_STATUS_INVALID`。取消不写库。目标日等于当前安排日：鉴权／加锁／幂等后 200，不改日期、不写 `plan_adjustments`。

接口：`POST /v1/students/:id/tasks/:occurrenceId/reschedule`（学生作用域，以便复用现网只对 `/v1/students` 附加的 `Idempotency-Key`）。body：`scheduledLocalDate`、`reason`（1–120）、`expectedVersion`（实例 version）。成功与 `plan_adjustments`（`TASK_RESCHEDULED`，含原定日、改后日、原因、操作者）同一事务。同键同摘要重放前仍重验当前 `TASK_ADJUST`，不重复审计；同键异体 409。`GET` 与暂停／归档／恢复按 `scheduledLocalDate` 判断日历与未来行；horizon 仍按 `occurrence_key` 去重，不得把被移动的原任务再生成一份。

第八条最小增量迁移只加 `task_occurrences.version`（默认 1，CHECK ≥ 1），不改 key／快照。七条已发布迁移与 test-v2 不变。历史夹具 `stp006_six_to_seven` 保持七条；合法非空七→八在隔离库 `stp006_seven_to_eight` 用 `migrate deploy` 验证。

### 3.8 仅本次任务内容编辑（本批）

主体：持有 `TASK_ADJUST` 的监护人（step-up，与改期相同，不另加共同制定）或绑定该档案的学生会话。仅 `ACTIVE` 计划下仍为 `PLANNED` 的实例可编辑。不改 `task_series` 默认正文、不改重复规则、不改 `scheduledLocalDate`。

已有业务字段（与预览／确认同一套长度）：`name` 1–64、`subject` 1–32、`standard`（完成标准／学习目标）1–240、`durationMinutes` 正整数且 ≤ 1440 或 `null`、`steps` 最多 12 条、每条 1–120。不新增「任务说明」等未建模字段。空名称／科目／标准拒绝。无变化请求：鉴权／加锁／幂等后 200，不改进度、不写审计。

展示已读实例快照（`nameSnapshot` 等），不读 series 正文。本批因此不新增第九条迁移：现有八条已能独立保存本次覆盖。horizon 新行仍从 series 复制；已编辑行不被 UPDATE。暂停／恢复只改状态，保留快照。

接口：`PATCH /v1/students/:id/tasks/:occurrenceId`（学生作用域，复用现网 `Idempotency-Key`）。`expectedVersion` 为实例 version，与改期共用乐观锁，不得静默覆盖。成功与 `plan_adjustments`（`TASK_CONTENT_EDITED`，含字段前后值与操作者）同一事务。同键同摘要重放前仍重验 `TASK_ADJUST`；同键异体 409。页面提供「编辑本次」，明确「仅影响本次任务」；不展示尚未实现的「本次及未来」。版本冲突提示重新加载。

## 12. 与原文冲突（不改 `PROJECT_PLAN.md`）

| 冲突 | 原口径 | 本文 | 处理 |
| --- | --- | --- | --- |
| 模板数 | 36 | 已由 STP 005 扩为 39 | 沿用 005 |
| 监护人新建 | 默认建议；共同制定须记录双方约定 | 006 共同制定写计划并强制约定字段；建议确认仍 STP 008 | 11.1 |
| 读取补齐 | GET 补齐 | GET 只读；补窗口仅 horizon POST | 11.3 |
| 计划权限「新版本」 | STP 004 8.2 将扩充新版本 | 权限集 key 仍为 `PRIMARY_GUARDIAN_V1`，只加 PLAN_*；不新建 V2 政策 | 11.2 |
| 接口冻结 | 建议 STP 002 后冻结 | **不宣称冻结** | 同 005 |
| S07 高保真 | STP 002 不含 S07 | 最小可操作预览 | 同 005 |

## 13. 第一批涉及文件与第七条迁移

本批已创建第七条 `prisma/migrations/20260917120000_stp006_study_plans_occurrences/`。**未改**已发布六条。test-v2 由应用启动发布，不在结构迁移内。

| 区域 | 文件（实现时） |
| --- | --- |
| 迁移 | 新建 `prisma/migrations/<timestamp>_study_plan_and_occurrences/`（第七条）；**不改**已发布六条 |
| Schema | `prisma/schema.prisma` 增加四表及与 `StudentProfile`／`PlanTemplateVersion`／`Account`／`DeviceSession` 的关系 |
| 权限 | `packages/domain/src/permissions.ts`（PLAN_*）；API `authorizeLocked` |
| 领域 | `packages/domain` 重复展开、窗口、`occurrence_key`、改期不变键 |
| 契约 | `packages/contracts` preview／import／plans／tasks／horizon 与 `coCreationAttested` |
| API | `apps/api` planning 模块；现有 import 占位改为真写入 |
| H5 | `apps/web` 学生 S07 入口、S03、S05／S08／S04 只读 |
| 测试 | T06-P-*（含 ORIGIN／UNIQ）、T03、T02-D-OCC、计划写 CON-3 |

第七条迁移范围：只建 `study_plans`、`task_series`、`task_occurrences`、`plan_adjustments` 及 4.1／第 7 节约束（含 `UNIQUE (task_series_id, occurrence_key)` 与 11.1 操作者／来源／约定列）。**不含**同意政策种子、**不含**改 `consent_document_versions`、**不含**回填实例。回滚：有生产数据后禁 drop；前滚仅新表。原库 `stp004_identity` 只读。

## 14. 文档状态

| 项 | 状态 |
| --- | --- |
| 本设计 | 11.1–11.3 已定稿；§3.5 状态转换已记录 |
| Schema／代码／第七条迁移／隔离 test-v2 | **第一批＋S06＋暂停／恢复／归档已落地**（整个阶段未完成；无第八条迁移） |
| STP 005 | 两页面阻塞已关闭；产品验收未完成（不变） |
| STP 004 | 进行中（不变） |
| 打卡／计时／通知／发布 | 不在本任务 |
