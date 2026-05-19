# CoreID Android 接入文档

本文档面向 Android 应用接入 CoreID 统一身份能力。

当前版本适用范围：
- 手机号注册
- 开发环境假验证码 / 真实短信验证码
- 密码登录
- 应用级注册资格校验
- 套餐列表、预校验、购买、订单查询与当前权益查询
- 验证码重置密码 / 用户自助改密码
- 兑换码预校验与核销

核心规则：
- 底层统一身份由 Casdoor 管理
- 应用注册资格由 CoreID 管理
- 用户在应用 A 注册，不代表自动拥有应用 B 的登录资格

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

```text
Android App -> 你的服务端 -> CoreID
                    ↓
            下发你自己的业务会话
```

推荐原因：

- 避免长期把 CoreID token 暴露在客户端
- 更适合接支付、风控、审计和业务编排
- 更容易把“身份体系”和“业务会话”解耦

开发环境为了快速联调，也可以先由 Android 直接请求 CoreID。

## 1. 基础信息

- Base URL：`http://localhost:3000`
- Content-Type：`application/json`
- 鉴权方式：
  - 登录成功后会返回 `token`
  - Android 端应保存该 token
  - 后续请求通过 `Authorization: Bearer <token>` 传递
- Token 生命周期：
  - 当前 identity token 默认有效期为 12 小时
  - 当前没有 refresh token 机制
  - 更推荐把它当作登录阶段和短期身份会话使用
- 单设备规则：
  - 同一应用下仅允许 1 台有效设备
  - 新设备登录会自动顶掉旧设备
  - Android 端必须持久化稳定的 `device_id`

统一错误响应格式：

```json
{
  "error": "Application does not exist"
}
```

## 2. 接入顺序

1. 获取可接入应用列表，确定目标 `app_id`
2. 发送验证码
3. 调用注册接口，为当前手机号创建统一账号并写入当前应用资格
4. 调用密码登录接口，并携带稳定的 `device_id` 与 `device_name`，获取 CoreID 会话 token
5. 调用 `/api/identity/me` 获取当前用户资料
6. 调用 `/api/identity/access-check` 校验当前用户是否具备目标应用资格
7. 调用 `GET /api/purchase/plans?app_id=...` 获取可售套餐
8. 调用 `POST /api/purchase/preview` 判断当前是新购还是续费
9. 调用 `POST /api/purchase/create` 创建购买记录
10. 调用 `GET /api/purchase/orders/:order_no` 查询订单详情
11. 如需模拟或对接支付确认，调用 `POST /api/purchase/confirm`
12. 调用 `GET /api/purchase/current-plan?user_id=...&app_id=...` 获取当前权益
13. 如需修改密码，调用 `POST /api/identity/change-password`
14. 退出登录时清理本地 token，必要时调用 `/api/identity/logout`

说明：
- 在应用 A 注册成功后，只会获得应用 A 的资格
- 若想登录应用 B，必须再对应用 B 完成注册

## 2.1 AI Agent 如何快速理解并接入

如果接入方不是传统 Android 页面，而是 Android 端的 AI 助手、Agent 或工具层，建议先让它建立下面的固定认知：

- 我属于哪个应用：`app_id`
- 当前用户是谁：`token / user_id`
- 当前用户能不能进入当前应用：`POST /api/identity/access-check`
- 当前用户有没有可用权益：`GET /api/purchase/current-plan`
- 当前用户能不能发起购买：`POST /api/purchase/preview`
- 当前用户是否可以核销兑换码：`POST /api/redeem/preview`

推荐顺序：

1. Agent 启动时先确定 `app_id`
2. 执行核心业务前先做 `access-check`
3. 涉及付费能力前先做 `current-plan` 或 `preview`
4. 涉及兑换码时先做 `redeem/preview`
5. 如果返回无资格、无权益、试用已领过、兑换码无效，Agent 不应继续业务动作，而应转成解释型回复

## 3. 接口列表

### 3.1 获取应用列表

`GET /api/identity/applications`

用途：
- 获取当前可接入的应用列表
- 注册页和登录页应基于该接口展示可选应用

成功响应：

```json
{
  "items": [
    {
      "id": "vidget",
      "name": "VidGet 视频下载器",
      "type": "android",
      "status": "active"
    },
    {
      "id": "zhujiaoyun",
      "name": "助教云",
      "type": "web",
      "status": "active"
    }
  ]
}
```

### 3.2 发送验证码

