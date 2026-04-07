const crypto = require("crypto");

const CURRENT_MODEL = String(process.env.GEMINI_MODEL || process.env.KIMI_MODEL || "gemini-2.5-flash").trim() || "gemini-2.5-flash";
const CURRENT_API_URL = (
  process.env.GEMINI_API_URL ||
  process.env.KIMI_API_URL ||
  process.env.UPSTREAM_API_URL ||
  ""
).trim();
const CURRENT_RAW_API_KEY =
  process.env.GEMINI_API_KEY || process.env.KIMI_API_KEY || process.env.UPSTREAM_API_KEY || "";
const CURRENT_API_KEY = normalizeApiKey(CURRENT_RAW_API_KEY);
const MODEL_TAG = /gemini/i.test(CURRENT_MODEL) ? "GEMINI" : "KIMI";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || "20000", 10) || 20000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = Math.min(REQUEST_TIMEOUT_MS, 20000);
const ANALYZE_CACHE_TTL_MS = Number.parseInt(process.env.ANALYZE_CACHE_TTL_MS || "600000", 10) || 600000;
const ANALYZE_CACHE_MAX_ITEMS = 200;
const DEBUG_UPSTREAM_RAW = /^(1|true|yes)$/i.test(String(process.env.DEBUG_UPSTREAM_RAW || ""));
const ANALYZE_CACHE_VERSION = "v3-extension-data-url";

const analyzeResultCache = new Map();
const inFlightAnalyzeRequests = new Map();

function nowMs() {
  return Date.now();
}

function durationFrom(startMs) {
  return Math.max(0, nowMs() - startMs);
}

function logTiming(modelTag, stage, ms, extra) {
  const suffix = extra ? ` | ${extra}` : "";
  console.log(`[${modelTag}][TIMING] ${stage}: ${ms}ms${suffix}`);
}

function deepClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return value;
  }
}

function createAnalyzeCacheKey(imageUrl, imageDataUrl) {
  const imageDataDigest = crypto.createHash("sha1").update(String(imageDataUrl || "")).digest("hex");
  return crypto
    .createHash("sha1")
    .update(`${ANALYZE_CACHE_VERSION}:${String(imageUrl || "")}:${imageDataDigest}`)
    .digest("hex");
}

function getCachedAnalyzeResult(cacheKey) {
  const cached = analyzeResultCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= nowMs()) {
    analyzeResultCache.delete(cacheKey);
    return null;
  }

  return deepClone(cached.value);
}

function cleanupAnalyzeCache() {
  const current = nowMs();
  for (const [key, value] of analyzeResultCache.entries()) {
    if (!value || value.expiresAt <= current) {
      analyzeResultCache.delete(key);
    }
  }

  if (analyzeResultCache.size <= ANALYZE_CACHE_MAX_ITEMS) {
    return;
  }

  const overflow = analyzeResultCache.size - ANALYZE_CACHE_MAX_ITEMS;
  let removed = 0;
  for (const key of analyzeResultCache.keys()) {
    analyzeResultCache.delete(key);
    removed += 1;
    if (removed >= overflow) {
      break;
    }
  }
}

function setCachedAnalyzeResult(cacheKey, value) {
  cleanupAnalyzeCache();
  analyzeResultCache.set(cacheKey, {
    expiresAt: nowMs() + ANALYZE_CACHE_TTL_MS,
    value: deepClone(value)
  });
}

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

function normalizeApiKey(rawValue) {
  const raw = String(rawValue || "");
  const noBom = raw.replace(/\uFEFF/g, "");
  const unquoted =
    (noBom.startsWith('"') && noBom.endsWith('"')) || (noBom.startsWith("'") && noBom.endsWith("'"))
      ? noBom.slice(1, -1)
      : noBom;
  return unquoted.replace(/[\r\n\t]/g, "").replace(/\s+/g, "").trim();
}

function keyFingerprint(key) {
  if (!key) {
    return "EMPTY";
  }
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
}

function inspectKey(rawValue, normalizedValue) {
  const raw = String(rawValue || "");
  return {
    rawLength: raw.length,
    normalizedLength: String(normalizedValue || "").length,
    hasWhitespace: /\s/.test(raw),
    hasInvisibleChars: /[\u200B-\u200D\uFEFF]/.test(raw),
    changedAfterNormalize: raw !== String(normalizedValue || "")
  };
}

