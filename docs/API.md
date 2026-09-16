# API（STP 004 `/v1`）

错误体：`{ code, message, requestId, fields? }`。端点以 `STP004_DESIGN.md` 9.2 为准，并采用下列已统一修正。

## 会话

- Cookie：开发 `stp_session` / `stp_csrf`；生产必须 `__Host-` + Secure。客户端不能用参数切换。
- 写请求要求允许 Origin 与绑定当前会话的 CSRF。
- 允许开发 Origin：`http://localhost:5173`、`http://127.0.0.1:5173`。不把 Admin :5174 加入家长认证来源。

## 端点

| 方法 | 路径 | 要点 |
| --- | --- | --- |
| POST | `/v1/auth/code` | SIGN_IN 或 GUARDIAN_STEP_UP |
| POST | `/v1/auth/session` | VERIFICATION_CODE / GUARDIAN_STEP_UP / STUDENT_MODE / PAIRING_CODE |
| GET | `/v1/auth/session` | 安全视图 |
| DELETE | `/v1/auth/session` | 幂等登出 |
| GET | `/v1/consent-documents` | 按 ageBand 返回当前测试政策 |
| GET/POST | `/v1/students` | 列表；建档需 step-up 与 Idempotency-Key |
| GET/PATCH | `/v1/students/:studentId` | 年龄与教育独立判别联合 |
| GET/POST | `/v1/students/:studentId/consents` | 历史；授予需 expectedStudentVersion |
| POST | `/v1/students/:studentId/consents/:consentId/withdraw` | **不要** expectedStudentVersion |
| POST | `/v1/students/:studentId/pairings` | 首次返回明文 code；重放 NOT_REPLAYABLE |
| POST | `/v1/students/:studentId/pairings/:pairingId/revoke` | 幂等 |
| GET | `/v1/students/:studentId/device-sessions` | 无 credential |
| POST | `/v1/students/:studentId/device-sessions/:sessionId/revoke` | 幂等 |

`GET /health` 仍在 `/v1` 之外。

## 错误码

沿用设计 9.4，另用于本阶段：`AGE_BAND_NOT_SUPPORTED`、`RATE_LIMITED`、`AUTH_GRANT_INVALID`、`PAIRING_INVALID`、`RESOURCE_NOT_FOUND` 同形。

## 幂等与版本

写档案／同意授予／配对／设备撤销需要 Idempotency-Key。撤回同意需要 Idempotency-Key，不需要学生 version。
