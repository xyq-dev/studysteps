# STP 005 学段、学制与年级目录——实现前设计

实现前设计基线。2026-09-16 用户已授权代码／Schema／新增迁移；本地实现对照本文件执行。STP 004 **仍进行中**。不得宣称 M0／STP 002／接口冻结。

## 1. 范围

| 本设计覆盖 | 明确不在本设计实现／验收 |
| --- | --- |
| 小学／初中／高中；六三／五四／自定义 `GradeConfig` | 大学及成人专用模板（方案第 2.1 节：第二阶段） |
| 目录版本、档案教育快照、升年级等历史 | `TaskOccurrence`／完成记录年级快照（**STP 006**） |
| 对象授权、幂等、乐观锁、**纳入 7.7 的目录锁**、增量迁移 | 协作监护人、班级、全国统一课表 |
| 家庭侧单通道 `PATCH EDUCATION`；S02／P05／S17；S07 可浏览；A02 只读 | 内容管理员运营发布台、导出／删除（STP 009） |
| T02-D 矩阵 | T03–T09；T11-D |

### 1.1 模板数量（相对原方案的范围变化）

原方案第 2.2 节与 `TASKS.md` 退出门槛写：**12 个常见年级入口 × 3 条 = 36**（日常安排、阅读或复习习惯、周计划）。12 档对齐六三常见入口：小一–小六、初一–初三、高一–高三。

五四制另有**初四**，不在这 12 档内。本设计**建议并记录**：在 36 之外**另补初四 3 条，总计 39**。这是对原方案“共 36 个”的显式扩展，不是把初四算进那 12 档、也不是让初四套用初三模板。

| 口径 | 数量 |
| --- | --- |
| 原方案／TASKS 原文 | 36 |
| 本设计拟议 STP 005 种子 | **39**（12×3 + 初四×3） |
| T02-D | 不依赖 36 或 39 是否已种完；映射合法性单独验收 |

`PROJECT_PLAN.md` **不改写**。冲突见第 10 节。自定义年级**可以打开 S07 浏览**全部已发布模板；**无 `catalogEntryKey` 时不自动推荐、不自动套用**。

正式学习记录仍禁止在年龄未确认或教育未合法时创建。STP 005 只解除 `ACADEMIC_CONFIGURATION_PENDING`，不实现 STP 006 写入。

## 2. 学段与学制映射

不得把年级存成跨学制全局整数。字段：`stageCode`、`schoolSystemCode`、`gradeCode`、`gradeLabel`、`termCode`。STP 004 可空快照列保留；本任务加目录与合法性，不改年龄列。

### 2.1 学段（P0）

| `stageCode` | 含义 | P0 年级范围 |
| --- | --- | --- |
| `PRIMARY` | 小学 | 六三：一至六年级；五四：一至五年级 |
| `JUNIOR` | 初中 | 六三：初一至初三；五四：初一至初四 |
| `SENIOR` | 高中 | 高一至高三 |

界面密度只影响展示，不改变授权或年龄。

### 2.2 学制

| `schoolSystemCode` | 含义 | 约束 |
| --- | --- | --- |
| `SIX_THREE` | 默认六三制 | 小学 6＋初中 3＋高中 3；**无**初四 |
| `FIVE_FOUR` | 五四制 | 小学 5＋初中 4＋高中 3；**无**小六；**有**初四 |
| `CUSTOM` | 自定义 | 必须指向已发布自定义 `GradeConfig`；`gradeCode` 不当成其他学制序号 |

`gradeCode` 仅在 `(schoolSystemCode, stageCode)` 内唯一。展示用 `gradeLabel`。`catalogEntryKey`：六三 12 档与五四重叠档（小一–小五、初一–初三、高一–高三）共用键；五四初四使用独立键（对应另 3 条模板）；自定义可空。

### 2.3 合法组合

只接受已发布 `GradeConfig`。客户端自报字段与目录行不一致则拒绝。

非法例（400，不静默改写）：六三＋初四；五四＋小六；裸数字年级；用六三小六数字匹配五四。

