const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");

function maskKey(key) {
  const k = String(key || "");
  if (!k) {
    return "EMPTY";
  }
  if (k.length <= 10) {
    return `${k.slice(0, 2)}***${k.slice(-2)}`;
  }
  return `${k.slice(0, 6)}...${k.slice(-4)}`;
}

function keyFingerprint(key) {
  const value = String(key || "");
  if (!value) {
    return "EMPTY";
  }
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const envPath = path.resolve(__dirname, "../.env");
const existingUpstreamKeyBeforeLoad =
  process.env.GEMINI_API_KEY || process.env.KIMI_API_KEY || process.env.UPSTREAM_API_KEY || "";
const dotenvResult = dotenv.config({
  path: envPath,
  override: true
});

console.log("[ENV] path:", envPath);
console.log("[ENV] loaded:", dotenvResult.error ? "no" : "yes");
if (dotenvResult.error) {
  console.log("[ENV] load error:", dotenvResult.error.message);
}
console.log(
  "[ENV] upstream key overridden:",
  existingUpstreamKeyBeforeLoad &&
    existingUpstreamKeyBeforeLoad !==
      (process.env.GEMINI_API_KEY || process.env.KIMI_API_KEY || process.env.UPSTREAM_API_KEY || "")
    ? "yes"
    : "no"
);
console.log(
  "[ENV] GEMINI_API_KEY/KIMI_API_KEY/UPSTREAM_API_KEY (masked):",
  maskKey(process.env.GEMINI_API_KEY || process.env.KIMI_API_KEY || process.env.UPSTREAM_API_KEY || "")
);
console.log(
  "[ENV] GEMINI_API_KEY/KIMI_API_KEY/UPSTREAM_API_KEY fingerprint:",
  keyFingerprint(
    process.env.GEMINI_API_KEY || process.env.KIMI_API_KEY || process.env.UPSTREAM_API_KEY || ""
  )
);

const express = require("express");
const cors = require("cors");
const { callUpstreamAnalyze, CURRENT_MODEL, MODEL_TAG } = require("./upstreamClient");
const { FREE_ANALYZE_LIMIT, getQuota, consumeQuota } = require("./quotaStore");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/health", function health(_req, res) {
  res.json({
    ok: true,
    service: "imgtoprompt-local-server",
    port: PORT,
    model: CURRENT_MODEL,
    provider: MODEL_TAG,
    freeAnalyzeLimit: FREE_ANALYZE_LIMIT
  });
});

function normalizeInstallId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function resolveQuotaClientKey(req, body) {
  const installId = normalizeInstallId(body && body.installId);
  if (installId) {
    return `install:${installId}`;
  }

  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  const ip = forwarded || realIp || req.ip || "unknown_ip";
  const userAgent = String(req.headers["user-agent"] || "unknown_ua");
  const fingerprint = crypto.createHash("sha1").update(`${ip}|${userAgent}`).digest("hex").slice(0, 24);
  return `anon:${fingerprint}`;
}

async function analyzeImage(body) {
  const payload = body || {};
  const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl : "";
  const imageDataUrl = payload.imageDataUrl;
  const detailLevel = payload.detailLevel === "enhanced" ? "enhanced" : "default";

  if (!imageDataUrl || typeof imageDataUrl !== "string") {
    const inputError = new Error("imageDataUrl is required and must be a string.");
    inputError.code = "INVALID_INPUT";
    inputError.statusCode = 400;
    throw inputError;
  }

  return callUpstreamAnalyze({
    imageUrl: imageUrl,
    imageDataUrl: imageDataUrl,
    detailLevel: detailLevel
  });
}

app.post("/api/analyze-image", async function analyzeImageHandler(req, res) {
  const quotaClientKey = resolveQuotaClientKey(req, req.body || {});
  const quotaBefore = getQuota(quotaClientKey);
  if (quotaBefore.remaining <= 0) {
    res.status(429).json({
      error: {
        code: "QUOTA_EXCEEDED",
        message: `免费额度已用完（${quotaBefore.limit}/${quotaBefore.limit}）`,
        type: "quota_limit"
      },
      quota: {
        limit: quotaBefore.limit,
        used: quotaBefore.used,
        remaining: quotaBefore.remaining
      }
    });
    return;
  }

  try {
    const result = await analyzeImage(req.body);
    const quotaAfter = consumeQuota(quotaClientKey);
    res.json({
      ...result,
      quota: {
        limit: quotaAfter.limit,
        used: quotaAfter.used,
        remaining: quotaAfter.remaining
      }
    });
  } catch (error) {
    console.error("analyze-image error:", error);
    const statusCode = Number(error && error.statusCode) || 500;
    const code = (error && error.code) || "ANALYZE_FAILED";
    const message = (error && error.message) || "Analyze failed.";
    const type = (error && error.type) || "";
    const upstream = (error && error.upstream) || null;

    res.status(statusCode).json({
      error: {
        code: code,
        message: message,
        type: type
      },
      upstream: upstream
        ? {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
            body: upstream.body
          }
        : undefined
    });
  }
});

app.use(function notFound(_req, res) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Route not found."
    }
  });
});

app.listen(PORT, function onListen() {
  // eslint-disable-next-line no-console
  console.log(`[ImgtoPrompt Server] listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log("当前提供方:", MODEL_TAG);
  // eslint-disable-next-line no-console
  console.log("当前模型:", CURRENT_MODEL);
});
