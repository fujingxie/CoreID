function buildBaseUrl() {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

function resolveSdkPlatform(application) {
  return application?.type === "web" ? "web" : "android";
}

function buildAndroidSdkMarkdown(application) {
  const appId = application.id;
  const appName = application.name;
  const baseUrl = buildBaseUrl();

  return `# ${appName} Android 接入文档

本文档面向 **${appName}** 的 Android 应用接入 CoreID 统一身份能力。

当前应用信息：
- App ID：\`${appId}\`
- 应用类型：\`${application.type}\`
- 运行状态：\`${application.status}\`

当前版本适用范围：
- 手机号注册
- 开发环境假验证码 / 真实短信验证码
- 密码登录
- 应用级注册资格校验
- 套餐列表、预校验、购买、订单查询与当前权益查询
- 验证码重置密码 / 用户自助改密码
- 兑换码预校验与核销

## CoreID 是什么

CoreID 不是一个 Android UI 组件，而是统一身份与权益中心。它负责：

- 用户注册与登录接口
- 应用级注册资格
- 套餐、订单、当前权益查询
- 兑换码核销
- 后台查看用户、应用、订单、设备和日志

一句话理解：

- Casdoor 管“这个人是谁”
- CoreID 管“这个人能进哪个应用、买了什么套餐、当前有什么权益”

## SDK 的作用

这里的“SDK 文档”不是某个必须依赖的 Android AAR，而是一份正式接入契约，回答的是：

- Android 应该调用哪些接口
- 每个接口需要什么参数
- 登录态和设备标识怎么处理
- 套餐购买、订单查询、兑换码核销怎么接
- 测试环境和生产环境分别怎么联调

## 推荐接入模式

推荐采用：

\`\`\`text
Android App -> 你的服务端 -> CoreID
                    ↓
            下发你自己的业务会话
\`\`\`

开发环境为了快速联调，也可以先由 Android 直接请求 CoreID。

## 1. 基础说明

- CoreID Base URL：\`${baseUrl}\`
- Content-Type：\`application/json\`
- 登录成功后会返回 CoreID 会话 \`token\`
- Android 端应保存该 token，并在后续请求中通过 \`Authorization: Bearer <token>\` 传递
- 当前 identity token 默认有效期为 12 小时
- 当前没有 refresh token 机制，更推荐把它当作登录阶段和短期身份会话使用

统一错误响应格式：

\`\`\`json
{
  "error": "Application does not exist"
}
\`\`\`

## 2. 核心规则

- 底层统一身份由 Casdoor 管理
- 应用注册资格由 CoreID 管理
- 用户在 **${appName}** 注册成功后，只会获得 **${appName}** 的登录资格
- 若要登录其他应用，必须针对对应 \`app_id\` 再完成注册
- 当前注册主凭证只支持手机号
- 验证码链路支持 \`dev\` 与 \`sms\` 两种模式
- 同一应用下仅允许 1 台有效设备，新设备登录会自动顶掉旧设备

## 3. 接入顺序

1. 调用 \`GET /api/identity/applications\` 获取可接入应用列表，确认目标 \`app_id=${appId}\`
2. 调用 \`POST /api/identity/send-code\` 发送手机号验证码（注册默认 \`purpose=register\`）
3. 调用 \`POST /api/identity/register\` 注册统一账号并开通 **${appName}** 资格
4. 调用 \`POST /api/identity/login/password\` 并携带稳定的 \`device_id\` 与 \`device_name\`，完成密码登录并获取 CoreID token
5. 调用 \`GET /api/identity/me?app_id=${appId}\` 获取当前用户
6. 调用 \`POST /api/identity/access-check\` 校验当前用户是否具备 **${appName}** 的资格
7. 调用 \`GET /api/purchase/plans?app_id=${appId}\` 获取可售套餐
8. 调用 \`POST /api/purchase/preview\` 判断当前是新购还是续费
9. 调用 \`POST /api/purchase/create\` 创建购买记录
10. 调用 \`GET /api/purchase/orders/:order_no\` 查询订单状态
11. 如需模拟支付确认或接入后续支付回调，调用 \`POST /api/purchase/confirm\`
12. 调用 \`GET /api/purchase/current-plan?user_id=<user_id>&app_id=${appId}\` 读取当前权益
13. 如需修改密码，调用 \`POST /api/identity/change-password\`
14. 如需忘记密码，先调用 \`POST /api/identity/send-code\` 并传 \`purpose=reset_password\`，再调用 \`POST /api/identity/reset-password\`
15. 退出登录时清理本地 token，必要时调用 \`POST /api/identity/logout\`

## 3.1 AI Agent 如何快速理解并接入

如果接入方不是传统 Android 页面，而是 Android 端的 AI 助手、Agent 或工具层，建议先让它建立下面的固定认知：

- 我属于哪个应用：\`app_id\`
- 当前用户是谁：\`token / user_id\`
- 当前用户能不能进入当前应用：\`POST /api/identity/access-check\`
- 当前用户有没有可用权益：\`GET /api/purchase/current-plan\`
- 当前用户能不能发起购买：\`POST /api/purchase/preview\`
- 当前用户是否可以核销兑换码：\`POST /api/redeem/preview\`

## 4. 接口总览

| Method | Path | 用途 |
| --- | --- | --- |
| GET | \`/api/identity/applications\` | 获取当前可接入应用列表 |
| POST | \`/api/identity/send-code\` | 发送手机号验证码 |
| POST | \`/api/identity/register\` | 注册统一账号并开通当前应用资格 |
| POST | \`/api/identity/login/password\` | 密码登录并获取 CoreID token |
| GET | \`/api/identity/me?app_id=${appId}\` | 读取当前登录用户与当前应用资格 |
| POST | \`/api/identity/access-check\` | 检查当前用户是否有目标应用资格 |
| GET | \`/api/purchase/plans?app_id=${appId}\` | 获取当前应用可售套餐列表 |
| POST | \`/api/purchase/preview\` | 预校验套餐购买，判断 new / renew |
| POST | \`/api/purchase/create\` | 创建购买记录 |
| GET | \`/api/purchase/orders/:order_no\` | 查询订单状态与订单详情 |
| POST | \`/api/purchase/confirm\` | 支付确认预留接口 |
| GET | \`/api/purchase/current-plan?user_id=<user_id>&app_id=${appId}\` | 读取当前套餐权益 |
| POST | \`/api/identity/change-password\` | 用户自助修改密码 |
| POST | \`/api/identity/reset-password\` | 通过验证码重置密码 |
| POST | \`/api/identity/logout\` | 清理 Web Cookie；Android 可选调用 |

## 5. 获取应用列表

\`GET /api/identity/applications\`

成功响应：

\`\`\`json
{
  "items": [
    {
      "id": "${appId}",
      "name": "${appName}",
      "type": "${application.type}",
      "status": "${application.status}"
    }
  ]
}
\`\`\`

## 6. 发送验证码

\`POST /api/identity/send-code\`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`app_id\` | string | 是 | 目标应用 ID，固定传 \`${appId}\` |
| \`phone\` | string | 是 | 手机号 |
| \`purpose\` | string | 否 | 默认 \`register\`；重置密码时传 \`reset_password\` |

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "phone": "13900001001"
}
\`\`\`

成功响应：

\`\`\`json
{
  "success": true,
  "mode": "dev",
  "app_id": "${appId}",
  "phone": "13900001001",
  "purpose": "register",
  "expires_at": "2026-05-14T12:34:56.000Z",
  "cooldown_seconds": 60,
  "debug_code": "123456"
}
\`\`\`

## 7. 注册

\`POST /api/identity/register\`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`app_id\` | string | 是 | 目标应用 ID，固定传 \`${appId}\` |
| \`phone\` | string | 是 | 手机号 |
| \`code\` | string | 是 | 开发模式可直接使用 \`debug_code\`；短信模式填写手机收到的验证码 |
| \`password\` | string | 是 | 登录密码，当前最短 6 位 |
| \`display_name\` | string | 否 | 展示名称；不传时默认使用手机号 |

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "phone": "13900001001",
  "code": "123456",
  "password": "12345678",
  "display_name": "${appName} 测试用户"
}
\`\`\`

成功响应：

\`\`\`json
{
  "success": true,
  "account_existed": false,
  "user": {
    "id": "built-in/u13900001001",
    "username": "u13900001001",
    "phone": "13900001001",
    "email": "u13900001001@dev.coreid.local"
  },
  "membership": {
    "app_id": "${appId}",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": null
  },
  "next_action": "login"
}
\`\`\`

## 8. 密码登录

\`POST /api/identity/login/password\`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`app_id\` | string | 是 | 目标应用 ID，固定传 \`${appId}\` |
| \`phone\` | string | 是 | 手机号 |
| \`password\` | string | 是 | 登录密码 |
| \`device_id\` | string | 是 | 设备唯一标识，必须稳定复用 |
| \`device_name\` | string | 是 | 设备名称，例如 \`Xiaomi 15 Pro\` |

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "phone": "13900001001",
  "password": "12345678",
  "device_id": "android-8f2a7c1b",
  "device_name": "Xiaomi 15 Pro"
}
\`\`\`

成功响应：

\`\`\`json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "built-in/u13900001001",
    "username": "u13900001001",
    "phone": "13900001001",
    "email": "u13900001001@dev.coreid.local",
    "app_ids": ["${appId}"]
  },
  "membership": {
    "app_id": "${appId}",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": "2026-05-14T12:36:10.000Z"
  },
  "device": {
    "app_id": "${appId}",
    "device_id": "android-8f2a7c1b",
    "device_name": "Xiaomi 15 Pro",
    "is_active": true,
    "last_login": "2026-05-14T12:36:10.000Z",
    "replaced_previous_device": false
  },
  "casdoor_access_token": "eyJhbGciOiJSUzI1NiIs..."
}
\`\`\`

Android 端建议：

- 使用设备持久标识生成稳定的 \`device_id\`
- \`device_id\` 不应每次启动都重新随机生成
- 若旧设备 token 被新设备顶掉，\`/api/identity/me\` 会返回 \`authenticated: false\`

## 9. 当前用户与资格校验

\`GET /api/identity/me?app_id=${appId}\`

成功响应：

\`\`\`json
{
  "authenticated": true,
  "user": {
    "id": "built-in/u13900001001",
    "username": "u13900001001",
    "phone": "13900001001",
    "email": "u13900001001@dev.coreid.local",
    "app_ids": ["${appId}"]
  },
  "memberships": [
    {
      "app_id": "${appId}",
      "status": "active",
      "register_source": "self_service_phone",
      "created_at": "2026-05-14T12:35:40.000Z",
      "last_login_at": "2026-05-14T12:36:10.000Z"
    }
  ],
  "current_membership": {
    "app_id": "${appId}",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": "2026-05-14T12:36:10.000Z"
  },
  "session": {
    "app_id": "${appId}",
    "device_id": "android-8f2a7c1b"
  }
}
\`\`\`

\`POST /api/identity/access-check\`

请求示例：

\`\`\`json
{
  "app_id": "${appId}"
}
\`\`\`

成功响应：

\`\`\`json
{
  "valid": true,
  "app_id": "${appId}",
  "user_id": "built-in/u13900001001",
  "session": {
    "app_id": "${appId}",
    "device_id": "android-8f2a7c1b",
    "device_valid": true
  },
  "membership": {
    "app_id": "${appId}",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": "2026-05-14T12:36:10.000Z"
  }
}
\`\`\`

## 10. Android Kotlin / OkHttp 示例

### 10.1 密码登录

\`\`\`kotlin
val client = OkHttpClient()
val loginJson = """
{
  "app_id": "${appId}",
  "phone": "13900001001",
  "password": "12345678",
  "device_id": "android-8f2a7c1b",
  "device_name": "Xiaomi 15 Pro"
}
""".trimIndent()

val request = Request.Builder()
  .url("${baseUrl}/api/identity/login/password")
  .post(loginJson.toRequestBody("application/json; charset=utf-8".toMediaType()))
  .build()

client.newCall(request).execute().use { response ->
  val body = response.body?.string().orEmpty()
  if (!response.isSuccessful) throw IllegalStateException(body)
  println(body) // 反序列化为 LoginResponse
}
\`\`\`

### 10.2 携带 Bearer Token

\`\`\`kotlin
val token = "登录接口返回的 token"

val request = Request.Builder()
  .url("${baseUrl}/api/identity/me?app_id=${appId}")
  .header("Authorization", "Bearer $token")
  .get()
  .build()
\`\`\`

## 11. 套餐购买相关接口

### 11.1 获取套餐列表

\`GET /api/purchase/plans?app_id=${appId}\`

成功响应示例：

\`\`\`json
{
  "items": [
    {
      "code": "monthly",
      "name": "${appName} 月度会员",
      "price": 18,
      "original_price": 28,
      "currency": "CNY",
      "duration_days": 30,
      "status": "active",
      "is_trial": false,
      "is_renewable": true,
      "features": ["单设备使用", "购买后立即生效"],
      "ui_hints": {
        "trial_limit_message": null
      }
    }
  ]
}
\`\`\`

### 11.2 购买预校验

\`POST /api/purchase/preview\`

请求示例：

\`\`\`json
{
  "user_id": "built-in/u13900001001",
  "app_id": "${appId}",
  "plan": "monthly"
}
\`\`\`

成功响应示例：

\`\`\`json
{
  "allowed": true,
  "purchase_mode": "new",
  "plan": {
    "code": "monthly",
    "name": "${appName} 月度会员",
    "price": 18,
    "duration_days": 30,
    "is_trial": false,
    "is_renewable": true
  },
  "reason_code": null,
  "message": null,
  "ui_hints": {
    "is_trial": false,
    "trial_limit_message": null
  }
}
\`\`\`

当试用套餐已领取时：

\`\`\`json
{
  "allowed": false,
  "reason_code": "TRIAL_ALREADY_USED",
  "message": "该试用套餐每个用户仅可领取一次",
  "ui_hints": {
    "is_trial": true,
    "trial_limit_message": "该试用套餐每个用户仅可领取一次"
  }
}
\`\`\`

### 11.3 创建购买记录

\`POST /api/purchase/create\`

请求示例：

\`\`\`json
{
  "user_id": "built-in/u13900001001",
  "app_id": "${appId}",
  "plan": "monthly",
  "order_no": "ORDER-20260516-2001"
}
\`\`\`

成功响应示例：

\`\`\`json
{
  "order": {
    "order_no": "ORDER-20260516-2001",
    "status": "pending",
    "purchase_mode": "new"
  }
}
\`\`\`

### 11.4 查询订单

\`GET /api/purchase/orders/:order_no\`

成功响应示例：

\`\`\`json
{
  "purchase": {
    "order_no": "ORDER-20260516-2001",
    "status": "paid",
    "purchase_mode": "new",
    "external_order_no": "WX-20260516-2001",
    "confirmed_at": "2026-05-16T10:08:00.000Z"
  },
  "events": [
    {
      "event_type": "payment_confirmed",
      "event_source": "manual_confirm",
      "from_status": "pending",
      "to_status": "paid"
    },
    {
      "event_type": "order_created",
      "event_source": "purchase_api",
      "from_status": null,
      "to_status": "pending"
    }
  ]
}
\`\`\`

### 11.5 支付确认预留接口

\`POST /api/purchase/confirm\`

当前可用于本地联调支付成功回写，后续可接真实支付网关。

请求示例：

\`\`\`json
{
  "order_no": "ORDER-20260516-2001",
  "status": "paid",
  "external_order_no": "WX-20260516-2001",
  "payment_payload": {
    "channel": "wechat",
    "trade_state": "SUCCESS"
  }
}
\`\`\`

如开启生产回调签名校验，请在请求头传：

\`\`\`
X-CoreID-Signature: sha256=<hmac_sha256_hex>
\`\`\`

签名规则：

- 使用 \`PAYMENT_CALLBACK_SECRET\` 作为密钥
- 对原始请求体执行 \`HMAC-SHA256\`
- 十六进制小写输出

### 11.6 读取当前权益

\`GET /api/purchase/current-plan?user_id=<user_id>&app_id=${appId}\`

成功响应示例：

\`\`\`json
{
  "app_id": "${appId}",
  "user_id": "built-in/u13900001001",
  "active": true,
  "plan": "monthly",
  "plan_name": "${appName} 月度会员",
  "status": "paid",
  "expires_at": "2026-06-15T10:08:00.000Z",
  "is_trial": false,
  "is_renewable": true
}
\`\`\`

### 11.6.1 兑换码预校验

\`POST /api/redeem/preview\`

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "code": "ABCD-EFGH-IJKL-MNOP"
}
\`\`\`

说明：

- 用户输入兑换码后，建议先调用 \`preview\`
- 只有预校验通过后，再调用正式核销接口

### 11.6.2 兑换码核销

\`POST /api/redeem/claim\`

请求头：

\`\`\`http
Authorization: Bearer <token>
\`\`\`

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "code": "ABCD-EFGH-IJKL-MNOP"
}
\`\`\`

说明：

- 核销成功后会生成一条标准购买记录
- 应和正常购买一样刷新 \`current-plan\`

### 11.6.1 兑换码预校验

\`POST /api/redeem/preview\`

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "code": "ABCD-EFGH-IJKL-MNOP"
}
\`\`\`

建议：

- 用户输入兑换码后先调 \`preview\`
- 不要直接调用 \`claim\`
- 预校验通过后，再进入正式核销

### 11.6.2 兑换码核销

\`POST /api/redeem/claim\`

请求头：

\`\`\`http
Authorization: Bearer <token>
\`\`\`

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "code": "ABCD-EFGH-IJKL-MNOP"
}
\`\`\`

说明：

- 核销成功后会生成一条标准购买记录
- 兑换码不是独立权益系统，而是一种购买来源
- 核销成功后应重新刷新 \`current-plan\`

### 11.7 修改密码

\`POST /api/identity/change-password\`

请求头：

\`\`\`http
Authorization: Bearer <token>
\`\`\`

请求示例：

\`\`\`json
{
  "current_password": "12345678",
  "new_password": "87654321"
}
\`\`\`

## 13.1 验证码重置密码

\`POST /api/identity/reset-password\`

\`\`\`json
{
  "app_id": "${appId}",
  "phone": "13900001001",
  "code": "123456",
  "new_password": "87654321"
}
\`\`\`

说明：
- 必须先调用 \`POST /api/identity/send-code\` 并传 \`purpose=reset_password\`
- 仅对已注册目标应用的手机号生效

成功响应：

\`\`\`json
{
  "success": true,
  "message": "Password updated successfully"
}
\`\`\`

说明：

- 必须带当前有效登录态
- 必须提供旧密码
- 新密码不能与旧密码相同

## 13.2 测试环境怎么调试

建议按这个顺序联调：

1. 确认后台已创建应用并拿到正确的 \`app_id\`
2. 先走 \`send-code -> register -> login/password\`
3. 再走 \`me -> access-check\`
4. 最后接 \`plans -> preview -> create -> orders -> current-plan\`
5. 如需兑换码，再接 \`redeem/preview -> redeem/claim\`

本地联调常用地址：

- CoreID Base URL：\`${baseUrl}\`
- 后台地址：\`${baseUrl}/admin\`
- 注册测试页：\`${baseUrl}/auth/register-test\`
- 登录测试页：\`${baseUrl}/auth/login-test\`

## 13.3 正式环境部署建议

- CoreID 使用正式 HTTPS 域名，例如 \`https://coreid.example.com\`
- Casdoor 使用正式 HTTPS 域名，例如 \`https://account.example.com\`
- Android 不长期依赖 CoreID token 作为唯一业务会话
- 注册和重置密码使用真实短信验证码
- 购买确认启用支付回调签名校验
- 所有关键接口打开限流、日志和异常监控

## 12. 接入方常见疑问（FAQ）

### 12.1 CoreID token 需要长期持有吗？

不建议。当前 token 更适合用作登录阶段或短期身份校验令牌。接入方通常应：

- 登录时调用 CoreID
- 同步本地用户和资格
- 自己签发本地 Session / JWT

### 12.2 接入方是否还需要保留本地用户表？

多数情况下需要。推荐分工：

- CoreID：统一身份、应用资格、套餐、订单、权益
- 应用本地：昵称、头像、学校、业务角色、业务数据、额度等

### 12.3 \`current-plan\` 是否需要 token？

当前版本的 \`GET /api/purchase/current-plan\` 主要面向服务端同步场景，不要求 Bearer token，只需要：

- \`user_id\`
- \`app_id\`

但建议只在服务端调用，不要直接暴露给前端浏览器。

### 12.4 套餐价格和业务权益分别由谁负责？

推荐分工：

- CoreID：套餐价格、有效期、订单、续费状态
- 接入方：根据 \`plan code\` 映射业务额度或特殊权益

### 12.5 单设备登录被顶掉后应该怎么处理？

如果旧设备 / 旧安装实例被新设备顶掉：

- \`GET /api/identity/me\` 会返回 \`authenticated: false\`
- 接入方应清理本地登录态
- 跳回登录页并提示用户重新登录

### 12.6 生产环境应该怎么配置 CoreID 地址？

接入方后端应通过环境变量保存 CoreID 地址，例如：

\`\`\`env
COREID_BASE_URL=https://coreid.example.com
\`\`\`

- 正式环境建议使用独立 HTTPS 域名
- 不建议把生产地址写死在前端

## 13. 接入自检清单

- 能拿到正确的 \`app_id\`
- 注册成功后，用户只拥有当前应用资格
- 同一用户不能直接登录未注册应用
- 登录请求始终带稳定的 \`device_id\`
- 新设备登录后，旧设备能被正确顶下线
- \`preview\` 能正确区分 \`new / renew / trial already used\`
- \`current-plan\` 能返回正确的当前权益
- 兑换码核销后能生成购买记录并刷新权益
- 改密码后，旧密码失效、新密码可登录
- 生产环境短信和支付签名已经切到正式配置

## 13. 常见错误与处理建议

| HTTP | 场景 | 返回示例 |
| --- | --- | --- |
| 400 | 参数缺失或 JSON 非法 | \`{"error":"Request body must be valid JSON"}\` |
| 401 | 密码错误 / token 无效 | \`{"error":"Phone number or password is incorrect"}\` |
| 403 | 应用停用 / 账号停用 / 未注册目标应用 | \`{"error":"This account has not been registered in the target app"}\` |
| 404 | 应用不存在 / 手机号未注册 | \`{"error":"Application does not exist"}\` |
| 409 | 重复注册 / 试用已领取 / 非法状态流转 | \`{"error":"This phone number is already registered in the target app"}\` |
| 429 | 触发限流 | \`{"error":"Verification code requests are too frequent, please slow down"}\` |

Android 建议：

- 401：清理本地 token，重新登录
- 403：提示“当前账号未开通此应用”或“账号已停用”
- 409：直接展示服务端提示文案
- 429：引导稍后重试
`;
}

function buildWebSdkMarkdown(application) {
  const appId = application.id;
  const appName = application.name;
  const baseUrl = buildBaseUrl();

  return `# ${appName} Web 接入文档

本文档面向 **${appName}** 的 Web 应用接入 CoreID 统一身份与套餐能力。

当前应用信息：
- App ID：\`${appId}\`
- 应用类型：\`${application.type}\`
- 运行状态：\`${application.status}\`

## 1. 基础说明

- CoreID Base URL：\`${baseUrl}\`
- Content-Type：\`application/json\`
- 登录成功后会返回 CoreID 会话 \`token\`
- 推荐由你的 Web 服务端代理调用 CoreID，并把 token 存进你自己的 HttpOnly Session Cookie
- 开发环境若直接在浏览器联调，也可以先用 \`Authorization: Bearer <token>\` 访问受保护接口

统一错误响应格式：

\`\`\`json
{
  "error": "Application does not exist"
}
\`\`\`

## 2. 核心规则

- 底层统一身份由 Casdoor 管理
- 应用注册资格由 CoreID 管理
- 用户在 **${appName}** 注册成功后，只会获得 **${appName}** 的登录资格
- 若要登录其他应用，必须针对对应 \`app_id\` 再完成注册
- 当前注册主凭证只支持手机号
- 验证码链路支持 \`dev\` 与 \`sms\` 两种模式
- 同一应用下仅允许 1 个有效 Web 设备上下文，新浏览器登录会自动顶掉旧浏览器

## 3. 什么是 CoreID

CoreID 不是一个前端 UI 组件，而是你应用外部的统一身份与权益中心。它主要负责：

- 用户注册与登录的统一接口
- 应用级注册资格控制
- 套餐、订单、当前权益查询
- 后台查看用户、应用、订单、设备和操作日志

你可以把它理解成：

- Casdoor 负责“这个人是谁”
- CoreID 负责“这个人能进哪个应用、买了什么套餐、当前有什么权益”

## 4. SDK 的作用

这里的“SDK 文档”本质上不是指一个现成的 npm 包，而是指：

- 你在 Web 应用里接入 CoreID 所需的接口契约
- 参数、返回结构、错误码、调用顺序
- 一套推荐的接入模式和代码示例

也就是说，这份文档的作用是帮助接入方快速完成：

- 注册
- 登录
- 会话保持
- 应用资格校验
- 套餐展示与购买

## 5. Web 接入建议

推荐使用 **服务端代理模式**：

1. 浏览器请求你的 Web 服务端
2. 你的服务端调用 CoreID 注册 / 登录 / 购买接口
3. 你的服务端持有 CoreID token，并下发自己的站点 Session
4. 浏览器后续只带自己站点 Cookie，不直接暴露 CoreID token

开发环境若为了加快联调，也可以临时用浏览器直接调用 CoreID：

- 把登录返回的 \`token\` 保存在内存或短期 \`sessionStorage\`
- 不建议长期放在 \`localStorage\`
- 页面刷新或退出登录时及时清理

## 6. AI Agent 接入建议

如果你的接入方不是传统 Web 页面，而是 AI Agent、Browser Agent 或工具型应用，建议按下面的思路接：

1. 先固定目标 \`app_id\`
2. Agent 在调用任何业务能力前，先调用 \`POST /api/identity/access-check\`
3. 若返回无资格，不要继续执行业务动作，应提示“当前账号未开通该应用”
4. 涉及付费能力时，先调用 \`GET /api/purchase/current-plan\` 或 \`POST /api/purchase/preview\`
5. 若 Agent 需要替用户发起购买，必须走：
   - \`preview\`
   - \`create\`
   - \`orders\`
   - \`confirm\`
   的顺序

给 Agent 的最小心智模型可以是：

- “我是哪个应用” -> \`app_id\`
- “这个用户是谁” -> \`token / user_id\`
- “这个用户能不能用当前应用” -> \`access-check\`
- “这个用户有没有对应付费权益” -> \`current-plan\`

## 7. 接入顺序

1. 调用 \`GET /api/identity/applications\` 获取可接入应用列表，确认目标 \`app_id=${appId}\`
2. 调用 \`POST /api/identity/send-code\` 发送手机号验证码
3. 调用 \`POST /api/identity/register\` 注册统一账号并开通 **${appName}** 资格
4. 调用 \`POST /api/identity/login/password\`，并携带稳定的浏览器 \`device_id\` 与 \`device_name\`
5. 调用 \`GET /api/identity/me?app_id=${appId}\` 获取当前用户
6. 调用 \`POST /api/identity/access-check\` 校验当前用户是否具备 **${appName}** 的资格
7. 调用 \`GET /api/purchase/plans?app_id=${appId}\` 获取可售套餐
8. 调用 \`POST /api/purchase/preview\` 判断当前是新购还是续费
9. 调用 \`POST /api/purchase/create\` 创建购买记录
10. 调用 \`GET /api/purchase/orders/:order_no\` 查询订单状态
11. 如需模拟支付确认或接入后续支付回调，调用 \`POST /api/purchase/confirm\`
12. 调用 \`GET /api/purchase/current-plan?user_id=<user_id>&app_id=${appId}\` 读取当前权益
13. 如需修改密码，调用 \`POST /api/identity/change-password\`
14. 退出登录时清理自己站点的 Session，并视需要调用 \`POST /api/identity/logout\`

## 8. 测试环境调试

本地或测试环境推荐这样联调：

- CoreID Base URL：\`${baseUrl}\`
- 若 \`send-code\` 返回 \`mode=dev\`，验证码会通过 \`debug_code\` 返回
- 若 \`send-code\` 返回 \`mode=sms\`，验证码会直接发送到手机
- 后台地址：\`${baseUrl}/admin\`
- 注册测试页：\`${baseUrl}/auth/register-test\`
- 登录测试页：\`${baseUrl}/auth/login-test\`

调试建议：

- 先确认应用是否已创建，并且拿到正确的 \`app_id\`
- 先注册，再登录，再做资格校验
- 如果是浏览器直接联调，优先用 \`sessionStorage\` 存 token
- 如果返回 401，优先检查 token 是否失效或是否被新浏览器顶掉
- 如果返回 403，优先检查该用户是否真的注册了当前应用

## 9. 正式环境部署建议

上线时建议至少做到：

- CoreID 使用正式 HTTPS 域名，例如 \`https://coreid.example.com\`
- Casdoor 使用独立 HTTPS 域名，例如 \`https://account.example.com\`
- Web 应用通过自己的服务端代理 CoreID，不直接把长期 token 暴露给浏览器
- 开启真实短信验证码，不再使用假验证码
- 为支付确认配置 \`PAYMENT_CALLBACK_SECRET\`
- 为回调与公开接口配置限流、日志与监控

生产环境至少要明确这些配置：

- \`BASE_URL\`
- \`DATABASE_URL\`
- \`CASDOOR_ENDPOINT\`
- \`CASDOOR_CLIENT_ID\`
- \`CASDOOR_CLIENT_SECRET\`
- \`CASDOOR_MASTER_PASSWORD\`
- \`AUTH_SESSION_SECRET\`
- \`PAYMENT_CALLBACK_ENABLED=true\`
- \`PAYMENT_CALLBACK_SECRET\`

## 10. 接口总览

| Method | Path | 用途 |
| --- | --- | --- |
| GET | \`/api/identity/applications\` | 获取当前可接入应用列表 |
| POST | \`/api/identity/send-code\` | 发送手机号验证码 |
| POST | \`/api/identity/register\` | 注册统一账号并开通当前应用资格 |
| POST | \`/api/identity/login/password\` | 密码登录并获取 CoreID token |
| GET | \`/api/identity/me?app_id=${appId}\` | 读取当前登录用户与当前应用资格 |
| POST | \`/api/identity/access-check\` | 检查当前用户是否有目标应用资格 |
| GET | \`/api/purchase/plans?app_id=${appId}\` | 获取当前应用可售套餐列表 |
| POST | \`/api/purchase/preview\` | 预校验套餐购买，判断 new / renew |
| POST | \`/api/purchase/create\` | 创建购买记录 |
| GET | \`/api/purchase/orders/:order_no\` | 查询订单状态与订单详情 |
| POST | \`/api/purchase/confirm\` | 支付确认预留接口 |
| GET | \`/api/purchase/current-plan?user_id=<user_id>&app_id=${appId}\` | 读取当前套餐权益 |
| POST | \`/api/identity/change-password\` | 用户自助修改密码 |
| POST | \`/api/identity/reset-password\` | 通过验证码重置密码 |
| POST | \`/api/identity/logout\` | 退出登录 |

## 11. 发送验证码

\`POST /api/identity/send-code\`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`app_id\` | string | 是 | 目标应用 ID，固定传 \`${appId}\` |
| \`phone\` | string | 是 | 手机号 |

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "phone": "13900001001"
}
\`\`\`

成功响应：

\`\`\`json
{
  "success": true,
  "mode": "dev",
  "app_id": "${appId}",
  "phone": "13900001001",
  "purpose": "register",
  "expires_at": "2026-05-14T12:34:56.000Z",
  "cooldown_seconds": 60,
  "debug_code": "123456"
}
\`\`\`

## 12. 注册

\`POST /api/identity/register\`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`app_id\` | string | 是 | 目标应用 ID，固定传 \`${appId}\` |
| \`phone\` | string | 是 | 手机号 |
| \`code\` | string | 是 | 开发模式可直接使用 \`debug_code\`；短信模式填写手机收到的验证码 |
| \`password\` | string | 是 | 登录密码，当前最短 6 位 |
| \`display_name\` | string | 否 | 展示名称；不传时默认使用手机号 |

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "phone": "13900001001",
  "code": "123456",
  "password": "12345678",
  "display_name": "${appName} Web 用户"
}
\`\`\`

成功响应：

\`\`\`json
{
  "success": true,
  "account_existed": false,
  "user": {
    "id": "built-in/u13900001001",
    "username": "u13900001001",
    "phone": "13900001001",
    "email": "u13900001001@dev.coreid.local"
  },
  "membership": {
    "app_id": "${appId}",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": null
  },
  "next_action": "login"
}
\`\`\`

## 13. 密码登录

\`POST /api/identity/login/password\`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| \`app_id\` | string | 是 | 目标应用 ID，固定传 \`${appId}\` |
| \`phone\` | string | 是 | 手机号 |
| \`password\` | string | 是 | 登录密码 |
| \`device_id\` | string | 是 | 浏览器设备唯一标识，必须稳定复用 |
| \`device_name\` | string | 是 | 设备名称，例如 \`Chrome on macOS\` |

请求示例：

\`\`\`json
{
  "app_id": "${appId}",
  "phone": "13900001001",
  "password": "12345678",
  "device_id": "web-chrome-8f2a7c1b",
  "device_name": "Chrome on macOS"
}
\`\`\`

成功响应：

\`\`\`json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "built-in/u13900001001",
    "username": "u13900001001",
    "phone": "13900001001",
    "email": "u13900001001@dev.coreid.local",
    "app_ids": ["${appId}"]
  },
  "membership": {
    "app_id": "${appId}",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": "2026-05-14T12:36:10.000Z"
  },
  "device": {
    "app_id": "${appId}",
    "device_id": "web-chrome-8f2a7c1b",
    "device_name": "Chrome on macOS",
    "is_active": true,
    "last_login": "2026-05-14T12:36:10.000Z",
    "replaced_previous_device": false
  }
}
\`\`\`

Web 端建议：

- 生成一个稳定的 \`device_id\` 并持久化，例如首次访问时写入自家站点 Cookie 或 localStorage
- \`device_id\` 不应每次刷新页面都重新生成
- 若旧浏览器会话被新浏览器顶掉，\`/api/identity/me\` 会返回 \`authenticated: false\`

## 14. 当前用户与资格校验

\`GET /api/identity/me?app_id=${appId}\`

成功响应：

\`\`\`json
{
  "authenticated": true,
  "user": {
    "id": "built-in/u13900001001",
    "username": "u13900001001",
    "phone": "13900001001",
    "email": "u13900001001@dev.coreid.local",
    "app_ids": ["${appId}"]
  },
  "current_membership": {
    "app_id": "${appId}",
    "status": "active"
  },
  "session": {
    "app_id": "${appId}",
    "device_id": "web-chrome-8f2a7c1b"
  }
}
\`\`\`

\`POST /api/identity/access-check\`

请求示例：

\`\`\`json
{
  "app_id": "${appId}"
}
\`\`\`

成功响应：

\`\`\`json
{
  "valid": true,
  "app_id": "${appId}",
  "user_id": "built-in/u13900001001",
  "session": {
    "app_id": "${appId}",
    "device_id": "web-chrome-8f2a7c1b",
    "device_valid": true
  },
  "membership": {
    "app_id": "${appId}",
    "status": "active"
  }
}
\`\`\`

## 15. Web JavaScript 示例

### 10.1 浏览器直接联调示例

\`\`\`js
const deviceIdKey = "coreid:${appId}:device-id";
let deviceId = localStorage.getItem(deviceIdKey);
if (!deviceId) {
  deviceId = "web-" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem(deviceIdKey, deviceId);
}

const loginResponse = await fetch("${baseUrl}/api/identity/login/password", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    app_id: "${appId}",
    phone: "13900001001",
    password: "12345678",
    device_id: deviceId,
    device_name: (navigator.userAgent.includes("Chrome") ? "Chrome" : "Browser") + " on " + navigator.platform
  })
});

const loginData = await loginResponse.json();
if (!loginResponse.ok) {
  throw new Error(loginData.error || "login failed");
}

sessionStorage.setItem("coreid_token", loginData.token);
\`\`\`

### 10.2 携带 Bearer Token 读取当前用户

\`\`\`js
const token = sessionStorage.getItem("coreid_token");

const meResponse = await fetch("${baseUrl}/api/identity/me?app_id=${appId}", {
  headers: {
    Authorization: "Bearer " + token
  }
});

const me = await meResponse.json();
\`\`\`

### 10.3 Node.js / 服务端代理示例

\`\`\`js
const response = await fetch("${baseUrl}/api/identity/login/password", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    app_id: "${appId}",
    phone: "13900001001",
    password: "12345678",
    device_id: "web-server-session-001",
    device_name: "Web session on server"
  })
});

const data = await response.json();
if (!response.ok) {
  throw new Error(data.error || "login failed");
}

// 把 data.token 存进你自己的 HttpOnly Session
\`\`\`

## 16. 套餐购买相关接口

### 11.1 获取套餐列表

\`GET /api/purchase/plans?app_id=${appId}\`

成功响应示例：

\`\`\`json
{
  "items": [
    {
      "code": "yearly",
      "name": "${appName} 年度会员",
      "price": 128,
      "original_price": 198,
      "currency": "CNY",
      "duration_days": 365,
      "status": "active",
      "is_trial": false,
      "is_renewable": true,
      "features": ["单浏览器会话", "购买后立即生效"],
      "ui_hints": {
        "trial_limit_message": null
      }
    }
  ]
}
\`\`\`

### 11.2 购买预校验

\`POST /api/purchase/preview\`

请求示例：

\`\`\`json
{
  "user_id": "built-in/u13900001001",
  "app_id": "${appId}",
  "plan": "yearly"
}
\`\`\`

成功响应示例：

\`\`\`json
{
  "allowed": true,
  "purchase_mode": "new",
  "plan": {
    "code": "yearly",
    "name": "${appName} 年度会员",
    "price": 128,
    "duration_days": 365,
    "is_trial": false,
    "is_renewable": true
  },
  "reason_code": null,
  "message": null
}
\`\`\`

试用套餐已领取时：

\`\`\`json
{
  "allowed": false,
  "reason_code": "TRIAL_ALREADY_USED",
  "message": "该试用套餐每个用户仅可领取一次",
  "ui_hints": {
    "is_trial": true,
    "trial_limit_message": "该试用套餐每个用户仅可领取一次"
  }
}
\`\`\`

### 11.3 创建购买记录

\`POST /api/purchase/create\`

请求示例：

\`\`\`json
{
  "user_id": "built-in/u13900001001",
  "app_id": "${appId}",
  "plan": "yearly",
  "order_no": "ORDER-20260516-3001"
}
\`\`\`

成功响应示例：

\`\`\`json
{
  "order": {
    "order_no": "ORDER-20260516-3001",
    "status": "pending",
    "purchase_mode": "new"
  }
}
\`\`\`

### 11.4 查询订单

\`GET /api/purchase/orders/:order_no\`

成功响应示例：

\`\`\`json
{
  "purchase": {
    "order_no": "ORDER-20260516-3001",
    "status": "paid",
    "purchase_mode": "new",
    "external_order_no": "WX-20260516-3001",
    "confirmed_at": "2026-05-16T10:08:00.000Z"
  },
  "events": [
    {
      "event_type": "payment_confirmed",
      "event_source": "manual_confirm",
      "from_status": "pending",
      "to_status": "paid"
    },
    {
      "event_type": "order_created",
      "event_source": "purchase_api",
      "from_status": null,
      "to_status": "pending"
    }
  ]
}
\`\`\`

### 11.5 支付确认预留接口

\`POST /api/purchase/confirm\`

当前可用于本地联调支付成功回写，后续可接真实支付网关。

请求示例：

\`\`\`json
{
  "order_no": "ORDER-20260516-3001",
  "status": "paid",
  "external_order_no": "WX-20260516-3001",
  "payment_payload": {
    "channel": "wechat",
    "trade_state": "SUCCESS"
  }
}
\`\`\`

如开启生产回调签名校验，请在请求头传：

\`\`\`
X-CoreID-Signature: sha256=<hmac_sha256_hex>
\`\`\`

签名规则：

- 使用 \`PAYMENT_CALLBACK_SECRET\` 作为密钥
- 对原始请求体执行 \`HMAC-SHA256\`
- 十六进制小写输出

### 11.6 读取当前权益

\`GET /api/purchase/current-plan?user_id=<user_id>&app_id=${appId}\`

成功响应示例：

\`\`\`json
{
  "app_id": "${appId}",
  "user_id": "built-in/u13900001001",
  "active": true,
  "plan": "yearly",
  "plan_name": "${appName} 年度会员",
  "status": "paid",
  "expires_at": "2027-05-16T10:08:00.000Z",
  "is_trial": false,
  "is_renewable": true
}
\`\`\`

### 11.7 修改密码

\`POST /api/identity/change-password\`

请求头：

\`\`\`http
Authorization: Bearer <token>
\`\`\`

请求示例：

\`\`\`json
{
  "current_password": "12345678",
  "new_password": "87654321"
}
\`\`\`

## 验证码重置密码

1. 调用 \`POST /api/identity/send-code\`
2. 请求体传 \`purpose=reset_password\`
3. 调用 \`POST /api/identity/reset-password\`

\`\`\`json
{
  "app_id": "${appId}",
  "phone": "13900001001",
  "code": "123456",
  "new_password": "87654321"
}
\`\`\`

成功响应：

\`\`\`json
{
  "success": true,
  "message": "Password updated successfully"
}
\`\`\`

说明：

- 必须带当前有效登录态
- 必须提供旧密码
- 新密码不能与旧密码相同

## 17. 接入方常见疑问（FAQ）

### 17.1 CoreID token 需要长期持有吗？

不建议。推荐模式是：

- 登录时调用 CoreID
- 同步本地用户、资格和权益
- 接入方自己签发本地 Session / JWT

### 17.2 接入方是否还需要保留本地用户表？

多数情况下需要。推荐分工：

- CoreID：统一身份、应用资格、套餐、订单、权益
- 应用本地：昵称、头像、业务角色、业务数据、额度等

### 17.3 \`current-plan\` 是否需要 token？

当前版本的 \`GET /api/purchase/current-plan\` 主要面向服务端同步场景，不要求 Bearer token，只需要：

- \`user_id\`
- \`app_id\`

但建议只在服务端调用，不要直接暴露给前端浏览器。

### 17.4 如果平台开放“验证码重置密码”，还需要额外配置什么？

需要。平台部署时应额外配置：

- \`CASDOOR_MASTER_PASSWORD\`

CoreID 会在验证码校验通过后，使用这个 Casdoor 组织级主密码代表用户完成改密。这是平台内部能力，不应下发给客户端或第三方接入前端。

### 17.5 套餐价格和业务权益分别由谁负责？

推荐分工：

- CoreID：套餐价格、有效期、订单、续费状态
- 接入方：根据 \`plan code\` 映射业务额度或特殊权益

### 17.6 单设备登录被顶掉后应该怎么处理？

如果旧浏览器被新浏览器顶掉：

- \`GET /api/identity/me\` 会返回 \`authenticated: false\`
- 接入方应清理本地登录态
- 跳回登录页并提示用户重新登录

### 17.7 生产环境应该怎么配置 CoreID 地址？

接入方后端应通过环境变量保存 CoreID 地址，例如：

\`\`\`env
COREID_BASE_URL=https://coreid.example.com
\`\`\`

建议：

- 正式环境使用独立 HTTPS 域名
- Web 前端不要写死生产地址

## 18. 接入自检清单

- 已在后台创建正确的 \`app_id\`
- Web 端注册 / 登录都走 CoreID
- 你的服务端能正确同步本地用户与 \`coreid_user_id\`
- \`access-check\` 能拦住未注册当前应用的用户
- \`plans / preview / create / orders / current-plan\` 已联调完成
- 试用套餐重复领取会被正确阻止
- 兑换码核销成功后，权益能立即更新
- 改密码和验证码重置密码都可用
- 生产环境已切到真实短信和支付签名

## 19. 常见错误与处理建议

| HTTP | 场景 | 返回示例 |
| --- | --- | --- |
| 400 | 参数缺失或 JSON 非法 | \`{"error":"Request body must be valid JSON"}\` |
| 401 | 密码错误 / token 无效 | \`{"error":"Phone number or password is incorrect"}\` |
| 403 | 应用停用 / 账号停用 / 未注册目标应用 | \`{"error":"This account has not been registered in the target app"}\` |
| 404 | 应用不存在 / 手机号未注册 | \`{"error":"Application does not exist"}\` |
| 409 | 重复注册 / 试用已领取 / 非法状态流转 | \`{"error":"This phone number is already registered in the target app"}\` |
| 429 | 触发限流 | \`{"error":"Verification code requests are too frequent, please slow down"}\` |

Web 建议：

- 401：清理 Session 或本地 token，跳回登录页
- 403：提示“当前账号未开通此应用”或“账号已停用”
- 409：直接展示服务端返回文案
- 429：显示冷却提示并限制重复点击
`;
}

function buildSdkMarkdown(application) {
  return resolveSdkPlatform(application) === "web"
    ? buildWebSdkMarkdown(application)
    : buildAndroidSdkMarkdown(application);
}

function buildSdkExportFileName(application) {
  return resolveSdkPlatform(application) === "web"
    ? `${application.id}-web-integration.md`
    : `${application.id}-android-integration.md`;
}

module.exports = {
  buildAndroidSdkMarkdown,
  buildWebSdkMarkdown,
  buildSdkMarkdown,
  buildSdkExportFileName,
  resolveSdkPlatform,
};
