# CoreID Web 接入文档

本文档面向接入 CoreID 的 Web 应用。

## CoreID 是什么

CoreID 不是一个前端页面组件，而是统一身份与权益中心。它负责：

- 用户注册与登录接口
- 应用级注册资格
- 套餐、订单、当前权益查询
- 后台查看用户、应用、订单、设备和日志

一句话理解：

- Casdoor 管“这个人是谁”
- CoreID 管“这个人能进哪个应用、买了什么套餐、当前有什么权益”

## SDK 的作用

这里的“SDK 文档”不是指一个现成的浏览器 SDK 包，而是指：

- 接入 CoreID 时要调用哪些接口
- 每个接口需要什么参数
- 返回什么结构
- 出错时怎么处理
- Web 端推荐用什么方式接入

也就是一份完整的接入契约。

## 目标

CoreID 负责：
- 统一身份
- 应用注册资格
- 套餐与购买
- 当前权益查询

Web 应用负责：
- 自己的前端页面与交互
- 自己的站点 Session 管理
- 按应用 `app_id` 调用 CoreID 接口

## 推荐接入模式

推荐采用：

`浏览器 -> 你的 Web 服务端 -> CoreID`

原因：
- 避免直接把 CoreID token 长期暴露在浏览器
- 更适合接支付、风控、审计
- 更容易用 HttpOnly Cookie 管理自己站点登录态

开发环境为了快速联调，也可以先直接在浏览器用 Bearer Token 调 CoreID。

## AI Agent 如何接入

如果接入方是 AI Agent、Browser Agent 或自动化工具，建议让它先建立下面的固定认知：

- 我属于哪个应用：`app_id`
- 当前用户是谁：`token / user_id`
- 当前用户能不能访问该应用：`POST /api/identity/access-check`
- 当前用户有没有可用权益：`GET /api/purchase/current-plan`

推荐顺序：

1. Agent 启动时先确定 `app_id`
2. 每次执行核心业务前先做 `access-check`
3. 需要付费能力时先做 `current-plan` 或 `preview`
4. 如果返回无资格、无权益、试用已领完，Agent 不应继续执行业务动作，而应转成解释型回复

这能让 Agent 更快建立稳定的调用顺序，而不是把权限逻辑散落在提示词里。

## 核心规则

- 底层统一身份由 Casdoor 管理
- 应用注册资格由 CoreID 管理
- 用户在应用 A 注册，不代表自动拥有应用 B 的登录资格
- 当前注册主凭证只支持手机号
- 验证码链路支持 `dev` 与 `sms` 两种模式
- 同一应用下只允许 1 个有效 Web 设备上下文，新浏览器登录会自动顶掉旧浏览器

## 接入顺序

1. `GET /api/identity/applications`
2. `POST /api/identity/send-code`
3. `POST /api/identity/register`
4. `POST /api/identity/login/password`
5. `GET /api/identity/me?app_id=...`
6. `POST /api/identity/access-check`
7. `GET /api/purchase/plans?app_id=...`
8. `POST /api/purchase/preview`
9. `POST /api/purchase/create`
10. `GET /api/purchase/orders/:order_no`
11. `GET /api/purchase/current-plan?user_id=...&app_id=...`
12. `POST /api/identity/change-password`

## 推荐接入架构

最推荐的方式是：

```text
浏览器 -> 你的 Web 服务端 -> CoreID
```

推荐原因：

- Web 前端不长期持有 CoreID token
- 你的服务端可以做用户同步、业务角色、套餐映射、权益缓存
- 更适合接支付、审计、风控和 AI Agent 协同

建议分工：

- CoreID：身份、资格、套餐、订单、兑换码核销、当前权益
- 接入方本地：昵称、头像、业务角色、业务数据、额度、站点 Session

## 测试环境怎么调试

本地/测试环境建议这样联调：

- CoreID Base URL：`http://localhost:3000`
- 若 `send-code` 返回 `mode=dev`，验证码会通过 `debug_code` 返回
- 若 `send-code` 返回 `mode=sms`，验证码会直接发送到手机
- 后台地址：`http://localhost:3000/admin`
- 注册测试页：`http://localhost:3000/auth/register-test`
- 登录测试页：`http://localhost:3000/auth/login-test`

调试顺序建议：

1. 先确认应用已经在后台创建，并拿到正确的 `app_id`
2. 先注册，再登录，再校验资格
3. 最后再接套餐与购买

常见排查点：

- `401`：token 失效，或当前浏览器已被新浏览器顶掉
- `403`：该用户没有当前应用资格
- `409`：重复注册、试用已领取、状态流转冲突
- `429`：接口限流

## 正式环境如何部署

上线时建议至少做到：

- CoreID 使用正式 HTTPS 域名，例如 `https://coreid.example.com`
- Casdoor 使用独立 HTTPS 域名，例如 `https://account.example.com`
- Web 应用通过自己的服务端代理 CoreID，不直接把长期 token 暴露给浏览器
- 用真实短信验证码替换开发态假验证码
- 为支付确认配置 `PAYMENT_CALLBACK_SECRET`
- 打开日志、限流、错误监控

生产环境至少要准备这些配置：

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

## 兑换码核销接入

如果你的应用支持“外部售卖兑换码、应用内核销”，应接这两步：

1. `POST /api/redeem/preview`
2. `POST /api/redeem/claim`

推荐流程：

1. 用户输入兑换码
2. 前端把兑换码发给你的服务端
3. 你的服务端先调 `redeem/preview`
4. 预校验通过后，再调 `redeem/claim`
5. 核销成功后，再调用 `current-plan` 或同步本地权益