### 2.4 `termCode`

建议并固定本任务枚举（方案未列值，此处补齐并记冲突于第 10 节）：

| 值 | 含义 |
| --- | --- |
| `FULL_YEAR` | 学年／不区分上下学期 |
| `FIRST_TERM` | 第一学期 |
| `SECOND_TERM` | 第二学期 |

学期不推导年级。变更学期走同一 `PATCH EDUCATION`，历史 `changeKind=TERM_SWITCH`。学年到点**只提示**，不静默升年级。

### 2.5 档案字段

新增可空 `gradeConfigId`（B09）。完整配置：`gradeConfigId` 指向已发布行；快照与该行**当时版本**一致（写时复制）。全空＝`ONBOARDING`＋`ACADEMIC_CONFIGURATION_PENDING`。禁止部分字段有值。

年龄与教育仍为不同 `kind`（`AGE` vs `EDUCATION`），互不推导。年级不能作为监护权限或未满 14 岁依据。

## 3. GradeConfig 版本与升年级历史

### 3.1 目录

| 实体 | 职责 |
| --- | --- |
| `GradeConfig` | 稳定身份；已发布 unique `(schoolSystemCode, stageCode, gradeCode)` |
| `GradeConfigVersion` | 不可变正文：标签、序号、`nextGradeConfigId`、`catalogEntryKey?`、允许的 `termCode` 集合 |
| 当前指针 | 与同意政策相同；已发布正文禁止 UPDATE／DELETE |

**STP 005 只通过迁移种子发布当前版本。家长不能写目录。A02 只读预览。运营改目录归 STP 009。** 种子无真实学校／儿童信息。

`nextGradeConfigId` 仅为升一年建议。高三／无 next 的自定义为 `null`。跨学制无默认 next。

### 3.2 历史

`StudentEducationHistory`：归属档案；`changeKind` 为 `SET`｜`PROMOTE`｜`REPEAT`｜`SKIP`｜`LEAVE`｜`RESUME`｜`SYSTEM_SWITCH`｜`TERM_SWITCH`；from／to 快照；操作人；`effectiveLocalDate`＋时区快照；`createdAt` UTC；行不可变。

升年级改**当前**档案；过去只通过本表解释（任务实例快照仍 STP 006）。不自动替换已有计划。

### 3.3 `ACTIVE`

须同时：适用同意仍为当前必要版本；教育为完整合法快照。已 `RESTRICTED` 不因配年级恢复。`ACTIVE` 不创建计划。

## 4. 写通道、step-up、权限

### 4.1 单一 PATCH 通道

**首次配齐与之后一切教育修改只走** `PATCH /v1/students/:studentId` 且 `kind=EDUCATION`。

不设 `POST .../education-changes` 作为第二条写通道。读历史用 `GET .../education-changes`。

**与现网冲突：** `POST /v1/students` 的 `createStudentSchema.education` 可选，`students.service.ts#create` 会把五字段快照直接写入档案，且不校验 `GradeConfig`。本设计拟议：建档教育保持全空；携带非空教育体则 400，不得在创建事务里完成 `SET`。这样首次设置与后续修改共用同一 PATCH，不另开建档配齐通道。若产品坚持建档一次写齐，须先书面确认，并要求与 PATCH 同一目录校验、同一 step-up、同一 7.7 目录锁——本稿不把该例外写成已批准。

请求须含 `expectedVersion`、`Idempotency-Key`、`gradeConfigId`（或显式 null 清空）、`termCode`（配齐时必填）、`changeKind`（首次从空到合法为 `SET`；其后升／留／跳／跨学制／学期须显式种类，禁止服务端猜测）。服务端按目录填快照五字段，不信任客户端自报的 stage／grade 与目录不一致。PATCH 契约须在现有 `education` 五字段之上增加 `gradeConfigId`／`changeKind`（本轮不改 contracts）。

### 4.2 与年龄写同级 step-up

本期教育写（含首次 `SET` 与后续种类）与 `kind=AGE` **同一级** step-up，复用现网时效，不另发明新窗口。

