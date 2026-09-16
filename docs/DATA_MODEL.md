# 数据模型（STP 004）

逻辑实体与约束以 `docs/STP004_DESIGN.md` 第 6 节为准。本文件记录本阶段落地口径。

## 实体

Account、AuthIdentity、AuthIdentityLookup、AuthChallenge、StudentProfile、GuardianLink、ConsentPolicy、ConsentDocumentVersion、ConsentRecord、DeviceSession、DevicePairing、IdempotencyRecord、RateLimitBucket。

不引入 `familyId`。UUID 不能代替授权。

## 归属与唯一

- 学习数据未来归属 `StudentProfile`；本阶段尚无学习表。
- 有效主监护：每个档案最多一个 `ACTIVE + PRIMARY_GUARDIAN`。
- 同一账号／档案最多一个有效关系。
- 同一档案／policy 最多一条未撤回未替代同意。
- session 主体字段互斥。
- 身份 lookup：`(provider, kind, lookupKeyVersion, subjectLookupDigest)` 唯一。

## 事务与锁

多实体写顺序：IdempotencyRecord → identity advisory／Identity／Lookup → Account → StudentProfile → ConsentPolicy → GuardianLink → ConsentRecord → DevicePairing → DeviceSession。

建档：profile + link + 必要 consent 同一事务。

## 时间与历史

`timestamptz` UTC。关系与同意历史不级联删除。已发布政策版本不可更新或删除。教育快照可空，STP 005 可加 `gradeConfigId` 并保留历史快照。

## 回滚

纯新增 migration。应用回滚保留新表。有数据后禁止 drop table 常规回滚，使用前滚修复。
