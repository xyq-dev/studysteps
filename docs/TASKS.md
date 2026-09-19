# StudySteps 开发任务清单

本清单沿用 `PROJECT_PLAN.md` 的 STP 001 至 STP 010、M0 至 M5、S／P／A 页面编号和 T01 至 T15 验收编号，只把既定方案拆成可执行批次，不重新选择架构。

当前已有 STP 003 的工程骨架，STP 004 档案／授权实现进行中（见本文件 STP 004 条目）。下文范围描述约束现有目录，也标明后续任务可以新增的文件。实现前“尚无业务代码”的表述已过时，不得当作当前事实。

## 执行顺序与门槛

| 顺序 | 任务 | 阶段 | 前置条件 | 退出门槛 |
| --- | --- | --- | --- | --- |
| 1 | STP 001 固定 P0 规则与页面清单 | M0 | 当前方案 | 专题文档之间无状态、权限、时间或口径冲突 |
| 2 | STP 002 关键页面高保真与状态 | M0 | STP 001 的术语和状态已统一 | 优先页面、组件状态和异常状态可评审 |
| 3 | STP 003 独立仓库与 CI 基础 | M1 基础 | 默认等待 M0；可提前做不依赖业务接口的骨架 | 全新安装及统一检查、测试、构建可运行。工程骨架已在本地验收；M0 未通过，接口未冻结 |
| 4 | STP 004 档案与授权基础 | M1 | STP 003 已完成；本地决定已写入；B07 仍阻塞最终验收 | 档案隔离、同意、配对和撤销通过。当前进行中，未完成 |
| 5 | STP 005 学段与模板种子 | 基础内容 | STP 003；与 STP 004 共享的档案字段已稳定 | 学制映射和模板可查询、预览。CI #5 `9118468` success；P05 刷新回填与 A02 只读目录已复测。不得标产品验收。退出门槛 39 条模板（原 36＋初四 3），见设计第 1.1／10 节 |
| 6 | STP 006 计划与任务生成 | M2 | STP 004、STP 005 | 重复、编辑范围、改期和并发约束通过。当前**第一批＋S06＋暂停／恢复／归档＋按需 horizon＋单次改期＋仅本次内容＋006-A＋006-B＋006-C＋006-D 已实施**；**整个阶段未完成**（通知 worker／T11-D／STP 007 未做），见 `docs/STP006_DESIGN.md` 与 `docs/STP006_IMPLEMENTATION_REPORT.md` |
| 7 | STP 007 完成与计时 | M2 | STP 006 的任务实例模型稳定 | 幂等完成、补记、撤销、计时与跨天通过 |
| 8 | STP 008 报告与家庭协作 | M3 | STP 007 的记录与事件可靠 | 报告可核对，可见范围和建议回应正确 |
| 9 | STP 009 后台与数据权利 | M4 | STP 004 至 STP 008 的对象和权限稳定 | 模板运营、支持、导出、删除和审计闭环 |
| 10 | STP 010 试点发布准备 | M5 | STP 001 至 STP 009 完成 | T01 至 T15 无阻断，恢复与试点检查有证据 |

默认按上表串行交付。只有在契约和文件边界已经固定时，STP 004 与 STP 005 才可由不同实施者并行；它们合并前必须复核档案、年级和模板外键。STP 006 与 STP 007 不并行，避免任务实例和完成模型相互返工。

## 所有任务的共同完成定义

- 开始前核验实际目录、文件、Git 仓库、分支、HEAD 和未提交改动；不存在的内容明确写“不存在”。
- 只修改任务列出的范围，保留已有文件和用户改动；任何扩展范围先获得确认。
- 业务约束在服务端与数据库层成立，不能只靠前端隐藏、客户端校验或测试桩。
- 新增行为有与风险匹配的单元、集成或端到端测试；实际运行检查、类型检查、测试和构建并记录退出结果。
- 数据库变更说明迁移、兼容和回滚／前滚策略；无迁移也明确记录。
- 更新 `docs/CURRENT_STATUS.md` 以及本文件中的任务状态与证据。没有执行的验证写“未执行”，不写“通过”。
- 实施报告包含任务编号、分支与前后 HEAD、修改文件、用户可见变化、测试结果、保留改动和未解决问题。
- 未经明确授权，不 commit、不 push、不建 PR、不创建远程资源、不部署、不处理真实用户数据。

## STP 001：固定 P0 规则与页面清单

状态：待开始

目标：把主方案中的 P0 范围、页面、状态、权限、时间和验收口径拆成后续设计与编码可直接引用的专题文档，不改变主方案结论。

修改范围：

- 新建 `docs/PRODUCT_SCOPE.md`：产品目标、角色、P0／P1／P2 边界和成功口径。
- 新建 `docs/BUSINESS_RULES.md`：计划、任务实例、完成、补记、撤销、计时、徽章、报告和家庭建议规则。
- 新建 `docs/PAGES.md`：S01 至 S18、P01 至 P06、A01 至 A06 的入口、主操作、状态和返回路径。
- 新建 `docs/DATA_MODEL.md`：逻辑实体、归属、唯一约束、事务、时间和历史规则。
- 新建 `docs/API.md`：`/v1` 接口、会话类型、授权、幂等、版本冲突和错误响应。
- 新建 `docs/ACCEPTANCE.md`：T01 至 T15 的前置、步骤、预期和证据要求。
- 仅为状态和追踪更新 `docs/CURRENT_STATUS.md`、`docs/TASKS.md`。

禁止范围：

- 不修改 `PROJECT_PLAN.docx`，不改写 `PROJECT_PLAN.md` 的产品或架构结论。
- 不创建应用、数据库、迁移或业务实现。
- 不把 P1／P2 功能写入 P0 的隐含依赖。

验收标准：

- P0、P1、P2 边界与主方案逐项一致。
- 五类任务实例状态、五类会话状态、计划和建议状态，以及部分完成、跳过、取消、逾期、补记、撤销口径无冲突。
- “仅这一次”与“从选定日期起”的影响范围、稳定实例 ID、历史快照和报告版本有唯一解释。
- 学生、主监护人、内容管理员、支持人员的对象权限和复盘可见范围可追踪到页面、API 和数据实体。
- S01 至 S18、P01 至 P06、A01 至 A06、T01 至 T15 均连续无缺号。
- 每项 T 验收可以追踪到规则、页面、接口和数据约束；未知业务项明确标注，不能静默猜测。

