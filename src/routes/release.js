const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { pool, query } = require("../config/db");
const { logAdminAction } = require("../services/auditLog");
const { createRateLimit } = require("../middleware/rateLimit");
const { generateDataUrl } = require("../services/qrcode");
const {
  ensureAppId,
  ensureEnum,
  ensureOptionalUrl,
  ensurePositiveInteger,
  ensureVersion,
} = require("../utils/validation");

const router = express.Router();
const publicRouter = express.Router();

const typeToExt = {
  apk: ".apk",
  exe: ".exe",
  dmg: ".dmg",
};
const binaryTypes = Object.keys(typeToExt);
const releaseTypes = [...binaryTypes, "web", "appstore"];

function createStatusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function getReleaseDirectory(appId) {
  return path.join(process.cwd(), "src", "uploads", "releases", appId);
}

function slugifyVersion(version) {
  return String(version || "unversioned").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function makeReleaseFilename(appId, type, version, originalName) {
  const ext = path.extname(originalName || "").toLowerCase() || typeToExt[type] || "";
  const timestamp = Date.now();
  return `${appId}-${type}-${slugifyVersion(version || "latest")}-${timestamp}${ext}`;
}

function getCurrentDownloadUrl(appId, type, webUrl) {
  return webUrl || `${process.env.BASE_URL || ""}/download/${appId}/${type}`;
}

function normalizeRequiredVersion(value) {
  const version = ensureVersion(value);
  if (!version) {
    throw createStatusError(400, "version is required");
  }
  return version;
}

function isBinaryType(type) {
  return binaryTypes.includes(type);
}

function isValidPublicUrl(value) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch (error) {
    return false;
  }
}

function buildReleaseHealth(release) {
  const isExternal = Boolean(release.web_url) || !isBinaryType(release.type);
  const downloadUrl = release.web_url || release.download_url;
  const hasDownloadUrl = Boolean(downloadUrl);
  const checks = [
    {
      key: "download_url",
      ok: hasDownloadUrl,
      label: hasDownloadUrl ? "下载链接已配置" : "缺少下载链接",
    },
  ];

  if (isExternal) {
    const externalUrlValid = isValidPublicUrl(downloadUrl);
    checks.push({
      key: "external_url",
      ok: externalUrlValid,
      label: externalUrlValid ? "外链格式有效" : "外链格式异常",
    });

    return {
      status: checks.every((check) => check.ok) ? "ok" : "error",
      label: checks.every((check) => check.ok) ? "外链已配置" : "外链异常",
      kind: "external",
      checks,
    };
  }

  const fileExists = Boolean(release.file_path && fs.existsSync(release.file_path));
  const hashReady = Boolean(release.sha256);
  checks.push(
    {
      key: "file",
      ok: fileExists,
      label: fileExists ? "文件存在" : "文件缺失",
    },
    {
      key: "sha256",
      ok: hashReady,
      label: hashReady ? "SHA256 已校验" : "缺少 SHA256",
    }
  );

  if (!fileExists || !hasDownloadUrl) {
    return {
      status: "error",
      label: "文件异常",
      kind: "binary",
      checks,
    };
  }

  return {
    status: hashReady ? "ok" : "warning",
    label: hashReady ? "文件正常" : "缺少哈希",
    kind: "binary",
    checks,
  };
}

