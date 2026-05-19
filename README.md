# CoreID

CoreID 是一个统一用户中心系统，当前版本先面向本地 Docker 验收，包含：

- 用户验证与购买状态查询
- 管理后台数据概览
- 安装包上传、列表、删除、公开下载
- 落地页上传、发布、预览和公开访问
- Casdoor OIDC 登录、回调、本地后台会话
- 基于 `admin.html` 风格的管理后台入口

## 本地启动

1. 复制环境变量文件：

```bash
cp .env.example .env
```

2. 启动 Docker 服务：

```bash
docker compose up --build
```

3. 打开本地页面：

- 管理后台：`http://localhost:3000/admin`
- 健康检查：`http://localhost:3000/health`
- VidGet 落地页：`http://localhost:3000/get/vidget`

## 本机运行模式

如果你本机已经有自己的 PostgreSQL，推荐用下面这套组合来避免端口和 OIDC 地址冲突：

- CoreID：宿主机 `npm start`
- Casdoor：Docker `http://localhost:8000`
- CoreID PostgreSQL：Docker `localhost:55432`

对应的 `DATABASE_URL` 示例：

```env
DATABASE_URL=postgresql://coreid:coreid@localhost:55432/coreid
```

## 说明

- 本地阶段默认 `ENFORCE_ADMIN_SECRET=false`，方便联调。
- 本地阶段默认 `ENFORCE_CASDOOR_AUTH=false`，所以后台会直接进入。
- 如果要启用后台接口鉴权，把 `.env` 中的 `ENFORCE_ADMIN_SECRET` 改为 `true`，然后通过 `x-admin-secret` 请求头传入 `ADMIN_SECRET`。
- 如果要启用 Casdoor 管理员登录，需要至少填写：
  - `CASDOOR_ENDPOINT`
  - `CASDOOR_INTERNAL_ENDPOINT`（可选，Docker 容器内访问宿主机 Casdoor 时使用）
  - `CASDOOR_CLIENT_ID`
  - `CASDOOR_CLIENT_SECRET`
  - `CASDOOR_REDIRECT_URI`
  - `AUTH_SESSION_SECRET`
  - `CASDOOR_ADMIN_USERS` 或 `CASDOOR_ADMIN_ROLES`
- 启用 Casdoor 后，把 `ENFORCE_CASDOOR_AUTH=true`，后台会先走 `/api/auth/login` 和 `/api/auth/callback`。
- 如果 CoreID 跑在 Docker、Casdoor 跑在宿主机，本地推荐这样配：
  - `CASDOOR_ENDPOINT=http://localhost:8000`
  - `CASDOOR_INTERNAL_ENDPOINT=http://host.docker.internal:8000`
- 这轮补充后，后台新增了：
  - 更严格的参数校验和上传限制
  - 登录/购买/上传基础限流
  - 管理员操作日志表和查询接口 `/api/admin/operation-logs`
  - 订单 CSV 导出接口 `/api/admin/purchases/export`
- `POST /api/auth/verify` 在开发态仍支持本地 bypass：当 `ALLOW_DEV_TOKEN_BYPASS=true` 且 Casdoor 未配置时，`token` 可以直接传用户 ID，或使用 `user:<user_id>`。
- 香港服务器部署前，建议先把 `.env` 中的 `secure` 相关条件换到 HTTPS 环境，并替换正式 Casdoor 配置。