## STP 002：关键页面高保真与状态

状态：待开始

目标：依据 STP 001 的统一规则完成第一轮可评审交互与视觉交付，冻结首轮页面状态和接口输入需求。

修改范围：

- 设计源文件及其导出预览；实际保存位置在任务开始时记录，不虚构当前不存在的设计文件。
- `docs/PAGES.md` 中的交互、状态、数据来源和页面流转说明。
- 若 STP 003 已完成，可在 `packages/ui` 中实现纯展示组件和设计变量；不得在此任务实现业务 API 或数据库。
- 优先页面：S04、S05、S06、S08、S09、S10、S11、S15、P02、A03。

必须覆盖：

- 首次无计划、今天休息、全部完成、任务逾期、加载中、请求失败、离线未同步、登录失效、无权限、计划已暂停十类状态。
- 默认、加载、禁用、选中、错误等适用组件状态。
- 360 至 430px 手机宽度、平板适配、字体放大、减少动效、键盘焦点和非纯颜色状态表达。
- 小学低年级与初高中信息密度差异，但不改变同一业务规则。

验收标准：

- 十个优先页面均有可评审高保真稿或等效可运行展示，不以文字线框冒充高保真。
- 每页标注主操作、数据来源、空状态、异常状态和返回位置。
- 新建计划三步流程、未来一周预览、“仅本次／未来”编辑范围、计时与直接学习的等价入口表达清楚。
- 任务完成不由计时自动触发；部分完成、困难、延期、补记和代录来源在交互上可区分。
- 主要点击区域不小于 44×44 逻辑像素；360 至 430px 无横向溢出，关键文字可读。
- 评审问题和需要的数据字段回写专题文档，经确认后才冻结第一轮接口。

## STP 003：独立仓库与 CI 基础

状态：已完成（工程骨架；不代表 M0 或接口冻结）

完成证据（2026-09-13，工作目录 `D:\Program Files\PycharmProjects\studysteps`）：

- 远端 `https://github.com/xyq-dev/studysteps.git` 的 `git ls-remote` 为空；本地 `git init -b main` 并绑定 origin。分支 `main`，尚无 commit，HEAD 不存在。本轮未 commit、未 push。
- `pnpm install --frozen-lockfile`（含清空 `node_modules` 后重装）、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm prisma:validate` 退出码均为 0。
- 测试覆盖 3 个应用与 3 个包，共 9 个用例；无 `passWithNoTests`。
- `GET /health` 返回 `200` 与 `{"status":"ok","service":"studysteps-api"}`。Web `:5173` 与 Admin `:5174` 可启动。
- Prisma schema 仅 datasource／generator，无业务模型、无 `prisma/migrations`。
- Docker／Compose 未执行：本机无 Docker。
- STP 001、STP 002 仍为待开始。

目标：建立可重复安装、检查、测试和构建的 TypeScript 工作区，只提供最小应用骨架，不提前实现业务。

修改范围：

- 根工作区、包管理器、锁文件、TypeScript、格式、检查、测试和构建配置。
- `apps/web`：React＋TypeScript＋Vite 的最小手机 H5 骨架。
- `apps/admin`：React＋TypeScript＋Vite 的最小桌面后台骨架。
- `apps/api`：NestJS＋TypeScript 的最小 API 与健康检查。
- `packages/contracts`、`packages/domain`、`packages/ui` 的最小可构建边界。
- `prisma/schema.prisma` 的 datasource／generator 基础；本任务不添加业务实体或迁移。
- `.github/workflows`、`.gitignore`、`.env.example`、开发说明及必要的 Docker 基础文件。
- 可按任务授权在本地初始化 Git；远程仓库、commit、push 和部署不在默认范围。

禁止范围：

- 不添加正式业务页面、业务实体、业务迁移或 `/v1` 业务接口。
- 不引入微服务、专用队列、搜索、向量数据库、照片、AI、支付或外部通知。
- M0 未通过时，不宣称接口已冻结或开始 STP 004。

验收标准：

- 从干净依赖缓存状态可按文档完成冻结安装。
- 根命令可以统一执行 lint、类型检查、测试和构建，三个应用及三个包均被覆盖。
- API 健康检查可启动验证；Web 和 Admin 可启动并构建最小页面。
- CI 使用与本地相同的冻结安装及验证命令；锁文件被工作区采用。
- `.env.example` 无真实密钥，日志不打印环境秘密。
- Prisma 静态校验通过且无业务迁移。
- 至少有有意义的启动或导入边界 smoke test；不使用空脚本或 `passWithNoTests` 伪装通过。

## STP 004：档案与授权基础

状态：进行中（不得标为完成）

2026-09-15 续作证据见 `docs/STP004_IMPLEMENTATION_REPORT.md` 第 10 节；2026-09-16 归档与分册登记见第 11 节。GitHub Actions **CI #1** run [`35049218151`](https://github.com/xyq-dev/studysteps/actions/runs/35049218151)（`576da3d`）success：四条迁移已应用、`stp004_api` 非超管、api 84 passed／0 skipped，五套 STP004 集成测试均执行。CI 通过不能代替 STP 004 收口。**不得** 写“第 1–8 项均修复”，也 **不得** 写“本阶段应执行项均已通过”。四项修复及第四条迁移 `20260915160000` 在 fresh／two-mig **复核通过**。TIME-2 范围仍仅为 idle／absolute／节流刷新。T02-B 可单独通过。T11-3、CON-3 为部分通过（学习写入未实现）。下列三项分册登记：原库 `stp004_identity` 污染且只读未升级；T02-D 已在 STP 005 本地执行（待 CI，见 `docs/STP005_IMPLEMENTATION_REPORT.md`）、T11-D → 后续阶段、学习写入既定延期。STP 004 整体仍不得标为完成。环境通过不能代替业务验收。

实现前审查证据（2026-09-13）：

- `docs/STP004_DESIGN.md` 已明确数据模型、关系、数据库约束、迁移影响、会话与对象鉴权、一次性配对、二次验证、撤销事务、API 契约及验收矩阵。
- `docs/CURSOR_STP004_PROMPT.md` 已单独生成，并设置强制门禁；门禁未解除时 Cursor 只能核验和报告。
- 审查基线为 origin `https://github.com/xyq-dev/studysteps.git`、分支 `main`、HEAD 不存在、全部现有文件 untracked；现有改动必须全部保留。
- 当前 API 仍只有 `GET /health`，Prisma 仍无业务模型和 migration，contracts/domain 仍为边界占位；本轮未修改或执行这些内容。
- T01、T10、T11 以及配对／验证码的越权、重放、过期、并发用例均只完成设计覆盖，执行状态为“未执行”。T02 仅完成年龄与年级分离设计，完整映射仍归 STP 005。
- 代码开始前仍须完成 STP 001、STP 002 与 M0 冻结，确认 `STP004_DESIGN.md` B01 至 B06、B08、B09，并另行授权代码／Schema 修改；宣称完成前还须解除 B07，提供隔离 PostgreSQL，真实验证 partial index、CHECK、复合 FK、锁序、事务和并发。