现网时效（2026-09-16 核验，未改代码）：`apps/api/src/common/config.ts` 的 `timing.stepUpMs = 5 * 60 * 1000`；`identity.requireStepUp` 与 `assertSessionCurrent(..., requireStepUp)` 均用 `stepUpValid(stepUpVerifiedAt, now, stepUpMs)`。教育写必须同时：

1. 事务外 `requireStepUp(session)`（与 AGE 相同入口）；
2. 事务内 `reauthorize(..., requireStepUp=true)`。现网 `patch()` 第五参仅为 `input.kind === 'AGE'`，`EDUCATION` 为 false。

**与现网冲突：** `EDUCATION`／`BASIC` 目前都不要求 step-up。STP 005 只收紧 `EDUCATION`，不扩大到 `BASIC`。不得为求绿跳过或改短窗口。CSRF／Origin 仍走现有 `guardWrite`。

学生会话不能改教育。撤销关系／同意后教育写必须失败。

### 4.3 权限表

| 主体 | 允许 | 禁止 |
| --- | --- | --- |
| Guardian＋有效主监护＋近期 step-up | 本档案 `PATCH EDUCATION`；读快照与历史 | 改其他档案；改年龄通道；写目录 |
| Guardian 读 | 已发布目录；本档案快照／历史 | — |
| StudentSession | 读本档案快照；读已发布目录；**打开 S07 浏览** | 改年级；自动套用未映射模板；读其他孩子 |
| 未认证 | 无 | 枚举档案 |
| 内容管理员 | 本阶段无登录写目录；种子在迁移里；A02 只读 | 家长会话发目录；看复盘 |
| 档案越权／不存在 | 同形 404 | 与“无此 GradeConfig”混淆（后者 `GRADE_CONFIG_INVALID`） |

S07：有 `catalogEntryKey` 时可**推荐**对应 3 条（初四为那组独立 3 条）；无映射仍可**浏览**已发布模板列表，导入须用户显式选择（导入事务属模板／STP 006 边界，本任务至少不得自动写入计划）。

## 5. 7.7 统一锁序（目录必须纳入）

STP 004 第 7.7 节现行顺序：

`IdempotencyRecord（如有） → identity advisory／AuthIdentity／Lookup（如有） → Account → StudentProfile → ConsentPolicy → GuardianLink → ConsentRecord → DevicePairing → DeviceSession`

（step-up 消费在 pairing 位置插入 `AuthChallenge`，见 STP 004 补记；不可变 `ConsentDocumentVersion` 不参与排序。）

**本任务把 `GradeConfig` 插在 `StudentProfile` 之后、`ConsentPolicy` 之前。** 多行按 `id` 升序。不可变 `GradeConfigVersion` 正文**不参与锁排序**（与政策文档版本相同）；只锁 `GradeConfig` 身份行。

完整序：

`Idempotency → identity advisory／Identity／Lookup → Account → StudentProfile → GradeConfig → ConsentPolicy → GuardianLink → ConsentRecord → DevicePairing →（AuthChallenge 如有）→ DeviceSession`

规则：

- 允许无锁预读收集 ID；**锁齐全后**完整重读再写。缺更早序位则整事务回滚以完整集合重试，禁止边走边补锁。
- 教育 `PATCH`：`FOR UPDATE` 档案；`FOR SHARE` 目标（及清空前的旧）`GradeConfig`。若本次会导致 `ACTIVE`／同意复核，继续按序锁 policy／link／consent，**不得**为图省事把 policy 提到 Student 之前（那会与现网 CON-2／授权事务反向）。
- **种子发布只锁 `GradeConfig`（及必要时 version 插入），不得反向批量锁 profile**（对标“政策发布只锁 policy”）。
- 现网授权事务若不触及目录，不锁 `GradeConfig`；因 Student 仍先于 Policy，与“Student → GradeConfig → Policy”无环：双方都以 Student 为更早锁。
- `lockedNow` 仍为完整锁集之后的 `clock_timestamp()`。
- 实现时扩展 `LockIds.gradeConfigIds`，以及 `normalizeLockIds`／`mergeLockIds`／`lockIdsContain`／`acquireLocks`；漏扩 `lockIdsContain` 会使目录锁在完整性检查中被静默忽略。本轮**不改代码**。

