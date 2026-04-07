(function initApi(global) {
  const root = global.ImgtoPrompt || (global.ImgtoPrompt = {});
  const REMOTE_ANALYZE_ENDPOINT = "https://pinterest-plugin-server.onrender.com/api/analyze-image";

  async function analyzeImage(imageUrl, options) {
    const opts = options || {};
    const safeImageUrl = String(imageUrl || "");
    const imageDataUrl = String(opts.imageDataUrl || "");
    if (!safeImageUrl && !imageDataUrl) {
      throw new Error("No image payload provided.");
    }

    const useMock = opts.useMock === true;

    if (useMock) {
      if (!root.mockApi || typeof root.mockApi.mockAnalyzeImage !== "function") {
        throw new Error("Mock API is unavailable.");
      }
      return root.mockApi.mockAnalyzeImage({
        imageUrl: safeImageUrl,
        shouldFail: Boolean(opts.shouldFail),
        delayMs: opts.delayMs
      });
    }

    if (!imageDataUrl) {
      throw new Error("未生成图片 base64 数据，请重试。");
    }

    const endpoint = opts.endpoint || REMOTE_ANALYZE_ENDPOINT;
    let response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          imageUrl: safeImageUrl,
          imageDataUrl: imageDataUrl
        })
      });
    } catch (error) {
      throw new Error("无法连接线上后端，请稍后重试。");
    }

    const rawText = await response.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (error) {
      throw new Error("后端返回了无效 JSON。");
    }

    if (!response.ok) {
      const errorObject = data && data.error && typeof data.error === "object" ? data.error : {};
      const message =
        errorObject.message ||
        data.message ||
        `分析接口请求失败（HTTP ${response.status}）。`;
      const apiError = new Error(String(message));
      apiError.code = errorObject.code || `HTTP_${response.status}`;
      apiError.type = errorObject.type || "";
      apiError.upstream = data && data.upstream ? data.upstream : null;
      throw apiError;
    }

    return data;
  }

  root.api = {
    analyzeImage: analyzeImage
  };
})(globalThis);