目标：完成监护人开通、学生档案、同意记录、受限学生会话、设备配对与撤销的最小闭环。

修改范围：

- `apps/api` 的 identity、profiles、consents 模块及必要的认证适配边界。
- `Account`、`StudentProfile`、`GuardianLink`、`ConsentRecord`、`DeviceSession` 数据模型与迁移。
- 为落实验证码、摘要轮换、政策当前版本／不可变正文、一次性配对和幂等所必需的 `AuthIdentity`、`AuthIdentityLookup`、`AuthChallenge`、`ConsentPolicy`、`ConsentDocumentVersion`、`DevicePairing`、`IdempotencyRecord` 支撑模型；它们仍位于既定模块边界内，不扩张用户功能。
- `packages/contracts` 的身份、档案、同意、配对、撤销契约和错误码。
- `packages/domain` 的年龄确认、会话范围和授权判断纯规则。
- `apps/web` 的 S01、S02 与共用／独立设备最小流程。
- `apps/web` 家长入口的 P05、P06 最小流程；后台只做必要支持入口，不扩展经营功能。

禁止范围：

- 不凭年级推断年龄或监护权限。
- 不将学生档案 ID 当登录凭证，不允许学生会话提升为家长会话。
- 不在 STP 005 前硬编码全国统一年级映射或全部科目。
- 不以 Local Storage bearer token、不可即时撤销的长效 JWT、前端角色开关或 mock 仓库代替服务端会话、对象授权和数据库约束。

验收标准：

- T01、T10 和 T11 的账号／关系／同意／设备撤销核心子项通过，并覆盖多档案正反向授权集成测试；T11 整体保留到真实通知 worker 复测，不提前标为通过。
- 未完成必要年龄确认和适用同意前不创建正式学习记录；同意版本、范围、主体和时间可追溯。
- 每个对象级接口检查具体档案的有效关系；猜测 ID 不泄露其他孩子是否存在。
- 配对兑换使用非秘密 `pairingId` 加短码定位，短码短期、单次、摘要存储、限制尝试；学生会话仅能访问一个档案。
- 撤销设备或关系后旧会话失效，待同步写入被服务端阻止；未发敏感通知只验证可复用的执行时鉴权入口，真实 worker 链路归 `T11-D` 延后验收。
- 家长代操作与学生操作使用真实会话主体，不接受客户端伪造 `accountId`。
- 共用设备进入学生模式后旧家长凭证不再可用；切回家长模式必须完成绑定会话、设备和用途的服务端二次验证。
- 验证码和配对码的错误、过期、重放、锁定响应不泄露内部状态；真实 PostgreSQL 并发兑换恰好一次成功。
- partial unique index、跨字段 CHECK、复合 FK、政策版本不可变、统一锁序、乐观锁、幂等冲突和撤销事务必须在隔离 PostgreSQL 验证，不能以静态 Prisma 校验或顺序 mock 代替。
- 本任务实现后只可将 `T02-B` 年龄与年级分离子项标为通过；T02 整体仍未通过，六三、五四、自定义映射和升年级历史必须保留给 STP 005。
- STP 004 可验证通知发送前复用的鉴权入口，但在真实通知 worker 尚未实现时，不得宣称 T11 的“未发提醒”链路已经端到端通过。

## STP 005：学段与模板种子

状态：P05 刷新回填与 A02 只读目录已复测关闭；可开始 STP 006 设计（不得标产品验收完成）

2026-09-16：用户授权代码／Schema／新增迁移后按 `docs/STP005_DESIGN.md` 落地，并完成当时的四项阻塞修复尝试。该「四项已修复」声明已被 2026-09-17 反例推翻（`created_at` 可伪造 leftover；`AGE_BAND_NOT_SUPPORTED` 曾被当成 consentCurrent）。历史说明保留在 `docs/STP005_IMPLEMENTATION_REPORT.md` 第 11 节。

2026-09-17：仅修订尚未发布的第五／第六条迁移与 activation 失败关闭。可信 leftover 改为第五条锁内封存的 allowlist；`created_at` 不再作为来源。第六条只消费该名单，并在任何版本 ID 回填前全量预检 assigned／current。测试只打在独占库 `stp005_rev_fresh` 与夹具 `stp005_rev_four_to_six`。既有 `stp004_identity`／`stp004_identity_fresh`／`stp005_four_to_six` 未 deploy、未 reset、未改账本。原库只读。STP 004 仍进行中。不得宣称 M0／STP 002／接口冻结。

`pnpm --filter @studysteps/web test:e2e`（2026-09-17 走查后修复复测，退出码 0，**5 passed / 0 skipped**）。证据：`docs/handoffs/STP005_BROWSER_EVIDENCE.md`。先前走查失败的 A02 目录展示与 P05 刷新回填已关闭。当时导入仍 409；STP 006 第一批已将合法映射的确认写入改为真实 import（空 body 为 `400 VALIDATION_ERROR`，无映射仍为 `TEMPLATE_IMPORT_NOT_ALLOWED`）。不得标 STP 005 产品验收。