说明：

- 兑换码不是单独一套权益系统
- 它最终会在 CoreID 中生成一条标准购买记录
- 核销后应和正常购买一样刷新当前权益

## 支付确认与签名校验

当前 CoreID 已提供：

- `POST /api/purchase/confirm`

作为支付确认入口。

如果生产环境开启：

- `PAYMENT_CALLBACK_ENABLED=true`
- `PAYMENT_CALLBACK_SECRET=<your-secret>`

则你的支付回调方或业务服务端必须在请求头里传：

```http
X-CoreID-Signature: <HMAC-SHA256>
```

签名说明：

- 对原始请求体做 `HMAC-SHA256`
- 使用 `PAYMENT_CALLBACK_SECRET` 作为密钥
- 把结果放到 `X-CoreID-Signature`

建议：

- 测试环境可以关闭签名校验
- 生产环境必须开启
- 同一 `order_no` 重复确认必须保持幂等

## Web 端设备标识建议

登录接口要求：
- `device_id`
- `device_name`

建议：
- 首次访问时生成稳定的 `device_id`
- 存放在站点自己的 Cookie 或 localStorage
- 不要每次刷新页面都重新生成

示例：

```js
const key = "coreid:web:device-id";
let deviceId = localStorage.getItem(key);
if (!deviceId) {
  deviceId = `web-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(key, deviceId);
}
```

## 浏览器直接联调示例

```js
const loginResponse = await fetch("http://localhost:3000/api/identity/login/password", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    app_id: "your_app_id",
    phone: "13900001001",
    password: "12345678",
    device_id: deviceId,
    device_name: "Chrome on macOS"
  })
});

const loginData = await loginResponse.json();
sessionStorage.setItem("coreid_token", loginData.token);
```

## 服务端代理示例

```js
const response = await fetch("http://localhost:3000/api/identity/login/password", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    app_id: "your_app_id",
    phone: "13900001001",
    password: "12345678",
    device_id: "web-server-session-001",
    device_name: "Web session on server"
  })
});

const data = await response.json();

// 把 data.token 放进你自己的服务端 Session
```

## 套餐购买建议

下单前必须先调：

`POST /api/purchase/preview`

原因：
- 试用套餐可能已领取过
- 当前购买可能是 `new`
- 也可能应该走 `renew`

如果返回：

```json
{
  "allowed": false,
  "reason_code": "TRIAL_ALREADY_USED"
}
```

前端应直接阻止继续下单，并展示服务端返回文案。

## 修改密码

当前已经支持用户自助修改密码：

`POST /api/identity/change-password`

要求：
- 必须带当前有效登录态
- 必须提供旧密码
- 必须提供新密码

请求示例：

```json
{
  "current_password": "12345678",
  "new_password": "87654321"
}
```

## 验证码重置密码

当前也支持“忘记密码 -> 验证码重置密码”：

1. 调用 `POST /api/identity/send-code`
2. 请求体传 `purpose=reset_password`
3. 再调用 `POST /api/identity/reset-password`

请求示例：

```json
{
  "app_id": "zhujiaoyun",
  "phone": "13900001001",
  "code": "123456",
  "new_password": "87654321"
}
```

## 接入方常见疑问

### CoreID token 需要长期持有吗？

不建议。推荐模式是：

- 登录时调用 CoreID
- 同步本地用户、资格和权益
- 接入方自己签发本地 Session / JWT

### 接入方是否还需要保留本地用户表？

多数情况下需要。推荐分工：

- CoreID：统一身份、应用资格、套餐、订单、权益
- 应用本地：昵称、头像、业务角色、业务数据、额度等

### `current-plan` 是否需要 token？

当前版本的 `GET /api/purchase/current-plan` 主要面向服务端同步场景，不要求 Bearer token，只需要：

- `user_id`
- `app_id`

但建议只在服务端调用，不要直接暴露给前端浏览器。

### 平台如果开放“验证码重置密码”，还需要额外配置什么？

需要。平台部署时应额外配置：

- `CASDOOR_MASTER_PASSWORD`

CoreID 会在验证码校验通过后，使用这个 Casdoor 组织级主密码代表用户完成改密。这是平台内部能力，不应暴露给前端或第三方接入客户端。

### 套餐价格和业务权益分别由谁负责？

推荐分工：

- CoreID：套餐价格、有效期、订单、续费状态
- 接入方：根据 `plan code` 映射业务额度或特殊权益

### 单设备登录被顶掉后应该怎么处理？

如果旧浏览器被新浏览器顶掉：

- `GET /api/identity/me` 会返回 `authenticated: false`
- 接入方应清理本地登录态
- 跳回登录页并提示用户重新登录

### 生产环境应该怎么配置 CoreID 地址？

接入方后端应通过环境变量保存 CoreID 地址，例如：

```env
COREID_BASE_URL=https://coreid.example.com
```

## 接入自检清单

- 已在后台创建正确的 `app_id`
- Web 端注册 / 登录都走 CoreID
- 你的服务端能正确同步本地用户与 `coreid_user_id`
- `access-check` 能拦住未注册当前应用的用户
- `plans / preview / create / orders / current-plan` 已联调完成
- 试用套餐重复领取会被正确阻止
- 兑换码核销成功后，权益能立即更新
- 改密码和验证码重置密码都可用
- 生产环境已切到真实短信和支付签名

## 常见错误处理

- `401`：清理站点 Session 或本地 token，跳回登录页
- `403`：提示“当前账号未开通此应用”或“账号已停用”
- `409`：直接展示服务端返回文案
- `429`：显示冷却提示并限制重复点击