### 5.1 与现网授权事务的兼容核验（只读）

`apps/api/src/common/lock-order.ts` 现行实序为：Idempotency → advisory → Identity → Lookup → Account → **StudentProfile → ConsentPolicy** → Link → Consent → Pairing → Challenge → Session。全部为 `FOR UPDATE`；`LockIds` **无** `gradeConfigIds`。

| 现网事务 | 实际锁集 | 插入 GradeConfig 后 |
| --- | --- | --- |
| 档案 PATCH／同意授予／撤回／配对 | Student 后立刻 Policy | 仅教育写加 GradeConfig；其它路径不锁目录则跳过该档，序仍 Student→Policy |
| `PolicyPublishService.publishNext` | **只锁 Policy**，不锁 profile | 与种子对标；教育写 Student→GradeConfig→Policy，发布只锁 Policy，无环 |
| CON-2（授权 vs 发布） | 授权 Student→Policy；发布 Policy | 目录不参与则行为不变；教育写多一档 SHARE／UPDATE 目录，发布仍不锁 Student／GradeConfig |
| 建档 `create` | Account→Policy（档案尚不存在） | 拟议建档不配教育，故不锁 GradeConfig；若误把教育写入建档，须在 Policy 之前锁目录，仍不得先锁尚未存在的 profile 再回头 |

`FOR SHARE`：现网 `acquireLocks` **不能**发 SHARE。实现须增加按表锁模式，或教育写对 `GradeConfig` 暂用 `FOR UPDATE`（更强、同序、与不锁目录的授权事务仍无环）。种子对目录 `FOR UPDATE`、教育写 `FOR SHARE` 相容；禁止种子或发布反向锁 profile。

不兼容的旧表述（本文此前一版“ConsentPolicy → GradeConfig → StudentProfile”）作废：那会把档案锁放到政策之后，与 7.7 和现网 `acquireLocks` 相反。

## 6. 约束、幂等、迁移

| 约束 | 数据库 |
| --- | --- |
| 学制内年级唯一 | 已发布 unique `(school_system_code, stage_code, grade_code)` |
| 快照完整 | 全空或 `grade_config_id`＋五字段＋`termCode ∈ {FULL_YEAR,FIRST_TERM,SECOND_TERM}` 且与版本一致 |
| 目录不可变 | 禁止 UPDATE 已发布 version 正文 |
| 历史不可改 | 无 UPDATE；无级联删档案 |
| 年龄／教育 | 无互推触发器 |

不猜测回填已有不完整快照。

幂等：同键同体重放；异体 409；`expectedVersion` 冲突 409；双 PATCH 一成功一 409；成功至多一条历史。

迁移：不改写已有四条；新表＋可空 FK＋CHECK。有历史后禁 drop 回滚。原库只读。CI 在四条之上叠加，不依赖 `.local`。

## 7. API 与页面

| 方法 | 路径 | 要点 |
| --- | --- | --- |
| GET | `/v1/grade-configs` | 已发布目录 |
| GET | `/v1/students/:studentId` | 配齐且同意有效则去掉 `ACADEMIC_CONFIGURATION_PENDING` |
| PATCH | `/v1/students/:studentId` `kind=EDUCATION` | **唯一教育写**；step-up＋CSRF；目录锁按 7.7 |
| GET | `/v1/students/:studentId/education-changes` | 历史 |
| GET | `/v1/templates` | 可浏览；推荐仅当有映射；**非 T02-D 必过项** |

错误码：`GRADE_CONFIG_INVALID`、`GRADE_CHANGE_NOT_ALLOWED`。无 `POST education-changes`。

| 页面 | 本任务 |
| --- | --- |
| S02 | 合法目录可选；未配齐不宣称学习已激活 |
| P05／S17 | 监护人改教育（step-up） |
| S07 | 任意已配年级（含自定义）可进；无映射不推荐、不套用 |
| A02 | 只读；无发布按钮 |

