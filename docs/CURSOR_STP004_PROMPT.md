【执行工具：Cursor｜模型：Grok 4.6 High Fast】

任务编号：STP 004

任务名称：账号、学生档案与授权基础

工作目录：`D:\Program Files\PycharmProjects\studysteps`

仓库：`https://github.com/xyq-dev/studysteps`

## 强制门禁

交接时 `docs/STP004_DESIGN.md` 的 `Implementation Gate` 为 `BLOCKED`。开始前完整读取：

- `AGENTS.md`
- `docs/PROJECT_PLAN.md`
- `docs/CURRENT_STATUS.md`
- `docs/TASKS.md`
- `docs/STP004_DESIGN.md`
- STP 001 应交付的 `docs/PRODUCT_SCOPE.md`、`docs/BUSINESS_RULES.md`、`docs/PAGES.md`、`docs/DATA_MODEL.md`、`docs/API.md`、`docs/ACCEPTANCE.md`

只有同时满足以下 Code Start Gate 才允许修改代码或 Prisma：

1. 六份 STP 001 专题文档均存在，STP 002 已完成，`CURRENT_STATUS.md` 明确记录 M0 首轮契约已经冻结。
2. `STP004_DESIGN.md` 的 B01 至 B06、B08、B09 已有经确认的结论，Implementation Gate 已由审查方改为 `READY`。
3. 用户在执行当轮明确授权 STP 004 业务代码、Schema 和 migration 文件修改。
4. B08 已明确无 HEAD 的处理方式：获得基线 commit 授权，或由用户明确接受无 commit 开发并要求保存完整前置文件清单与哈希。不得自行 commit。

任一 Code Start Gate 条件不满足：只输出核验结果和未解除阻塞项，不修改任何文件，不运行安装、测试或迁移，不把 STP 004 标为进行中。若实现中发现冻结的 M0 文档与设计矛盾，立即停止，不静默修改契约，并将冲突报告给审查方重新把 Gate 置为 `BLOCKED`。

B07 是 Acceptance Gate：没有隔离 PostgreSQL 时，可以在 Code Start Gate 已解除后编写代码和 migration 文件，但只能保持“进行中／阻塞”，不得应用到未知数据库、不得用 mock 冒充约束或并发通过、不得把 STP 004 标为完成。

## 开始时核验

1. 输出实际工作目录和相关文件清单。
2. 核验 `origin`、当前分支、`git rev-parse --verify HEAD`、`git status --short --branch`；保留全部已有改动和 untracked 文件。
3. 记录开始前 HEAD、工作区状态和将修改文件的 SHA-256。交接快照是 `main`、无 HEAD、全部现有文件 untracked，但以执行时事实为准。
4. 读取实际 `apps/api`、`packages/contracts`、`packages/domain`、`apps/web` 和 `prisma` 文件，不重复设计已冻结架构。
5. 如已提供隔离数据库，核验它确实不是生产、共享开发或含真实数据的数据库；目标不清楚就停止。若未提供，记录 B07，允许继续代码但不应用 migration、不宣称完成。

## 实现目标

严格按 `docs/STP004_DESIGN.md` 完成：

- 账号与认证身份解耦；验证码 challenge 一次性、过期、限次、不可枚举。
- 年龄与学段／学制／年级完全分离；年龄未确认不持久化学生档案。
- 建档、主监护关系和当前必要同意在同一事务形成或全部回滚。
- GuardianSession 与单档案 StudentSession 使用可服务端撤销的不透明凭证。
- 共用设备返回家长模式必须重新验证，学生 session 不能提权。
- 配对凭证使用非秘密 `pairingId` 与短码，短码短期、单次、HMAC 摘要、限次；并发兑换恰好一个成功。
- 每个学生对象按当前 session 和有效 GuardianLink 做服务端授权；不存在与无权对象响应同形。
- 设备、关系和必要同意撤销后，旧 session、pairing 和后续离线重放立即失败。
- 非单调资源更新使用 version 乐观锁；单调撤销用行锁、状态条件和幂等语义；要求幂等的写接口绑定主体、操作、key 和请求摘要。

## 允许修改

