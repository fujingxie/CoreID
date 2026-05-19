const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { pool, query } = require("../config/db");
const { logAdminAction } = require("../services/auditLog");
const { createDefaultLandingDraftFile, getLandingDirectory } = require("../services/landingDraft");
const { createRateLimit } = require("../middleware/rateLimit");
const { renderLandingPage, renderLandingPreviewByAppId } = require("../services/landingPage");
const { ensureAppId, ensurePositiveInteger, ensureSlug } = require("../utils/validation");

const adminRouter = express.Router();
const publicRouter = express.Router();

function createStatusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function toStoragePath(filePath) {
  if (!filePath) {
    return null;
  }
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function removeFileIfExists(filePath) {
  const resolvedPath = toStoragePath(filePath);
  if (resolvedPath && fs.existsSync(resolvedPath)) {
    fs.unlinkSync(resolvedPath);
  }
}

async function withTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureLandingFileExists(filePath) {
  const resolvedPath = toStoragePath(filePath);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw createStatusError(400, "Landing HTML file is missing");
  }
  return resolvedPath;
}

function copyLandingSnapshot(sourceFilePath, appId) {
  const sourcePath = toStoragePath(sourceFilePath);
  const targetDirectory = getLandingDirectory(appId);
  fs.mkdirSync(targetDirectory, { recursive: true });
  const snapshotPath = path.join(targetDirectory, `published-${Date.now()}.html`);
  fs.copyFileSync(sourcePath, snapshotPath);
  return snapshotPath;
}

async function getUnusedLandingPath(client, candidatePath) {
  if (!candidatePath) {
    return null;
  }

  const result = await client.query(
    `
      SELECT (
        COALESCE((SELECT COUNT(*) FROM landing_pages WHERE draft_html_path = $1), 0) +
        COALESCE((SELECT COUNT(*) FROM landing_pages WHERE published_html_path = $1), 0) +
        COALESCE((SELECT COUNT(*) FROM landing_page_versions WHERE html_path = $1), 0)
      )::int AS ref_count
    `,
    [candidatePath]
  );

  return result.rows[0]?.ref_count === 0 ? candidatePath : null;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const directory = getLandingDirectory(ensureAppId(req.body.app_id));
      fs.mkdirSync(directory, { recursive: true });
      cb(null, directory);
    } catch (error) {
      cb(error);
    }
  },
  filename(req, file, cb) {
    cb(null, `draft-${Date.now()}.html`);
  },
});

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    if (!file.originalname.toLowerCase().endsWith(".html")) {
      return cb(new Error("Only HTML files are allowed"));
    }

    return cb(null, true);
  },
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

adminRouter.post(
  "/upload",
  createRateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyPrefix: "admin-landing-upload",
    message: "Landing page uploads are too frequent, please try again later",
  }),
  upload.single("html_file"),
  async (req, res, next) => {
    try {
      const appId = ensureAppId(req.body.app_id);

      if (!req.file) {
        return res.status(400).json({ error: "app_id and html_file are required" });
      }

      const finalSlug = req.body.slug ? ensureSlug(req.body.slug) : ensureSlug(appId, "slug");
      const htmlPath = req.file.path;

      const result = await withTransaction(async (client) => {
        const existingResult = await client.query(
          `
            SELECT draft_html_path, published_html_path
            FROM landing_pages
            WHERE app_id = $1
            LIMIT 1
          `,
          [appId]
        );
        const existing = existingResult.rows[0];

        const upsertResult = await client.query(
          `
            INSERT INTO landing_pages (
              app_id,
              slug,
              html_path,
              draft_html_path,
              draft_updated_at,
              updated_at
            )
            VALUES ($1, $2, $3, $3, NOW(), NOW())
            ON CONFLICT (app_id)
            DO UPDATE SET
              slug = EXCLUDED.slug,
              html_path = EXCLUDED.html_path,
              draft_html_path = EXCLUDED.draft_html_path,
              draft_updated_at = NOW(),
              updated_at = NOW()
            RETURNING *
          `,
          [appId, finalSlug, htmlPath]
        );

        const removableDraftPath =
          existing?.draft_html_path && existing.draft_html_path !== existing.published_html_path
            ? await getUnusedLandingPath(client, existing.draft_html_path)
            : null;

        return {
          landing: upsertResult.rows[0],
          removableDraftPath,
        };
      });

      if (result.removableDraftPath && result.removableDraftPath !== htmlPath) {
        removeFileIfExists(result.removableDraftPath);
      }

      await logAdminAction(req, {
        action: "landing.upload",
        targetType: "landing_page",
        targetId: appId,
        details: {
          app_id: appId,
          slug: finalSlug,
          draft_html_path: htmlPath,
        },
      });

      return res.status(201).json({
        success: true,
        landing: result.landing,
        preview_url: `${process.env.BASE_URL}/api/admin/landing/preview/${appId}`,
      });
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        removeFileIfExists(req.file.path);
      }
      return next(error);
    }
  }
);