`POST /api/identity/send-code`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `app_id` | string | 是 | 目标应用 ID |
| `phone` | string | 是 | 手机号，当前按中国大陆手机号规则校验 |
| `purpose` | string | 否 | 验证码用途，默认 `register`，重置密码时传 `reset_password` |

请求示例：

```json
{
  "app_id": "vidget",
  "phone": "13900001001"
}
```

成功响应：

```json
{
  "success": true,
  "mode": "dev",
  "app_id": "vidget",
  "phone": "13900001001",
  "purpose": "register",
  "expires_at": "2026-05-14T12:34:56.000Z",
  "cooldown_seconds": 60,
  "debug_code": "123456"
}
```

开发环境说明：
- 当 `mode = dev` 时，接口会返回 `debug_code`
- 当 `mode = sms` 时，验证码会直接发送到用户手机，响应中不会返回验证码本身
- 正式上线前必须配置真实短信渠道与模板

### 3.3 注册

`POST /api/identity/register`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `app_id` | string | 是 | 目标应用 ID |
| `phone` | string | 是 | 手机号 |
| `code` | string | 是 | 验证码；开发环境可用 `debug_code`，短信模式下填写手机收到的验证码 |
| `password` | string | 是 | 登录密码，当前最短 6 位 |
| `display_name` | string | 否 | 展示名称；不传时默认使用手机号 |

请求示例：

```json
{
  "app_id": "vidget",
  "phone": "13900001001",
  "code": "123456",
  "password": "12345678",
  "display_name": "VidGet 测试用户"
}
```

成功响应：

```json
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
    "app_id": "vidget",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": null
  },
  "next_action": "login"
}
```

关键规则：
- 若手机号还没有统一账号，会先创建 Casdoor 用户，再写入当前应用资格
- 若手机号已存在统一账号，则必须提供正确的原密码，才能为该账号补注册新的应用资格
- 同一手机号对同一 `app_id` 重复注册会返回冲突错误

### 3.4 密码登录

`POST /api/identity/login/password`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `app_id` | string | 是 | 目标应用 ID |
| `phone` | string | 是 | 手机号 |
| `password` | string | 是 | 登录密码 |
| `device_id` | string | 是 | 设备唯一标识，必须稳定复用 |
| `device_name` | string | 是 | 设备名称，例如 `Xiaomi 15 Pro` |

请求示例：

```json
{
  "app_id": "vidget",
  "phone": "13900001001",
  "password": "12345678",
  "device_id": "android-8f2a7c1b",
  "device_name": "Xiaomi 15 Pro"
}
```