- `packages/contracts`：STP 004 的运行时请求校验、响应类型、错误码和判别联合。
- `packages/domain`：无 NestJS、HTTP、Prisma、文件、网络或时钟隐式依赖的年龄、同意、会话、配对和权限纯规则；时间通过参数／端口注入。
- `prisma/schema.prisma` 与一份 STP 004 migration，包括可审查的 PostgreSQL partial unique index、CHECK、复合 FK 和已发布政策不可变保护。
- `apps/api`：PrismaModule／PrismaService、requestId、统一错误、cookie／CSRF、identity、profiles、consents、pairing、session、撤销和统一对象授权入口。
- `apps/api/package.json`、锁文件、根脚本、Dockerfile、CI 中为 Prisma Client 和隔离 PostgreSQL 验收所必需的最小修改；禁止顺手重构工程或加入部署步骤。
- `apps/web`：S01、S02、P05、P06 的最小流程及真实阻塞／错误状态，不扩展视觉范围。
- 与上述行为直接对应的单元、HTTP、数据库集成和最小 E2E 测试。
- `README.md`、`docs/CURRENT_STATUS.md`、`docs/TASKS.md` 以及单独的实施证据文档中的真实状态和验证证据。STP 001／002 契约文档与 `docs/STP004_DESIGN.md` 均只读；任何规范变化必须停止并重新审查，不得由实现者迁就代码静默改写。

## 数据与迁移要求

- 按设计实现 `Account`、`AuthIdentity`、`AuthIdentityLookup`、`AuthChallenge`、`StudentProfile`、`GuardianLink`、`ConsentPolicy`、`ConsentDocumentVersion`、`ConsentRecord`、`DeviceSession`、`DevicePairing`、`IdempotencyRecord` 或经审查确认的等价命名。
- UUID 不能代替授权；时间使用 PostgreSQL `timestamptz` 和 UTC；可变聚合使用 version 条件更新。
- session token、验证码、配对码、CSRF secret 不存明文；短码摘要必须有独立服务端 pepper。敏感标识采用带密钥查找摘要，确需取回的值加密并记录 key version。
- 数据库必须真实约束：有效主监护关系唯一、同账号／档案有效关系唯一、当前有效同意唯一、session 主体字段互斥、link／student／account／消费 session 的复合关联一致、配对单次消费、step-up identity／account／session／device 同属、已发布政策不可更新或删除、current 指针只指本 policy 已发布版本，以及必要 FK 删除策略。
- 身份 lookup 使用版本化别名；key 轮换期间写入所有活动版本并先完成回填验证，不能因摘要换 key 创建重复账号。
- 同意 policy 有稳定当前版本指针；精确正文及 JCS canonical scope 入库。政策发布和授权锁同一 policy 行，发布不能自动代表监护人接受。
- 关系与同意历史不级联删除。STP 004 只做撤销／受限，不实现 STP 009 的物理删除编排。
- migration 是纯新增；不改已有业务数据。允许在确认无真实数据的隔离 PostgreSQL 应用并验证，禁止生产迁移、共享库迁移和未经确认的 reset。
- 应用回滚保留新增表；产生数据后不以 drop table 回滚，使用前滚修复。
- 所有多实体写事务遵循设计 7.7 的统一锁顺序；先 account/profile，再锁按稳定全序排列的 policy，取得锁后完整重验 consent、link、pairing 和 session。首次 identity 并发使用设计规定的 advisory lock；不能把无锁预读当授权依据。

## API 与安全要求

