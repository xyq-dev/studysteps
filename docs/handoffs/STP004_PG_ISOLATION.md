# STP 004 隔离 PostgreSQL 证据（无凭证）

- 来源：PostgreSQL 官网 Windows 页 https://www.postgresql.org/download/windows/ 指向的 EDB binaries https://www.enterprisedb.com/download-postgresql-binaries
- 包：postgresql-16.15-1-windows-x64-binaries.zip
- 工作目录：项目忽略目录 `.local/stp004-pg`
- 数据目录：`.local/stp004-pg/data`
- 监听：仅 127.0.0.1，端口不写入本文件
- 认证：scram-sha-256；API 角色 `stp004_api` 为非超级用户
- 探测结果：`postgres|127.0.0.1/32|PORT|127.0.0.1`
- 角色：
```
stp004_admin|super=true|createdb=true
stp004_api|super=false|createdb=false
```
- 数据库：`stp004_identity|owner=stp004_api`
- 当前 public 表数量：14
- postmaster PID：16848
- 证据刷新走 SCRAM 与 5s/8s 超时，不再切换 trust/psql
- 未安装系统服务，未改共享实例，未输出密码
