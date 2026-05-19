const fs = require("fs");
const path = require("path");

function getLandingDirectory(appId) {
  return path.join(process.cwd(), "src", "uploads", "landing", appId);
}

function createDefaultLandingHtml({ appId, appName, description, slug }) {
  const safeTitle = appName || appId;
  const safeDescription = description || `${safeTitle} 的默认落地页草稿，可继续上传正式 HTML 覆盖。`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle} 下载页</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "PingFang SC", "Noto Sans SC", sans-serif;
        min-height: 100vh;
        background: radial-gradient(circle at top, #20293a, #0b0d12 62%);
        color: #f6f7fb;
        display: grid;
        place-items: center;
        padding: 32px;
      }
      .shell {
        width: min(960px, 100%);
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(12, 15, 22, 0.82);
        border-radius: 28px;
        padding: 44px;
        box-shadow: 0 30px 90px rgba(0, 0, 0, 0.36);
        backdrop-filter: blur(18px);
      }
      .eyebrow {
        display: inline-flex;
        padding: 8px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: #c7d1e6;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 20px 0 12px;
        font-size: clamp(32px, 5vw, 52px);
        line-height: 1.05;
      }
      p {
        margin: 0;
        color: #b7bfd0;
        font-size: 16px;
        line-height: 1.7;
        max-width: 620px;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.25fr 0.75fr;
        gap: 28px;
        margin-top: 34px;
      }
      .card {
        border-radius: 22px;
        padding: 24px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .card h2 {
        margin: 0 0 14px;
        font-size: 18px;
      }
      .download-stack {
        display: grid;
        gap: 12px;
      }
      .download-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 50px;
        padding: 0 18px;
        border-radius: 16px;
        background: #ffffff;
        color: #0d1220;
        font-weight: 600;
        text-decoration: none;
      }
      .qr {
        display: grid;
        place-items: center;
        gap: 14px;
      }
      .qr img {
        width: min(240px, 100%);
        border-radius: 20px;
        background: #fff;
        padding: 12px;
      }
      .slug {
        margin-top: 18px;
        font-size: 13px;
        color: #8891a4;
      }
      @media (max-width: 860px) {
        .shell { padding: 26px; }
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <span class="eyebrow">CoreID Landing Draft</span>
      <h1>${safeTitle}</h1>
      <p>${safeDescription}</p>
      <div class="grid">
        <section class="card">
          <h2>立即下载</h2>
          <div id="${appId}-download-buttons" class="download-stack">
            <a class="download-btn" href="#">发布后自动注入下载按钮</a>
          </div>
        </section>
        <section class="card qr">
          <h2>扫码下载</h2>
          <img id="${appId}-qrcode" src="" alt="扫码下载 ${safeTitle}" />
          <div class="slug">当前草稿路径：/get/${slug}</div>
        </section>
      </div>
    </main>
  </body>
</html>`;
}

function createDefaultLandingDraftFile({ appId, appName, description, slug }) {
  const directory = getLandingDirectory(appId);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `draft-${Date.now()}.html`);
  fs.writeFileSync(
    filePath,
    createDefaultLandingHtml({
      appId,
      appName,
      description,
      slug,
    }),
    "utf8"
  );
  return filePath;
}

module.exports = {
  createDefaultLandingDraftFile,
  createDefaultLandingHtml,
  getLandingDirectory,
};