function inferImageMimeType(contentTypeHeader, imageUrl, buffer) {
  const fromHeader = String(contentTypeHeader || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (fromHeader === "image/jpeg" || fromHeader === "image/jpg") {
    return "image/jpeg";
  }
  if (fromHeader === "image/png") {
    return "image/png";
  }

  if (buffer && buffer.length >= 4) {
    const isPng =
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    if (isPng) {
      return "image/png";
    }
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (isJpeg) {
      return "image/jpeg";
    }
  }

  const lowerUrl = String(imageUrl || "").toLowerCase();
  if (lowerUrl.includes(".png")) {
    return "image/png";
  }
  return "image/jpeg";
}

function isPinterestImageHost(urlValue) {
  try {
    const url = new URL(urlValue);
    return /(^|\.)pinimg\.com$/i.test(url.hostname);
  } catch (error) {
    return false;
  }
}

function buildImageUrlCandidates(imageUrl) {
  const original = String(imageUrl || "").trim();
  if (!original) {
    return [];
  }

  if (!isPinterestImageHost(original)) {
    return [original];
  }

  const candidates = [];
  const sizes = ["564x", "474x"];
  sizes.forEach((size) => {
    try {
      const url = new URL(original);
      const nextPath = url.pathname.replace(/\/(originals|1200x|736x|564x|474x|236x)\//i, `/${size}/`);
      if (nextPath !== url.pathname) {
        url.pathname = nextPath;
        candidates.push(url.toString());
      }
    } catch (error) {
      // Ignore malformed URL transformation.
    }
  });

  candidates.push(original);
  return Array.from(new Set(candidates));
}

async function downloadImageAsDataUrl(imageUrl, modelTag) {
  if (!imageUrl) {
    const error = new Error("图片地址为空，无法下载图片。");
    error.code = "IMAGE_URL_REQUIRED";
    error.statusCode = 400;
    throw error;
  }

  const overallStartMs = nowMs();
  const imageCandidates = buildImageUrlCandidates(imageUrl);
  const attemptErrors = [];

  for (let index = 0; index < imageCandidates.length; index += 1) {
    const candidateUrl = imageCandidates[index];
    const downloadStartMs = nowMs();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(candidateUrl, {
        method: "GET",
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        },
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error && error.name === "AbortError") {
        attemptErrors.push(`候选图 ${index + 1} 下载超时`);
      } else {
        attemptErrors.push(`候选图 ${index + 1} 下载失败`);
      }
      continue;
    } finally {
      clearTimeout(timeoutId);
    }

    console.log(`[${modelTag}] image download status:`, response.status, response.statusText);
    logTiming(modelTag, "image_download_attempt", durationFrom(downloadStartMs), `${index + 1}/${imageCandidates.length}`);

    if (!response.ok) {
      attemptErrors.push(`候选图 ${index + 1} HTTP ${response.status}`);
      continue;
    }

    let buffer;
    const readStartMs = nowMs();
    try {
      const arrBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrBuffer);
    } catch (error) {
      attemptErrors.push(`候选图 ${index + 1} 读取失败`);
      continue;
    }
    logTiming(modelTag, "image_read_buffer", durationFrom(readStartMs), `${index + 1}/${imageCandidates.length}`);

    if (!buffer || buffer.length === 0) {
      attemptErrors.push(`候选图 ${index + 1} 内容为空`);
      continue;
    }

    const encodeStartMs = nowMs();
    const mimeType = inferImageMimeType(response.headers.get("content-type"), candidateUrl, buffer);
    const base64 = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;
    logTiming(modelTag, "image_base64_encode", durationFrom(encodeStartMs), `${index + 1}/${imageCandidates.length}`);

    console.log(`[${modelTag}] image source url:`, candidateUrl);
    console.log(`[${modelTag}] image mime:`, mimeType);
    console.log(`[${modelTag}] image bytes:`, buffer.length);
    logTiming(modelTag, "image_prepare_total", durationFrom(overallStartMs));

    return {
      mimeType: mimeType,
      dataUrl: dataUrl,
      sourceUrl: candidateUrl
    };
  }

  const failError = new Error(
    `图片下载失败，请确认图片链接可访问。${attemptErrors.length ? `(${attemptErrors.join("；")})` : ""}`
  );
  failError.code = "IMAGE_DOWNLOAD_FAILED";
  failError.statusCode = 502;
  throw failError;
}