目标：建立可配置的学段、学制、年级、学期和科目映射，并提供可预览的原创基础模板。

修改范围：

- catalog 模块，`Subject`、`GradeConfig`、`PlanTemplateVersion` 及相关迁移。
- 非真实用户的配置与模板种子数据。
- `packages/contracts` 和 `packages/domain` 的筛选、映射、版本和快照规则。
- 模板查询接口、S03 初次计划预览、S07 模板库；后台仅加入完成本任务所需的配置预览。

验收标准：

- T02 通过；六三、五四及自定义年级不会被全局数字错误映射。
- 12 个常见年级入口各 3 个原创模板（36），**另补五四初四 3 个，共 39**；相对 `PROJECT_PLAN.md` 原文 36 的范围变化见 `STP005_DESIGN.md` 第 1.1／10 节。模板注明适用范围和可调整内容。
- 科目由学生或家长选择，不自动加入全部学科；具体年级课程配置不冒充全国统一课表。
- 自定义年级可进入 S07 浏览；无映射不自动推荐或套用。
- 导入前可以预览、修改和取消；导入后保存模板内容与版本快照。
- 模板下架只阻止新导入，不删除已经创建的计划。
- 种子不含真实学生、学校、联系方式或受版权限制素材。

## STP 006：计划与任务生成

状态：第一批＋S06＋暂停／恢复／归档＋按需 task-horizon＋单次改期＋仅本次内容＋006-A 本次及未来内容＋006-B 本次及未来重复安排＋006-C 单次拆分已实施（整个阶段未完成）。设计见 `docs/STP006_DESIGN.md`；证据见 `docs/STP006_IMPLEMENTATION_REPORT.md`。

2026-09-18：本批落地 006-C 单次任务拆分。按 §16：父行 `CANCELLED/SPLIT` 留在原 series；每个子任务是同计划新建 ONCE series＋一行实例；第十条补齐 `source_occurrence_id` 同计划／一层／不可变与 `cancel_reason` CHECK。八→九夹具冻结为只打第九条并 `resolve --applied`，避免 `migrate deploy` 追到第十条。本地 lint／typecheck／test／build／prisma:validate／e2e 已通过（api 187、e2e 14）。worker／Outbox、打卡、计时、通知仍属后续。STP 004 仍进行中；STP 005 产品验收未完成。

2026-09-18（设计定稿，随后已实现）：基于 `main@beddf9b` 已把“单次任务拆分”固定为 STP 006-C，唯一方案见 `docs/STP006_DESIGN.md` §16。子任务使用同计划新建 ONCE series 以兼容 `UNIQUE(series_id, scheduled_local_date)`；需要第十条归属约束。

2026-09-18：本批落地 006-B 本次及未来重复安排。既有 future-change 判别联合开放 `kind=SCHEDULE`；确认按 §15.4 B 取消／恢复／推进指针／horizon 内新增；无第十条迁移。本地 lint／typecheck／test／build／prisma:validate／e2e 已通过（api 176、e2e 13）。拆分／horizon 工人仍属后续。STP 004 仍进行中；STP 005 产品验收未完成。

2026-09-18：本批落地仅本次任务内容编辑。只改选中实例的名称／科目／完成标准／时长／步骤快照，不改 series 与重复规则。无第九条迁移。`TASK_DATE_CONFLICT` 仍只约束同规则撞日，未改。本地 lint／typecheck／test／build／prisma:validate／e2e 已通过（api 164、e2e 11）。未来规则编辑、拆分、horizon 工人仍属后续。STP 004 仍进行中；STP 005 产品验收未完成。GitHub Actions 在 push 后按新 SHA 跟踪。

2026-09-18：本批落地 006-A 本次及未来内容修改。第九条双轴 revision、真实例外指针、CONTENT preview／confirm 与 revision-aware horizon 已实施。SCHEDULE 入口未启用。本地 lint／typecheck／test／build／prisma:validate／e2e 已通过（api 173、e2e 12）。CI #12（`72d02b2`）在隔离库准备失败：七→八夹具 `migrate deploy` 会连同第九条一起应用；已改为只打第八条并 `resolve --applied`，与六→七冻结方式一致。006-B／拆分／horizon 工人仍属后续。STP 004 仍进行中；STP 005 产品验收未完成。

2026-09-18（设计定稿，未实现）：基于 `main@9703303` 已把“本次及未来”固定为下列 006-A／006-B 两批；共同使用 `docs/STP006_DESIGN.md` §15 的原始 key 切点、内容／排期双轴修订、显式单次例外和第九条迁移。用户已持续授权后续实现，执行时无需再次申请；本行不改变 STP 006 完成状态，也不授权 STP 007、commit／push／部署。

目标：实现计划、重复规则、每日任务实例、范围编辑、暂停、归档、改期和拆分。

修改范围：

- planning 模块及 `StudyPlan`、`TaskSeries`、`TaskOccurrence`、调整记录与迁移。
- 计划、规则、日程、改期接口及契约。
- `packages/domain` 的重复、生成、编辑范围、状态转换和日期规则。
- S05、S06、S08、S09、S12 及 S04 的日程读取部分。
- 未来 14 天预生成与显式 `task-horizon` POST／Outbox 入口（GET 日程不补齐）。
- FUTURE 共用的 `TaskSeriesRevision`、实例 revision／exception 指针、第九条迁移，以及学生作用域 preview／confirm 接口；不复制 series、不改迁移 1–8／`test-v2`。

验收标准：

- T03、T04、T07 通过，并覆盖 T08 的本地日期与时区边界。
- P0 支持单次、每天、每周指定日期及起止日期／持续标记，不解析任意自然语言规则。
- `series_id＋occurrence_key` 唯一；确认生成、horizon POST 和并发重试不会重复（GET 不补齐）。
- 改期保持实例 ID、最初安排日期和发生键；同日冲突只提示，不自动覆盖。
- “仅本次”和“未来”作用范围按 `STP006_DESIGN.md` §15 正确：切点只取选中实例原始 `occurrenceKey`，实际日期另管历史／撞日，显式单次例外、历史与终态不被覆盖。
- 暂停、恢复、归档已按 §3.5 落地（保留历史，归档不可恢复）。单次改期已按 §3.7 落地。仅本次内容编辑已按 §3.8 落地。未来规则编辑已按 §15 落地。单次拆分已按 §16 落地；拆分后的原任务不会再次计为完成。
- 并发写入使用版本；冲突返回 409 和可解释差异，不静默覆盖。

