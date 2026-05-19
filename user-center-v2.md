# 统一用户中心 — 完整开发文档 v2.0

> 功能范围：用户管理、购买记录、应用管理、安装包管理、落地页生成与分发

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────┐
│                   香港服务器                          │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │   Casdoor   │  │   授权服务   │  │  文件服务  │  │
│  │  用户中心    │  │ Node.js+PG  │  │  静态托管  │  │
│  └─────────────┘  └──────────────┘  └───────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │              管理后台（Web）                  │   │
│  │  Dashboard / 用户 / 购买 / 应用 / 落地页      │   │
│  └─────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ↓            ↓            ↓
          VidGet       助教云        落地页访客
        Android App   Web产品    yourdomain.com/get/vidget
```

---

## 二、数据库表结构

### 应用表 applications
```sql
CREATE TABLE applications (
    id VARCHAR(50) PRIMARY KEY,        -- vidget / zhujiaoyun
    name VARCHAR(100) NOT NULL,         -- 显示名称
    description TEXT,                   -- 产品描述
    type VARCHAR(20) NOT NULL,          -- android / web / desktop
    status VARCHAR(20) DEFAULT 'active',-- active / inactive
    created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO applications (id, name, type) VALUES
('vidget', 'VidGet 视频下载器', 'android'),
('zhujiaoyun', '助教云', 'web');
```

### 安装包/地址表 app_releases
```sql
CREATE TABLE app_releases (
    id SERIAL PRIMARY KEY,
    app_id VARCHAR(50) NOT NULL,
    type VARCHAR(20) NOT NULL,         -- apk / exe / dmg / web / appstore
    file_path VARCHAR(500),            -- 服务器文件路径（安装包）
    file_name VARCHAR(200),            -- 原始文件名
    file_size BIGINT,                  -- 文件大小（bytes）
    download_url VARCHAR(500),         -- 对外下载地址
    web_url VARCHAR(500),              -- 网页产品直接填URL
    version VARCHAR(50),               -- 版本号 如 1.0.2
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (app_id) REFERENCES applications(id),
    UNIQUE(app_id, type)               -- 每个产品每种类型只保留一条（覆盖）
);
```

### 落地页表 landing_pages
```sql
CREATE TABLE landing_pages (
    id SERIAL PRIMARY KEY,
    app_id VARCHAR(50) UNIQUE NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,  -- URL路径 如 vidget
    html_path VARCHAR(500),             -- 上传的HTML文件路径
    is_published BOOLEAN DEFAULT false,
    published_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (app_id) REFERENCES applications(id)
);
```

### 购买记录表 purchases
```sql
CREATE TABLE purchases (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL,
    app_id VARCHAR(50) NOT NULL,
    plan VARCHAR(20) NOT NULL,          -- lifetime / monthly
    order_no VARCHAR(100) UNIQUE,
    amount DECIMAL(10,2),
    expired_at TIMESTAMP,               -- 买断填NULL
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (app_id) REFERENCES applications(id)
);
```

### 设备表 devices
```sql
CREATE TABLE devices (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL,
    app_id VARCHAR(50) NOT NULL,
    device_id VARCHAR(200) NOT NULL,
    device_name VARCHAR(100),
    last_login TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, app_id, device_id)
);
```

---

## 三、API接口设计

### 3.1 授权相关

#### POST `/api/auth/verify`
App启动时验证Token

**请求**
```json
{
  "token": "eyJhbGc...",
  "app_id": "vidget",
  "device_id": "android_xxxxxxxx"
}
```

**响应**
```json
{
  "valid": true,
  "user_id": "user_123",
  "username": "Jeam",
  "is_purchased": true,
  "plan": "lifetime",
  "expired_at": null
}
```

---

### 3.2 购买相关

#### POST `/api/purchase/create`
支付成功后创建购买记录

```json
{
  "user_id": "user_123",
  "app_id": "vidget",
  "plan": "lifetime",
  "order_no": "WX20240510123456",
  "amount": 38.00
}
```

#### GET `/api/purchase/status?user_id=&app_id=`
查询购买状态

---

### 3.3 安装包管理

#### POST `/api/admin/release/upload`
上传安装包（multipart/form-data）

**参数**
```
app_id: vidget
type: apk / exe / dmg
version: 1.0.2
file: [二进制文件]
```

**逻辑**
- 上传到服务器 `/uploads/releases/{app_id}/` 目录
- 同名类型已存在则直接覆盖（删除旧文件，写入新文件）
- 更新 `app_releases` 表对应记录（UPSERT）
- 返回新的下载URL

**响应**
```json
{
  "success": true,
  "download_url": "https://api.yourdomain.com/download/vidget/apk",
  "file_size": 45678901,
  "version": "1.0.2"
}
```

#### GET `/api/admin/release/list?app_id=vidget`
获取某产品所有安装包信息

#### DELETE `/api/admin/release/:app_id/:type`
删除某类型安装包

#### GET `/download/:app_id/:type`
**公开接口**，用户点击下载时调用，直接返回文件流或重定向到文件地址

---

### 3.4 落地页管理

#### POST `/api/admin/landing/upload`
上传落地页HTML（multipart/form-data）

**参数**
```
app_id: vidget
slug: vidget          （URL路径，不填默认用app_id）
html_file: [HTML文件]
```

**逻辑**
- 保存HTML到 `/uploads/landing/{app_id}/index.html`（覆盖）
- 更新 `landing_pages` 表
- HTML中预留占位符，系统自动注入下载按钮和二维码

**HTML占位符规范（给设计HTML时用）**
```html
<!-- 系统自动替换为对应下载按钮组 -->
<div id="vidget-download-buttons"></div>

