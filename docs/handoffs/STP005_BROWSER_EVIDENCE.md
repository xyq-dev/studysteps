# STP 005 真实浏览器走查证据（脱敏）

日期：2026-09-17
工具：`@playwright/test@1.55.1` + Chromium；验证码由测试进程读取 `GET /__local/test-inbox` 后填入输入框，不绕过认证。
未使用纯 HTTP 脚本代替页面点击。不含验证码／配对明文的截图在忽略目录 `.local/stp005-e2e/screenshots/`。

## 现场

| 项 | 事实 |
| --- | --- |
| HEAD | `911846895adcba9ad2958f2b4c707655903cd56a`（`main` = `origin/main`） |
| 测试库 | `stp005_rev_fresh` @ `127.0.0.1:6260`（pid 2796，本轮未停） |
| 禁止回落 | 未使用 `stp004_identity`／`stp004_identity_fresh`／`stp005_four_to_six` |
| 已应用迁移 | 六条；文件第五／第六条 SHA-256 为 `6f51d8e5…`／`93ffc8d0…`。账本第五条仍为修剪前 `2e765521…`（已知，语义同修订 SQL） |
| 种子 | 已发布年级 25、模板 39 |

## 命令

```bash
pnpm exec eslint apps/web/e2e/stp005-walkthrough.spec.ts apps/web/playwright.config.ts
pnpm --filter @studysteps/web typecheck
pnpm --filter @studysteps/web exec playwright test --config playwright.config.ts e2e/stp005-walkthrough.spec.ts
pnpm --filter @studysteps/web test:e2e
```

| 命令 | 退出码 | 数量 |
| --- | --- | --- |
| eslint（上述两文件） | 0 | — |
| web typecheck | 0 | — |
| walkthrough 单独 | 0 | 2 passed |
| `pnpm --filter @studysteps/web test:e2e` | 0 | **4 passed / 0 failed / 0 skipped**（含既有 STP004 1 + STP005 1 + 本轮 2） |

Playwright 日志再次出现 `Internal error: step id not found: fixture@95`；四用例仍 passed。未把该内部提示当作失败。CI 工作流仍无 Playwright。

根 `pnpm lint`／`pnpm test`／`pnpm build`：**本轮未重跑**（复用 CI #5 `9118468` success 与此前 139 passed）。

## 路径结论

### P05 教育资料

| 路径 | 结论 | 证据 |
| --- | --- | --- |
| 首次 SET，年级／学期保存 | **通过** | 状态「年级已保存」；PATCH `changeKind=SET` `termCode=FULL_YEAR` |
| 刷新后数据仍在 | **通过（需重新登录）** | 刷新回到 S01（SPA 不恢复会话屏）；再登录后二次 SET 得到「已配置年级不能再用 SET」，证明服务端已保存 |
| 刷新后页面展示当前年级 | **失败（体验）** | 刷新丢失 React 状态，P05 不回填已保存年级／学期 |
| 六三有小六、无初四 | **通过** | 选项含 `SIX_THREE · 六年级`，无六三初四 |
| 五四无小六、有初四 | **通过** | 选项含 `FIVE_FOUR · 初四`，无五四六年级 |
| 同学制升年级 PROMOTE | **通过** | 一年级 → 二年级；PATCH `changeKind=PROMOTE` |
| TERM_SWITCH | **通过** | 同学制同年级改 `FIRST_TERM`；PATCH `changeKind=TERM_SWITCH` |
| SYSTEM_SWITCH | **通过** | 六三 → 五四初四 → 自定义实验班；均提交用户所选 `SYSTEM_SWITCH` |
| 页面提交用户选择的 changeKind | **通过** | 每次保存断言 PATCH body，不猜测种类 |
| 教育修改不改变监护授权 | **通过（页面可见部分）** | P06 仍显示「当前有效」与撤回；P05 不展示年龄段字段 |
| 保存失败无假成功 | **通过** | 空档案 PROMOTE →「空档案只能 SET…」，状态不含「年级已保存」 |
| 五分钟 step-up 页面入口 | **通过** | 学生视图「申请家长二次验证」可点出发送；后端 5 分钟窗口复用既有并发证据，本轮未再等超时 |

### S07 模板

| 路径 | 结论 | 证据 |
| --- | --- | --- |
| 已发布模板可浏览 | **通过** | 列表 39 个导入按钮 |
| 13 档 × 3 类，五四初四独立 | **通过** | 含 `JUNIOR_G4 · 日常安排／阅读或复习习惯／周计划`，不套用初三标题 |
| 筛选／推荐与当前教育一致 | **通过** | 初四：`可推荐 3 条`；实验班：`无合法映射，禁止导入`；列表仍可浏览全部已发布项（设计允许浏览） |
| 自定义可浏览、无映射不套用 | **通过** | 实验班仍 39 条可浏览；导入提示「没有合法模板映射」 |
| 有映射导入限制 | **通过** | 「计划导入属于后续任务」 |
| 学生视图打开 S07 | **未执行** | 学生视图无「打开模板库」按钮 |
| 导入前预览／修改／取消 | **未执行** | 属 STP 006；当前只有导入按钮 |