### STP 006-A：本次及未来的内容修改

状态：**本批已实施并通过本地验证，见实施报告第 15 节**。不得把 006-B、拆分或 worker 写成已完成。整个 STP 006 仍未完成。

目标：从一个具体、合格的 `TaskOccurrence` 起修改同一 `TaskSeries` 的正文；不影响同计划其他 series，不覆盖过去、终态或显式单次例外；窗口外实例在后续 horizon 使用新正文。

固定语义：

- 切点由服务端读取锚点 `occurrenceKey`（含），按锁内档案时区解释；客户端不传日期。锚点已改期时，实际日仅用于历史资格与撞日展示。
- 内容是名称／科目／完成标准／时长／步骤完整包。`content_exception_adjustment_id` 非空即保护整包，即使快照值已回到规则值也不清除。
- 选中实例已有内容例外时保留该实例；表单从有效规则版本取值，预览明确说明。排期例外不阻止正文更新。
- `TaskSeries.version` 是聚合修订头；成功只递增目标 series 和实际变化 occurrence 的 version，plan version 不变。

实现范围：

- **迁移 9：** 新建 `task_series_revisions`，一次铺好 `BASELINE|CONTENT|SCHEDULE` 两轴；为 occurrence 增加 content／schedule revision 指针与两种 exception adjustment 指针；增加复合 FK、FK 索引、shape CHECK、不可变触发器、series version-head 延迟校验和 `UNIQUE(series_id, scheduled_local_date)`。迁移 1–8 与 `test-v2` 不改。
- **回填：** series 真实字段成为 revision 1；旧 `TASK_CONTENT_EDITED`／`TASK_RESCHEDULED` 通过可重放 audit lineage 标记例外，不用快照差异或 `created_at` 推断。异常来源使迁移失败。
- **API：** 新增 `POST /v1/students/:studentId/tasks/:occurrenceId/future-change/preview` 与同路径 `/future-change` confirm；A 期公开 proposal 只接受严格 `kind=CONTENT`。请求带 student／plan／series／anchor expected version；confirm 另带 opaque `previewDigest` 和稳定 `Idempotency-Key`。
- **事务：** 沿用统一授权图和锁序；Guardian preview／confirm 都做 5 分钟 step-up，锁后用 DB 时钟复验；重验当前同意、教育、会话与对象权限后才开始幂等写。失权 replay 拒绝，成功才 heartbeat。
- **horizon：** 提取 revision-aware 共用生成／协调逻辑；新行按 key 选择有效 CONTENT，仍按原始 key 去重，GET 零写入。现有仅本次内容／改期在同一事务维护显式 exception 证据。
- **交互：** 具体实例“编辑内容”先选“仅本次／本次及未来”；FUTURE 编辑后必须看影响预览再确认。预览分组显示修改／保留例外／保持不变；取消零写。修正 web API 层，确认重试复用同一 key，并保留结构化错误 `code／fields`。

文件入口：

- `prisma/schema.prisma`；新 `prisma/migrations/<timestamp>_stp006_series_revisions/migration.sql`；新增 `scripts/stp006-eight-to-nine.mjs`，更新 fresh 校验但不改旧升级夹具含义。
- `packages/domain/src/planning.ts` 及单测；`packages/contracts/src/plans.ts`、`errors.ts`、`index.ts`、`index.test.ts`。
- `apps/api/src/planning/planning.controller.ts`、`planning.service.ts`；`stp006.http.spec.ts`、`stp006.db.spec.ts`、`stp006.concurrency.spec.ts`；新增 eight-to-nine 与 CI migration gate。
- `apps/web/src/app.tsx`、`styles.css`、`app.test.tsx`，以及独立 FUTURE content E2E；实现完成后才更新 `STP006_IMPLEMENTATION_REPORT.md`／`CURRENT_STATUS.md`／本任务真实证据。

验收矩阵：

- 切点：改期锚点仍按原始 key；key 前、实际已过去、`IN_PROGRESS`／`COMPLETED`／`SKIPPED`／`CANCELLED` 不改。
- 例外：普通单次内容、已改回 baseline 的单次内容、锚点自身例外均保留；只有排期例外的合格行仍更新正文。
- 生成：已生成未来行更新；窗口外随后 horizon 使用有效正文；跨学年时旧实例教育快照不变，新实例取生成时当前教育。
- 陈旧／幂等：四个 expected version、sibling／revision／本地 today 变化；同键同体一次、同键异体 409；预览／取消零业务写。
- 权限／竞争：真实锁等待使有效 step-up 跨过 5 分钟后拒绝且零业务副作用；与单次内容、改期、horizon、暂停／归档、同意／link／session 撤销双向竞争及失权 replay。
- 数据库：九迁移 fresh、合法非空八→九保留、回退值仍识别例外、迁移期写被锁住，以及 FK／CHECK／unique／immutability／version-head 的实际反例；不得仅查迁移数量或账本。

退出：上述行为、实际约束和 UI 流程都有证据，且 `git diff --check`、项目规定静态／测试／构建门槛按风险执行通过。A 完成不等于 006-B、拆分或 worker 完成。

### STP 006-B：本次及未来的重复安排调整

状态：**本批已实施并通过本地验证，见实施报告第 16 节**。不得把拆分或 worker 写成已完成。整个 STP 006 仍未完成。

目标：从选中实例原始 key 起修改同一 series 的 `ONCE`／`DAILY`／`WEEKLY_DAYS`、星期、结束日／持续；协调已生成未来实例，并让窗口外实例随后按新规则补齐。

实现范围：