<!-- 系统自动替换为二维码图片 -->
<img id="vidget-qrcode" src="" alt="扫码下载" />
```

#### POST `/api/admin/landing/publish/:app_id`
发布落地页（设置 is_published = true）

#### POST `/api/admin/landing/unpublish/:app_id`
下线落地页

#### GET `/api/admin/landing/info/:app_id`
获取落地页信息（URL、发布状态、更新时间）

---

### 3.5 落地页访问（公开）

#### GET `/get/:slug`
用户访问落地页

**逻辑**
1. 查询 `landing_pages` 表，找到对应 `app_id`
2. 检查 `is_published = true`
3. 读取HTML文件
4. 查询该产品所有 `app_releases`，生成下载按钮HTML
5. 生成落地页URL的二维码
6. 注入到HTML占位符中
7. 返回完整HTML页面

**生成的下载按钮示例（注入到HTML中）**
```html
<a href="https://api.yourdomain.com/download/vidget/apk">
  下载 Android 版（APK）· 45.6 MB · v1.0.2
</a>
<a href="https://api.yourdomain.com/download/vidget/exe">
  下载 Windows 版（EXE）· 78.2 MB · v1.0.2
</a>
```

---

### 3.6 管理后台统计

#### GET `/api/admin/dashboard`
首页数据概览

**响应**
```json
{
  "total_users": 1280,
  "new_users_today": 23,
  "total_revenue": 48640.00,
  "active_devices": 956,
  "revenue_by_app": [
    { "app_id": "vidget", "revenue": 38000.00 },
    { "app_id": "zhujiaoyun", "revenue": 10640.00 }
  ],
  "user_growth_30d": [
    { "date": "2024-04-10", "count": 12 },
    ...
  ]
}
```

#### GET `/api/admin/users?page=1&limit=20&search=&app_id=`
用户列表（分页+搜索）

#### GET `/api/admin/users/:user_id`
用户详情（购买记录+设备列表）

#### GET `/api/admin/purchases?page=1&app_id=&date_from=&date_to=`
购买记录列表

---

## 四、项目结构

```
user-center/
├── src/
│   ├── app.js                    入口
│   ├── routes/
│   │   ├── auth.js               Token验证
│   │   ├── purchase.js           购买记录
│   │   ├── release.js            安装包管理
│   │   ├── landing.js            落地页管理
│   │   └── admin.js              后台统计
│   ├── middleware/
│   │   ├── verifyToken.js        Casdoor Token验证
│   │   └── adminAuth.js          管理后台鉴权
│   ├── services/
│   │   ├── qrcode.js             二维码生成
│   │   └── landingPage.js        落地页HTML处理
│   └── uploads/                  文件存储目录
│       ├── releases/             安装包
│       │   ├── vidget/
│       │   │   ├── vidget.apk
│       │   │   ├── vidget-setup.exe
│       │   │   └── vidget.dmg
│       │   └── zhujiaoyun/
│       └── landing/              落地页HTML
│           ├── vidget/
│           │   └── index.html
│           └── zhujiaoyun/
│               └── index.html
├── admin/                        管理后台前端（静态）
│   └── index.html
├── package.json
└── .env
```

---

## 五、核心服务代码

### 5.1 安装包上传（release.js）

```javascript
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = `./uploads/releases/${req.body.app_id}`;
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        // 按类型固定文件名，覆盖旧文件
        const ext = path.extname(file.originalname);
        cb(null, `${req.body.app_id}-${req.body.type}${ext}`);
    }
});

