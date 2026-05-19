function createRateLimit({ windowMs, max, keyPrefix = "global", message = "Too many requests" }) {
  const store = new Map();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip}`;
    const current = store.get(key);

    if (!current || current.expiresAt <= now) {
      store.set(key, {
        count: 1,
        expiresAt: now + windowMs,
      });
      return next();
    }

    current.count += 1;

    if (current.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.expiresAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: message,
      });
    }

    return next();
  };
}

module.exports = {
  createRateLimit,
};
