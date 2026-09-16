# StudySteps

家庭学习计划与完成记录产品的独立代码仓库。当前批次只提供可安装、可检查、可测试、可构建的工程骨架，不包含业务页面、业务接口或业务数据模型。

产品与架构结论以 `docs/PROJECT_PLAN.md` 为准。原始方案文件 `docs/PROJECT_PLAN.docx` 仅保留，不作为实现入口。

## 当前范围

- `apps/web`：学生与家长手机优先 H5 骨架
- `apps/admin`：桌面管理后台骨架
- `apps/api`：NestJS 模块化单体骨架，仅提供 `/health`
- `packages/contracts`、`packages/domain`、`packages/ui`：共享边界
- `prisma/schema.prisma`：PostgreSQL datasource 与 generator，无业务模型、无迁移

## 前置版本

本批在本地核验后固定如下目标：

| 工具 | 目标版本 | 选择理由 |
| --- | --- | --- |
| Node.js | 22（`engines`: `>=22.14.0`） | 当前 LTS 基线；不把开发机上的 Node 23 当作项目目标 |
| pnpm | 10.17.0 | 工作区与冻结锁文件；写入 `packageManager` |
| TypeScript | 5.9.3 | 与 NestJS 11 官方兼容线一致，不使用 TypeScript 7 |
| React | 19.3.0 | 当前稳定 React |
| Vite | 7.3.6 | 与 Vitest 3 配对的稳定前端构建器 |
| NestJS | 11.1.16（CLI 11.0.24） | 稳定 CommonJS 应用线；NestJS 12 为 ESM-only |
| Prisma | 6.19.3 | 在 `schema.prisma` 内声明 datasource；Prisma 8 仍为 RC |
| Vitest | 3.2.7 | 覆盖三个应用与三个包的 smoke test |

开发机若已安装更高的兼容 Node，仍应按仓库约束使用 pnpm，不要全局改写用户工具。

## 安装

```bash
corepack enable
pnpm install --frozen-lockfile
```

首次生成本地锁文件时用 `pnpm install`。之后本地与 CI 都使用冻结安装。

复制环境占位文件（不含真实密钥）：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

## 开发

```bash
pnpm dev
pnpm dev:web
pnpm dev:admin
pnpm dev:api
```

默认端口：

- Web：`http://127.0.0.1:5173`
- Admin：`http://127.0.0.1:5174`
- API 健康检查：`http://127.0.0.1:3000/health`

Web 与 Admin 只显示应用标识和“工程初始化中”。`/health` 只返回静态状态，不读取或回传环境秘密。

## 检查、测试与构建

本地与 CI 使用同一组根命令：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm prisma:validate
```

`pnpm prisma:validate` 只做 schema 静态校验。STP 004 已写入业务 Schema 与 migration 文件，但在隔离 PostgreSQL 就绪前不要执行 `prisma migrate`，也不要把数据库验收写成通过。

`pnpm prisma:generate` 生成本地 Prisma Client。

## Docker

`docker-compose.yml` 仅提供本地 PostgreSQL 16 占位服务。`apps/api/Dockerfile` 是 API 镜像草稿。

若本机没有 Docker，不要把 Compose 或镜像构建写成已验证。当前交接环境未安装 Docker 时，相关检查应记录为未执行。

## 不要在本骨架上假设

- 接口尚未冻结；M0 / STP 001 / STP 002 未完成
- 不存在业务实体、`/v1` 业务接口或正式 S／P／A 页面
- 不接入真实短信、对象存储、支付或分析供应商