const upload = multer({ storage });

router.post('/upload', upload.single('file'), async (req, res) => {
    const { app_id, type, version } = req.body;
    const file = req.file;

    const downloadUrl = `${process.env.BASE_URL}/download/${app_id}/${type}`;

    // UPSERT：存在则覆盖，不存在则新建
    await pool.query(`
        INSERT INTO app_releases (app_id, type, file_path, file_name, file_size, download_url, version, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (app_id, type)
        DO UPDATE SET
            file_path = $3,
            file_name = $4,
            file_size = $5,
            download_url = $6,
            version = $7,
            updated_at = NOW()
    `, [app_id, type, file.path, file.originalname, file.size, downloadUrl, version]);

    res.json({ success: true, download_url: downloadUrl, version });
});

// 公开下载接口
router.get('/download/:app_id/:type', async (req, res) => {
    const { app_id, type } = req.params;
    const result = await pool.query(
        'SELECT * FROM app_releases WHERE app_id = $1 AND type = $2',
        [app_id, type]
    );
    if (!result.rows[0]) return res.status(404).json({ error: '未找到安装包' });
    res.download(result.rows[0].file_path, result.rows[0].file_name);
});

module.exports = router;
```

---

### 5.2 落地页处理（landingPage.js）

```javascript
const fs = require('fs');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function renderLandingPage(slug) {
    // 1. 查找落地页
    const lpResult = await pool.query(
        'SELECT * FROM landing_pages WHERE slug = $1 AND is_published = true',
        [slug]
    );
    if (!lpResult.rows[0]) return null;
    const lp = lpResult.rows[0];

    // 2. 读取HTML模板
    const htmlPath = `./uploads/landing/${lp.app_id}/index.html`;
    if (!fs.existsSync(htmlPath)) return null;
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // 3. 查询所有安装包
    const releases = await pool.query(
        'SELECT * FROM app_releases WHERE app_id = $1',
        [lp.app_id]
    );

    // 4. 生成下载按钮HTML
    const typeLabels = { apk: 'Android', exe: 'Windows', dmg: 'macOS', web: '网页版' };
    const buttonsHtml = releases.rows.map(r => {
        const sizeMB = r.file_size ? (r.file_size / 1024 / 1024).toFixed(1) + ' MB · ' : '';
        const label = typeLabels[r.type] || r.type;
        return `<a class="download-btn" href="${r.download_url}">
            下载 ${label} 版 · ${sizeMB}v${r.version}
        </a>`;
    }).join('\n');

    // 5. 生成二维码（当前页面URL）
    const pageUrl = `${process.env.BASE_URL}/get/${slug}`;
    const qrcodeDataUrl = await QRCode.toDataURL(pageUrl);

    // 6. 注入到HTML
    html = html.replace(
        '<div id="vidget-download-buttons"></div>',
        `<div id="vidget-download-buttons">${buttonsHtml}</div>`
    );
    html = html.replace(
        /src="" alt="扫码下载"/,
        `src="${qrcodeDataUrl}" alt="扫码下载"`
    );

    return html;
}

