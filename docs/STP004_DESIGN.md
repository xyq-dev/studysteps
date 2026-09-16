# STP 004 账号、学生档案与授权基础——实现前设计审查

审查日期：2026年9月13日

## 1. 审查结论

| 项目 | 结论 |
| --- | --- |
| 设计审查 | 已完成 |
| 业务代码 | 未开始 |
| Prisma 业务模型／迁移 | 未创建、未执行 |
| STP 003 | 沿用已有验收结果，本轮未重跑 |
| Implementation Gate | **LOCAL_CODE_AUTHORIZED**（验收仍受 B07 阻塞；不代表 STP 004 完成） |
| 阻塞主因 | 全量 M0／STP 002 高保真仍未完成；隔离 PostgreSQL 验收（B07）在无测试库时不得宣称通过 |

本文件是 STP 004 的设计基线。`docs/CURSOR_STP004_IMPLEMENT.md` 已给出 B01–B09 本地决定并授权本地代码／Schema／migration。这不等于全量 M0 冻结、正式政策批准或 STP 004 验收完成。B07 未取得隔离 PostgreSQL 证据前，状态必须保持进行中。

核心结论：

- 授权边界必须是具体 `StudentProfile` 及其当前有效 `GuardianLink`，不能使用 `familyId` 或“同一账号下的孩子”推导访问权。
- 年龄确认与学段／学制／年级是两组独立事实，任何方向都不得互相推导。
- 未确认年龄时只提供静态体验，不在服务端创建 `StudentProfile` 或正式学习记录。
- P0 未成年人档案由已验证的监护人账号开通；未满 14 岁缺少当前必需同意时，建档事务整体回滚。
- 家长和学生使用服务端可撤销的不透明会话；学生会话只绑定一个档案，不能升级为家长会话。
- 共用设备切回家长模式必须重新验证。生成配对码、撤销设备、变更年龄和撤回同意等敏感操作还要求近期验证。
- 配对凭证由非秘密 `pairingId` 与短码共同组成；短码建议 10 分钟失效、单次消费、有限尝试，只保存带服务端密钥的摘要；并发兑换只能成功一次。
- 撤销事务提交后，旧会话的后续请求必须失败。受保护写入与撤销使用同一数据库线性化边界，不能“先鉴权、后落库”。
- 不存在对象与存在但无权访问的学生对象对外返回同形响应，避免泄露档案是否存在。

## 2. 审查基线

### 2.1 Git 与工作区

| 项目 | 实际结果 |
| --- | --- |
| 工作目录 | `D:\Program Files\PycharmProjects\studysteps` |
| origin | `https://github.com/xyq-dev/studysteps.git` |
| 分支 | `main` |
| HEAD | 不存在；`git rev-parse --verify HEAD` 退出码 128 |
| 远端 refs | `git ls-remote --heads --tags origin` 无输出，退出码 0 |
| 工作区 | 全部现有项目文件均为 untracked，没有可供普通 `git diff` 比较的基线 |

所有现有文件均视为用户已有改动。本轮只新增或更新文档，不初始化新历史、不 commit、不 push。

### 2.2 当前实现

- `apps/api` 只有 `GET /health`，没有全局 `/v1` 前缀、认证、对象鉴权、请求校验、统一错误响应或 PrismaModule。
- `prisma/schema.prisma` 只有 PostgreSQL datasource 和 Prisma Client generator；没有业务模型，也没有 `prisma/migrations`。
- `apps/api/package.json` 没有 `@prisma/client` 运行依赖。
- `packages/contracts` 只有健康检查契约；`packages/domain` 只有保持无框架／无 I/O 的边界占位。
- 当前机器没有 Docker、`psql` 或 `pg_isready`；尚无可核验的隔离 PostgreSQL 测试环境。
- STP 001 所要求的 `PRODUCT_SCOPE.md`、`BUSINESS_RULES.md`、`PAGES.md`、`DATA_MODEL.md`、`API.md`、`ACCEPTANCE.md` 均不存在；STP 002 设计也未完成。

## 3. 范围与需求追踪

| 来源 | STP 004 本次设计覆盖 | 边界／后续任务 |
| --- | --- | --- |
| S01 | 身份入口、年龄确认、授权说明与错误状态 | 正式文案和经营主体待确认 |
| S02 | 昵称、内置头像、年龄与教育字段分离、建档事务 | 科目、模板及完整年级合法性由 STP 005 完成 |
| P05 | 档案查看、学生模式、设备列表、配对和撤销 | 完整年级调整由 STP 005 完成 |
| P06 | 当前同意要求、授权历史、授予与撤回 | 导出和删除实际能力属于 STP 009 |
| T01 | 年龄、必要同意、版本留痕与建档原子性 | STP 004 必须真实验收 |
| T02 | 年龄与年级字段、规则和更新路径彼此独立 | 六三／五四／自定义映射和升年级历史由 STP 005 验收，STP 004 不得宣称 T02 全部通过 |
| T10 | 家长跨档案、学生跨档案、嵌套资源和存在性隐藏 | STP 004 必须真实验收，并作为后续模块共用授权入口 |
| T11 | 会话、关系、同意与配对撤销后的即时拒绝 | STP 004 验收核心授权服务；未发通知需在 STP 009／010 有真实 worker 后复测 |

STP 004 不实现协作监护人、主监护人自动转移、公开自助解绑、年级目录、科目、模板、计划、任务、计时、报告、导出、删除编排、管理员支持台或外部通知。

“正式学习记录”在本设计中指 `StudyPlan`、`TaskSeries`、`TaskOccurrence`、`CompletionRecord`、学习 `StudySession`、`Reflection`、`WeeklyReport`、`PlanSuggestion`、`BadgeEvent` 及对应 Outbox 业务事件。它们均不属于 STP 004。年龄未确认时连 `StudentProfile` 也不持久化；认证挑战可以存在，但不得携带儿童昵称、年级等档案内容。

## 4. 信任主体与会话边界

| 主体 | 服务端可信来源 | 能力 | 明确禁止 |
| --- | --- | --- | --- |
| 未认证请求 | 无 | 请求登录验证码、读取公开且已批准的最小告知元数据 | 创建档案、探测账号或档案、指定操作人 |
| GuardianSession | 有效 `DeviceSession.accountId` | 列出当前有效关系可见的档案；按关系权限操作指定档案 | 仅凭账号存在访问任意档案；静默冒用学生完成任务 |
| StudentSession | 有效 `DeviceSession.studentProfileId` | 只访问一个绑定档案的学生安全接口 | 列出家庭档案、访问其他孩子、管理同意／设备、切换或提升为家长 |
| 已撤销／过期会话 | 数据库状态 | 无 | 读取、写入、离线重放、兑换配对或继续同步 |
| 管理员／支持人员 | 独立账号体系 | 不在 STP 004 实现 | 复用家长会话或获得默认全库权限 |

请求体中的 `accountId`、`actorId`、`guardianId`、`createdBy`、确认时间或服务端接收时间都不能决定真实主体；出现这些权威字段时应拒绝或忽略，审计主体始终来自服务端会话。

### 4.1 会话载体

P0 手机 H5 的推荐基线是高熵不透明 session token：