成功响应：

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "built-in/u13900001001",
    "username": "u13900001001",
    "phone": "13900001001",
    "email": "u13900001001@dev.coreid.local",
    "app_ids": ["vidget"]
  },
  "membership": {
    "app_id": "vidget",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": "2026-05-14T12:36:10.000Z"
  },
  "device": {
    "app_id": "vidget",
    "device_id": "android-8f2a7c1b",
    "device_name": "Xiaomi 15 Pro",
    "is_active": true,
    "last_login": "2026-05-14T12:36:10.000Z",
    "replaced_previous_device": false
  },
  "casdoor_access_token": "eyJhbGciOiJSUzI1NiIs..."
}
```

Android 端建议：
- 保存 `token`
- 始终为当前安装实例生成并持久化同一个 `device_id`
- 后续通过 `Authorization: Bearer <token>` 调用 `/me` 和 `/access-check`
- `casdoor_access_token` 可先忽略，除非你的业务后续还需要直接透传到其他服务

### 3.5 获取当前用户

`GET /api/identity/me?app_id=<app_id>`

请求头：

```http
Authorization: Bearer <token>
```

成功响应：

```json
{
  "authenticated": true,
  "user": {
    "id": "built-in/u13900001001",
    "username": "u13900001001",
    "phone": "13900001001",
    "email": "u13900001001@dev.coreid.local",
    "app_ids": ["vidget"]
  },
  "memberships": [
    {
      "app_id": "vidget",
      "status": "active",
      "register_source": "self_service_phone",
      "created_at": "2026-05-14T12:35:40.000Z",
      "last_login_at": "2026-05-14T12:36:10.000Z"
    }
  ],
  "current_membership": {
    "app_id": "vidget",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": "2026-05-14T12:36:10.000Z"
  },
  "session": {
    "app_id": "vidget",
    "device_id": "android-8f2a7c1b"
  }
}
```

未登录响应：

```json
{
  "authenticated": false,
  "user": null
}
```

### 3.6 应用资格校验

`POST /api/identity/access-check`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `app_id` | string | 是 | 目标应用 ID |
| `token` | string | 否 | 当未通过 `Authorization` 头传 token 时可放在 body 中 |

请求示例：

```json
{
  "app_id": "vidget"
}
```

成功响应：

```json
{
  "valid": true,
  "app_id": "vidget",
  "user_id": "built-in/u13900001001",
  "session": {
    "app_id": "vidget",
    "device_id": "android-8f2a7c1b",
    "device_valid": true
  },
  "membership": {
    "app_id": "vidget",
    "status": "active",
    "register_source": "self_service_phone",
    "created_at": "2026-05-14T12:35:40.000Z",
    "last_login_at": "2026-05-14T12:36:10.000Z"
  }
}
```

说明：
- `valid = true` 代表该用户已经在目标应用注册且资格可用
- `valid = false` 代表未注册、资格停用或账号已被后台停用

### 3.7 退出登录

`POST /api/identity/logout`

成功响应：

```json
{
  "success": true
}
```

Android 端建议：
- 调用该接口不是必须
- 核心动作是清除本地保存的 `token`

### 3.7.1 修改密码

`POST /api/identity/change-password`

请求头：

```http
Authorization: Bearer <token>
```

请求示例：

```json
{
  "current_password": "12345678",
  "new_password": "87654321"
}
```

成功响应：

```json
{
  "success": true,
  "message": "Password updated successfully"
}
```

说明：
- 必须带当前有效登录态
- 必须提供旧密码
- 新密码不能与旧密码相同

### 3.7.2 验证码重置密码

`POST /api/identity/reset-password`

请求示例：

```json
{
  "app_id": "vidget",
  "phone": "13900001001",
  "code": "123456",
  "new_password": "87654321"
}
```

成功响应：

```json
{
  "success": true,
  "message": "Password reset successfully"
}
```

说明：
- 适合“忘记密码”场景
- 必须先调用 `POST /api/identity/send-code`，并传 `purpose=reset_password`
- 仅对已经在目标应用注册的手机号生效

### 3.8 获取套餐列表

`GET /api/purchase/plans?app_id=vidget`

成功响应：

```json
{
  "items": [
    {
      "code": "monthly",
      "name": "VidGet 月度会员",
      "description": "按月订阅，支持续费",
      "duration_days": 30,
      "price": 18,
      "original_price": 25,
      "currency": "CNY",
      "status": "active",
      "sort_order": 1,
      "is_trial": false,
      "is_renewable": true,
      "features": ["1080P 下载", "不限速"]
    }
  ]
}
```

### 3.9 套餐预校验

`POST /api/purchase/preview`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | string | 是 | 当前登录用户 ID |
| `app_id` | string | 是 | 目标应用 ID |
| `plan` | string | 是 | 套餐编码，例如 `monthly` |
| `purchase_mode` | string | 否 | `new` 或 `renew`；不传时后端自动推断 |

成功响应：

```json
{
  "allowed": true,
  "reason": null,
  "purchase_mode": "renew",
  "plan": {
    "code": "monthly",
    "name": "VidGet 月度会员",
    "duration_days": 30,
    "price": 18,
    "original_price": 25,
    "currency": "CNY",
    "status": "active",
    "sort_order": 1,
    "is_trial": false,
    "is_renewable": true,
    "features": ["1080P 下载", "不限速"]
  },
  "current_plan": {
    "plan": "monthly",
    "plan_name": "VidGet 月度会员",
    "expired_at": "2026-06-14T12:36:10.000Z",
    "status": "paid"
  },
  "latest_purchase": {
    "plan": "monthly",
    "plan_name": "VidGet 月度会员",
    "expired_at": "2026-06-14T12:36:10.000Z",
    "status": "paid"
  },
  "entitlement": {
    "is_active": true,
    "trial_used": false,
    "can_renew": true
  },
  "pricing": {
    "amount": 18,
    "currency": "CNY",
    "expected_expired_at": "2026-07-14T12:36:10.000Z"
  }
}
```

说明：
- `allowed=false` 时不会创建订单，`reason` 会说明原因
- 同一应用下试用套餐只能使用一次
- 当前活动套餐与目标套餐相同且支持续费时，默认会推断成 `renew`
- 当 `allowed=false` 且 `reason_code=TRIAL_ALREADY_USED` 时，应明确提示“该试用套餐每个用户仅可领取一次”

### 3.10 创建购买记录

`POST /api/purchase/create`

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | string | 是 | 当前登录用户 ID |
| `app_id` | string | 是 | 目标应用 ID |
| `plan` | string | 是 | 套餐编码 |
| `order_no` | string | 是 | 业务订单号，必须唯一 |
| `purchase_mode` | string | 否 | `new` 或 `renew`；建议沿用 preview 的结果 |
| `payment_method` | string | 否 | 支付方式，例如 `wechat` |
| `status` | string | 否 | 默认 `paid`，可传 `pending / failed / refunded / expired` |

请求示例：

```json
{
  "user_id": "built-in/u13900001001",
  "app_id": "vidget",
  "plan": "monthly",
  "order_no": "ORDER-20260515-0001",
  "purchase_mode": "renew",
  "payment_method": "wechat",
  "status": "paid"
}
```

成功响应：

```json
{
  "success": true,
  "purchase_mode": "renew",
  "purchase": {
    "user_id": "built-in/u13900001001",
    "app_id": "vidget",
    "plan": "monthly",
    "plan_name": "VidGet 月度会员",
    "order_no": "ORDER-20260515-0001",
    "amount": 18,
    "expired_at": "2026-07-14T12:36:10.000Z",
    "payment_method": "wechat",
    "status": "paid"
  },
  "plan": {
    "code": "monthly",
    "name": "VidGet 月度会员",
    "duration_days": 30,
    "price": 18,
    "currency": "CNY",
    "is_trial": false,
    "is_renewable": true
  }
}
```

### 3.11 当前权益

### 3.11 查询订单详情

`GET /api/purchase/orders/:order_no`

用途：
- 让应用在创建购买记录后，按业务订单号查询当前订单状态
- 可用于支付结果轮询或订单详情页展示

成功响应：

```json
{
  "purchase": {
    "order_no": "ORDER-20260515-0001",
    "plan": "monthly",
    "plan_name": "VidGet 月度会员",
    "purchase_mode": "renew",
    "status": "pending",
    "amount": 18,
    "expired_at": "2026-08-12T12:36:10.000Z"
  },
  "entitlement": {
    "is_active": true,
    "current_plan": {
      "plan": "monthly",
      "status": "paid"
    },
    "latest_purchase": {
      "order_no": "ORDER-20260515-0001",
      "status": "pending"
    },
    "can_renew": true
  }
}
```

### 3.12 支付确认预留接口

`POST /api/purchase/confirm`

用途：
- 预留给支付回调、服务端补单或开发环境手动确认订单
- 当前版本还没有直连微信/支付宝，这个接口更像“支付确认接入口”

请求头：

```http
X-CoreID-Signature: sha256=<hmac_sha256_hex>
```

说明：
- 当 `PAYMENT_CALLBACK_ENABLED=true` 且配置了 `PAYMENT_CALLBACK_SECRET` 时，会强制校验该签名
- 签名内容为原始请求体，算法为 `HMAC-SHA256`
- 本地开发默认可关闭签名校验

请求参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `order_no` | string | 是 | 业务订单号 |
| `status` | string | 是 | `paid / pending / failed / refunded / expired` |
| `payment_method` | string | 否 | 支付方式，例如 `wechat` |
| `external_order_no` | string | 否 | 第三方支付单号 |
| `confirmed_at` | string | 否 | 支付确认时间 |
| `payment_payload` | object | 否 | 原始支付回调摘要 |

请求示例：

```json
{
  "order_no": "ORDER-20260515-0001",
  "status": "paid",
  "payment_method": "wechat",
  "external_order_no": "WX-20260515-0001",
  "confirmed_at": "2026-05-15T13:00:00+08:00",
  "payment_payload": {
    "channel": "wechat",
    "trade_state": "SUCCESS"
  }
}
```

成功响应：

```json
{
  "success": true,
  "purchase": {
    "order_no": "ORDER-20260515-0001",
    "status": "paid",
    "external_order_no": "WX-20260515-0001",
    "confirmed_at": "2026-05-15T05:00:00.000Z"
  },
  "entitlement": {
    "is_active": true,
    "current_plan": {
      "plan": "monthly",
      "status": "paid"
    }
  }
}
```

### 3.13 当前权益

`GET /api/purchase/current-plan?user_id=<user_id>&app_id=vidget`

成功响应：

```json
{
  "app_id": "vidget",
  "user_id": "built-in/u13900001001",
  "account_status": "active",
  "membership": {
    "app_id": "vidget",
    "status": "active",
    "register_source": "self_service_phone"
  },
  "entitlement": {
    "is_active": true,
    "trial_used": false,
    "current_plan": {
      "plan": "monthly",
      "plan_name": "VidGet 月度会员",
      "expired_at": "2026-07-14T12:36:10.000Z",
      "status": "paid"
    },
    "latest_purchase": {
      "plan": "monthly",
      "plan_name": "VidGet 月度会员",
      "expired_at": "2026-07-14T12:36:10.000Z",
      "status": "paid"
    },
    "can_renew": true
  }
}
```

### 3.14 兑换码预校验

`POST /api/redeem/preview`

请求示例：

```json
{
  "app_id": "vidget",
  "code": "ABCD-EFGH-IJKL-MNOP"
}
```

作用：

- 告诉客户端该兑换码是否有效
- 告诉客户端该兑换码对应什么套餐
- 告诉客户端当前用户是否可以继续核销

建议：

- 用户输入兑换码后先调 `preview`
- 不要直接调用 `claim`

### 3.15 兑换码核销

`POST /api/redeem/claim`

请求头：

```http
Authorization: Bearer <token>
```

请求示例：

```json
{
  "app_id": "vidget",
  "code": "ABCD-EFGH-IJKL-MNOP"
}
```

说明：

- 核销成功后，CoreID 会生成一条标准购买记录
- 兑换码不是单独一套权益系统，而是一种“购买来源”
- 核销成功后，客户端仍然应刷新 `current-plan`

## 4. Android Kotlin / OkHttp 示例

### 4.1 数据模型

```kotlin
data class ApiError(
    val error: String
)