### A02 只读目录

| 路径 | 结论 | 证据 |
| --- | --- | --- |
| 按现有方式打开 | **通过** | `http://127.0.0.1:5174/` 标题「A02 学段科目配置」 |
| 无编辑／发布入口 | **通过** | 「只读预览 · 无发布」；无发布／下架按钮；本轮未做管理员登录 |
| 目录与版本信息展示 | **失败** | 状态「目录读取失败，后台仍无发布入口」。Admin Vite 无 `/v1` 代理，且 `GET /v1/grade-configs` 需会话，现有访问拿不到目录 |

## 截图（忽略目录，无验证码／配对明文）

`.local/stp005-e2e/screenshots/`

- `01-p05-catalog-mobile.png`
- `02-p05-promote-from-empty-error.png`
- `03-p05-after-set.png`
- `04-s07-mapped-junior-g4.png`
- `05-s07-custom-unmapped.png`
- `07-a02-readonly.png`

学生 step-up 入口已在页面断言；本轮不再截该屏，避免验证码输入入图。2026-09-17 14:10 复跑 `pnpm --filter @studysteps/web test:e2e` 仍为 **4 passed / 0 skipped**（17.3s，退出码 0），截图已写回上述忽略目录。

## 是否可进入 STP 006 设计

**可以开始 STP 006 设计**（计划／任务实例／导入事务）。家庭侧目录查询、教育 PATCH 种类与 39 条模板浏览已在真实页面跑通；导入明确 409 留给 STP 006。

不得把本走查写成 STP 005 产品验收完成，也不得把 STP 004 标为整体完成。A02 目录展示失败与刷新不回填年级属体验／后台缺口，不阻塞 STP 006 设计，但实现导入前须处理「当前年级」在页面上的可信展示。

## 修复验证（2026-09-17 下午，保留上方失败记录）

未改 API 鉴权、Schema、六条迁移。HEAD 仍为 `9118468`。库仍为 `stp005_rev_fresh` @ 6260。

### 根因

1. A02：Admin Vite 无 `/v1` 代理，`fetch('/v1/grade-configs')` 打到 5174 失败（走查截图「目录读取失败」）。接口本身需要会话，未登录时也不应展示目录。
2. P05：刷新后 SPA 状态清空，未调用 `GET /v1/auth/session`／学生详情；年级下拉还会在空值时默认第一项。二次 SET 被拒不能证明页面回填。

### 修复后命令

| 命令 | 退出码 | 数量 |
| --- | --- | --- |
| eslint（web/admin 改动文件） | 0 | — |
| web／admin typecheck | 0 | — |
| web／admin unit test | 0 | 各 1 passed |
| web／admin build | 0 | — |
| `pnpm --filter @studysteps/web test:e2e` | **0** | **5 passed / 0 failed / 0 skipped**（19.1s） |

根 `pnpm lint`／`pnpm test`／`pnpm build`：**本轮未重跑**。Playwright `fixture@95`／`fixture@40` 内部提示仍出现，未当作失败。

### 路径复测

| 路径 | 走查结论 | 修复后 |
| --- | --- | --- |
| P05 刷新后无需重新登录 | 失败（回 S01） | **通过**（「已恢复家长会话」；无 phone-input） |
| P05 刷新后回填年级／学期 | 失败（用二次 SET 被拒代替） | **通过**（`option:checked` 为 `SIX_THREE · 一年级`，学期 `FULL_YEAR`，摘要含版本） |
| PROMOTE／TERM_SWITCH 后刷新 | 未按页面值验收 | **通过**（`FIRST_TERM` 后刷新仍 `FIRST_TERM`；升二年级后刷新仍二年级） |
| A02 登录上下文目录与版本 | **失败** | **通过**（25 条，含初四／`JUNIOR_G4`／版本 v1） |
| A02 未登录 | 未单列 | **通过**（登录提示，列表 0 条，无「已加载」） |
| A02 无发布／下架 | 通过 | **通过** |
| STP004／STP005 既有 E2E | 通过 | **通过**（未回归） |

新增截图：`03b-p05-after-reload.png`、`07-a02-readonly.png`（已覆盖为成功态）、`08-a02-unauthenticated.png`。

**两项页面阻塞已关闭。可以开始 STP 006 设计。不得标 STP 005 产品验收或 STP 004 完成。**