- 业务 API 全部位于 `/v1`，错误体为 `{code,message,requestId,fields?}`。
- 以 `docs/STP004_DESIGN.md` 的端点和请求形状为准；客户端不得指定 actor、授权主体、服务端时间或同意摘要。
- GuardianSession 的每个学生对象请求都查询具体有效 link；StudentSession 只允许绑定档案。
- 学生对象不存在和越权统一 404 `RESOURCE_NOT_FOUND`；有效 StudentSession 调家长端点返回 403 `SESSION_SCOPE_FORBIDDEN`。
- 过期或撤销会话返回 401；近期验证不足返回 403 `STEP_UP_REQUIRED`；版本冲突与幂等冲突返回明确 409。
- 配对和验证码的未知、错误、过期、已使用、锁定、撤销对外同形；详细原因只进入脱敏安全事件。
- 配对兑换必须提交 `{pairingId, code, device}`，按 selector 锁行后校验 HMAC 并原子计数；禁止客户端提交 `studentId/accountId`。配对创建的同 key 重试返回 `NOT_REPLAYABLE` 且 `code:null`，不能再次披露 secret。
- 同源 H5 使用 HttpOnly／Secure／SameSite session Cookie、独立的非 HttpOnly `__Host-` CSRF Cookie、严格 Origin／Fetch Metadata 和不可空的 session CSRF 摘要；前端只把 CSRF Cookie 镜像到 header，不写 Web Storage。登录、学生模式、家长恢复和凭证轮换时同步轮换两类 Cookie。禁止 Local Storage bearer token、不可撤销长效 JWT、固定生产验证码或日志输出秘密。
- 年龄跨段更新要求 step-up、expectedVersion 和幂等；同一事务重算当前 policy，缺少新同意时将档案限制并撤销学生 session／pairing。每次学生请求实时校验当前 policy，不能只信 profile status。
- 严格采用设计 8.2 的 `PRIMARY_GUARDIAN_V1` action 与档案状态矩阵；不得自行扩大 `RESTRICTED`、StudentSession 或未交付模块的权限。
- 真实认证／短信供应商仍未授权时，只实现端口和测试／开发 adapter；生产配置缺失必须 fail closed，不能调用真实第三方。

## 禁止范围

- 不实现 STP 005 的 `GradeConfig`、Subject、科目、36 个模板、全国年级映射或种子。
- 不实现计划、任务、完成、计时、复盘、报告或徽章。
- 不实现 STP 009 的导出／删除、支持人员后台、管理员全局查询或真实通知 worker。
- 不实现协作监护人、自动主监护人转移或公开“夺取档案”。
- 不加入照片、外部 AI、支付、题库、社区、小程序、原生应用、微服务、专用队列、搜索或向量数据库。
- 不使用真实儿童信息、真实手机号、生产凭证或正式同意文案作为测试数据。
- 不修改 `docs/PROJECT_PLAN.docx`，不重写 `docs/PROJECT_PLAN.md` 的既定结论。
- 不 commit、不 push、不建 PR、不 pack、不部署。

## 必须验证

先执行本任务相关测试，再执行并记录退出码：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm prisma:validate
```

还必须在隔离 PostgreSQL 中验证 `docs/STP004_DESIGN.md` 第 11 章全部非延后用例，至少包括：

- T01 建档／同意原子回滚及版本留痕；
- T02 的年龄／年级分离边界，不宣称完成 STP 005 映射；
- T10 家长、学生与嵌套资源的正反向档案隔离；
- T11 设备、关系、同意撤销后旧会话和重放失效；
- 验证码与 step-up 的错误、过期、重放、跨会话／设备／用途及跨账号主体拼接；
- 配对错误、锁定、过期、重放以及真实双事务并发消费；
- 配对生成／兑换／关系撤销及旧 session 写入／撤销的锁序竞争；
- 首次身份并发、CSRF／Origin、年龄跨段、政策发布／授权竞争；
- version 并发冲突、Idempotency-Key 同／异请求与 secret 安全重试、partial unique、CHECK、复合 FK、已发布政策更新／删除保护、current 指向草稿拒绝与事务故障回滚。

没有真实 PostgreSQL 证据时，不得写“数据库约束通过”“并发通过”或“STP 004 已完成”。即使核心撤销用例通过，也只能写“T11 核心子项通过”；T11 整体须等待 STP 009／010 的真实通知 worker 复测。不要重跑与本任务无关的 STP 003 手工开发服务器验证。

## 完成报告

必须包含：

- 任务编号、实际目录、origin、分支、前后 HEAD 和工作区状态；
- Code Start Gate、Acceptance Gate 证据与已采用的 B01 至 B09 结论；
- 修改文件及原因、用户可见变化；
- 数据模型、migration 名称、约束、应用环境、前滚／回滚说明；
- 每条测试命令、退出码、用例数量和数据库并发证据；
- 未执行项、失败项、剩余阻塞和 STP 005／009 延后边界；
- 保留的已有文件与改动；
- commit、push、pack、部署均未执行，除非用户在当轮另行授权。

达到 STP 004 验收门槛后停止，不继续 STP 005。
