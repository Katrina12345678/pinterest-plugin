const fs = require("fs");
const path = require("path");

const FREE_ANALYZE_LIMIT = Math.max(1, Number.parseInt(process.env.FREE_ANALYZE_LIMIT || "30", 10) || 30);
const QUOTA_STORE_FILE = path.resolve(__dirname, "../.quota-store.json");

let loaded = false;
const quotaMap = new Map();

function safeParseNumber(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function sanitizeKey(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "anonymous";
  }
  const safe = raw.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120);
  return safe || "anonymous";
}

function loadStoreIfNeeded() {
  if (loaded) {
    return;
  }
  loaded = true;

  try {
    if (!fs.existsSync(QUOTA_STORE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(QUOTA_STORE_FILE, "utf8");
    const data = raw ? JSON.parse(raw) : {};
    const usage = data && typeof data === "object" && data.usage && typeof data.usage === "object" ? data.usage : {};
    Object.keys(usage).forEach((key) => {
      const safeKey = sanitizeKey(key);
      const used = safeParseNumber(usage[key]);
      if (used > 0) {
        quotaMap.set(safeKey, used);
      }
    });
  } catch (error) {
    console.warn("[Quota] failed to load quota store:", error.message || error);
  }
}

function persistStore() {
  try {
    const usage = {};
    for (const [key, used] of quotaMap.entries()) {
      usage[key] = safeParseNumber(used);
    }

    const payload = JSON.stringify(
      {
        version: 1,
        limit: FREE_ANALYZE_LIMIT,
        usage: usage
      },
      null,
      2
    );

    fs.mkdirSync(path.dirname(QUOTA_STORE_FILE), { recursive: true });
    const tempFile = `${QUOTA_STORE_FILE}.tmp`;
    fs.writeFileSync(tempFile, payload, "utf8");
    fs.renameSync(tempFile, QUOTA_STORE_FILE);
  } catch (error) {
    console.warn("[Quota] failed to persist quota store:", error.message || error);
  }
}

function getQuota(clientKey) {
  loadStoreIfNeeded();
  const key = sanitizeKey(clientKey);
  const used = safeParseNumber(quotaMap.get(key));
  const remaining = Math.max(0, FREE_ANALYZE_LIMIT - used);
  return {
    key: key,
    limit: FREE_ANALYZE_LIMIT,
    used: used,
    remaining: remaining
  };
}

function consumeQuota(clientKey) {
  loadStoreIfNeeded();
  const key = sanitizeKey(clientKey);
  const currentUsed = safeParseNumber(quotaMap.get(key));
  const nextUsed = currentUsed + 1;
  quotaMap.set(key, nextUsed);
  persistStore();

  return {
    key: key,
    limit: FREE_ANALYZE_LIMIT,
    used: nextUsed,
    remaining: Math.max(0, FREE_ANALYZE_LIMIT - nextUsed)
  };
}

module.exports = {
  FREE_ANALYZE_LIMIT,
  getQuota,
  consumeQuota
};