高保真仍未交付，见第 9 节：不因此把接口写成已冻结。

## 8. T02-D 验收矩阵

执行前一律 **未执行**。CI 绿不能代替本表。

| 编号 | 断言 | 入口 |
| --- | --- | --- |
| T02-D-63 | 六三可存、无初四 | DB＋API |
| T02-D-54 | 五四可初四、不可小六 | DB＋API |
| T02-D-X | 自定义按其配置存；可打开 S07；无 key 时响应不含自动推荐／自动导入 | API（S07 批次可后做 UI） |
| T02-D-REJ | 非法组合 400，version 不变 | API |
| T02-D-AGE | 改年级不改年龄；改年龄不改教育 | T02-B 回归 |
| T02-D-SET | 空→合法仅 PATCH EDUCATION＋`SET`；同意有效才 `ACTIVE` | API＋DB |
| T02-D-PROMOTE | 同通道 `PROMOTE`；旧快照在历史 | API＋DB |
| T02-D-YR | 无确认不自动升年级 | 负向 |
| T02-D-REP | 留级／跳级／跨学制显式 kind | API＋DB |
| T02-D-TERM | 仅三枚举；`TERM_SWITCH` 不改 `gradeConfigId` | API＋DB |
| T02-D-STEP | 无有效 step-up 的教育写失败；窗口与年龄写相同 | API |
| T02-D-IDEM | 同键无第二历史；异体 409 | API |
| T02-D-CON | 双 PATCH 409 | 并发 |
| T02-D-AUTH | 跨档案同形 404 | API |
| T02-D-LOCK | 锁序 Student→GradeConfig→Policy；与现网授权／CON-2 无反向；种子不锁 profile | 并发 |
| T02-D-OCC | 任务实例年级快照 | **STP 006** |

T02 整体须 T02-B∧T02-D。39 模板种子是 STP 005 退出门槛，不并进 T02-D。

## 9. M0／STP 002 对本阶段的硬依赖（不虚构冻结或绕过）

| 来源 | 实际状态 | 对 STP 005 的含义 |
| --- | --- | --- |
| 方案 18.2 | 建议先完成 STP 001／002 **再冻结第一轮接口** | **不得宣称** STP 005 API 已冻结 |
| STP 001 | 六份专题已按 **STP 004 范围**抽出；全量 M0 **未冻结** | 年级目录以方案第 2 章＋本文为准；与专题冲突时记录，不静默改方案 |
| STP 002 | **待开始**；优先页为 **S04、S05、S06、S08、S09、S10、S11、S15、P02、A03**（不是 “S04–S11”；该名单**不含 S07**） | S07／A02 **不在**该优先名单；A03 是模板运营稿，不冻结本阶段种子。缺高保真 **不**等于禁止目录／PATCH 的服务端设计与本轮已授权编码 |
| STP 004 Code Start Gate（`CURSOR_STP004_PROMPT.md`） | 曾要求 STP 002 完成；后以 B01＋`LOCAL_CODE_AUTHORIZED` **仅授权 STP 004** | **不自动授权** STP 005 改 Schema／代码 |
| STP 004 验收门禁 B07 | 隔离库证据已有，STP 004 **仍不得标完成** | 共享的 `PATCH`、step-up、7.7 仍可能被 STP 004 收口牵动 |
| `TASKS.md` STP 005 前置 | STP 003；与 STP 004 **共享档案字段已稳定** | 字段已存在但教育写尚未 step-up、尚无目录锁；**编码前须另行授权**，且须接受与进行中的 STP 004 合并 |

**不是硬阻塞（不得写成已绕过门禁）：** 用最小可操作页做 S07 浏览（类似 STP 004 的 S02），不以高保真冒充 STP 002 完成。

**是硬阻塞：** 无新的代码／Schema 授权就开始实现；把 T02 或接口写成已冻结；为赶 STP 005 削弱 STP 004 断言或 skip。