function resolveChatCompletionsEndpoint(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) {
    return "";
  }
  if (/\/openai\/chat\/completions\/?$/i.test(input)) {
    return input.replace(/\/+$/, "");
  }
  if (/\/openai\/?$/i.test(input)) {
    return `${input.replace(/\/+$/, "")}/chat/completions`;
  }
  if (/\/chat\/completions\/?$/i.test(input)) {
    return input.replace(/\/+$/, "");
  }
  if (/generativelanguage\.googleapis\.com/i.test(input) && /\/v1beta\/?$/i.test(input)) {
    return `${input.replace(/\/+$/, "")}/openai/chat/completions`;
  }
  if (/\/v1\/?$/i.test(input)) {
    return `${input.replace(/\/+$/, "")}/chat/completions`;
  }
  return input.replace(/\/+$/, "");
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (error) {
    return null;
  }
}

function normalizeTags(raw) {
  const EN_TO_ZH_TAG_MAP = {
    portrait: "人像",
    "fashion portrait": "时尚人像",
    fashion: "时尚",
    "fashion photography": "时尚摄影",
    "editorial fashion": "杂志时尚",
    "casual wear": "休闲穿搭",
    casual: "休闲风格",
    streetwear: "街头风格",
    "street style": "街头风格",
    "youth culture": "青年文化",
    youthful: "年轻感",
    minimalist: "极简",
    minimal: "极简",
    studio: "棚拍",
    "studio lighting": "棚拍光线",
    playful: "俏皮",
    modern: "现代感",
    cinematic: "电影感",
    "high contrast": "高对比度",
    abstract: "抽象",
    "abstract portrait": "抽象人像",
    distortion: "视觉扭曲",
    "colorful": "高饱和色彩",
    "clean background": "纯色背景"
  };

  function hasCjk(text) {
    return /[\u3400-\u9fff]/.test(String(text || ""));
  }

  function normalizeEnglishKey(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function toChineseTag(tag) {
    const value = String(tag || "").trim();
    if (!value) {
      return "";
    }
    if (hasCjk(value)) {
      return value;
    }
    const key = normalizeEnglishKey(value);
    if (!key) {
      return value;
    }
    if (EN_TO_ZH_TAG_MAP[key]) {
      return EN_TO_ZH_TAG_MAP[key];
    }
    const partial = Object.keys(EN_TO_ZH_TAG_MAP).find((k) => key.includes(k) || k.includes(key));
    if (partial) {
      return EN_TO_ZH_TAG_MAP[partial];
    }
    return value;
  }

  function finalize(list) {
    const normalized = list
      .map((item) => toChineseTag(item))
      .map((item) => String(item).trim())
      .filter(Boolean);

    const deduped = [];
    const seen = new Set();
    normalized.forEach((item) => {
      if (!seen.has(item)) {
        deduped.push(item);
        seen.add(item);
      }
    });
    return deduped.slice(0, 6);
  }

  if (Array.isArray(raw)) {
    return finalize(raw);
  }
  if (typeof raw === "string") {
    const list = raw
      .split(/[，,、/|]/g)
      .map((item) => item.trim())
      .filter(Boolean);
    return finalize(list);
  }
  return [];
}

function normalizeAnalyzeResult(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const tags = normalizeTags(data.tags);
  const jsonResult =
    data.json_result && typeof data.json_result === "object" && !Array.isArray(data.json_result)
      ? data.json_result
      : {
          raw: String(data.raw || "")
        };

  return {
    summary_zh: String(data.summary_zh || ""),
    summary_en: String(data.summary_en || ""),
    tags: tags,
    prompt_zh: String(data.prompt_zh || ""),
    prompt_en: String(data.prompt_en || ""),
    json_result: jsonResult
  };
}

function detectSectionKey(line) {
  const raw = String(line || "");
  if (!raw) {
    return "";
  }

  const lower = raw.toLowerCase();
  if (/prompt[_\s-]*zh|中文\s*prompt|中文提示词/.test(lower)) {
    return "prompt_zh";
  }
  if (/prompt[_\s-]*en|英文\s*prompt|english\s*prompt/.test(lower)) {
    return "prompt_en";
  }
  if (/summary[_\s-]*zh|中文描述|描述/.test(lower)) {
    return "summary_zh";
  }
  if (/summary[_\s-]*en|英文描述|english\s*summary/.test(lower)) {
    return "summary_en";
  }
  if (/风格标签|标签|tags?/.test(lower)) {
    return "tags";
  }
  if (/json|结构化结果/.test(lower)) {
    return "json";
  }
  return "";
}

function parseSectionedText(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = {
    summary_zh: [],
    summary_en: [],
    prompt_zh: [],
    prompt_en: [],
    tags: [],
    json: []
  };

  let activeSection = "";
  lines.forEach((line) => {
    const section = detectSectionKey(line);
    if (section) {
      activeSection = section;
      const inline = line.replace(/^(\d+[\.\)]\s*)?[^:：]*[:：]\s*/, "").trim();
      if (inline) {
        sections[section].push(inline);
      }
      return;
    }

    if (activeSection) {
      sections[activeSection].push(line);
    }
  });

  return {
    summary_zh: sections.summary_zh.join("\n").trim(),
    summary_en: sections.summary_en.join("\n").trim(),
    prompt_zh: sections.prompt_zh.join("\n").trim(),
    prompt_en: sections.prompt_en.join("\n").trim(),
    tags: normalizeTags(sections.tags.join(" ")),
    jsonText: sections.json.join("\n").trim(),
    lines: lines
  };
}

