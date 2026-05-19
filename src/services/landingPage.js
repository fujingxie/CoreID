const fs = require("fs");
const path = require("path");
const { query } = require("../config/db");
const { generateDataUrl } = require("./qrcode");

const RELEASE_LABELS = {
  apk: "Android",
  exe: "Windows",
  dmg: "macOS",
  web: "网页版",
  appstore: "App Store",
};

function formatBytes(bytes) {
  if (!bytes) {
    return "";
  }

  return `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;
}

function injectElementById(html, tagName, idValue, replacement) {
  const pattern = new RegExp(
    `<${tagName}([^>]*id=["']${idValue}["'][^>]*)>[\\s\\S]*?<\\/${tagName}>`,
    "i"
  );

  return html.replace(pattern, replacement);
}

function injectImageSource(html, idValue, src) {
  const pattern = new RegExp(
    `(<img[^>]*id=["']${idValue}["'][^>]*src=["'])[^"']*(["'][^>]*>)`,
    "i"
  );

  return html.replace(pattern, `$1${src}$2`);
}

async function buildDownloadButtons(appId) {
  const result = await query(
    `
      SELECT type, file_size, version, download_url, web_url
      FROM app_releases
      WHERE app_id = $1
      ORDER BY updated_at DESC
    `,
    [appId]
  );

  return result.rows
    .map((release) => {
      const href = release.web_url || release.download_url;
      const label = RELEASE_LABELS[release.type] || release.type;
      const size = formatBytes(release.file_size);
      const segments = [`下载 ${label}`, size, release.version ? `v${release.version}` : ""].filter(Boolean);

      return `<a class="download-btn" href="${href}" target="_blank" rel="noreferrer">${segments.join(
        " · "
      )}</a>`;
    })
    .join("\n");
}

async function buildRenderedLandingHtml({ appId, slug, htmlPath }) {
  if (!htmlPath) {
    return null;
  }

  const resolvedPath = path.isAbsolute(htmlPath) ? htmlPath : path.join(process.cwd(), htmlPath);
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  let html = fs.readFileSync(resolvedPath, "utf8");
  const buttonsHtml = await buildDownloadButtons(appId);
  const pageUrl = `${process.env.BASE_URL}/get/${slug}`;
  const qrcode = await generateDataUrl(pageUrl);

  const buttonIds = [`${appId}-download-buttons`, `${slug}-download-buttons`, "download-buttons"];
  const qrIds = [`${appId}-qrcode`, `${slug}-qrcode`, "qrcode"];

  for (const buttonId of buttonIds) {
    const nextHtml = injectElementById(
      html,
      "div",
      buttonId,
      `<div id="${buttonId}">${buttonsHtml}</div>`
    );

    if (nextHtml !== html) {
      html = nextHtml;
      break;
    }
  }

  for (const qrId of qrIds) {
    const nextHtml = injectImageSource(html, qrId, qrcode);

    if (nextHtml !== html) {
      html = nextHtml;
      break;
    }
  }

  return html;
}

async function renderLandingPreviewByAppId(appId) {
  const result = await query(
    `
      SELECT slug, draft_html_path, published_html_path, html_path
      FROM landing_pages
      WHERE app_id = $1
      LIMIT 1
    `,
    [appId]
  );

  const landing = result.rows[0];
  if (!landing) {
    return null;
  }

  const htmlPath = landing.draft_html_path || landing.published_html_path || landing.html_path;
  return buildRenderedLandingHtml({
    appId,
    slug: landing.slug,
    htmlPath,
  });
}

async function renderLandingPage(slug) {
  const result = await query(
    `
      SELECT lp.app_id, lp.slug, lp.published_html_path, lp.html_path
      FROM landing_pages lp
      WHERE lp.slug = $1 AND lp.is_published = true
      LIMIT 1
    `,
    [slug]
  );

  const landing = result.rows[0];
  if (!landing) {
    return null;
  }

  return buildRenderedLandingHtml({
    appId: landing.app_id,
    slug: landing.slug,
    htmlPath: landing.published_html_path || landing.html_path,
  });
}

module.exports = {
  renderLandingPage,
  renderLandingPreviewByAppId,
};
