# 验收（STP 004 追踪）

T03–T09、T12–T15 及学习闭环仍以 `PROJECT_PLAN.md` 为准，本阶段不执行。T01、T02-B、T10、T11 核心子项及设计第 11 节 AUTH／PAIR／CON／IDEM／DB／TX／TIME 属于本阶段应执行项。

## T01 未满 14 岁开通

前置：隔离库、测试政策已发布、测试认证启用。  
步骤：未确认年龄建档；缺同意建档；确认当前测试政策建档。  
预期：前两者无残留；后者原子创建 profile／link／consent，学习访问仍阻塞。

## T02-B 年龄／年级分离

变更年级不改年龄；变更年龄不改教育字段。完整六三／五四映射延后 STP 005。

## T10 家庭隔离

Guardian 跨档案、Student 跨档案、伪造 body 归属、子资源越权：与不存在对象同形 404。

## T11 撤销

设备、关系、必要同意撤销后旧会话失败。T11-3 本阶段只验收档案受限与学生会话拒绝；学习写入接口不存在，不能标为通过。T11-D 真实通知 worker 延后。只能写「核心子项／部分通过」，不能写 T11 整体通过。

## 本文件新增（本阶段已有隔离库证据）

- 撤回不带 expectedStudentVersion（WD-1）。
- 撤回 C1 → 新授权 C2 → 重放 C1：C2 与新会话有效（WD-2）。
- 失败次数提交后可见；达上限后正确码无效（FAIL-1／FAIL-2）。
- 测试模式在 production／未知环境关闭（CFG-1）。
- 限频与 idle／absolute 超时边界（RATE-1、TIME-2）。TIME-2 **不**覆盖锁等待越期或授权事务内心跳。

## 本文件新增（2026-09-14 晚间复审）

- 五态删除路径（DEL）：列表剔除、同形 404、Student 401、失败不 heartbeat。
- 设备／关系／同意 × revoke-first／step-up-first 六组独立并发（LOCK-1 含 S0→G1 使新 Guardian cookie 401；link step-up-first 后 G1 有效但档案 404；consent step-up-first 后 G1 仅 RESTRICTED 最小路径）。不得笼统写“step-up 已覆盖”。
- 锁等待越过 challenge／pairing／idle／absolute 到期（TIME-3）。
- heartbeat 只在授权事务成功后 touch（HB-1）；authVersion／link／policy／session 失效 vs GET 竞态（HB-2）。
- lookup 复合 FK、签发不可变、替换链约束（DB-7）；首次 SIGN_IN 无 identity 回填。

## 本文件新增（2026-09-15）

- AuthChallenge 两条父键 CHECK；替换反环锁双方并验证锁后可见性；多跳链拒绝成环。
- advisory 锁后重查最新 challenge；同身份同设备并发发码 201+429，仅一个有效码。
- step-up 发码与 logout 绑定 CSRF；成功发码在授权事务内心跳；未登录 SIGN_IN 保持无 CSRF。
- 政策发布与失败锁定统一 `clock_timestamp()`；HB-2 四条仓库并发（authVersion／link／policy／session）。

执行状态见 `docs/handoffs/STP004_ACCEPTANCE_TRACE.md`。环境检查通过不能代替上表业务验收。不得写“第 1–8 项均修复”。STP 004 保持进行中。

## 本文件新增（2026-09-16 归档）

- 2026-09-15 四项修复与第四条迁移 `20260915160000` 在 fresh／two-mig **复核通过**。2026-09-16 只归档文档，未改代码、未重跑。
- 入仓库回归与 `.local` 临时探针分开：后者不替代 `stp004.*.spec.ts` 与 `e2e/stp004-ui.spec.ts`。
- 原库污染、T02-D／T11-D／学习写入既定延期、合同层 pointer 等非阻塞补强 **分册登记**，不混作本轮四项或第四条迁移失败。
- STP 004 仍进行中。

## 证据要求

没有隔离 PostgreSQL 或浏览器证据时，对应项写「未执行」，STP 004 保持进行中。T02-D、T11-D 仍为后续阶段。