- 将同一 API 判别联合公开扩为 `kind=SCHEDULE`；start／cut 仍由服务端锚点导出，客户端只传 repeatKind／weekdays／endLocalDate／ongoing／reason。正常情况下不新增第十条迁移。
- 新规则移除的未来无例外 `PLANNED` 行变为 `CANCELLED/SERIES_RULE_REMOVED`；再次加入时恢复同一 id/key。其他取消原因不复活；schedule exception 保护实际日期和存在性，content exception 保护正文但不阻止排期协调。
- 当前 horizon 内新增缺失 key；窗口外留给之后的 revision-aware horizon。恢复行保留教育快照；新行用当前合法教育和该 key 的有效 CONTENT。
- 预览显示修改／保留例外／取消／恢复／新增／保持不变及所有撞日；确认重算。`UNIQUE(series_id, scheduled_local_date)` 和 `TASK_DATE_CONFLICT` 禁止同 series 任意状态撞日，不同 series 同日允许。
- H5 在具体实例“调整重复安排”提供范围选择、规则编辑、影响预览和确认；不加入删除、强制取消、拆分或自动换日。

主要文件：复用 006-A 的 domain／contracts／planning controller-service／web 入口；扩展 `stp006.http/db/concurrency`、migration gate 复测和独立 FUTURE schedule E2E。若 A 已按定稿完成，不应再改 schema；发现确切冲突必须先记录，不能自行选择新架构。

验收矩阵：

- 新增／移除日期、`SERIES_RULE_REMOVED` 同行恢复、其他取消不复活；ONCE／DAILY／WEEKLY_DAYS 和 end／ongoing 边界。
- 连续两次较早／较晚切点编辑，以及 CONTENT→SCHEDULE、SCHEDULE→CONTENT 都按各轴最高有效 revision 解析，不重复生成。
- 改期例外与选中锚点例外保留；无例外行正确取消／恢复；窗口外再次 horizon 使用新规则。
- 同 series 撞日（含终态／取消行）预览阻塞且确认 409；不同 series 同日成功。不可调整冲突不自动覆盖，作为既定产品边界返回。
- 与单次改期、内容编辑、horizon、暂停／归档和撤权的双向真实并发不死锁、不静默覆盖；跨本地午夜旧 preview 被拒绝。

退出：006-A 全量回归和本批矩阵通过，才可把“本次及未来重复安排”标为完成。仍不进入拆分、worker／Outbox、STP 007、打卡、计时或通知。

### STP 006-C：单次任务拆分

状态：**已实施，见 `docs/STP006_DESIGN.md` 第 16 节与实施报告第 17 节。** 不得把 worker、STP 007 完成态拆分写成已完成。整个 STP 006 仍未完成。

目标：把选中的一条尚未开始的任务实例拆成 2–8 条可独立执行的后续实例；父行保留为 `CANCELLED/SPLIT`；不修改原重复规则，不生成多级任务树。

固定语义（不得改选型）：

- `steps` 仍是单实例勾选清单，编辑步骤不是拆分。
- 父实例保持原 `id`／`occurrenceKey`／系列归属／快照／例外；`status=CANCELLED` 且 `cancel_reason=SPLIT`。
- 每个子任务是同计划下新建的 `ONCE` `TaskSeries`＋一行实例，`sourceOccurrenceId` 指向父 id。这是兼容第九条 `UNIQUE(series_id, scheduled_local_date)` 与 key=原日 CHECK 的唯一方案；禁止把子任务插入父 series、禁止伪造日期或改写父 key。
- 只拆 `ACTIVE`＋`PLANNED` 且实际安排日 ≥ 锁内今日的实例。子任务 2–8 条，字段长度与仅本次内容相同；时长不要求和父相等。
- 子任务用当前合法教育快照；父快照不改。列表分母不计父。不支持撤销拆分；子任务后续改内容／改期不恢复父任务。
- 子任务允许既有仅本次编辑与改期；禁止 FUTURE、禁止再拆。父 series 的 SCHEDULE 不得复活 `SPLIT` 行。horizon 不重生父、不重复子。
- 共同制定不适用于拆分。权限为 `TASK_ADJUST`、当前同意、Guardian 五分钟 step-up。

已落地：

- **迁移 10：** `source_occurrence_id` 索引、同计划／一层／不可变触发器、`cancel_reason` CHECK 含 `SPLIT`。未改迁移 1–9 与 `test-v2`。历史夹具保持原上界，另建九→十夹具。
- **API：** `POST /v1/students/:id/tasks/:occurrenceId/split/preview` 与 `/split`；`TASK_SPLIT` 审计；错误码含 `TASK_SPLIT_PREVIEW_STALE`。
- **事务：** 预览零写；确认原子落库；统一锁序；幂等重放仍验权。
- **H5：** 实例上“拆成多条任务”→ 填写 → 预览 → 确认；取消零写；无强行覆盖。

验收：§16.8 矩阵已在本批本地验证。仍不进入 worker／Outbox、STP 007、打卡、计时或通知。

### STP 006-D：horizon 后台自动补齐

状态：**已实施，见 `docs/STP006_DESIGN.md` 第 17 节与实施报告第 18 节。** 006-D 通过不等于整个 STP 006 验收完成，也不等于通知 worker／T11-D 通过。STP 004／005 完成状态不变。B04 与生产启用仍延期。

目标：不依赖用户点击 `task-horizon`，由独立单体 worker 为符合当前资格的 `ACTIVE` plan 自动维持档案时区 today..today+13 窗口；保留现有显式 POST 和手动按钮，GET 仍不生成任务。只补 `TaskOccurrence`，不做通知、提醒、完成、计时或通用队列平台。

固定选型：

- 第十一条迁移新增每 plan 唯一一行的专用 `task_horizon_jobs`，不是 STP 007 的通用 `OutboxEvent`。作业单位为 plan；state 固定 `READY／LEASED／BLOCKED／FAILED／RETIRED`，带 available time、generation、lease token／owner／时限、attempt 和受控结果字段。
- worker 主体固定 `SYSTEM/HORIZON_WORKER_V1`，不是 Account／DeviceSession。它不调用公开 POST，不伪造 Cookie、CSRF、step-up、共同制定或学生确认，不使用人类 `IdempotencyRecord`，也不 heartbeat。
- HTTP 与 worker 使用不同授权 adapter，只共享 `TaskHorizonCoreService.reconcilePlanLocked`。旧设计“worker 调用带 CSRF POST”的传输约定由 §17 明确取代；公开 POST 的现有授权、幂等与响应不变。
- 持续授权来自仍为 ACTIVE 的合法计划和执行锁内的当前资格：profile／activation、年龄、教育、current policy／consent scope、ConsentRecord 对应 ACTIVE link 与 ACTIVE grantor Account。入队和启动配置不能代替执行授权。
- `test-v2` 正文和 scope 已直接覆盖生成／保存任务实例、年级快照和来源审计，隔离实现可复用；它不是正式生产告知且不覆盖通知，T11-D 继续延期。