adminRouter.post("/create", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.body.app_id);
    const slug = req.body.slug ? ensureSlug(req.body.slug) : ensureSlug(appId, "slug");

    const result = await withTransaction(async (client) => {
      const appResult = await client.query(
        `
          SELECT id, name, description
          FROM applications
          WHERE id = $1
          LIMIT 1
        `,
        [appId]
      );
      const app = appResult.rows[0];
      if (!app) {
        throw createStatusError(404, "Application not found");
      }

      const existingLanding = await client.query(
        `
          SELECT id
          FROM landing_pages
          WHERE app_id = $1
          LIMIT 1
        `,
        [appId]
      );
      if (existingLanding.rows[0]) {
        throw createStatusError(409, "Landing page already exists for this application");
      }

      const slugConflict = await client.query(
        `
          SELECT id
          FROM landing_pages
          WHERE slug = $1
          LIMIT 1
        `,
        [slug]
      );
      if (slugConflict.rows[0]) {
        throw createStatusError(409, "Slug is already in use");
      }

      const draftPath = createDefaultLandingDraftFile({
        appId,
        appName: app.name,
        description: app.description,
        slug,
      });

      const createResult = await client.query(
        `
          INSERT INTO landing_pages (
            app_id,
            slug,
            html_path,
            draft_html_path,
            draft_updated_at,
            updated_at
          )
          VALUES ($1, $2, $3, $3, NOW(), NOW())
          RETURNING *
        `,
        [appId, slug, draftPath]
      );

      return createResult.rows[0];
    });

    await logAdminAction(req, {
      action: "landing.create",
      targetType: "landing_page",
      targetId: appId,
      details: {
        app_id: appId,
        slug,
      },
    });

    return res.status(201).json({
      success: true,
      landing: result,
      preview_url: `${process.env.BASE_URL}/api/admin/landing/preview/${appId}`,
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/publish/:app_id", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const result = await withTransaction(async (client) => {
      const landingResult = await client.query(
        `
          SELECT *
          FROM landing_pages
          WHERE app_id = $1
          LIMIT 1
        `,
        [appId]
      );
      const landing = landingResult.rows[0];

      if (!landing) {
        throw createStatusError(404, "Landing page not found");
      }

      const draftPath = landing.draft_html_path || landing.html_path;
      await ensureLandingFileExists(draftPath);

      const snapshotPath = copyLandingSnapshot(draftPath, appId);

      await client.query(
        `
          UPDATE landing_page_versions
          SET is_current = false
          WHERE app_id = $1
        `,
        [appId]
      );

      const versionResult = await client.query(
        `
          INSERT INTO landing_page_versions (
            app_id,
            slug_snapshot,
            html_path,
            is_current,
            published_at
          )
          VALUES ($1, $2, $3, true, NOW())
          RETURNING *
        `,
        [appId, landing.slug, snapshotPath]
      );

      const updateResult = await client.query(
        `
          UPDATE landing_pages
          SET
            html_path = $2,
            published_html_path = $2,
            is_published = true,
            published_at = NOW(),
            updated_at = NOW()
          WHERE app_id = $1
          RETURNING *
        `,
        [appId, snapshotPath]
      );

      return {
        landing: updateResult.rows[0],
        version: versionResult.rows[0],
      };
    });

    await logAdminAction(req, {
      action: "landing.publish",
      targetType: "landing_page",
      targetId: appId,
      details: {
        app_id: appId,
        slug: result.landing.slug,
        version_id: result.version.id,
      },
    });

    return res.json({ success: true, landing: result.landing, version: result.version });
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/unpublish/:app_id", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const result = await query(
      `
        UPDATE landing_pages
        SET is_published = false, updated_at = NOW()
        WHERE app_id = $1
        RETURNING *
      `,
      [appId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Landing page not found" });
    }

    await logAdminAction(req, {
      action: "landing.unpublish",
      targetType: "landing_page",
      targetId: appId,
      details: {
        app_id: appId,
        slug: result.rows[0].slug,
      },
    });

    return res.json({ success: true, landing: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/preview/:app_id", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const html = await renderLandingPreviewByAppId(appId);

    if (!html) {
      return res.status(404).send("草稿不存在，请先上传 HTML");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/versions/:app_id", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const result = await query(
      `
        SELECT id, app_id, slug_snapshot, html_path, is_current, published_at, created_at
        FROM landing_page_versions
        WHERE app_id = $1
        ORDER BY is_current DESC, published_at DESC
      `,
      [appId]
    );

    return res.json({ items: result.rows });
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/restore/:version_id", async (req, res, next) => {
  try {
    const versionId = ensurePositiveInteger(req.params.version_id, "version_id");
    const restored = await withTransaction(async (client) => {
      const versionResult = await client.query(
        `
          SELECT *
          FROM landing_page_versions
          WHERE id = $1
          LIMIT 1
        `,
        [versionId]
      );
      const version = versionResult.rows[0];

      if (!version) {
        throw createStatusError(404, "Landing page version not found");
      }

      await ensureLandingFileExists(version.html_path);

      await client.query(
        `
          UPDATE landing_page_versions
          SET is_current = false
          WHERE app_id = $1
        `,
        [version.app_id]
      );

      await client.query(
        `
          UPDATE landing_page_versions
          SET is_current = true
          WHERE id = $1
        `,
        [versionId]
      );

      const landingResult = await client.query(
        `
          UPDATE landing_pages
          SET
            html_path = $2,
            published_html_path = $2,
            is_published = true,
            published_at = NOW(),
            updated_at = NOW()
          WHERE app_id = $1
          RETURNING *
        `,
        [version.app_id, version.html_path]
      );

      return {
        version,
        landing: landingResult.rows[0],
      };
    });

    await logAdminAction(req, {
      action: "landing.restore",
      targetType: "landing_page_version",
      targetId: String(versionId),
      details: {
        app_id: restored.version.app_id,
        slug: restored.landing?.slug || restored.version.slug_snapshot,
      },
    });

    return res.json({ success: true, landing: restored.landing });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/info/:app_id", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const result = await query(
      `
        SELECT *
        FROM landing_pages
        WHERE app_id = $1
        LIMIT 1
      `,
      [appId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Landing page not found" });
    }

    return res.json({
      ...result.rows[0],
      url: `${process.env.BASE_URL}/get/${result.rows[0].slug}`,
      preview_url: `${process.env.BASE_URL}/api/admin/landing/preview/${appId}`,
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/list", async (req, res, next) => {
  try {
    const result = await query(
      `
        SELECT
          a.id AS app_id,
          a.name,
          a.description,
          lp.slug,
          lp.html_path,
          lp.draft_html_path,
          lp.published_html_path,
          lp.is_published,
          lp.published_at,
          lp.draft_updated_at,
          lp.updated_at,
          version_summary.version_count,
          version_summary.last_version_published_at
        FROM applications a
        LEFT JOIN landing_pages lp ON lp.app_id = a.id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS version_count,
            MAX(published_at) AS last_version_published_at
          FROM landing_page_versions
          WHERE app_id = a.id
        ) version_summary ON true
        ORDER BY a.created_at ASC
      `
    );

    return res.json({
      items: result.rows.map((item) => ({
        ...item,
        url: item.slug ? `${process.env.BASE_URL}/get/${item.slug}` : null,
        preview_url: `${process.env.BASE_URL}/api/admin/landing/preview/${item.app_id}`,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

publicRouter.get("/get/:slug", async (req, res, next) => {
  try {
    const html = await renderLandingPage(ensureSlug(req.params.slug));

    if (!html) {
      return res.status(404).send("页面不存在或尚未发布");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (error) {
    return next(error);
  }
});

module.exports = {
  adminRouter,
  publicRouter,
};