function parseModelOutputToResult(messageText) {
  const parsedJson = extractJsonObject(messageText);
  if (parsedJson) {
    return normalizeAnalyzeResult({
      summary_zh: parsedJson.summary_zh || parsedJson.summaryZh || parsedJson.zh_summary || "",
      summary_en: parsedJson.summary_en || parsedJson.summaryEn || parsedJson.en_summary || "",
      tags: parsedJson.tags || parsedJson.style_tags || parsedJson.styleTags || [],
      prompt_zh: parsedJson.prompt_zh || parsedJson.promptZh || parsedJson.zh_prompt || "",
      prompt_en: parsedJson.prompt_en || parsedJson.promptEn || parsedJson.en_prompt || "",
      json_result: parsedJson.json_result || parsedJson.jsonResult || parsedJson
    });
  }

  // Fallback parsing for plain text responses.
  const text = String(messageText || "").trim();
  const sectionData = parseSectionedText(text);
  const jsonFromSection = extractJsonObject(sectionData.jsonText || "");

  const summaryZh = sectionData.summary_zh || sectionData.lines[0] || text;
  const summaryEn = sectionData.summary_en || "";
  const promptZh = sectionData.prompt_zh || summaryZh;
  const promptEn = sectionData.prompt_en || summaryEn || "";
  const tags = sectionData.tags || [];

  return normalizeAnalyzeResult({
    summary_zh: summaryZh,
    summary_en: summaryEn,
    tags: tags,
    prompt_zh: promptZh,
    prompt_en: promptEn,
    json_result: jsonFromSection || { raw: text }
  });
}