迁移 11 需求：

- `plan_id UUID PRIMARY KEY` 且真实 FK `study_plans(id) ON DELETE RESTRICT`；不另造 job id，也不冗余可错配 student id。
- state／available、`requested／processed／claimed_generation`、lease shape、attempt、reason 和 SYSTEM executor 均有实际 CHECK；partial due／expired-lease 索引，非空 lease token 唯一。
- plan INSERT 触发器原子建 job；合法非空十→十一回填 ACTIVE=due-now、PAUSED=blocked、ARCHIVED=retired，既有计划／revision／exception／SPLIT 父子／occurrence digest 不变。
- 新建 `stp006-ten-to-eleven` 夹具并把 fresh 上界改 11；八→九继续停 9，九→十继续停 10 且断言没有 job 表。迁移 1–10 和 `test-v2` 不改写。

实施文件入口：

- Schema／migration 11／ten-to-eleven 与 fresh、CI migration gate。
- `apps/api/src/planning/task-horizon-core.service.ts`、`task-horizon-job.repository.ts`、共享 `planning-eligibility.service.ts`／`horizon-signal.service.ts` 与无 controller 的 PlanningCoreModule；现有 PlanningService 作为 HTTP adapter，StudentsService 只接入同意／关系／教育／时区变更后的 signal／block，StudentsModule 完成 provider 装配。
- `apps/api/src/common/lock-order.ts`／spec 增加全序最后一类 job；`apps/api/src/horizon-worker/{main,module,service}.ts` 只 import PlanningCoreModule、config 和 Prisma。RuntimeConfig、`.env.example`、根与 API package scripts 同步增加；WorkerModule 不得 import AppModule／StudentsModule，也不得借 `PolicySeedService.OnModuleInit` 启动。
- domain 日期／revision 纯规则和 API／DB／真实并发测试；无新公共 worker API、无新 H5 功能，只回归手动按钮。

运行契约：

```bash
pnpm build
# 运行下列命令前，进程环境必须已有 HORIZON_WORKER_ENABLED=true
pnpm worker:horizon -- --continuous
pnpm worker:horizon -- --once --max-jobs=20 --max-ms=60000
pnpm worker:horizon -- --status
pnpm worker:horizon -- --requeue-failed=<planId> --reason=OPERATOR_RETRY_AFTER_DIAGNOSIS
```

默认关闭；普通 API、`pnpm dev`、单测和升级夹具不启动循环。默认 poll 30 秒、batch 20、并发 4、lease 300 秒、60 秒续租、最多 8 次技术退避。`--once` 必须受 job／时间双上限约束并关闭 Nest context／Prisma；continuous 响应 SIGTERM 停止领取并有界退出。requeue 仅对 FAILED job 做 generation CAS，退出码和审计按 §17.7 固定，不直接写 occurrence。

事务与锁：

- claim／renew／过期回收是 job-only 短事务，`FOR UPDATE SKIP LOCKED` 后立即提交，绝不持 job 行再取业务图。
- 业务事务按 `Account → StudentProfile → GradeConfig → ConsentPolicy → GuardianLink → ConsentRecord → StudyPlan → TaskSeries → TaskOccurrence → TaskHorizonJob`，锁后读 DB now、重验资格／规则并调用共享核心；job token CAS 是最后一步，与实例变更同事务提交。
- crash 在提交前则业务与结束状态一起回滚；提交结果未知则二者已一起提交或一起回滚；过期 token 不能提交。业务失败后才用 job-only CAS 退避。DB uniques 和锁后重读是最终防重，不以 lease-once 宣称幂等。
- generation 防处理期间 signal 丢失。成功排到下一档案本地日 00:05 加稳定 0–599 秒抖动；可恢复资格 BLOCKED 由相关事务立即 signal 并每日低频复查；技术错误 8 次后 FAILED，须受控显式 requeue；归档／删除 RETIRED。

核心联动：

- 继续按原始 key、CONTENT／SCHEDULE revision 双轴生成；只恢复无排期例外的 `SERIES_RULE_REMOVED`。不覆盖单次例外、历史、终态、`USER_CANCELLED`、`SPLIT`、暂停／归档原因。
- 明确跳过含 `sourceOccurrenceId` 的拆分子 series；父 SPLIT key 不复活。新实例用生成时当前合法年级，旧实例快照不变。
- `createMany(skipDuplicates)` 不得静默吞同 series 实际日冲突；候选日已被不同 key 占用时整 plan 零写并 `BLOCKED/DATE_OCCUPIED`，人类 POST 保持 409。单 plan 根 series 上限 100、候选／冲突锁行上限 5,000，超限零写并 FAILED，不做半批。
- 与 HTTP、FUTURE、改期、拆分、暂停／归档、同意／关系撤销均沿用业务图锁线性化；撤权先则 worker 零写，worker 先只能提交在撤权响应前。

验收矩阵：

- 无手动 POST 自动生成、同日本地重复 no-op、两个时区跨日窗口、GET 零写、手动按钮回归。
- CONTENT／SCHEDULE 连续修订、窗口外补齐、改期 key、拆分父子、各种取消原因、旧／新年级快照。
- logout／session 过期／设备撤销与 Account／link／consent／policy／profile／education／plan 状态逐项区分；失效执行零写，恢复 signal 后可补，无伪 actor／heartbeat。
- 双 worker、worker+HTTP 及各关键写操作用独立真实连接和 `pg_blocking_pids` 证明锁等待；不能仅用 `Promise.all`。
- claim 后崩溃、提交前崩溃、提交结果未知、过期 lease、旧 token、重试耗尽与 requeue；无重复、无半批、无错误作业覆盖。
- fresh 11、合法非空十→十一保留及 FK／UNIQUE／CHECK／partial index／trigger 的实际反例；旧夹具各自上界不变。
- 超过 batch 的同时到期 job、最早失败行与空闲并发槽实测：失败行退避、后排不饥饿、claim 不超空闲槽；bounded once 正常退出且无遗留 worker。horizon worker 通过不等于通知 worker 或 T11-D 通过。

