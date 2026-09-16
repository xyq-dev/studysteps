# STP 004 B01–B09 本地决定落实

依据：`docs/CURSOR_STP004_IMPLEMENT.md`（本轮授权来源）。  
范围：仅 STP 004 本地后端与最小 H5。不宣称全量 M0、STP 001、STP 002 完成。

| ID | 本地决定 | 落实位置 | 尚待条件 |
| --- | --- | --- | --- |
| B01 | 固定本阶段契约；STP 002 高保真仍待完成 | 六份专题文档 + 本文件 | 全量 M0 评审、高保真稿 |
| B02 | 本提示词授权本地代码、Schema、migration 与隔离库验证 | `CURRENT_STATUS.md`、本文件 | 无；不重复索要同一授权 |
| B03 | PHONE / PHONE_OTP、大陆号规范化、测试 delivery、5 分钟／5 次 | contracts、domain、配置、测试 adapter | 真实短信供应商、生产密钥托管 |
| B04 | 测试政策 TEST_CHILD_CORE_SERVICE / TEST_MINOR_CORE_SERVICE；test-v1 | 种子、policy resolver | 经营主体、正式文案、法律审阅 |
| B05 | 会话／配对／Origin／限频采用实施文件第 3 节本地默认值 | 配置校验与测试 | 生产来源与期限必须另行核验 |
| B06 | 18 岁及以上拒绝正式建档／转入，返回 AGE_BAND_NOT_SUPPORTED | API 与 S01/S02 文案 | 成年独立开通流程 |
| B07 | 无隔离 PostgreSQL 不阻止写代码，但不能宣称数据库验收或 STP 004 完成 | 实施报告 | 隔离库上的迁移、约束、并发 |
| B08 | 接受无 HEAD；前置清单与哈希 | `docs/handoffs/STP004_PRE_IMPLEMENTATION_SNAPSHOT.md` | 基线 commit 需另行授权 |
| B09 | 教育快照可空；不校验全国年级映射；年龄与教育互不推导 | Schema、contracts、独立 PATCH | STP 005 的 GradeConfig 与 T02 全量映射 |

## 开工 / 验收 / 上线

| 状态 | 结论 |
| --- | --- |
| 本地开工 | 上述决定写入文档后允许编码 |
| 验收 | B07 未解除前保持进行中；不把 STP 004 标为完成 |
| 上线 | 未就绪。正式政策、真实短信、生产 Origin／Cookie、经营主体均未具备 |

## 本阶段已统一的冲突

撤回同意：请求使用 `consentId`、原因码和 `Idempotency-Key`，**不要求** `expectedStudentVersion`。重放旧撤回不得撤销后来的新授权。失败次数必须先落库再返回认证失败。