data class IdentityUser(
    val id: String,
    val username: String,
    val phone: String?,
    val email: String?,
    val app_ids: List<String> = emptyList()
)

data class Membership(
    val app_id: String,
    val status: String,
    val register_source: String?,
    val created_at: String?,
    val last_login_at: String?
)

data class LoginResponse(
    val success: Boolean,
    val token: String,
    val user: IdentityUser,
    val membership: Membership?,
    val casdoor_access_token: String?
)
```

### 4.2 密码登录示例

```kotlin
val client = OkHttpClient()
val json = """
{
  "app_id": "vidget",
  "phone": "13900001001",
  "password": "12345678",
  "device_id": "android-8f2a7c1b",
  "device_name": "Xiaomi 15 Pro"
}
""".trimIndent()

val request = Request.Builder()
    .url("http://localhost:3000/api/identity/login/password")
    .post(json.toRequestBody("application/json; charset=utf-8".toMediaType()))
    .build()

client.newCall(request).execute().use { response ->
    val body = response.body?.string().orEmpty()
    if (!response.isSuccessful) {
        throw IllegalStateException(body)
    }
    println(body)
}
```

### 4.3 携带 Bearer Token 获取当前用户

```kotlin
val token = "登录接口返回的 token"

val request = Request.Builder()
    .url("http://localhost:3000/api/identity/me?app_id=vidget")
    .header("Authorization", "Bearer $token")
    .get()
    .build()
