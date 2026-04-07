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
    provider: MODEL_TAG
  });
});

async function analyzeImage(body) {
  const payload = body || {};
  const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl : "";
  const imageDataUrl = payload.imageDataUrl;

  if (!imageDataUrl || typeof imageDataUrl !== "string") {
    const inputError = new Error("imageDataUrl is required and must be a string.");
    inputError.code = "INVALID_INPUT";
    inputError.statusCode = 400;
    throw inputError;
  }

  return callUpstreamAnalyze({
    imageUrl: imageUrl,
    imageDataUrl: imageDataUrl
  });
}

app.post("/api/analyze-image", async function analyzeImageHandler(req, res) {
  try {
    const result = await analyzeImage(req.body);
    res.json(result);
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