module.exports = { renderLandingPage };
```

---

### 5.3 落地页路由（landing.js）

```javascript
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { renderLandingPage } = require('../services/landingPage');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 公开访问落地页
router.get('/get/:slug', async (req, res) => {
    const html = await renderLandingPage(req.params.slug);
    if (!html) return res.status(404).send('页面不存在或未发布');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

// 上传落地页HTML
const lpStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = `./uploads/landing/${req.body.app_id}`;
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'index.html')
});
const lpUpload = multer({ storage: lpStorage });

router.post('/admin/landing/upload', lpUpload.single('html_file'), async (req, res) => {
    const { app_id, slug } = req.body;
    const finalSlug = slug || app_id;

    await pool.query(`
        INSERT INTO landing_pages (app_id, slug, html_path, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (app_id)
        DO UPDATE SET slug = $2, html_path = $3, updated_at = NOW()
    `, [app_id, finalSlug, `./uploads/landing/${app_id}/index.html`]);

    res.json({
        success: true,
        preview_url: `${process.env.BASE_URL}/get/${finalSlug}`
    });
});

// 发布落地页
router.post('/admin/landing/publish/:app_id', async (req, res) => {
    await pool.query(
        'UPDATE landing_pages SET is_published = true, published_at = NOW() WHERE app_id = $1',
        [req.params.app_id]
    );
    res.json({ success: true });
});

// 下线落地页
router.post('/admin/landing/unpublish/:app_id', async (req, res) => {
    await pool.query(
        'UPDATE landing_pages SET is_published = false WHERE app_id = $1',
        [req.params.app_id]
    );
    res.json({ success: true });
});

module.exports = router;
```

---

## 六、依赖安装

```bash
npm install express pg multer qrcode uuid axios dotenv
npm install pm2 -g
```

---

## 七、环境变量 .env

```env
DATABASE_URL=postgresql://user:password@localhost:5432/user_center
CASDOOR_ENDPOINT=https://account.yourdomain.com
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
BASE_URL=https://api.yourdomain.com
ADMIN_SECRET=your_admin_secret_key
PORT=3000
```

---

## 八、Nginx 配置

```nginx
# 授权服务 API
server {
    listen 443 ssl;
    server_name api.yourdomain.com;
    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    # 落地页（公开访问）
    location /get/ {
        proxy_pass http://localhost:3000;
    }

    # 下载接口（公开访问）
    location /download/ {
        proxy_pass http://localhost:3000;
    }

    # API接口
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # 管理后台静态文件
    location /admin/ {
        root /var/www/user-center;
        try_files $uri $uri/ /admin/index.html;
    }

    # 上传文件大小限制（安装包可能很大）
    client_max_body_size 200M;
}
```

---

## 九、落地页HTML模板规范

你自己设计HTML时需要遵守以下占位符规范，系统会自动注入内容：

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>VidGet - 网页视频下载器</title>
</head>
<body>
    <!-- 你的自定义设计内容 -->
    <h1>VidGet</h1>
    <p>专业的网页视频下载工具</p>

    <!-- 系统自动注入下载按钮，保留此div -->
    <div id="vidget-download-buttons"></div>

    <!-- 系统自动注入二维码，保留src=""和alt属性 -->
    <img id="vidget-qrcode" src="" alt="扫码下载" width="200" height="200" />

</body>
</html>
```

---

## 十、功能开发优先级

```
第一阶段（基础能力）
  → 数据库初始化
  → Casdoor 部署 + 配置
  → 授权服务（Token验证 + 购买记录）
  → App接入登录验证

第二阶段（分发能力）
  → 安装包上传管理
  → 落地页上传 + 发布
  → 公开落地页访问 + 二维码生成
  → 下载接口

第三阶段（管理后台）
  → Dashboard 数据概览
  → 用户列表 + 详情
  → 购买记录查询
  → 应用管理界面
```

---

## 十一、落地页访问效果

用户访问 `https://api.yourdomain.com/get/vidget`，看到：

```
[你上传的自定义HTML设计]
    ↓（系统自动注入）
[下载 Android 版 · 45.6 MB · v1.0.2]
[下载 Windows 版 · 78.2 MB · v1.0.2]
    ↓（系统自动注入）
[二维码图片 → 扫码直达当前页面]
```

---

*文档版本 v2.0 | 统一用户中心 | 含落地页与安装包管理*