```

### 4.4 套餐预校验示例

```kotlin
val previewJson = """
{
  "user_id": "built-in/u13900001001",
  "app_id": "vidget",
  "plan": "monthly"
}
""".trimIndent()

val previewRequest = Request.Builder()
    .url("http://localhost:3000/api/purchase/preview")
    .post(previewJson.toRequestBody("application/json; charset=utf-8".toMediaType()))
    .build()
```

## 5. 常见错误码

| HTTP 状态 | 场景 | `error` 示例 | Android 端建议 |
| --- | --- | --- | --- |
| 400 | 参数缺失或 JSON 非法 | `Request body must be valid JSON` | 校验请求体并提示用户重试 |
| 401 | 密码错误 | `Phone number or password is incorrect` | 提示重新输入密码 |
| 403 | 应用停用 / 账号停用 / 未注册目标应用 | `Application is not active` / `This account has not been registered in the target app` | 提示业务不可用或引导先注册目标应用 |
| 404 | 应用不存在 / 手机号未注册 | `Application does not exist` / `This phone number has not been registered yet` | 检查 `app_id` 或引导用户先注册 |
| 409 | 重复注册 / 已有统一账号但密码不匹配 | `This phone number is already registered in the target app` | 提示用户直接登录或使用原密码补注册其他应用 |
| 429 | 触发限流 | `Verification code requests are too frequent, please slow down` | 做按钮倒计时和重试等待 |

购买相关还会出现：
- `Trial plan has already been used in this app`
- `This plan does not support renewal`
- `Use renew for the current active plan`

## 6. 开发联调建议

- 注册页、登录页使用应用自己的 UI
- 统一通过 CoreID API 完成注册、登录和资格校验
- 登录态只信任 CoreID 返回的 `token`
- 后台用户管理中的“所属产品 / 应用资格”会直接反映 `app_id` 注册关系
- 套餐购买前先调用 `/api/purchase/preview`，不要直接盲下单
- 兑换码核销前先调用 `/api/redeem/preview`

## 7. 正式环境部署建议

- CoreID 使用正式 HTTPS 域名，例如 `https://coreid.example.com`
- Casdoor 使用正式 HTTPS 域名，例如 `https://account.example.com`
- Android 不长期依赖 CoreID token 作为唯一业务会话
- 注册和重置密码使用真实短信验证码
- 购买确认启用支付回调签名校验
- 所有关键接口打开限流、日志和异常监控