品牌／经营主体／正式政策文案仍阻塞**生产**种子文案，不阻塞测试目录种子。

## 10. 冲突清单（不改原方案正文）

| 冲突 | 原口径 | 本文拟议 | 处理 |
| --- | --- | --- | --- |
| 模板总数 | 第 2.2 节、第 16.1 节 M4、第 18.2 节 STP 005 均为 **36** | 36＋初四 3=**39** | 记范围变化；**不改** `PROJECT_PLAN.md`；`TASKS.md` 退出门槛改为 39 并注明相对 36 的扩展 |
| `termCode` 取值 | 方案未列枚举 | `FULL_YEAR`／`FIRST_TERM`／`SECOND_TERM` | 设计补齐；若产品否定须改本文后再编码 |
| 教育写 step-up | 7.4／年龄变更点名近期验证；现网只 AGE（`reauthorize` 第五参亦然） | 教育写与 AGE 同级，窗口 5 分钟 | 实现时改 API，补测试；属收紧现网，不是放宽 |
| 建档教育体 | `create` 可选写入五字段、无目录 | 建档保持全空；配齐只走 PATCH | 实现时拒绝非空 create.education；属收紧，须回归建档用例 |
| 锁序 | 7.7 无 GradeConfig；`acquireLocks` 仅 FOR UPDATE | Student 之后、Policy 之前；SHARE 或暂用 UPDATE | 实现时改 `lock-order.ts` 及完整性检查；禁止政策之后再锁档案 |
| 双写通道 | 本文前一版允许 POST changes | **只保留 PATCH** | 前一版作废 |
| A02 发布 | 方案 A02 含配置；内容管理员可发布模板 | 本阶段只读＋种子 | 写配置／A03 运营发布推迟 STP 009 |

## 11. 衔接与文档状态

编码已按本设计落地（见 `docs/STP005_IMPLEMENTATION_REPORT.md`）。contracts 的 EDUCATION 体含 `gradeConfigId`／`termCode`／`changeKind`；`requireStepUp` 覆盖 EDUCATION；`LockIds`＋`acquireLocks` 含 `gradeConfigIds` FOR SHARE；仅新增第五条 migration；种子 39 条模板＋学制行。

| 项 | 状态 |
| --- | --- |
| 设计（含拟议关闭） | 已出 |
| Schema／代码 | 本地已实现，未 commit；产品验收待 CI |
| T02-D 执行 | 本地隔离库已跑；CI 未跑本轮 |
| 模板种子 | 迁移内 39 条已发布原创模板 |

## 12. 具体开工阻塞

2026-09-16 用户已授权 STP 005 代码、Schema 与新增迁移。授权之后仍须满足：

1. 接受第 10 节 36→39 与 `TASKS` 退出门槛对齐（或产品改回 36 并废止初四独立模板）。`PROJECT_PLAN.md` 第 2.2／16.1／18.2 仍为 36，未改写。
2. 教育写补 step-up（事务外 `requireStepUp`＋事务内 `reauthorize(..., true)`），窗口保持 5 分钟，回归 AGE／撤销矩阵，禁止删断言或 skip。
3. 目录锁按第 5／5.1 节进入 7.7；扩 `LockIds` 全套辅助函数；与 CON-2／政策发布／授权 GET 同序验证。本轮已用 GradeConfig `FOR SHARE`。
4. 建档拒绝非空 `education`（或先确认“建档一次写齐”例外）。
5. 不宣称 M0／STP 002／接口冻结；S07 仅最小可浏览。STP 002 优先页是 S04、S05、S06、S08–S11、S15、P02、A03，**不含 S07／A02**。
6. 原库只读；只在 fresh／CI 库迁新表。
7. STP 004 仍进行中：共享 `students.patch`、`students.create` 与锁模块的改动须可审查，不夹带 STP 006。
8. 本轮授权仅覆盖 STP 005 代码／Schema／新增迁移与隔离库验证；STP 004 的 `LOCAL_CODE_AUTHORIZED` 不扩大到 STP 006／009。