function serializeRelease(release) {
  return {
    ...release,
    downloads_30d: Number(release.downloads_30d || 0),
    downloads_24h: Number(release.downloads_24h || 0),
    health: buildReleaseHealth(release),
  };
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

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function removeStaleReleaseFiles(filePaths) {
  (filePaths || []).forEach((filePath) => {
    try {
      removeFileIfExists(filePath);
    } catch (error) {
      console.error("[release] failed to remove stale release file", { filePath, error });
    }
  });
}

async function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function validateReleasePayload({ type, version, webUrl, file }) {
  if (!version) {
    throw createStatusError(400, "version is required");
  }

  if (!isBinaryType(type)) {
    if (!webUrl) {
      throw createStatusError(400, "web_url is required for web/appstore releases");
    }
    return {
      sha256: null,
      validation: {
        previousReleaseOverwritten: true,
        metadataValidated: true,
        hashComputed: false,
      },
    };
  }

  if (!file) {
    throw createStatusError(400, "file is required for binary release types");
  }

  const expectedExt = typeToExt[type];
  const actualExt = path.extname(file.originalname || "").toLowerCase();
  if (!expectedExt || actualExt !== expectedExt) {
    throw createStatusError(400, `Binary file extension must be ${expectedExt} for ${type} releases`);
  }

  const stat = fs.statSync(file.path);
  if (!stat.isFile()) {
    throw createStatusError(400, "uploaded release file is invalid");
  }

  if (stat.size <= 0) {
    throw createStatusError(400, "uploaded release file is empty");
  }

  const sha256 = await computeFileSha256(file.path);
  return {
    sha256,
    validation: {
      previousReleaseOverwritten: true,
      metadataValidated: true,
      hashComputed: true,
    },
  };
}

async function upsertCurrentRelease(client, release) {
  const result = await client.query(
    `
      INSERT INTO app_releases (
        app_id,
        type,
        file_path,
        file_name,
        file_size,
        sha256,
        download_url,
        web_url,
        version,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (app_id, type)
      DO UPDATE SET
        file_path = EXCLUDED.file_path,
        file_name = EXCLUDED.file_name,
        file_size = EXCLUDED.file_size,
        sha256 = EXCLUDED.sha256,
        download_url = EXCLUDED.download_url,
        web_url = EXCLUDED.web_url,
        version = EXCLUDED.version,
        updated_at = NOW()
      RETURNING *
    `,
    [
      release.app_id,
      release.type,
      release.file_path || null,
      release.file_name || null,
      release.file_size || null,
      release.sha256 || null,
      release.download_url || null,
      release.web_url || null,
      release.version || null,
    ]
  );

  return result.rows[0];
}

async function syncCurrentReleaseFromVersion(client, version) {
  if (!version) {
    await client.query("DELETE FROM app_releases WHERE app_id = $1 AND type = $2", [
      version?.app_id,
      version?.type,
    ]);
    return null;
  }

  return upsertCurrentRelease(client, version);
}

async function getCurrentVersion(client, appId, type) {
  const result = await client.query(
    `
      SELECT *
      FROM app_release_versions
      WHERE app_id = $1 AND type = $2 AND is_current = true
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [appId, type]
  );
  return result.rows[0] || null;
}

async function getLatestVersion(client, appId, type) {
  const result = await client.query(
    `
      SELECT *
      FROM app_release_versions
      WHERE app_id = $1 AND type = $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [appId, type]
  );
  return result.rows[0] || null;
}

async function setCurrentVersion(client, appId, type, nextCurrentId) {
  await client.query(
    `
      UPDATE app_release_versions
      SET is_current = CASE WHEN id = $1 THEN true ELSE false END
      WHERE app_id = $2 AND type = $3
    `,
    [nextCurrentId || 0, appId, type]
  );
}

async function findOrphanedFilePaths(client, candidatePaths) {
  const uniquePaths = [...new Set((candidatePaths || []).filter(Boolean))];
  const removablePaths = [];

  for (const filePath of uniquePaths) {
    const result = await client.query(
      `
        SELECT (
          COALESCE((SELECT COUNT(*) FROM app_releases WHERE file_path = $1), 0) +
          COALESCE((SELECT COUNT(*) FROM app_release_versions WHERE file_path = $1), 0)
        )::int AS ref_count
      `,
      [filePath]
    );

    if ((result.rows[0]?.ref_count || 0) === 0) {
      removablePaths.push(filePath);
    }
  }

  return removablePaths;
}

async function recordDownload({
  appId,
  type,
  versionId = null,
  version = null,
  downloadKind,
  fileName = null,
  targetUrl = null,
  req,
}) {
  try {
    await query(
      `
        INSERT INTO release_download_logs (
          app_id,
          type,
          version_id,
          version,
          download_kind,
          file_name,
          target_url,
          referer,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        appId,
        type,
        versionId,
        version,
        downloadKind,
        fileName,
        targetUrl,
        req.get("referer") || null,
        req.ip || null,
        req.get("user-agent") || null,
      ]
    );
  } catch (error) {
    console.error("[release] failed to record download", error);
  }
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const appId = ensureAppId(req.body.app_id);
      const directory = getReleaseDirectory(appId);
      fs.mkdirSync(directory, { recursive: true });
      cb(null, directory);
    } catch (error) {
      cb(error);
    }
  },
  filename(req, file, cb) {
    try {
      const appId = ensureAppId(req.body.app_id);
      const type = ensureEnum(req.body.type, "type", binaryTypes);
      const version = normalizeRequiredVersion(req.body.version);
      const originalExt = path.extname(file.originalname || "").toLowerCase();
      const expectedExt = typeToExt[type];
      const ext = originalExt || expectedExt;

      if (ext !== expectedExt) {
        throw createStatusError(400, `Binary file extension must be ${expectedExt} for ${type} releases`);
      }

      cb(null, makeReleaseFilename(appId, type, version, file.originalname || ext));
    } catch (error) {
      cb(error);
    }
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
  fileFilter(req, file, cb) {
    try {
      const type = ensureEnum(req.body.type, "type", binaryTypes);
      const ext = path.extname(file.originalname || "").toLowerCase();
      if (ext && ext !== typeToExt[type]) {
        throw createStatusError(400, `File extension must match ${typeToExt[type]} for ${type} releases`);
      }
      cb(null, true);
    } catch (error) {
      cb(error);
    }
  },
});

router.post(
  "/upload",
  createRateLimit({
    windowMs: 60 * 1000,
    max: 20,
    keyPrefix: "admin-release-upload",
    message: "Release uploads are too frequent, please try again later",
  }),
  upload.single("file"),
  async (req, res, next) => {
    try {
      const appId = ensureAppId(req.body.app_id);
      const type = ensureEnum(req.body.type, "type", releaseTypes);
      const version = normalizeRequiredVersion(req.body.version);
      const webUrl = ensureOptionalUrl(req.body.web_url, "web_url");
      const file = req.file;
      const validated = await validateReleasePayload({ type, version, webUrl, file });
      const downloadUrl = getCurrentDownloadUrl(appId, type, webUrl);

      const result = await withTransaction(async (client) => {
        const currentResult = await client.query(
          `
            SELECT file_path
            FROM app_releases
            WHERE app_id = $1 AND type = $2
            LIMIT 1
          `,
          [appId, type]
        );

        const historyResult = await client.query(
          `
            SELECT file_path
            FROM app_release_versions
            WHERE app_id = $1 AND type = $2
          `,
          [appId, type]
        );

        await client.query("DELETE FROM app_release_versions WHERE app_id = $1 AND type = $2", [appId, type]);

        const currentRelease = await upsertCurrentRelease(client, {
          app_id: appId,
          type,
          file_path: file?.path || null,
          file_name: file?.originalname || null,
          file_size: file?.size || null,
          sha256: validated.sha256,
          download_url: downloadUrl,
          web_url: webUrl || null,
          version,
        });

        const removablePaths = await findOrphanedFilePaths(client, [
          currentResult.rows[0]?.file_path,
          ...historyResult.rows.map((row) => row.file_path),
        ]);

        return {
          release: currentRelease,
          removablePaths,
        };
      });

      removeStaleReleaseFiles(result.removablePaths);

      await logAdminAction(req, {
        action: "release.upload",
        targetType: "release",
        targetId: `${appId}:${type}`,
        details: {
          app_id: appId,
          type,
          version,
          file_name: file?.originalname || null,
          file_sha256: validated.sha256,
          web_url: webUrl,
        },
      });

      return res.status(201).json({
        success: true,
        release: result.release,
        validation: validated.validation,
      });
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        removeFileIfExists(req.file.path);
      }
      return next(error);
    }
  }
);

router.get("/list", async (req, res, next) => {
  try {
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : null;
    const params = [];
    let whereClause = "";

    if (appId) {
      params.push(appId);
      whereClause = "WHERE app_releases.app_id = $1";
    }

    const result = await query(
      `
        SELECT
          app_releases.*,
          COALESCE(download_stats.downloads_30d, 0)::int AS downloads_30d,
          COALESCE(download_stats.downloads_24h, 0)::int AS downloads_24h,
          download_stats.last_download_at
        FROM app_releases
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS downloads_30d,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS downloads_24h,
            MAX(created_at) AS last_download_at
          FROM release_download_logs
          WHERE release_download_logs.app_id = app_releases.app_id
            AND release_download_logs.type = app_releases.type
        ) download_stats ON true
        ${whereClause}
        ORDER BY app_id ASC, updated_at DESC
      `,
      params
    );

    return res.json({ items: result.rows.map(serializeRelease) });
  } catch (error) {
    return next(error);
  }
});

router.get("/versions", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.query.app_id);
    const type = ensureEnum(req.query.type, "type", releaseTypes);
    const result = await query(
      `
        SELECT
          id,
          app_id,
          type,
          version,
          file_path,
          file_name,
          file_size,
          sha256,
          download_url,
          web_url,
          is_current,
          created_at
        FROM app_release_versions
        WHERE app_id = $1 AND type = $2
        ORDER BY is_current DESC, created_at DESC
      `,
      [appId, type]
    );

    return res.json({ items: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/qr", async (req, res, next) => {
  try {
    const versionId = req.query.version_id ? ensurePositiveInteger(req.query.version_id, "version_id") : null;
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : null;
    const type = req.query.type ? ensureEnum(req.query.type, "type", releaseTypes) : null;

    if (!versionId && !(appId && type)) {
      throw createStatusError(400, "version_id or app_id + type is required");
    }

    const result = versionId
      ? await query(
          `
            SELECT app_id, type, version, file_name, web_url, download_url
            FROM app_release_versions
            WHERE id = $1
            LIMIT 1
          `,
          [versionId]
        )
      : await query(
          `
            SELECT app_id, type, version, file_name, web_url, download_url
            FROM app_releases
            WHERE app_id = $1 AND type = $2
            LIMIT 1
          `,
          [appId, type]
        );

    const release = result.rows[0];
    if (!release) {
      throw createStatusError(404, "Release not found");
    }

    const downloadUrl = release.web_url || release.download_url;
    if (!downloadUrl) {
      throw createStatusError(404, "Release download URL is missing");
    }

    const qrCodeDataUrl = await generateDataUrl(downloadUrl);
    return res.json({
      app_id: release.app_id,
      type: release.type,
      version: release.version || null,
      file_name: release.file_name || null,
      download_url: downloadUrl,
      qr_code_data_url: qrCodeDataUrl,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/stats", async (req, res, next) => {
  try {
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : null;
    const type = req.query.type ? ensureEnum(req.query.type, "type", releaseTypes) : null;
    const requestedDays = req.query.days ? ensurePositiveInteger(req.query.days, "days") : 30;
    const days = Math.min(requestedDays, 90);
    const params = [days];
    const conditions = ["created_at >= NOW() - ($1 * INTERVAL '1 day')"];

    if (appId) {
      params.push(appId);
      conditions.push(`app_id = $${params.length}`);
    }

    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [summaryResult, groupedResult, recentResult] = await Promise.all([
      query(
        `
          SELECT
            COUNT(*)::int AS total_downloads,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS downloads_24h,
            COUNT(DISTINCT app_id || ':' || type || ':' || COALESCE(version, 'current'))::int AS release_count,
            MAX(created_at) AS last_download_at
          FROM release_download_logs
          ${whereClause}
        `,
        params
      ),
      query(
        `
          SELECT
            app_id,
            type,
            COALESCE(version, '未标记版本') AS version,
            COUNT(*)::int AS total_downloads,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS downloads_24h,
            MAX(created_at) AS last_download_at
          FROM release_download_logs
          ${whereClause}
          GROUP BY app_id, type, COALESCE(version, '未标记版本')
          ORDER BY total_downloads DESC, last_download_at DESC
          LIMIT 20
        `,
        params
      ),
      query(
        `
          SELECT
            app_id,
            type,
            version_id,
            version,
            download_kind,
            file_name,
            target_url,
            referer,
            ip_address,
            user_agent,
            created_at
          FROM release_download_logs
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT 30
        `,
        params
      ),
    ]);

    return res.json({
      summary: {
        ...(summaryResult.rows[0] || {
          total_downloads: 0,
          downloads_24h: 0,
          release_count: 0,
          last_download_at: null,
        }),
        days,
      },
      grouped: groupedResult.rows,
      recent: recentResult.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/restore/:version_id", async (req, res, next) => {
  try {
    const versionId = ensurePositiveInteger(req.params.version_id, "version_id");
    const restored = await withTransaction(async (client) => {
      const versionResult = await client.query(
        `
          SELECT *
          FROM app_release_versions
          WHERE id = $1
          LIMIT 1
        `,
        [versionId]
      );

      const version = versionResult.rows[0];
      if (!version) {
        throw createStatusError(404, "Release version not found");
      }

      await setCurrentVersion(client, version.app_id, version.type, versionId);
      return syncCurrentReleaseFromVersion(client, { ...version, is_current: true });
    });

    await logAdminAction(req, {
      action: "release.restore",
      targetType: "release_version",
      targetId: String(versionId),
      details: restored,
    });

    return res.json({ success: true, release: restored });
  } catch (error) {
    return next(error);
  }
});

router.delete("/version/:version_id", async (req, res, next) => {
  try {
    const versionId = ensurePositiveInteger(req.params.version_id, "version_id");
    const deleted = await withTransaction(async (client) => {
      const versionResult = await client.query(
        `
          SELECT *
          FROM app_release_versions
          WHERE id = $1
          LIMIT 1
        `,
        [versionId]
      );
      const version = versionResult.rows[0];
      if (!version) {
        throw createStatusError(404, "Release version not found");
      }

      await client.query("DELETE FROM app_release_versions WHERE id = $1", [versionId]);

      let nextCurrent = null;
      if (version.is_current) {
        nextCurrent = await getLatestVersion(client, version.app_id, version.type);
        await setCurrentVersion(client, version.app_id, version.type, nextCurrent?.id || 0);
      } else {
        nextCurrent = await getCurrentVersion(client, version.app_id, version.type);
      }

      if (nextCurrent) {
        nextCurrent = await getCurrentVersion(client, version.app_id, version.type);
      }

      const currentRelease = nextCurrent
        ? await syncCurrentReleaseFromVersion(client, nextCurrent)
        : (await client.query("DELETE FROM app_releases WHERE app_id = $1 AND type = $2", [
            version.app_id,
            version.type,
          ])) && null;

      const removablePaths = await findOrphanedFilePaths(client, [version.file_path]);
      return { version, fallback: currentRelease, removablePaths };
    });

    removeStaleReleaseFiles(deleted.removablePaths);

    await logAdminAction(req, {
      action: "release.version.delete",
      targetType: "release_version",
      targetId: String(versionId),
      details: {
        app_id: deleted.version.app_id,
        type: deleted.version.type,
        version: deleted.version.version,
      },
    });

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.delete("/history/:app_id/:type", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const type = ensureEnum(req.params.type, "type", releaseTypes);
    const deleted = await withTransaction(async (client) => {
      const versionsResult = await client.query(
        `
          SELECT file_path
          FROM app_release_versions
          WHERE app_id = $1 AND type = $2
        `,
        [appId, type]
      );

      if (!versionsResult.rows.length) {
        throw createStatusError(404, "Release history not found");
      }

      await client.query("DELETE FROM app_releases WHERE app_id = $1 AND type = $2", [appId, type]);
      await client.query("DELETE FROM app_release_versions WHERE app_id = $1 AND type = $2", [appId, type]);
      const removablePaths = await findOrphanedFilePaths(
        client,
        versionsResult.rows.map((row) => row.file_path)
      );
      return { removablePaths };
    });

    removeStaleReleaseFiles(deleted.removablePaths);

    await logAdminAction(req, {
      action: "release.history.delete",
      targetType: "release",
      targetId: `${appId}:${type}`,
      details: {
        app_id: appId,
        type,
      },
    });

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:app_id/:type", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const type = ensureEnum(req.params.type, "type", releaseTypes);
    const deleted = await withTransaction(async (client) => {
      const currentReleaseResult = await client.query(
        `
          SELECT *
          FROM app_releases
          WHERE app_id = $1 AND type = $2
          LIMIT 1
        `,
        [appId, type]
      );
      const currentRelease = currentReleaseResult.rows[0];

      if (!currentRelease) {
        throw createStatusError(404, "Release not found");
      }

      const historyResult = await client.query(
        `
          SELECT file_path
          FROM app_release_versions
          WHERE app_id = $1 AND type = $2
        `,
        [appId, type]
      );

      await client.query("DELETE FROM app_releases WHERE app_id = $1 AND type = $2", [appId, type]);
      await client.query("DELETE FROM app_release_versions WHERE app_id = $1 AND type = $2", [appId, type]);

      const removablePaths = await findOrphanedFilePaths(client, [
        currentRelease.file_path,
        ...historyResult.rows.map((row) => row.file_path),
      ]);
      return {
        currentRelease,
        removablePaths,
      };
    });

    removeStaleReleaseFiles(deleted.removablePaths);

    await logAdminAction(req, {
      action: "release.current.delete",
      targetType: "release",
      targetId: `${appId}:${type}`,
      details: {
        app_id: appId,
        type,
        removed_version: deleted.currentRelease.version || null,
      },
    });

    return res.json({
      success: true,
    });
  } catch (error) {
    return next(error);
  }
});

publicRouter.get("/download/:app_id/:type", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const type = ensureEnum(req.params.type, "type", releaseTypes);
    const result = await query(
      `
        SELECT
          file_path,
          file_name,
          web_url,
          version
        FROM app_releases
        WHERE app_id = $1 AND type = $2
        LIMIT 1
      `,
      [appId, type]
    );

    const release = result.rows[0];

    if (!release) {
      return res.status(404).json({ error: "Release not found" });
    }

    await recordDownload({
      appId,
      type,
      versionId: null,
      version: release.version || null,
      downloadKind: "current",
      fileName: release.file_name || null,
      targetUrl: release.web_url || release.file_path || null,
      req,
    });

    if (release.web_url) {
      return res.redirect(release.web_url);
    }

    if (!release.file_path || !fs.existsSync(release.file_path)) {
      return res.status(404).json({ error: "Release file is missing" });
    }

    return res.download(release.file_path, release.file_name || path.basename(release.file_path));
  } catch (error) {
    return next(error);
  }
});

publicRouter.get("/download/version/:version_id", async (req, res, next) => {
  try {
    const versionId = ensurePositiveInteger(req.params.version_id, "version_id");
    const result = await query(
      `
        SELECT app_id, type, version, file_path, file_name, web_url
        FROM app_release_versions
        WHERE id = $1
        LIMIT 1
      `,
      [versionId]
    );

    const release = result.rows[0];
    if (!release) {
      return res.status(404).json({ error: "Release version not found" });
    }

    await recordDownload({
      appId: release.app_id,
      type: release.type,
      versionId,
      version: release.version || null,
      downloadKind: "version",
      fileName: release.file_name || null,
      targetUrl: release.web_url || release.file_path || null,
      req,
    });

    if (release.web_url) {
      return res.redirect(release.web_url);
    }

    if (!release.file_path || !fs.existsSync(release.file_path)) {
      return res.status(404).json({ error: "Release file is missing" });
    }

    return res.download(release.file_path, release.file_name || path.basename(release.file_path));
  } catch (error) {
    return next(error);
  }
});

module.exports = {
  adminRouter: router,
  publicRouter,
};