CoreID 生产环境至少要准备这些配置：

- `BASE_URL`
- `DATABASE_URL`
- `CASDOOR_ENDPOINT`
- `CASDOOR_CLIENT_ID`
- `CASDOOR_CLIENT_SECRET`
- `CASDOOR_MASTER_PASSWORD`
- `AUTH_SESSION_SECRET`
- `PHONE_VERIFICATION_MODE=sms`
- `SMS_PROVIDER=tencentcloud` 或 `SMS_PROVIDER=aliyun`
- 腾讯云短信：`SMS_TENCENT_*`
- 阿里云短信：`SMS_ALIYUN_*`
- 若使用阿里云短信模板，当前模板变量只需包含 `code`
- `PAYMENT_CALLBACK_ENABLED=true`
- `PAYMENT_CALLBACK_SECRET`

## 8. 接入方常见疑问

### 8.1 CoreID token 需要长期持有吗？

不建议。推荐模式是：

- 登录时调用 CoreID
- 同步本地用户、资格和权益
- 接入方自己签发本地 Session / JWT

### 8.2 接入方是否还需要保留本地用户表？

多数情况下需要。推荐分工：

- CoreID：统一身份、应用资格、套餐、订单、权益
- 应用本地：昵称、头像、业务角色、业务数据、额度等

### 8.3 `current-plan` 是否需要 token？

当前版本的 `GET /api/purchase/current-plan` 主要面向服务端同步场景，不要求 Bearer token，只需要：

- `user_id`
- `app_id`

但建议只在服务端调用，不要直接暴露给客户端。

### 8.4 如果平台开放“验证码重置密码”，还需要额外配置什么？

需要。平台部署时应额外配置：

- `CASDOOR_MASTER_PASSWORD`

CoreID 会在验证码校验通过后，使用这个 Casdoor 组织级主密码代表用户完成改密。这是平台内部能力，不应下发到 Android 客户端。

### 8.5 套餐价格和业务权益分别由谁负责？

推荐分工：

- CoreID：套餐价格、有效期、订单、续费状态
- 接入方：根据 `plan code` 映射业务额度或特殊权益

### 8.6 单设备登录被顶掉后应该怎么处理？

如果旧设备被新设备顶掉：

- `GET /api/identity/me` 会返回 `authenticated: false`
- 接入方应清理本地登录态
- 跳回登录页并提示用户重新登录

### 8.7 生产环境应该怎么配置 CoreID 地址？

接入方后端应通过环境变量保存 CoreID 地址，例如：

```env
COREID_BASE_URL=https://coreid.example.com
```

## 9. 接入自检清单

- 能拿到正确的 `app_id`
- 注册成功后，用户只拥有当前应用资格
- 同一用户不能直接登录未注册应用
- 登录请求始终带稳定的 `device_id`
- 新设备登录后，旧设备能被正确顶下线
- `preview` 能正确区分 `new / renew / trial already used`
- `current-plan` 能返回正确的当前权益
- 兑换码核销后能生成购买记录并刷新权益
- 改密码后，旧密码失效、新密码可登录
- 生产环境短信和支付签名已经切到正式配置

## 10. 当前限制

- 当前只支持手机号注册
- 当前只提供密码登录
- 当前验证码链路为开发态假验证码
- 当前支付回调仍是本地记录模式，尚未接微信/支付宝正式网关
- 生产环境接入前，需替换为真实短信通道并补充更严格的安全策略