退出：第 17 节本批已落地。仍不得自动进入 STP 007、通知 worker、T11-D 或生产启用。

## STP 007：完成与计时

状态：待开始

目标：完成可靠的部分／完整记录、补记、撤销、计时、异常恢复、汇总和基础徽章事件。

修改范围：

- tracking 模块及 `CompletionRecord`、`StudySession`、`BadgeEvent`、`OutboxEvent` 与迁移。
- 完成、撤销、会话动作接口及契约。
- `packages/domain` 的幂等、补记窗口、会话状态、跨天拆分、汇总和徽章规则。
- S04、S09、S10、S11 的执行与完成闭环。

验收标准：

- T05、T06、T08、T09、T12 通过。
- 完成状态、有效完成记录、当日汇总和徽章事件在同一事务边界内成功或回滚。
- `Idempotency-Key` 绑定主体、接口和请求摘要；同键同内容返回既有结果，同键不同内容冲突。
- 每个任务实例仅一条有效完成；每名学生仅一个未结束会话，数据库约束与并发测试成立。
- 部分完成保持进行中；补记限制最近 7 个自然日并保留接收时间、操作人和补记标识。
- 撤销同步修正有效完成、汇总、报告版本和当前徽章资格，不重复发奖。
- 客户端倒计时不作为真实累计依据，不自动完成任务；跨午夜按时区拆分，异常长会话转待确认。
- 家长代录保存真实操作人和来源，学生端可以识别。

## STP 008：报告与家庭协作

状态：待开始

目标：交付成长、周复盘、版本化周报、求助、家长反馈和计划建议回应闭环。

修改范围：

- reflection、reports、family 模块及 `Reflection`、`WeeklyReport`、`PlanSuggestion` 与迁移。
- 复盘、周报、建议和回应接口及契约。
- 确定性的调整建议规则与必要 Outbox 处理。
- S13、S14、S15、S16，P01、P02、P03、P04。

验收标准：

- T14 通过，并复测 T05、T06、T10、T11 对报告和家庭读取的影响。
- 周报保存安排数、调整数、完成数、按时完成数、分子、分母、范围和版本，可回到原记录核对。
- 补记更新报告版本，计入实际学习日但不计入按时完成；无计划日不显示误导性的 0%。
- 复盘正文默认学生个人可见；主动分享、求助和撤回分享均有明确动作与授权检查。
- 家长新增计划默认是建议；接受、拒绝、撤回和重复回应幂等并保留轨迹。
- 首期建议由可解释的确定性规则生成，用户确认后才修改计划，不调用外部 AI。
- 三种 P0 徽章条件固定、无随机、无付费关联；家长反馈不形成同学排名。

## STP 009：后台与数据权利

状态：待开始

目标：完成内容运营、必要账号支持、运行概况、数据导出／删除和敏感操作审计。

建议拆为两个连续 PR：009A 完成 A01 至 A04 与模板发布；009B 完成 A05 至 A06、数据请求、审计和相关后台任务。

修改范围：

- admin、notifications 及 data request 相关模块，独立管理员认证与角色权限。
- A01 至 A06、S17、S18、P05、P06 的剩余能力。
- 模板审核、发布、下架和版本；站内消息及打开页面后的到期提示。
- `AuditLog`、`DataRequest`、导出、在线删除、备份删除重放与迁移。
- 支持工单的临时授权、必要遮罩、到期和审计。

验收标准：

- T13 通过，并复测 T10、T11；导出、上传签名、通知和后台任务都执行对象级授权。
- 管理员账号体系独立并支持二次验证；内容管理员默认不能浏览学生照片或复盘正文。
- 模板版本可审核、预览、发布和下架；下架不删除已导入计划。
- 导出与删除请求验证有权主体，异步状态可查；必要保留范围和失败处理有记录。
- 在线删除目标和备份轮转按已批准规则执行；恢复后不会重新开放已删除档案。
- 审计只记必要摘要，不记录令牌、验证码、儿童复盘正文或其他不必要敏感信息。
- P0 仅站内消息和打开页面后的提示，不擅自接外部渠道。

## STP 010：试点发布准备

状态：待开始

目标：在不扩张 P0 的前提下完成联调、设备、安全、性能、恢复和 14 天家庭试用准备。

修改范围：

- 全仓缺陷修复、测试、监控、日志脱敏、健康检查、运行手册和试点说明。
- Android 常见浏览器、iPhone Safari、微信内置浏览器以及 360 至 430px 的关键路径验证。
- 性能脚本、备份恢复演练、数据请求演练和安全检查记录。
- 引导、模板、反馈入口与试点指标采集；只使用非真实或经批准的隔离测试数据。

禁止范围：

- 不因试点准备加入照片、外部 AI、小程序、原生应用、支付、社区或 P1／P2 功能。
- 通过本任务不等于授权生产部署、真实家庭导入或发送邀请。

验收标准：

- T01 至 T15 全部有可复核证据且无阻断问题；严重权限、数据丢失或重复记录问题为零容忍门槛。
- 监护人开通、学生计划与完成、周复盘、家长查看、模板运营、导出和删除关键端到端路径通过。
- 360 至 430px 无溢出，软键盘、后台恢复、弱网、离线同步和共用设备切换完成人工验证。
- 在记录清楚的测试资源和数据量下，100 个活跃会话、读写混合时普通 API P95 低于 500ms。
- 实际执行一次备份恢复并记录结果；RPO 24 小时、RTO 4 小时作为验收目标而非未经验证的承诺。
- 错误追踪、结构化日志、健康检查、限频、CSRF／XSS、防密钥泄漏和紧急撤销会话均有检查结果。
- 试点指标能够区分首次成功、第二周使用、自主制定、调整、周复盘、体验压力和技术可靠性，不采集复盘正文做分析。
