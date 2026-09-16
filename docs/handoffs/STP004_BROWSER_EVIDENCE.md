# STP 004 真实浏览器证据（脱敏）

- 工具：项目开发依赖 `@playwright/test@1.55.1` + 本机 Chromium
- 页面操作：导航、填写、点击、界面断言；验证码由测试进程读取 `GET /__local/test-inbox` 后填入输入框，不绕过校验
- 独立浏览器上下文：家长设备 / 学生设备
- 未使用 `page.evaluate(fetch)`、纯 HTTP 脚本或直接改库代替页面验收
- 原始 trace／含 Cookie 的失败附件只在忽略目录 `.local/stp004-e2e/`
- 本轮（审查 1–8 修复后）再次执行 Chromium：先因隔离库已有档案从登录进入 P05 而非空 S02 失败；随后 P05 增加“创建档案”入口并复测，退出码 0。号码本身不写入本文件。

## 本轮命令

`pnpm --filter @studysteps/web test:e2e`

退出码：0（1 passed）

## 页面路径与界面断言

| 步骤 | 界面断言（不含验证码／短码／Cookie） |
| --- | --- |
| 登录 | S02 标题可见；状态“已进入家长会话”之前先完成验证码填写 |
| 建档及同意 | 勾选测试政策后创建；P05 可见；状态含“档案已创建” |
| 学生模式 | 学生视图标题可见 |
| 二次验证回家长 | 状态含“已重新验证并回到家长会话”；回到 P05 |
| 第二上下文配对 | 学生上下文进入学生视图；状态含“已通过配对进入学生模式” |
| 撤销设备 | 家长上下文状态含“已撤销目标学生会话” |
| 被撤销设备 | 学生上下文“刷新会话”后状态含“未登录” |
| 撤回同意 | 状态含“撤回已处理”与 `RESTRICTED` |

## 截图（忽略目录，对外不附短码页细节）

`.local/stp004-e2e/screenshots/`

- `01-s02-after-login.png`
- `02-p05-after-create.png`
- `03-student-mode.png`
- `04-back-to-guardian.png`
- `05-pairing-issued.png`（含一次性配对明文，仅本地）
- `06-second-device-student.png`
- `07-device-revoked.png`
- `08-revoked-device-denied.png`
- `09-consent-withdrawn.png`

HTML 报告：`.local/stp004-e2e/playwright-report/`（忽略，可能含会话痕迹）
