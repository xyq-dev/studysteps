【执行工具：Cursor｜模型：Grok 4.6 High Fast】

任务编号：STP 003

任务名称：独立仓库与 CI 基础（首个代码批次）

工作目录：

`D:\Program Files\PycharmProjects\studysteps`

任务目标：

在保留全部现有文档的前提下，建立可重复安装、检查、测试和构建的 TypeScript 工作区。只完成 STP 003 的仓库、应用空骨架、共享包边界、Prisma 空基础和 CI，不实现任何业务实体、业务接口或正式业务页面。

开始前必须执行并报告：

1. 输出实际工作目录，递归列出根目录现有文件。
2. 完整阅读 `AGENTS.md`、`docs/PROJECT_PLAN.md`、`docs/CURRENT_STATUS.md`、`docs/TASKS.md`；原始 DOCX 只保留，不修改。
3. 核验当前目录是否为 Git 仓库；如是，记录当前分支、HEAD 和工作区状态；如不是，明确记录“分支不存在、HEAD 不存在”，不得伪造。
4. 核验 Git、Node、npm、pnpm、Corepack 和 Docker 的实际版本／可用性。交接快照显示 Git、Node、npm、pnpm、Corepack 可用而 Docker 不存在，但必须以执行当时的结果为准。
5. 如果文件状态或既定方案与本提示词冲突，先停止并报告冲突，不覆盖已有内容。

当前门槛：

- `docs/CURRENT_STATUS.md` 记录 STP 001、STP 002 尚未完成。
- 本任务只能搭建不依赖业务接口和页面定稿的工程骨架。
- 不得因为完成脚手架就把 M0、STP 001 或 STP 002 标记为已完成，也不得宣称首轮接口已冻结。

必须沿用的架构，不再重新选型：

- `apps/web`：React＋TypeScript＋Vite，学生与家长手机 H5。
- `apps/admin`：React＋TypeScript＋Vite，桌面管理后台。
- `apps/api`：NestJS＋TypeScript，API 与后台任务部署为一个模块化单体。
- `packages/contracts`：请求响应契约、校验规则和错误码的边界。
- `packages/domain`：不依赖框架和 I/O 的纯业务逻辑边界。
- `packages/ui`：共享设计变量与基础展示组件边界。
- `prisma`：PostgreSQL＋Prisma；本批仅 datasource／generator 基础。
- 后台异步方向是数据库 Outbox；本批不实现 Outbox 业务表，不引入专用消息队列。

包管理与版本规则：

- 方案没有锁定包管理器。若执行时仍无新增决策，使用 pnpm workspace 作为本批实施选择，并在 README、`package.json` 的 `packageManager` 字段和锁文件中固定。
- 选择相互兼容的稳定 Node、React、Vite、NestJS、TypeScript、Prisma、测试和检查工具版本，并记录实际版本；不要仅因为机器上已有某个 Node 版本就假定它是项目目标版本。
- 不全局升级或卸载用户工具。需要 Node 版本约束时在仓库内声明。
- 保持工具链最小。本批不主动引入 Nx、Turborepo、微服务框架、专用队列、搜索或向量数据库；如确有必要，先停止并说明理由，等待授权。

允许修改：

- 根工作区配置、包管理配置、锁文件、TypeScript 配置、lint、格式化、测试和构建配置。
- `apps/web`、`apps/admin`、`apps/api` 的最小可启动、可测试、可构建骨架。
- `packages/contracts`、`packages/domain`、`packages/ui` 的最小导出边界和有意义的导入 smoke test。
- `apps/api` 的无业务数据健康检查，例如 `/health`；它不属于 `/v1` 业务接口。
- `prisma/schema.prisma` 的 PostgreSQL datasource 和 generator 基础；不得添加业务模型或生成业务迁移。
- `.github/workflows/ci.yml`、`.gitignore`、`.env.example`、根 README，以及本地开发所必需的 Dockerfile／Compose 基础文件。
- `docs/CURRENT_STATUS.md`、`docs/TASKS.md` 中仅与 STP 003 实际状态和验证证据有关的内容。

禁止修改或实施：

- 不删除、覆盖或重新生成 `docs/PROJECT_PLAN.docx`。
- 不改写 `docs/PROJECT_PLAN.md`、`AGENTS.md` 中已经确定的产品和架构结论。
- 不添加 Account、StudentProfile、Plan、Task、Completion 等业务实体或任何业务数据库迁移。
- 不实现 `/v1` 身份、档案、模板、计划、任务、计时、报告、后台等业务接口。
- 不实现正式 S／P／A 页面，不用占位业务数据假装流程已完成。
- 不加入照片、外部 AI、支付、题库、社区、外部通知、小程序或原生应用。
- 不创建云资源、Git 远程仓库、生产环境或测试环境，不接入真实第三方凭证。
- 不 commit、不 push、不创建 PR，除非用户在执行当轮另行明确授权。

Git 授权：

- 如果开始核验时仍不存在 `.git`，允许为 STP 003 执行本地 `git init -b main`。
- 初始化后记录分支和 HEAD；未提交时 HEAD 仍可能不存在，必须如实报告。
- 不添加 remote，不 commit，不 push，不改写任何外部仓库历史。

最低交付：

- 根目录有清晰的 workspace 和统一命令。
- Web、Admin、API 可以分别启动，并可从根目录统一构建。
- Web 和 Admin 只显示最小应用标识与“工程初始化中”类状态，不呈现虚构业务完成度。
- API 只提供健康检查；健康响应不读取或泄露敏感环境变量。
- 三个共享包有清晰导出边界，可以被目标应用导入。
- Prisma schema 可以静态校验，但本批无业务表、无 migration。
- CI 在干净环境中执行冻结安装、lint、类型检查、测试、构建和 Prisma 校验。
- `.env.example` 只包含安全占位值，不含真实密钥。
- README 记录前置版本、安装、开发、检查、测试、构建、Prisma 校验和当前 Docker 限制。

必须实际执行并记录命令、退出码和结果：

1. 锁文件对应的冻结安装。
2. lint。
3. typecheck。
4. test。
5. build。
6. Prisma validate。
7. API 健康检查启动验证。
8. 能执行时验证 Docker／Compose 配置；若 Docker 仍不存在，明确写“未执行：Docker 不可用”，不得写成通过。

测试要求：

- 至少为 API 健康检查提供真实测试。
- 至少验证三个共享包的导出或导入边界。
- 不使用空脚本、永远返回成功的脚本、`passWithNoTests` 或删除失败测试来制造绿色结果。
- CI 和本地使用同一组根命令，避免“本地通过、CI 跳过”。

完成后更新：

- 在 `docs/CURRENT_STATUS.md` 中记录 STP 003 的真实状态、Git 状态、工具版本和验证证据。
- 在 `docs/TASKS.md` 中只更新 STP 003 状态；STP 001、STP 002 未经独立验收仍保持待开始／进行中。
- 如果只完成部分验收，状态写“进行中”，列出剩余项，不降低验收标准。

最终实施报告必须包含：

- 任务编号和实际工作目录；
- Git 初始化情况、分支、前后 HEAD 和工作区状态；
- 技术版本与选择理由；
- 修改文件清单及每类文件的目的；
- 用户可见变化；
- 数据库迁移与回滚情况，本批预期为“无业务迁移”；
- 每条实际验证命令、退出码和结果；
- 未执行项目及原因；
- 明确保留的已有文件和已有改动；
- 未解决问题及其是否阻塞下一任务。

完成 STP 003 后停止，不继续 STP 004，不部署，不 commit，不 push。