async function callUpstreamAnalyze(params) {
  const analyzeStartMs = nowMs();
  const options = params || {};
  const imageUrl = typeof options.imageUrl === "string" ? options.imageUrl : "";
  const imageDataUrl = typeof options.imageDataUrl === "string" ? options.imageDataUrl : "";
  const modelTag = MODEL_TAG;
  const errorPrefix = MODEL_TAG;

  if (!imageDataUrl) {
    const error = new Error("imageDataUrl is required.");
    error.code = "IMAGE_DATA_URL_REQUIRED";
    error.statusCode = 400;
    throw error;
  }

  const payloadImageUrl = String(imageDataUrl || "").trim();
  const isBase64DataUrl = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(payloadImageUrl);
  if (!isBase64DataUrl) {
    const formatError = new Error("imageDataUrl is not a valid base64 image data URL.");
    formatError.code = "IMAGE_DATA_URL_INVALID";
    formatError.statusCode = 400;
    throw formatError;
  }

  const cacheKey = createAnalyzeCacheKey(imageUrl, payloadImageUrl);
  const cachedResult = getCachedAnalyzeResult(cacheKey);
  if (cachedResult) {
    console.log(`[${modelTag}] cache hit:`, cacheKey.slice(0, 8));
    logTiming(modelTag, "analyze_total", durationFrom(analyzeStartMs), "cache_hit");
    return cachedResult;
  }

  if (inFlightAnalyzeRequests.has(cacheKey)) {
    console.log(`[${modelTag}] in-flight dedupe hit:`, cacheKey.slice(0, 8));
    return inFlightAnalyzeRequests.get(cacheKey);
  }

  const runPromise = (async () => {
    const isGeminiModel = /gemini/i.test(CURRENT_MODEL);
    const endpoint = resolveChatCompletionsEndpoint(CURRENT_API_URL);
    const apiKey = CURRENT_API_KEY;
    const rawApiKey = CURRENT_RAW_API_KEY;

    if (!apiKey) {
      const missingKeyError = new Error(`${modelTag} API KEY 未配置`);
      missingKeyError.code = `${errorPrefix}_API_KEY_MISSING`;
      missingKeyError.statusCode = 500;
      throw missingKeyError;
    }
    if (!endpoint) {
      const missingUrlError = new Error(`${modelTag} API URL 未配置`);
      missingUrlError.code = `${errorPrefix}_API_URL_MISSING`;
      missingUrlError.statusCode = 500;
      throw missingUrlError;
    }

    const requestHeaders = {
      "Content-Type": "application/json"
    };
    if (!isGeminiModel) {
      requestHeaders.Authorization = `Bearer ${apiKey}`;
    }

    let requestEndpoint = endpoint;
    if (isGeminiModel) {
      const geminiEndpoint = resolveChatCompletionsEndpoint(process.env.GEMINI_API_URL || endpoint);
      const geminiKey = String(process.env.GEMINI_API_KEY || apiKey || "").trim();
      const requestUrl = new URL(geminiEndpoint);
      requestUrl.searchParams.set("key", geminiKey);
      requestEndpoint = requestUrl.toString();
    }

    console.log(`[${modelTag}] BASE URL:`, isGeminiModel ? requestEndpoint.replace(/key=[^&]*/i, "key=***") : endpoint);
    console.log(`[${modelTag}] API KEY (masked):`, maskKey(apiKey));
    console.log(`[${modelTag}] API KEY fingerprint:`, keyFingerprint(apiKey));
    console.log(`[${modelTag}] API KEY inspect:`, inspectKey(rawApiKey, apiKey));
    console.log(`[${modelTag}] REQUEST HEADERS:`, {
      "Content-Type": requestHeaders["Content-Type"],
      Authorization: requestHeaders.Authorization ? `Bearer ${maskKey(apiKey)}` : undefined
    });
    if (requestHeaders.Authorization) {
      console.log(`[${modelTag}] AUTH HEADER:`, `Bearer ${maskKey(apiKey)}`);
    }
    console.log("当前模型:", CURRENT_MODEL);

    const imagePrepareStartMs = nowMs();
    const approxBytes = Math.round((payloadImageUrl.length * 3) / 4);
    console.log(`[${modelTag}] image payload isDataUrl:`, isBase64DataUrl);
    console.log(`[${modelTag}] image payload prefix:`, payloadImageUrl.slice(0, 48));
    console.log(`[${modelTag}] image payload bytes(approx):`, approxBytes);
    logTiming(modelTag, "image_prepare_pipeline", durationFrom(imagePrepareStartMs), "from_extension");

    const requestBody = {
      model: CURRENT_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "请分析这张图片，并严格只输出一个 JSON 对象，不要输出任何额外解释、标题、Markdown 或代码块。",
                "字段必须完整包含：",
                "1) summary_zh: 中文描述字符串",
                "2) summary_en: 英文描述字符串",
                "3) tags: 长度为6的中文字符串数组（必须中文，不要英文）",
                "4) prompt_zh: 中文提示词字符串",
                "5) prompt_en: 英文提示词字符串",
                "6) json_result: 对象，包含 subject/style/lighting/composition/mood 字段",
                "请确保所有字段非空；如果无法判断也要给出合理补全。"
              ].join("\n")
            },
            {
              type: "image_url",
              image_url: {
                url: payloadImageUrl
              }
            }
          ]
        }
      ]
    };
    if (!isGeminiModel) {
      // Only send KIMI-specific setting for KIMI-like models.
      requestBody.thinking = {
        type: "disabled"
      };
    }

    const upstreamStartMs = nowMs();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    let response;
    let responseHeaders = {};
    try {
      response = await fetch(requestEndpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        const timeoutError = new Error(`${modelTag} request timed out.`);
        timeoutError.code = `${errorPrefix}_TIMEOUT`;
        timeoutError.statusCode = 504;
        throw timeoutError;
      }

      const causeCode =
        (error && error.cause && error.cause.code) || (error && error.code) || "NETWORK_UNKNOWN";
      const causeMessage =
        (error && error.cause && error.cause.message) ||
        (error && error.message) ||
        String(error || "unknown network error");
      const dnsHint = /ENOTFOUND|EAI_AGAIN|getaddrinfo|resolve host/i.test(causeMessage)
        ? " DNS 解析失败，请检查本机网络、DNS 或代理设置。"
        : "";
      const networkError = new Error(`Failed to connect to ${modelTag} API. ${causeMessage}.${dnsHint}`);
      networkError.code = `${errorPrefix}_NETWORK_ERROR`;
      networkError.statusCode = 502;
      networkError.causeCode = String(causeCode);
      networkError.causeMessage = String(causeMessage);
      throw networkError;
    } finally {
      clearTimeout(timeoutId);
      logTiming(modelTag, "upstream_request_wait", durationFrom(upstreamStartMs));
    }

    responseHeaders = Object.fromEntries(response.headers.entries());
    console.log(`[${modelTag}] upstream response.status:`, response.status);
    console.log(`[${modelTag}] upstream response.statusText:`, response.statusText);
    console.log(`[${modelTag}] upstream response.headers:`, responseHeaders);

    const rawText = await response.text();
    if (DEBUG_UPSTREAM_RAW) {
      console.log(`[${modelTag}] upstream response.body raw:`, rawText);
    } else {
      console.log(`[${modelTag}] upstream response.body size:`, rawText.length);
    }

    let parsed;
    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch (error) {
      if (!response.ok) {
        const nonJsonError = new Error(
          rawText || `${modelTag} request failed with status ${response.status} and non-JSON response.`
        );
        nonJsonError.code = `${errorPrefix}_HTTP_${response.status}`;
        nonJsonError.type = "upstream_non_json_error";
        nonJsonError.statusCode = response.status;
        nonJsonError.upstream = {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: rawText
        };
        throw nonJsonError;
      }

      const parseError = new Error(`${modelTag} response is not valid JSON.`);
      parseError.code = `${errorPrefix}_INVALID_JSON`;
      parseError.type = "invalid_json";
      parseError.statusCode = 502;
      parseError.upstream = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: rawText
      };
      throw parseError;
    }

    if (!response.ok) {
      const errorObj =
        parsed && parsed.error && typeof parsed.error === "object"
          ? parsed.error
          : parsed && typeof parsed === "object"
          ? parsed
          : {};
      const message =
        errorObj.message ||
        errorObj.msg ||
        (parsed && parsed.message) ||
        `${modelTag} request failed with status ${response.status}.`;
      const upstreamCode =
        errorObj.code || (parsed && parsed.code) || `${errorPrefix}_HTTP_${response.status}`;
      const upstreamType = errorObj.type || (parsed && parsed.type) || "";

      const httpError = new Error(String(message));
      httpError.code = String(upstreamCode);
      httpError.type = String(upstreamType);
      httpError.statusCode = response.status;
      httpError.upstream = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: rawText
      };
      throw httpError;
    }

    const parseStartMs = nowMs();
    const content =
      parsed &&
      parsed.choices &&
      Array.isArray(parsed.choices) &&
      parsed.choices[0] &&
      parsed.choices[0].message &&
      typeof parsed.choices[0].message.content === "string"
        ? parsed.choices[0].message.content
        : "";
    const result = parseModelOutputToResult(content);
    logTiming(modelTag, "parse_model_output", durationFrom(parseStartMs));
    setCachedAnalyzeResult(cacheKey, result);
    logTiming(modelTag, "analyze_total", durationFrom(analyzeStartMs), "live");
    return result;
  })();

  inFlightAnalyzeRequests.set(cacheKey, runPromise);
  try {
    return await runPromise;
  } catch (error) {
    logTiming(modelTag, "analyze_total", durationFrom(analyzeStartMs), "failed");
    throw error;
  } finally {
    inFlightAnalyzeRequests.delete(cacheKey);
  }
}

module.exports = {
  callUpstreamAnalyze,
  CURRENT_MODEL,
  MODEL_TAG
};