- 浏览器只通过 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` 的 `__Host-stp_session` Cookie 携带会话凭证，不把 token 放入 Local Storage。受保护响应使用 `Cache-Control: no-store`。
- 数据库只保存 token 摘要，不保存 bearer token。随机 token 至少 256 bit；高熵 token 可用 SHA-256 摘要，短验证码与配对码必须使用带独立服务端 pepper 的 HMAC 摘要。
- 所有受保护请求实时检查 `DeviceSession`、账号状态、档案状态和当前 `GuardianLink`。P0 不缓存授权结果，因此撤销不等待 JWT 自然过期。
- 每个活动会话都必须有不可空的 CSRF 摘要。新会话同时设置独立的 `__Host-stp_csrf` Cookie（`Secure`、`SameSite=Lax`、`Path=/`、不设 `HttpOnly`）；前端读取它并逐请求镜像到 `X-CSRF-Token`，不写入 Local／Session Storage。服务端要求 header 与 cookie 恒定时间相等且摘要匹配当前 session。登录、学生模式切换、家长模式恢复和其他会话轮换都同时轮换 session 与 CSRF Cookie。
- 所有已认证的 unsafe method 同时校验允许的 `Origin`、CSRF cookie 和 header。尚无会话可供校验的验证码申请、首次登录兑换和配对兑换至少严格校验 Origin／Fetch Metadata 并限频；不能因为它们创建会话就跳过来源校验。
- 开发环境可以使用单独的非 `__Host-` cookie 配置，但生产配置必须启动时拒绝不安全组合。
- 如果首批入口从同源 H5 改为跨站部署或小程序，必须重新审查 Cookie、CORS、CSRF 和凭证存储；不能只增加一个允许来源。

纯长效 JWT、只包含 `studentId` 的自签令牌或前端角色标志均不满足即时撤销要求。即使后续用 JWT 包装，也只能携带 `sid`，每次仍检查服务端会话和当前关系。

## 5. 生命周期与状态

### 5.1 Account

- `ACTIVE`：可以建立 GuardianSession。
- `LOCKED`：临时阻止新的验证和会话，已有会话按安全策略撤销或拒绝。
- `DISABLED`：禁止所有业务访问并使账号会话失效。
- `DELETION_PENDING`／`DELETED`：仅为 STP 009 的向前兼容枚举预留；STP 004 不提供任何进入这些状态的命令或删除编排。

手机号或第三方主体验证只能证明对登录渠道的控制，不能自动证明现实中的监护关系。P0 若采用“监护人声明”方式，界面、同意记录和文案必须如实标明，不能显示为已经核验的法定关系。

### 5.2 StudentProfile

- `ONBOARDING`：年龄已确认、适用同意已记录、主监护关系已建立，但 STP 005 的年级／科目配置尚未完成；禁止创建正式学习记录。
- `ACTIVE`：当前必需同意、主监护关系和产品配置均满足。STP 004 不独自宣称已经达到完整激活条件。
- `RESTRICTED`：必要同意撤回、主监护关系失效或安全冻结；学生会话失效，只允许有权家长进入最小的同意和数据权利路径。
- `DELETION_PENDING`／`DELETED`：仅为后续数据权利流程的向前兼容枚举预留；STP 004 不提供任何状态转换。

`UNCONFIRMED` 是前端和契约中的引导状态，不作为持久化 `StudentProfile.ageBand`。服务端只接受 `UNDER_14`、`AGE_14_TO_17`、`AGE_18_PLUS`；其中 `AGE_18_PLUS` 的 P0 路径尚未决定，门禁解除前默认拒绝创建，不擅自让家长代为同意。

### 5.3 GuardianLink

- P0 只允许 `PRIMARY_GUARDIAN`。
- `ACTIVE` 才能提供对象权限；`REVOKED` 永久保留历史，不可因为重新授权而复活原会话。
- 一个账号可拥有多个有效档案关系；每个档案 P0 最多一个有效主监护关系。
- 复杂解绑、争议关系和主监护人转移走后续人工核实，不提供公开的“夺取档案”接口。

### 5.4 ConsentRecord

一行表示一次授权事实。授权正文、版本、摘要、范围快照、主体和授予时间不可覆盖；撤回只补充撤回字段，再次授权创建新记录。当前是否满足同意要求由当前政策版本与未撤回、未替代的记录共同计算，不存可漂移的 `hasConsent` 布尔值。发布新政策只能让旧授权不再满足当前要求；只有监护人重新明确接受后，才能替代旧记录并创建新的授权记录，不能因发布动作自动代同意。

### 5.5 DeviceSession 与 DevicePairing

- GuardianSession 和 StudentSession 共用 `DeviceSession` 模型，但由数据库 CHECK 保证主体字段互斥。
- StudentSession 必须且只能绑定一个 `StudentProfile` 和签发它的有效 `GuardianLink`。
- `DevicePairing` 经创建、消费、过期、锁定或撤销后均不能回到可用状态。
- 生成新配对码时，在同一事务撤销该档案此前尚未消费的码，减少同时有效的攻击面。

## 6. 数据模型

### 6.1 全局约定

- Prisma 使用 camelCase 字段并通过 `@map`／`@@map` 映射 snake_case 数据库名。
- 主键使用不可猜测 UUID。UUID 只降低枚举便利性，不能代替对象授权。
- 时间字段使用 PostgreSQL `timestamptz(3)` 并以 UTC 写入；业务时区仅存于 `StudentProfile.timezone`。
- 可变聚合使用 `version Int @default(1)`；更新条件必须包含旧版本，影响行数为 0 时返回 409。
- 身份标识采用规范化值的带密钥查找摘要；确需回显／发送的标识另行加密并记录密钥版本。查找密钥轮换通过版本化别名完成，不能靠直接覆盖摘要。验证码、配对码、session token 和 CSRF secret 不保存明文。
- 同意范围使用 UTF-8 RFC 8785 JSON Canonicalization Scheme（JCS）后再做 SHA-256，并同时保存 `scopeSchemaVersion` 与 `digestAlgorithmVersion`；不得直接对任意 JSON 序列化结果取摘要。
- 核心身份、关系、同意与会话历史不使用无审查的级联删除。外键使用 `RESTRICT`／`NO ACTION`，STP 009 再设计可证明的数据删除编排。
- Prisma 6 无法完整声明的 partial unique index 与跨字段 CHECK 必须写入可审查 migration SQL，并在真实 PostgreSQL 中测试。

### 6.2 实体与关键字段

#### Account

`id`、`status`、`authVersion`、`version`、`createdAt`、`updatedAt`、`lockedUntil`、`disabledAt`、`deletedAt`。

- 不保存 `familyId`，不保存学生档案 ID 作为登录凭证。
- `authVersion` 用于账号级紧急失效；会话保存签发时版本并在请求时比对。

#### AuthIdentity

`id`、`accountId`、`kind`、`provider`、`encryptedIdentifier`、`encryptionKeyVersion`、`verifiedAt`、`createdAt`、`updatedAt`。

- 身份查找摘要不直接放在本表唯一列中，而由版本化 `AuthIdentityLookup` 管理。
- 提供 `UNIQUE(id, provider, kind)` 与 `UNIQUE(id, accountId, provider, kind)`，分别作为 lookup 与 challenge 复合 FK 的候选键。
- 认证供应商尚未确定，因此 `Account` 不永久焊死手机号字段；服务层只允许配置中明确支持的 `kind/provider`。
- 加密字段和查找摘要均不得进入日志或错误响应。

#### AuthIdentityLookup

`id`、`authIdentityId`、`kind`、`provider`、`lookupKeyVersion`、`subjectLookupDigest`、`createdAt`。

- `UNIQUE(provider, kind, lookupKeyVersion, subjectLookupDigest)`；HMAC 输入按 provider、kind 和规范化值做域分离。
- `UNIQUE(authIdentityId, lookupKeyVersion)`、`UNIQUE(authIdentityId, provider, kind, lookupKeyVersion, subjectLookupDigest)`，并以 `(authIdentityId, provider, kind)` 复合 FK 保证别名命名空间与父 identity 一致；完整候选键供 challenge 引用。
- 查询时对所有处于读取窗口的 key version 计算摘要；创建身份时为所有活动读取版本写入别名，因此新旧版本至少共享一个唯一域，不能在轮换期间为同一主体创建第二个账号。
- 引入新版本的顺序固定为：暂停或串行化身份创建、全量回填新版本别名并验证无冲突、将新版本加入读写集合、再退休旧版本。禁止先停用旧 key 再边访问边补数据。

#### AuthChallenge

`id`、`purpose`、`identityKind`、`provider`、`accountId?`、`authIdentityId?`、`boundSessionId?`、`deviceInstallationDigest`、`destinationLookupDigest`、`destinationLookupKeyVersion`、`encryptedDestination?`、`codeDigest`、`codeDigestKeyVersion`、`attemptCount`、`maxAttempts`、`expiresAt`、`consumedAt`、`lockedAt`、`createdAt`。

- `purpose` 至少区分 `SIGN_IN` 和 `GUARDIAN_STEP_UP`。
- DB CHECK 按 purpose 约束字段：`SIGN_IN` 不得绑定已有 session；`GUARDIAN_STEP_UP` 必须绑定当前 session、account、identity、设备和用途。存在 identity 时，以复合 FK 保证 `(authIdentityId, accountId, provider, identityKind)` 同属一个登录主体，且 destination digest／key version 是该 identity 的实际 lookup 别名。严格构造器与集成测试仍需再次保证，不能让可空列形成跨会话 challenge。
- `GUARDIAN_STEP_UP` 的约束触发器还要证明：identity 属于该 account；GuardianSession 的 `accountId` 或 StudentSession 的 `issuedByAccountId` 等于 challenge account；challenge 的设备摘要等于绑定 session。消费事务再次检查 session 未撤销、未过期且 scope 符合，不能交叉拼接另一账号的 identity、session 或设备。
- 二次验证挑战绑定当前会话、设备和用途，不可跨会话、跨设备或改作登录。
- 登录挑战默认建议 5 分钟过期、最多 5 次验证；发送频率和更长周期限额仍需在 M0 冻结。

#### StudentProfile

`id`、`status`、`nickname`、`avatarPresetId`、`ageBand`、`ageConfirmationSource`、`ageConfirmedAt`、`ageConfirmedByAccountId`、`stageCode?`、`schoolSystemCode?`、`gradeCode?`、`gradeLabel?`、`termCode?`、`timezone`、`createdByAccountId`、`version`、`createdAt`、`updatedAt`、`restrictedAt`、`deletedAt`。

- 不采集出生日期、真实姓名、学校、班级、定位、通讯录或人脸。
- 年龄字段与全部教育字段独立更新；不建立任何年龄／年级推导触发器。
- `timezone` 默认 `Asia/Shanghai`，服务端校验为支持的 IANA 时区。
- 教育字段在 `ONBOARDING` 可空；STP 005 负责 `GradeConfig`、合法组合和是否增加外键。STP 004 不创建年级／科目枚举或全国映射。
- 昵称不做全局唯一，`createdByAccountId` 只用于溯源，不能用于授权。
- DB CHECK 保证持久化 `ageBand` 不为未确认状态，且 `ageConfirmationSource`、`ageConfirmedAt`、`ageConfirmedByAccountId` 同时存在。

#### GuardianLink

`id`、`accountId`、`studentProfileId`、`role`、`permissionSetKey`、`status`、`activeFrom`、`revokedAt`、`revokedByAccountId?`、`revocationReasonCode?`、`version`、`createdAt`、`updatedAt`。

- P0 服务端固定签发 `PRIMARY_GUARDIAN_V1` 权限集；客户端不能自选权限。
- partial unique：同一 `(accountId, studentProfileId)` 最多一个 `ACTIVE` 关系。
- partial unique：每个 `studentProfileId` 最多一个 `ACTIVE` 且 role 为 `PRIMARY_GUARDIAN` 的关系。
- 为跨表一致性提供候选键 `UNIQUE(id, studentProfileId)` 与 `UNIQUE(id, studentProfileId, accountId)`；下游不能只用互不相关的单列外键拼装授权关系。
- 查询索引：`(accountId, status, studentProfileId)`、`(studentProfileId, status)`。

#### ConsentPolicy

`id`、`policyKey`、`locale`、`currentDocumentVersionId?`、`version`、`createdAt`、`updatedAt`。

- `UNIQUE(policyKey, locale)`；它是政策发布、建档和重新授权共同锁定的稳定对象。
- `(currentDocumentVersionId, id)` 使用复合 FK 指向同一 policy 的文档版本，不能把另一 policy 的版本设为当前。
- 一旦已有发布版本，`policyKey/locale` 不可原地改名；需要新语义时创建新 policy。
- 数据库触发器必须拒绝把 `publishedAt IS NULL` 或尚未冻结的草稿设为 `currentDocumentVersionId`；只靠 publisher service 判断不够。
- P0 不做自动定时切版。发布事务以 `expectedVersion` 排他锁定本行并切换当前版本指针；建档／授权事务以共享锁读取同一指针。
- 若授权事务先取得锁并提交，其同意在线性化点有效；若发布事务先切换指针，使用旧展示版本的授权返回 409 `CONSENT_VERSION_CHANGED`。

#### ConsentDocumentVersion

`id`、`consentPolicyId`、`version`、`contentFormat`、`contentBody`、`contentDigest`、`scopeCanonicalJson`、`scopeDigest`、`scopeSchemaVersion`、`digestAlgorithmVersion`、`publishedAt?`、`createdAt`。

- `UNIQUE(consentPolicyId, version)` 与供复合 FK 使用的 `UNIQUE(id, consentPolicyId)`；`policyKey/locale` 来自不可变的父 `ConsentPolicy`，不在版本行复制一套可漂移值。
- 客户端提交的版本必须由服务端解析为当前已发布记录；客户端不能指定权威正文摘要。
- `contentBody` 保存用户实际看到的精确正文；不允许用可被覆盖的 URL 代替。数据库触发器拒绝更新或删除任何 `publishedAt IS NOT NULL` 的版本；正文、范围、摘要、格式或版本发生变化时只能创建新版本。
- 正式经营主体和文案未确定前只能使用明确标记为测试／草稿的非生产数据，不能称为已完成法律审阅。

#### ConsentRecord

`id`、`studentProfileId`、`guardianLinkId`、`consentPolicyId`、`documentVersionId`、`scopeSnapshot`、`scopeDigest`、`scopeSchemaVersion`、`digestAlgorithmVersion`、`ageBandSnapshot`、`grantedByAccountId`、`grantedAt`、`withdrawnByAccountId?`、`withdrawnAt?`、`withdrawalReasonCode?`、`supersededAt?`、`version`、`createdAt`。

- P0 一份 `policyKey` 对应一个不可拆分的同意 scope；若未来一份文档需要多个选择项，应新增不可变的 policy item 定义，不能让请求自由提交 `consentKey`。
- partial unique：同一 `(studentProfileId, consentPolicyId)` 最多一条未撤回、未替代记录；API 的 `policyKey` 由父 policy 解析，不接受客户端直接写数据库 ID。
- 复合 FK 保证 `(documentVersionId, consentPolicyId)` 属于同一 policy，`(guardianLinkId, studentProfileId, grantedByAccountId)` 属于同一监护关系。
- CHECK：`withdrawnAt >= grantedAt`；撤回人、时间和原因字段保持一致。
- 监护关系撤销后仍保留当时的授权历史。只有监护人重新明确接受当前版本时，才在一个事务中替代旧记录并创建新记录。

#### DeviceSession

`id`、`scope`、`accountId?`、`studentProfileId?`、`issuedByGuardianLinkId?`、`issuedByAccountId?`、`origin`、`credentialDigest`、`csrfDigest`、`accountAuthVersionAtIssue?`、`issuerAuthVersionAtIssue?`、`deviceInstallationDigest`、`deviceLabel?`、`authenticatedAt`、`stepUpVerifiedAt?`、`lastSeenAt?`、`expiresAt`、`revokedAt?`、`revocationReasonCode?`、`replacedBySessionId?`、`version`、`createdAt`、`updatedAt`。

- `UNIQUE(credentialDigest)`。
- 提供 `UNIQUE(id, studentProfileId)` 与 `UNIQUE(id, accountId)` 作为 pairing 的复合 FK 候选键。
- guardian CHECK：`accountId` 与 `accountAuthVersionAtIssue` 非空，学生签发字段为空。
- student CHECK：`accountId` 与 `accountAuthVersionAtIssue` 为空，`studentProfileId`、`issuedByGuardianLinkId`、`issuedByAccountId` 与 `issuerAuthVersionAtIssue` 非空。
- 学生会话使用 `(issuedByGuardianLinkId, studentProfileId, issuedByAccountId)` 复合 FK 绑定同一关系；请求时同时检查签发账号状态和 `authVersion`。账号安全失效不能只撤销 GuardianSession 而遗漏其签发的学生设备。
- CHECK：`expiresAt > createdAt`；撤销与替换字段状态一致。
- 索引：账号、学生、签发关系和设备摘要分别与 `revokedAt/expiresAt` 组合。
- `lastSeenAt` 按配置节流更新，不为每次读请求制造数据库写入。

#### DevicePairing

`id`、`studentProfileId`、`issuedByGuardianLinkId`、`createdByAccountId`、`createdBySessionId`、`codeDigest`、`digestKeyVersion`、`attemptCount`、`maxAttempts`、`expiresAt`、`consumedAt?`、`consumedBySessionId?`、`revokedAt?`、`lockedAt?`、`version`、`createdAt`。

- 推荐显示为 8 位去歧义 Crockford Base32 短码；CSPRNG 生成，摘要使用独立 pepper 的 HMAC-SHA-256。
- 默认 10 分钟失效、最多 5 次失败、单次使用；数值作为可配置安全参数，在 M0 确认。
- `(issuedByGuardianLinkId, studentProfileId, createdByAccountId)` 使用复合 FK 指向同一 link；`(createdBySessionId, createdByAccountId)` 必须指向同一 GuardianSession；`(consumedBySessionId, studentProfileId)` 必须指向同一学生的 StudentSession。
- `UNIQUE(digestKeyVersion, codeDigest)` 仅用于碰撞保护；兑换先按非秘密 UUID `pairingId` 定位并锁定记录，再按该行 key version 校验短码 HMAC，因此错误短码也能原子递增正确记录的次数。
- `consumedBySessionId` 唯一只表达 session 与 pairing 的一对一反向关系；单次消费由行锁和 `consumedAt IS NULL` 条件更新保证。CHECK 要求消费时间与 session 同时为空或同时非空，并限制 consumed／revoked／locked 终态不能互相矛盾。
- 未知、错误、过期、已使用、锁定和撤销对外统一为 `PAIRING_INVALID`。

#### IdempotencyRecord

`id`、`actorScope`、`actorId`、`operation`、`keyDigest`、`requestDigest`、`resourceType?`、`resourceId?`、`responseStatus?`、`expiresAt`、`createdAt`、`completedAt?`。

- `UNIQUE(actorScope, actorId, operation, keyDigest)`。
- 同键同请求不得重复副作用，并按端点返回可安全重建的既有结果；同键不同请求摘要返回 409 `IDEMPOTENCY_CONFLICT`。含一次性 secret 的响应重放不得再次披露 secret。
- 不在记录中保存 session token、验证码、配对明文或完整敏感响应。
- 幂等记录只以 `resourceType/resourceId` 逻辑指向业务结果；业务表不反向保存 `idempotencyRecordId`，避免循环依赖。占位、业务写入和完成状态处于同一事务；相同请求仍在执行时返回明确的可重试冲突。
- 创建档案、同意授予／撤回、配对创建／撤销和设备撤销要求 `Idempotency-Key`。认证挑战消费仍以原子单次消费为最终安全边界；丢失凭证响应时重新发起挑战，不能重放旧 grant 生成第二个会话。

### 6.3 关系和删除策略

- `Account 1:N AuthIdentity`，`AuthIdentity 1:N AuthIdentityLookup`。
- `Account N:M StudentProfile` 仅通过 `GuardianLink`；P0 每个档案最多一个有效主监护人。
- `ConsentPolicy 1:N ConsentDocumentVersion` 并以当前版本指针线性化发布；`StudentProfile 1:N ConsentRecord`，每条记录同时指向同一 policy、当时的 `GuardianLink`、操作 `Account` 和精确文档版本。
- GuardianSession 指向 `Account`；StudentSession 指向一个 `StudentProfile`、签发它的 `GuardianLink` 和签发账号。
- `DevicePairing` 指向档案、签发关系、创建账号与创建会话；消费后指向唯一的 StudentSession。
- 关系一致性使用复合候选键／复合 FK 落到 PostgreSQL；若 Prisma DSL 无法完整表达，写入 migration SQL。不得只靠若干彼此独立的单列 FK 允许 link、student、account 交叉错配。
- 所有历史关系使用 `RESTRICT/NO ACTION`。STP 004 只实现撤销和受限状态，不做物理删除。

### 6.4 数据库约束汇总

| 约束 | 数据库实现 | 应用层仍需执行 |
| --- | --- | --- |
| 登录主体唯一与轮换 | `AuthIdentityLookup UNIQUE(provider, kind, lookup_key_version, subject_lookup_digest)`；活动版本全量别名 | 规范化、域分离、轮换时暂停／串行创建、加密、供应商 allowlist |
| 一个账号／档案最多一个有效关系 | `GuardianLink` partial unique，谓词 `status = ACTIVE` | 每次对象请求检查当前状态和权限集 |
| 一个档案最多一个有效主监护人 | `GuardianLink` partial unique，谓词 `status = ACTIVE AND role = PRIMARY_GUARDIAN` | 争议解绑／转移不开放自助 |
| link／student／account 同属一个授权关系 | `GuardianLink` 复合候选键；session、consent、pairing 复合 FK | 事务中再次检查状态与权限 |
| step-up 主体不可拼接 | identity 复合 FK＋constraint trigger 关联 account、session 与设备 | 消费时重验 session 状态、scope、用途与时限 |
| 年龄确认字段一致 | `StudentProfile` CHECK | 不从年级推断年龄；政策矩阵判断 |
| 一个 policy 最多一个当前有效同意 | `ConsentRecord` partial unique，谓词为未撤回且未替代 | 仅在监护人明确接受后替代；当前版本判断 |
| 一个当前政策版本 | `ConsentPolicy UNIQUE(policyKey, locale)` 与 FK 当前版本指针 | 发布／授权锁同一 policy 行；适用年龄与 scope 解析 |
| 已发布告知不可变且 current 可用 | version 行触发器拒绝更新／删除已发布版本；policy 指针触发器仅接受本 policy 的已发布版本 | 精确正文和 canonical scope 入库；发布只新增版本并切指针 |
| Guardian／Student session 主体互斥 | `DeviceSession` CHECK | 每个请求加载 session、账号、档案与 link |
| 会话凭证唯一 | `UNIQUE(credential_digest)` | 高熵随机、cookie／CSRF、轮换与撤销 |
| 配对码定位唯一 | `UNIQUE(digest_key_version, code_digest)` | 生成碰撞重试、限频、服务端时间 |
| pairing 与消费 session 一对一且同档案 | `UNIQUE(consumed_by_session_id)`、复合 FK、终态 CHECK | `pairingId` 行锁与未消费条件更新；消费和 session 同一事务 |
| 幂等作用域唯一 | `UNIQUE(actor_scope, actor_id, operation, key_digest)` | 请求摘要比较、secret 不重复披露 |
| 乐观锁 | `UPDATE ... WHERE id = ? AND version = ?` 并递增 version | 影响行数为 0 时返回 409 及安全差异 |

partial unique 与 CHECK 必须保留在 migration SQL 和数据库测试中；Prisma Client 查询前检查不能取代这些约束。

## 7. 核心事务流程

### 7.1 验证码登录

1. `POST /v1/auth/code` 规范化登录标识，按标识摘要、IP、设备和用途限频。
2. 对已存在和不存在账号返回相同的 202 结构，禁止账号枚举；生产响应和日志不包含验证码。
3. `POST /v1/auth/session` 先无锁读取 challenge 关联 ID，并以规范化 identity 命名空间的带密钥摘要取得 PostgreSQL transaction-level advisory lock；再按 7.7 的认证子序列处理 identity／account、challenge 与旧 session（如有），完整重读后验证用途、设备、次数、服务端时间和摘要。不能先锁 challenge 再反向锁已有 account。
4. 首次登录在同一事务创建 `Account`、`AuthIdentity` 与所有活动 key version 的 `AuthIdentityLookup`；已有身份则加载账号状态。两个不同 challenge 并发验证同一新 identity 时由同一 advisory lock 串行，唯一冲突仍须整事务回滚／重试并安全重读同一 identity，不能产生孤立 Account 或返回 500。
5. 原子标记 challenge 已消费、创建 GuardianSession、写入 cookie。并发提交同一 challenge 只能一个成功。

真实验证码供应商未确定。实施应先提供明确的 `AuthDeliveryPort` 和仅测试环境可启用的 fake adapter；生产启动配置缺失时必须 fail closed，不能把固定验证码或控制台输出带入生产。

### 7.2 原子建档与同意

`POST /v1/students` 必须由近期验证的 GuardianSession 调用，并要求 `Idempotency-Key`：

1. 服务端按固定锁顺序共享锁定适用的 `ConsentPolicy` 行，并读取其当前 `ConsentDocumentVersion`；不信任客户端自报摘要、主体或时间。
2. 校验年龄确认与教育字段相互独立。`UNCONFIRMED` 或尚未批准的 `AGE_18_PLUS` 立即拒绝。
3. 未满 14 岁或其他需监护同意的范围缺少当前版本确认时，返回 `CONSENT_REQUIRED`。
4. 在一个事务创建 `StudentProfile(ONBOARDING)`、`GuardianLink(PRIMARY_GUARDIAN)` 和所有必要 `ConsentRecord`。
5. 任一步失败全部回滚，不能留下无同意档案、孤立关系或半套授权记录。

STP 004 返回 `learningAccess.allowed=false` 和明确阻塞原因 `ACADEMIC_CONFIGURATION_PENDING`。STP 005 完成合法学制／年级配置后，才允许转为完整 `ACTIVE` 并宣称 S02、T02 闭环。

政策发布在 STP 004 只提供可测试的内部 application command／受控种子边界，不新增管理员公共端点或运营界面；正式内容和真实发布仍受 B04 与上线阻塞项约束。

### 7.3 共用设备的学生模式与家长二次验证

1. 近期验证的 GuardianSession 选择其有权档案，通过 `POST /v1/auth/session` 的 `STUDENT_MODE` grant 请求学生模式。
2. 服务端按 7.7 依次锁定并复核 account、profile、ConsentPolicy、link、ConsentRecord 与当前 session，在同一事务撤销或替换 GuardianSession，并签发只绑定该档案的 StudentSession；浏览器替换 session cookie 与 CSRF token，并清理家长页面状态。
3. StudentSession 不能选择其他档案，也不能调用任何家长管理端点。
4. 切回家长模式时，`POST /v1/auth/code` 使用 `GUARDIAN_STEP_UP`，目标身份由当前 StudentSession 的签发关系推导，客户端不能更换接收账号。
5. 成功验证后撤销旧 StudentSession、签发新的 GuardianSession，并同时轮换 session 与 CSRF 凭证。前端切换布尔值或恢复旧 cookie 均无效。

建议“近期验证”窗口默认为 5 分钟并配置化。初次成功登录在窗口内可视为近期验证；生成／撤销配对、撤销设备、修改年龄、授予／撤回同意，以及未来导出／删除均要求重新检查。最终窗口与会话绝对／闲置有效期属于 M0 待确认项。

### 7.4 一次性配对

1. `POST /v1/students/:studentId/pairings` 要求有效主监护关系、`PAIRING_CREATE` 权限和近期验证。
2. 事务按 7.7 依次锁定并复核 account、profile、ConsentPolicy、link、ConsentRecord、旧 pairing 和当前 GuardianSession，撤销此前未消费 pairing，生成新码；明文只在本次成功响应显示。
3. 独立设备用 `POST /v1/auth/session` 的 `PAIRING_CODE` grant 提交 `{ pairingId, code, device }`；`pairingId` 是非秘密 selector，不能附带或覆盖 `studentId/accountId`。
4. 服务端先无锁读取 selector 所需的关联 ID，再按全局顺序依次锁定和复核 account、profile、ConsentPolicy、link、ConsentRecord、pairing；随后用该行 `digestKeyVersion` 校验 HMAC。错误短码也能对该 pairing 原子增加尝试次数。
5. 条件更新 pairing 并创建 StudentSession 位于同一事务；两个并发兑换恰好一个成功。
6. 错误尝试原子递增，达到上限锁定。外部错误保持同形，内部仅记录不含明文码的原因代码。

H5 交互必须同时把 selector 和短码交给新设备：`pairingId` 可经二维码／深链或单独的配对引用传递，短码由用户另行输入；短码不得放进 URL、Referer、分析事件或日志。最终展示方式属于 B05/M0，但协议层始终要求两者，不能退回仅凭错误短码全库扫描。

### 7.5 年龄跨段变更与政策重算

年龄变更是独立敏感命令，必须要求近期验证、`expectedVersion` 和 `Idempotency-Key`。事务先锁定 account 与 profile，再按全局顺序锁定旧、新年龄段所有可能适用的 ConsentPolicy、link、当前 ConsentRecord、pairing 与 session，写入新的年龄确认事实后重新计算当前必要同意：

- 若新年龄段要求已满足，保留与新要求兼容的访问状态；年龄变更不得修改任何教育字段。
- 若缺少新要求，不得保留原有学习权限：原子将 profile 置为 `RESTRICTED`，撤销全部 StudentSession 与未消费 pairing，并在响应返回缺失的 policy keys。允许同一请求携带当前版本的明确接受并原子创建新 ConsentRecord，但不能自动沿用旧年龄段同意。
- `AGE_18_PLUS` 在 B06 解除前仍拒绝，不由实现者自行开启。

每个 StudentSession 请求和每个正式学习写入都实时根据 `ConsentPolicy.currentDocumentVersionId` 与当前未撤回 ConsentRecord 重算必要同意，不能只相信缓存的 `StudentProfile.status`。发布新版本只切换 policy 指针；旧同意随即不再满足后续请求，但不会自动创建新授权。

### 7.6 撤销

设备撤销：按 7.7 锁定授权事实与目标 StudentSession，只撤销目标 session；不影响该家长的其他档案或设备。

监护关系撤销：当前任务不开放自助公共接口。内部 application command 必须按 7.7 在一个事务锁定 account、profile、link、相关 pairing 与 session，标记 link 为 `REVOKED`，撤销该 link 签发的全部 StudentSession 和未消费 pairing，并将失去有效主监护关系的档案置为 `RESTRICTED`。

必要同意撤回：按 7.7 锁定 account、profile、ConsentPolicy、关系、当前 ConsentRecord、pairing 与 session，填写撤回字段并把档案置为 `RESTRICTED`，撤销 StudentSession 与 pairing。GuardianSession 可保留账号登录，但只能访问该档案的最小同意及后续数据权利路径。

“立即失效”定义为：撤销事务提交后开始的请求必定失败；已经在撤销前获得全部授权事实锁并完成的事务属于撤销前操作。为保证该边界：

- 受保护写事务必须在同一线性化边界内锁定或版本校验签发 Account 及 `authVersion`、当前 ConsentPolicy／ConsentRecord、StudentProfile、GuardianLink 和 DeviceSession；撤销或政策切换取得冲突锁。
- 鉴权检查和业务写入在同一事务内，不允许中间释放授权上下文。
- 撤销返回后不再有旧会话的晚到写入成功。
- 后续 worker、通知和导出在执行时重新检查当前关系、同意和会话，不信任旧消息中的授权快照。
- Account 被锁定、禁用或递增 `authVersion` 时，同一事务撤销该账号的 GuardianSession 及其签发的全部 StudentSession；请求端也必须检查学生会话保存的 issuer auth version。

### 7.7 全局锁顺序与失败处理

所有会触及多个可变实体的事务遵循同一锁顺序：`IdempotencyRecord（如有） → identity advisory lock／AuthIdentity／Lookup（如有） → Account → StudentProfile → ConsentPolicy → GuardianLink → ConsentRecord → DevicePairing → DeviceSession`。多个 policy 按 `(policyKey, locale, id)` 排序，其他同类多行按稳定 ID 升序；不可变的 ConsentDocumentVersion 不参与锁排序。政策发布事务只锁 policy／version，不得反向批量锁 profile；若无锁预读后发现还需取得一个更早序位的行，整事务回滚并以完整集合重试，禁止边走边补锁。

允许先做无锁读取来收集关联 ID，但取得锁后必须完整重读并复核所有状态，不能把预读结果当授权依据。新建 profile 等尚不存在的行没有可预锁对象；先按顺序锁定全部已有父对象，再在同一事务创建。验证码消费属于不触及学生对象的独立子序列：`identity advisory lock → AuthIdentity／Lookup → Account → AuthChallenge → DeviceSession`；新 identity 因尚无可锁行，在 advisory lock 内验证 challenge 后创建新行。协调摘要使用单独密钥，轮换时必须排空旧进程并原子切换，禁止两个 key 世代同时生成不同 advisory key。数据库报告 deadlock／serialization failure 时只可做有上限的整事务重试；只有事务提交后才能返回撤销或消费成功。真实 PostgreSQL 必须覆盖首次身份并发、生成与兑换、兑换与关系撤销、旧会话写入与撤销四组竞争。

H5 无法远程物理擦除永久离线且已丢失设备的浏览器存储。P0 可保证服务端拒绝同步，并要求受保护响应不进入 Service Worker Cache、敏感正文默认不持久化、收到 401 后清理 IndexedDB／Cache Storage／页面状态。对外文案不能宣称已经远程擦除离线设备。

## 8. 服务端鉴权与对象隔离

### 8.1 每次请求的固定顺序

1. 解析不透明 cookie，加载未过期、未撤销的 `DeviceSession`。
2. GuardianSession 检查 `Account.status/authVersion`；StudentSession 同时检查绑定档案、签发 `GuardianLink`、签发 Account 的当前状态／`authVersion` 和当前必要同意。
3. 从路径或目标资源关系解析真实 `studentProfileId`，不得信任请求体中的归属字段。
4. GuardianSession 查询该具体档案的有效 link 与所需权限；StudentSession 要求目标档案等于会话绑定档案。
5. 对写请求按 7.7 的顺序在同一事务锁定并重做上述检查，再执行业务写入与版本更新。

### 8.2 固定权限集与档案状态矩阵

`PRIMARY_GUARDIAN_V1` 在 STP 004 固定为以下 action，客户端不能自行组合：`PROFILE_LIST`、`PROFILE_READ`、`PROFILE_UPDATE_BASIC`、`PROFILE_UPDATE_AGE`、`PROFILE_UPDATE_EDUCATION_SNAPSHOT`、`CONSENT_READ`、`CONSENT_GRANT`、`CONSENT_WITHDRAW`、`STUDENT_MODE_CREATE`、`PAIRING_CREATE`、`PAIRING_REVOKE`、`DEVICE_SESSION_READ`、`DEVICE_SESSION_REVOKE`。计划、报告、建议和数据权利的权限将在对应 STP 扩充新版本，不在本任务暗中放行。

| 会话／档案状态 | 允许 | 拒绝或降级 |
| --- | --- | --- |
| Guardian＋`ONBOARDING` | 列表与最小档案读取；基本资料、年龄或教育快照独立修正；同意文档、历史、授予／撤回；设备列表／撤销；在当前必要同意有效时创建学生模式或 pairing | 所有正式学习写入返回 `LEARNING_ACCESS_BLOCKED`；教育组合合法性仍待 STP 005 |
| Guardian＋`ACTIVE` | 上述全部 STP 004 action；后续模块仍需各自权限判断 | 不因主监护身份自动获得未实现模块或其他档案权限 |
| Guardian＋`RESTRICTED` | 最小档案读取、年龄修正、同意文档／历史／重新授予、设备列表／撤销、登出；未来数据权利入口仅显示真实未实现状态 | 禁止学生模式、创建 pairing、普通资料扩写和全部学习写入 |
| Student＋`ONBOARDING` | 安全裁剪的自身档案／session 读取与登出 | 无家庭列表、同意／设备管理或正式学习写入 |
| Student＋`ACTIVE` | 安全裁剪的自身档案／session；未来学习端点仍由对应模块单独授权 | 无家长 action、无其他档案、无自动完成能力 |
| Student＋`RESTRICTED`／无效签发条件 | 会话在限制事务中被撤销；遗漏的并发请求仍因实时重算而失败 | 统一 401，不保留只读后门 |
| `DELETION_PENDING`／`DELETED` | STP 004 无进入这些状态的命令 | 除后续 STP 009 明确的数据权利流程外均拒绝 |

每个端点必须映射到一个明确 action 与上述状态，不使用“登录即全权”的兜底。`RESTRICTED` 的“最小路径”只包含表中列出的同意修复、年龄修正和设备撤销；STP 009 交付前不存在可假装成功的导出／删除接口。

### 8.3 响应矩阵

| 请求主体／资源 | 本档案 | 同一账号的另一有效档案 | 其他账号档案 | 不存在档案 | 家长敏感接口 |
| --- | --- | --- | --- | --- | --- |
| GuardianSession | 按 link 权限允许 | 必须另查对应 link，不能继承前一档案 | 404 同形 | 404 同形 | 还需近期验证 |
| StudentSession | 仅学生安全接口允许 | 404 同形 | 404 同形 | 404 同形 | 403 `SESSION_SCOPE_FORBIDDEN` |
| 过期／撤销 session | 401 | 401 | 401 | 401 | 401 |
| 未认证 | 401 | 401 | 401 | 401 | 401 |

不存在档案与存在但未授权档案必须使用相同 HTTP 状态、错误码、响应字段和近似处理路径。列表查询先按有效 link 或绑定 student 过滤，不先全量读取再由前端过滤。

## 9. API 契约

### 9.1 通用约定

- 业务路径统一 `/v1`，HTTPS＋JSON。
- 错误体固定为 `{ code, message, requestId, fields? }`；`fields` 只含安全的字段级错误，不含对象是否存在、摘要、token 或内部栈。
- 创建／变更档案、同意授予、配对和设备撤销要求 `Idempotency-Key`。同意撤回也要求 `Idempotency-Key`，但不要求 `expectedStudentVersion`。同键不同请求摘要返回 409。
- 可变资源响应带 `version`；非单调更新请求带 `expectedVersion`，不使用最后写入覆盖。设备、pairing、同意撤回和登出属于单调撤销命令，使用目标行锁、状态条件和 Idempotency-Key（登出天然幂等），故不要求客户端先读 version；重复撤销返回同一安全终态。撤回只影响路径指向的记录，重放不得撤销后续新授权。
- 服务端时间以 ISO 8601 UTC 返回。客户端不提交 `createdAt`、`grantedAt`、`actorId` 等权威字段。
- session token 通过 cookie 设置，不出现在 JSON 响应。
- 新建／轮换 session 的响应同时设置 HttpOnly session Cookie 和非 HttpOnly CSRF Cookie；原始 token 不进入 JSON、日志或持久化 Web Storage。`GET /v1/auth/session` 只返回安全 session 视图。所有受保护响应均为 `Cache-Control: no-store`。

### 9.2 端点清单

| 方法与路径 | 请求主体 | 请求重点 | 成功响应重点 |
| --- | --- | --- | --- |
| `POST /v1/auth/code` | 未认证或有效 session | `purpose`；登录时提交登录标识，step-up 时目标由 session 推导 | 202：`challengeId`、`expiresAt`、`retryAfterSeconds`，保持账号枚举同形 |
| `POST /v1/auth/session` | 按 grant | `VERIFICATION_CODE`、`GUARDIAN_STEP_UP`、`STUDENT_MODE` 或 `PAIRING_CODE` 判别联合 | 原子轮换 session／CSRF Cookie；返回 session scope、绑定档案、过期时间和 step-up 窗口 |
| `GET /v1/auth/session` | 有效 session | 无 | 安全 session 视图，不返回身份原文、session credential 或 CSRF token |
| `DELETE /v1/auth/session` | 有效或已失效 cookie | 无 | 204；重复登出幂等并清 session／CSRF Cookie |
| `GET /v1/consent-documents` | 已验证 GuardianSession | `ageBand` | 当前适用 policy key、version、与 digest 对应的精确正文和 scope；不返回可变内容 URL，不接受客户端自定义政策 |
| `GET /v1/students` | GuardianSession | 游标 | 只返回当前账号有有效 link 的档案摘要 |
| `POST /v1/students` | 近期验证的 GuardianSession | 最小档案、年龄确认、教育快照、当前同意确认 | 201：profile、link、consent 摘要、`learningAccess`、`serverTime` |
| `GET /v1/students/:studentId` | 有效 Guardian／绑定 StudentSession | 无 | 按 session scope 裁剪字段的档案视图 |
| `PATCH /v1/students/:studentId` | GuardianSession；年龄字段需近期验证 | `expectedVersion` 与基本资料、年龄或教育快照变更判别联合 | 更新后 profile、新 version；年龄返回同意重算／撤销影响；任一命令绝不修改另一组字段 |
| `GET /v1/students/:studentId/consents` | GuardianSession | 游标 | 当前状态及不可变历史摘要 |
| `POST /v1/students/:studentId/consents` | 近期验证的 GuardianSession | `expectedStudentVersion`、当前 policy key/version | 新授权记录、profile 状态与 version |
| `POST /v1/students/:studentId/consents/:consentId/withdraw` | 近期验证的 GuardianSession | 原因码与 Idempotency-Key；不要求 expectedStudentVersion | 撤回记录、安全的当前访问状态；重放不撤销后来的新授权 |
| `POST /v1/students/:studentId/pairings` | 近期验证的 GuardianSession | 可选安全设备标签 | 首次 201：`secretState=ISSUED`、`pairingId`、仅本次明文 `code`、`expiresAt`；同幂等请求重试见下文 |
| `POST /v1/students/:studentId/pairings/:pairingId/revoke` | 近期验证的 GuardianSession | 无 | pairing 撤销摘要；重复请求幂等 |
| `GET /v1/students/:studentId/device-sessions` | GuardianSession | 游标 | 设备标签、来源、最近活动、过期／撤销状态；不返回 credential 摘要 |
| `POST /v1/students/:studentId/device-sessions/:sessionId/revoke` | 近期验证的 GuardianSession | 原因码 | 会话撤销摘要；重复请求幂等 |

公开自助 `GuardianLink` 撤销／转移端点不在 STP 004。服务端应提供可测试的内部 command，供后续经过工单授权的支持流程复用。

### 9.3 关键请求形状

```json
{
  "purpose": "SIGN_IN",
  "identity": {
    "kind": "PHONE",
    "value": "<仅传输，不记录日志>"
  },
  "device": {
    "installationId": "<客户端随机标识，不是凭证>"
  }
}
```

`GUARDIAN_STEP_UP` 请求不得传任意手机号，服务端从当前会话链路解析接收身份。

```json
{
  "grantType": "VERIFICATION_CODE",
  "challengeId": "uuid",
  "code": "123456",
  "device": {
    "installationId": "uuid",
    "label": "家庭手机"
  }
}
```

其他 grant 只接受完成其用途的最小字段：`STUDENT_MODE` 接受目标 `studentId` 但由 GuardianLink 再授权；`PAIRING_CODE` 必须接受非秘密 `pairingId`、配对码和设备信息，不接受 `studentId/accountId`；`GUARDIAN_STEP_UP` 必须匹配原 challenge、会话、设备和用途。

```json
{
  "grantType": "PAIRING_CODE",
  "pairingId": "uuid",
  "code": "7K9M-2P4R",
  "device": {
    "installationId": "uuid",
    "label": "学习平板"
  }
}
```

所有 grant 成功时采用同一安全 JSON 骨架，并通过 `Set-Cookie` 同时轮换 session／CSRF Cookie；`studentId` 在 GuardianSession 中为 `null`，在 StudentSession 中为唯一绑定档案：

```json
{
  "session": {
    "scope": "STUDENT",
    "studentId": "uuid",
    "expiresAt": "2026-09-13T12:00:00.000Z",
    "stepUpValidUntil": null
  },
  "serverTime": "2026-09-13T10:00:00.000Z"
}
```

```json
{
  "profile": {
    "nickname": "小树",
    "avatarPresetId": "avatar-03",
    "timezone": "Asia/Shanghai"
  },
  "ageConfirmation": {
    "band": "UNDER_14",
    "source": "GUARDIAN_DECLARATION"
  },
  "education": {
    "stageCode": null,
    "schoolSystemCode": null,
    "gradeCode": null,
    "gradeLabel": null,
    "termCode": null
  },
  "consentAcceptances": [
    {
      "policyKey": "CHILD_CORE_SERVICE",
      "version": "<服务端已发布版本>"
    }
  ]
}
```

响应中的 `grantedByAccountId`、`grantedAt`、policy 摘要和 `GuardianLink` 均由服务端生成。上例 policy key 只是契约占位，不是已批准的正式文案或最终 scope。

配对创建使用判别响应。首次成功返回 `{"secretState":"ISSUED","pairingId":"uuid","code":"...","expiresAt":"..."}`；同一 Idempotency-Key、同一请求的安全重放返回 200 `{"secretState":"NOT_REPLAYABLE","pairingId":"uuid","code":null,"expiresAt":"..."}`，绝不再次披露明文。需要新码时客户端生成新的 Idempotency-Key；新建事务会撤销此前尚未消费的码。

### 9.4 错误语义

| HTTP | code | 使用场景 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | JSON、字段或判别联合无效 |
| 401 | `AUTH_SESSION_INVALID` | session 不存在、过期、撤销或账号失效 |
| 401 | `AUTH_GRANT_INVALID` | 验证码 challenge 未知、错误、过期、已用或锁定；外部同形 |
| 401 | `PAIRING_INVALID` | 配对未知、错误、过期、已用、已撤销或锁定；外部同形 |
| 403 | `SESSION_SCOPE_FORBIDDEN` | 有效 StudentSession 访问家长能力 |
| 403 | `STEP_UP_REQUIRED` | session 有效但近期验证缺失／过期 |
| 403 | `LEARNING_ACCESS_BLOCKED` | 档案受限或尚未满足正式学习条件 |
| 404 | `RESOURCE_NOT_FOUND` | 不存在或对当前主体无权的学生对象，响应同形 |
| 409 | `VERSION_CONFLICT` | `expectedVersion` 过期，返回安全的当前 version／冲突字段 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同主体、操作和 key 对应不同请求摘要 |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | 同主体、操作、key 与请求仍在另一事务处理中；响应带安全的重试提示 |
| 409 | `CONSENT_VERSION_CHANGED` | 页面展示版本与服务端当前必需政策不同 |
| 422 | `AGE_CONFIRMATION_REQUIRED` | 年龄未确认 |
| 422 | `AGE_BAND_NOT_SUPPORTED` | P0 尚未批准的年龄路径 |
| 422 | `CONSENT_REQUIRED` | 缺少当前必要同意 |
| 429 | `RATE_LIMITED` | 验证码、配对或敏感操作超过限额 |

## 10. 迁移影响与实施要求

当前是空业务 Schema，因此首个 STP 004 migration 可以只新增 enum、表、FK、普通索引、partial unique index、CHECK 和已发布政策不可变保护，无历史数据回填，也不修改现有业务行。

推荐一个可审查迁移 `<timestamp>_stp004_identity_profiles_consents`。依赖顺序为：Account、AuthIdentity、AuthIdentityLookup、StudentProfile、GuardianLink、ConsentPolicy（当前版本指针先留空）、ConsentDocumentVersion、ConsentRecord、DeviceSession、AuthChallenge、DevicePairing、IdempotencyRecord；随后补 ConsentPolicy 当前版本 FK、DeviceSession 自引用 FK、复合 FK、partial index、跨字段 CHECK、step-up／current-policy 约束触发器和已发布版本更新／删除保护。业务表不反向引用 IdempotencyRecord，因此不存在迁移循环。

实现还需同步补齐：

- `apps/api` 的 `@prisma/client` 运行依赖、PrismaModule／PrismaService 和关闭钩子。
- Docker 构建中的 Prisma Client generate 与运行产物路径。
- API 全局 `/v1` 前缀、统一验证、错误转换、requestId、cookie／CSRF 和安全日志脱敏。
- 真实 PostgreSQL 的隔离测试库；CI 可增加 PostgreSQL service，但不得使用生产或共享开发数据库。
- partial unique、CHECK、复合 FK、政策不可变保护、FK 删除策略、事务回滚、统一锁顺序和并发行为的数据库测试。SQLite、mock repository 或纯单元测试不能替代。
- 手写 SQL 约束使用稳定名称，并在 Schema 注释和迁移测试中登记；后续 Prisma migration 不得因 DSL 无法表达就静默删除 partial index、CHECK、复合 FK 或触发器。

回滚原则：

- 新 API 部署前先应用向后兼容的纯新增迁移；旧 API 不访问新表，因此应用回滚时保留新增表。
- 一旦产生身份、儿童档案或同意记录，禁止用 drop table 作为常规回滚；采用前滚修复。
- 只有明确为一次性、隔离且无数据的本地测试库，才可按依赖逆序删除新增对象。
- 本轮没有创建 migration、没有运行 `prisma migrate`，也没有生产迁移授权。

## 11. 验收矩阵

设计状态均为已覆盖。执行状态以隔离 PostgreSQL、HTTP 和真实浏览器证据为准；未跑项保持未执行，T02-D／T11-D 为后续阶段。

| 编号 | 场景 | 必须结果 | 层级 | 设计状态 | 执行状态 |
| --- | --- | --- | --- | --- | --- |
| T01-1 | 年龄未确认请求建档 | 拒绝；无 StudentProfile、link、consent 或学习记录残留 | Domain＋DB＋API | 已覆盖 | HTTP 契约拒绝（UNCONFIRMED 不能过 schema） |
| T01-2 | 未满 14 岁缺少当前必要同意 | 整个建档事务回滚 | DB＋API | 已覆盖 | HTTP 422 CONSENT_REQUIRED |
| T01-3 | 当前政策版本全部确认 | 原子创建 profile、主 link、同意记录；主体、版本、范围和时间可追溯 | DB＋API | 已覆盖 | HTTP 201 建档 |
| T01-4 | 旧／未知政策版本或客户端伪造主体 | 在授权线性化点已非当前版本则 409；授权先持锁提交时允许成功，随后按新 policy 限制访问 | Contract＋API＋DB | 已覆盖 | CON-2 两种提交顺序：发布先完成则旧版本 409；授权先完成则随后 pairing／学生模式 CONSENT_REQUIRED |
| T02-B | 变更 grade 不改变 age；变更 age 不改变教育字段 | 两套字段和更新规则独立 | Domain＋Schema | 已覆盖 | HTTP 改 grade 后 age 仍 UNDER_14 |
| T02-D | 六三、五四、自定义映射及升年级历史 | 明确归 STP 005；不计入 STP 004 通过 | 追踪 | 已覆盖 | 延后 |
| AGE-1 | 年龄跨段导致必要政策集合变化 | 原子更新年龄并重算；缺同意时 restricted 且撤销学生会话／pairing，不修改教育字段 | PostgreSQL＋API | 已覆盖 | matrix：跨段后 RESTRICTED，教育字段不变，旧学生会话 401，未消费 pairing 已撤销 |
| T10-1 | Guardian A 读写 Guardian B 的真实档案 ID | 与不存在 ID 同形 404，无存在性泄露 | API＋DB | 已覆盖 | HTTP 同形 404 |
| T10-2 | A 的 StudentSession 访问 A 的另一个孩子 | 拒绝；同一监护人也不能跨档案 | API＋DB | 已覆盖 | matrix：学生会话读同胞与缺失 ID 同形 404 |
| T10-3 | 伪造 body 中的 accountId／studentId | 不改变服务端主体或资源归属 | Contract＋API | 已覆盖 | contracts 剥除伪造字段；matrix 建档归属仍为会话账号 |
| T10-4 | 跨档案 consent、pairing、device 子资源 | 通过关联查询统一拒绝 | API＋DB | 已覆盖 | matrix：跨档案子资源与缺失 ID 同形 404 |
| T11-1 | 撤销设备后重用旧 token | 撤销提交后的下一请求立即 401，无写入 | DB＋API | 已覆盖 | HTTP 401 |
| T11-2 | 撤销 GuardianLink | 该档案权限、签发学生会话与 pairing 全部失效；其他档案不受影响 | Transaction＋API | 已覆盖 | matrix 内部命令：该档案 404／401，另一档案仍可读 |
| T11-3 | 撤回必要同意 | 档案受限，学生会话和 pairing 失效，学习写入被拒绝 | Transaction＋API | 已覆盖 | HTTP RESTRICTED；学习写入仍未实现 |
| T11-4 | 重新授权后使用旧 session | 旧 session 仍失败，必须签发新 session | Integration | 已覆盖 | matrix：重授后旧学生会话 401，新会话可读 |
| T11-D | 未发敏感通知重新鉴权 | STP 004 验证共用授权服务；真实 worker 在 STP 009／010 复测 | 追踪 | 已覆盖 | 延后 |
| AUTH-1 | 登录／step-up challenge 错误、过期、重放、跨设备／用途 | 外部同形失败，不创建第二个 session | API＋DB | 已覆盖 | matrix：同形 AUTH_GRANT_INVALID；失败 challenge 未消费 |
| AUTH-2 | 从 StudentSession 直接切回家长或调家长端点 | 403；必须重新验证并签发新 GuardianSession | API＋E2E | 已覆盖 | HTTP 学生列档案 403；Chromium 二次验证回家长 |
| AUTH-3 | 两个 challenge 并发首次验证同一 identity | 最终恰好一个 Account／AuthIdentity，无孤立账号、无 500 | PostgreSQL＋API | 已覆盖 | 双 challenge HTTP 在 advisory 锁等待后恰好一个 Account／AuthIdentity，无 500 |
| AUTH-4 | 缺失／错误 CSRF 或跨 Origin 写请求 | 失败且无副作用；会话轮换后旧 CSRF 失效 | HTTP＋E2E | 已覆盖 | HTTP 拒绝错误 CSRF／跨 Origin；Chromium 页面写请求带绑定 CSRF |
| AUTH-5 | step-up 拼接另一账号的 identity、session 或 device digest | 复合约束／触发器或事务重验拒绝，不发送或消费 challenge | PostgreSQL＋API | 已覆盖 | matrix：拼接 session／device 401，challenge 未消费 |
| PAIR-1 | 配对码正确、错误、达到次数上限和过期边界 | 仅有效码可创建一个绑定档案的 session；错误不泄露状态 | Domain＋API | 已覆盖 | matrix：错码／锁定／过期同形 PAIRING_INVALID |
| PAIR-2 | 两事务并发消费同一码 | 恰好一个成功，数据库仅一个新 StudentSession | PostgreSQL | 已覆盖 | 双 HTTP 消费同一码：一行锁等待后 201+401，仅一个学生会话 |
| PAIR-3 | 关系、档案或同意先被撤销 | 即使码仍在时间窗内也失败 | PostgreSQL＋API | 已覆盖 | matrix：先撤回或撤销关系后窗口内消费仍 401 |
| PAIR-4 | 生成 vs 兑换、兑换 vs 关系撤销并发 | 遵循统一锁序，无未处理死锁；结果可线性化且最多一个 session | PostgreSQL | 已覆盖 | PAIR-4：重叠等待后无 500，最多一个学生会话 |
| CON-1 | 两端用同一 version 更新档案 | 一个成功，一个 409；不最后写覆盖 | PostgreSQL＋API | 已覆盖 | CON-1：双 HTTP 同 version，一成功一 409，无最后写覆盖 |
| CON-2 | 旧政策授权与新版本发布并发 | 以 ConsentPolicy 锁为线性化点；发布先完成则旧版本 409，授权先完成则随后访问按新政策受限 | PostgreSQL＋API | 已覆盖 | 独立连接 + pg_blocking_pids 重叠；两种提交顺序均通过 |
| CON-3 | 旧 session 写入与设备／关系／同意撤销竞争 | 写入只能在线性化于撤销之前；撤销响应后无晚到提交 | PostgreSQL | 已覆盖 | patch 与 withdraw 两种顺序重叠；撤销响应后 BASIC 写入 403 |
| IDEM-1 | 同 key 同 body／同 key 不同 body | 前者重建既有结果，后者 409 | DB＋API | 已覆盖 | HTTP |
| IDEM-2 | 配对创建的首次响应丢失后同 key 重试 | 不重复副作用、不重放 secret；返回 `NOT_REPLAYABLE`，新 key 才能生成并撤销旧码 | API＋DB | 已覆盖 | matrix：同 key 不重放 secret；新 key 撤销旧码 |
| DB-1 | 直接插入第二个有效主监护关系 | partial unique 在数据库拒绝 | PostgreSQL | 已覆盖 | 隔离库拒绝 |
| DB-2 | 插入主体字段不合法的 DeviceSession | CHECK 在数据库拒绝 | PostgreSQL | 已覆盖 | 隔离库拒绝 |
| DB-3 | 同一 policy key 插入第二条当前有效授权 | partial unique 在数据库拒绝 | PostgreSQL | 已覆盖 | 隔离库拒绝 consent_records_one_current |
| DB-4 | 将 link、student、account 或消费 session 交叉错配 | 复合 FK／CHECK 在数据库拒绝 | PostgreSQL | 已覆盖 | 隔离库拒绝 consent_records_link_fk 与 device_pairings_consumed_session_fk |
| DB-5 | 原地修改或删除已发布正文／scope／digest | 数据库拒绝，只能新增版本并切 policy 指针 | PostgreSQL | 已覆盖 | 隔离库拒绝 |
| DB-6 | 将 current policy 指针指向草稿或另一 policy 的版本 | 复合 FK／触发器在数据库拒绝 | PostgreSQL | 已覆盖 | 隔离库拒绝 |
| TX-1 | 建档、同意、消费或撤销中途故障 | 不出现半建档、半消费或半撤销 | PostgreSQL | 已覆盖 | db.spec：写后抛错回滚，无半状态 |
| TIME-1 | 服务器时钟恰好达到 `expiresAt` | challenge／pairing／session 均视为过期 | Domain＋PostgreSQL | 已覆盖 | domain `isExpired` 含相等；matrix 将 expiresAt 置为边界后 401 |
| WD-1 | 撤回不带 expectedStudentVersion | 契约不要求学生 version；客户端伪造撤回人无效 | Contract＋API | 已覆盖 | contracts + matrix：服务端主体来自会话 |
| WD-2 | 撤回 C1 后授予 C2 再重放 C1 | C2 与新会话有效；旧学生会话仍失败；并发可线性化 | PostgreSQL＋API | 已覆盖 | matrix 顺序路径；concurrency 双 HTTP 重放重叠 |
| FAIL-1 | 错码失败次数必须先提交 | 连续错误可见；锁定后正确码无效；过期不解锁 | API＋DB | 已覆盖 | matrix：attemptCount 逐次 +1，locked 后正确码 401 |
| FAIL-2 | 并发错码与最后一次兑换竞争 | 次数原子累加；结果可线性化；无 500 | PostgreSQL＋API | 已覆盖 | concurrency：重叠等待后 attemptCount=2；最后一次竞争无双成功 |
| RATE-1 | 发码身份／设备冷却 | 60s 内同身份同设备再发 429 | API＋DB | 已覆盖 | matrix：第二发码 RATE_LIMITED，仍仅一条挑战 |
| TIME-2 | idle／absolute 会话边界 | 过期拒绝且不回写 lastSeen；先判过期再节流刷新 | Domain＋API | 已覆盖 | matrix：idle／absolute 401；90s 后只刷新未过期会话 |
| CFG-1 | 测试认证关闭 | production 拒绝；未知环境默认关闭 | Config | 已覆盖 | `config.spec.ts` |

测试时使用可注入时钟，不依赖开发机时区。数据库并发用例必须真正开启多个事务，不用顺序 mock 冒充竞争。STP 004 只能将 T11 的账号／关系／同意／设备撤销核心子项记为通过；T11 整体仍须等待 STP 009／010 的真实通知 worker 验证 `T11-D`，不得提前写成整体通过。

## 12. 阻塞项与解除证据

### 12.1 开始业务编码前必须解除

| ID | 阻塞项 | 需要的决定／证据 |
| --- | --- | --- |
| B01 | 本阶段契约已从方案整理为六份专题文档；STP 002 高保真与全量 M0 仍未完成 | 见 `docs/PRODUCT_SCOPE.md` 等与 `docs/handoffs/STP004_B01_B09_DECISIONS.md`；不得宣称全量冻结 |
| B02 | `CURSOR_STP004_IMPLEMENT.md` 已授权本地代码、Schema、migration 与隔离库验证 | 状态文档记录授权来源；不重复索要同一范围 |
| B03 | 已固定 PHONE／PHONE_OTP、大陆号规则、测试 delivery 与本地验证码参数 | 真实短信与生产密钥仍待上线条件 |
| B04 | 已固定测试政策与 RESTRICTED 最小权限；界面必须标记测试 | 经营主体、正式文案和法律审阅仍是上线条件 |
| B05 | 已采用实施文件第 3 节本地默认值 | 生产 Origin／期限必须另行核验 |
| B06 | 18 岁及以上拒绝正式建档／转入，返回 AGE_BAND_NOT_SUPPORTED | 成年开通留给后续独立流程 |
| B08 | 接受无 HEAD；前置清单与哈希见 `docs/handoffs/STP004_PRE_IMPLEMENTATION_SNAPSHOT.md` | 基线 commit 需另行授权 |
| B09 | 教育快照可空；不校验全国映射；STP 005 可新增 gradeConfigId 并保留历史快照 | T02 全量映射仍归 STP 005 |

### 12.2 可以编码但在验收完成前必须解除

| ID | 风险 | 解除证据 |
| --- | --- | --- |
| B07 | 本机已有任务独占 EDB ZIP 临时实例并跑过迁移、约束、业务并发与 Chromium 页面流；STP 004 仍不得标完成 | 剩余矩阵子项与 T11-D 仍阻塞整体验收；不得以 mock 代替 |

### 12.3 不阻塞本地核心逻辑，但阻塞真实上线

- 实际经营主体与隐私责任主体。
- 经确认的监护人告知、儿童个人信息专门规则和法律审阅。
- 真实验证码供应商、生产密钥托管、密钥轮换和供应商数据处理边界。
- 生产域名、Cookie 域、CORS／CSRF 来源和部署地区。
- 儿童档案、身份摘要、同意证明与安全日志的最终保留／删除期限。
- 丢失且永久离线 H5 设备本地残留风险的对外说明与接受。

## 13. Cursor 实施边界

Code Start Gate 只在 B01 至 B06、B08、B09 都有批准结论且用户另行授权代码／Schema 修改后解除。B07 是 Acceptance Gate：没有隔离 PostgreSQL 时可以编写代码与 migration 文件，但必须保持“进行中／阻塞”，不能宣称完成。

门禁解除后的实现顺序：

1. 先在 `packages/contracts` 固定运行时校验、请求响应和错误码；在 `packages/domain` 实现无框架、无 I/O 的年龄、会话、配对、同意和权限规则。
2. 再建立 Prisma 模型与一份可审查 migration，补齐 partial index、CHECK、复合 FK 和已发布政策不可变保护；使用隔离 PostgreSQL 验证。
3. 在 `apps/api` 建立 Prisma、requestId、错误映射、session、CSRF、identity、profiles、consents、pairing 和统一对象授权入口。
4. 实现 S01、S02、P05、P06 的最小 H5 流程；对 STP 005／009 尚未交付的控件显示真实不可用状态，不伪造完成。
5. 运行根命令和本文件验收矩阵，更新状态；未取得数据库或 E2E 证据时保持“进行中／阻塞”。即使撤销核心子项通过，T11 整体仍待后续真实通知 worker 复测。

不得在实现中加入 STP 005 的年级目录、科目和 36 个模板，或 STP 009 的导出、删除后台和支持人员界面。不得用前端隐藏、mock、内存仓库或不可撤销 JWT 代替数据库约束与服务端授权。

## 14. 2026-09-14 晚间实现补记（不静默改写上文产品结论）

本轮为实现审查未关闭项记录与上文的差异，不另建平行方案。产品权限矩阵、学习写入延期、T02-D／T11-D 边界不变。

1. **GET 与授权事务（相对 8.1 第 5 步）**  
   心跳闭合要求受保护 GET（列表、档案、同意、设备、文档、`GET /v1/auth/session`）与写入走同一授权事务：锁 → `lockedNow` → session／对象／action 重验 → 成功才 `touchLastSeenLocked`。这收紧“写请求才锁”的表述，不改变 8.2 权限矩阵，也不把 GET 变成可完成任务的写入。

2. **设备撤销与替换链（相对 7.6 “只撤销目标 session”）**  
   目标仍是该设备上的指定会话，不影响该家长其他档案或其他设备。若该会话已有活动替换后继（Student S0 → Guardian G1），撤销必须沿 lineage 锁定并撤销全部活动后继，否则新 Guardian cookie 会复活。监护关系／必要同意撤销仍只处理该档案的 StudentSession／pairing，**不得**误撤账号级 Guardian successor。

3. **GUARDIAN_STEP_UP 锁子序列（相对 7.7）**  
   step-up 消费锁序为：identity advisory → AuthIdentity → Lookup → Account → StudentProfile → ConsentPolicy → GuardianLink → ConsentRecord → AuthChallenge → DeviceSession（不含 pairing）。锁后完整重读；缺锁则整事务重试。普通 SIGN_IN 仍只用认证子序列（advisory → Identity／Lookup → Account → AuthChallenge → DeviceSession），不锁学生图。

4. **服务端时间**  
   取得完整锁集并 `assertLockSetComplete` 之后，用 PostgreSQL `clock_timestamp()` 作为本事务 `lockedNow`。challenge TTL、session idle／absolute、pairing、消费、撤销、签发、TTL 与 `serverTime` 均使用该时刻；事务重试必须重新读取。不得用事务开始时的 JS `Date` 做到期判定。

5. **删除态（相对 8.2）**  
   STP 004 仍无进入 `DELETION_PENDING`／`DELETED` 的产品命令。若测试或后续 STP 009 写入这些状态：Guardian 列表剔除；精确 STP 004 路径与不存在对象同形 404；StudentSession 401；失败响应不得 heartbeat。

6. **expand 迁移**  
   不改写已应用的 `20260914000000` 与 `20260914170000`。新增 lookup 五列 MATCH SIMPLE FK、签发事实不可变、`replacedBySessionId` 一对一及方向／防环。首次 SIGN_IN 允许 challenge 的 identity／account 为空，成功消费后回填。expand **不**立即强制“replacement reason 必有 pointer”。DDL 前只读预检；缺 alias 或旧替换脏行则停止，不猜测回填。clean deploy 另建可丢弃库，不清空现有库。

7. **2026-09-15 父键、反环、发码与 CSRF（相对 MATCH SIMPLE 与 7.1／7.7）**  
   AuthChallenge 增加两条同级父键 CHECK，防止 MATCH SIMPLE 在部分 NULL 时跳过复合 FK。替换反环必须锁 predecessor 与 successor（id 升序），锁后再读 pointer。发码在 identity advisory 之后重查最新 challenge。已登录 step-up 发码与 logout 要求会话绑定 CSRF；未登录 SIGN_IN 不要求。政策发布与失败锁定的时刻取自锁后 `clock_timestamp()`。新增 `20260915160000` 不改写既有三条迁移。原库保持只读；合法非空两迁移旧库用于验证第三条及本轮迁移。
