(function initMockApi(global) {
  const root = global.ImgtoPrompt || (global.ImgtoPrompt = {});

  const FIXED_MOCK_RESULT = {
    summary_zh:
      "一张具有强烈时尚摄影感的人像图像，人物佩戴墨镜，画面具有抽象扭曲效果和电影感光影。",
    summary_en:
      "A fashion-forward portrait image featuring sunglasses, abstract distortion, cinematic lighting, and strong contrast.",
    tags: ["时尚摄影", "抽象人像", "视觉扭曲", "电影感", "高对比度", "现代情绪"],
    prompt_zh:
      "时尚摄影风格，抽象扭曲人像，人物佩戴墨镜，电影感光影，高对比度，现代情绪，杂志感构图，精致细节",
    prompt_en:
      "fashion editorial photography, abstract distorted portrait, sunglasses, cinematic lighting, high contrast, modern mood, magazine composition, refined details",
    json_result: {
      subject: "人物佩戴墨镜的人像",
      style: "时尚摄影 / 电影感 / 抽象扭曲",
      lighting: "高对比度电影光影",
      composition: "近景肖像，杂志构图",
      mood: "现代、冷感、情绪化"
    }
  };

  function cloneResult() {
    return JSON.parse(JSON.stringify(FIXED_MOCK_RESULT));
  }

  function mockAnalyzeImage(payload) {
    const input = payload || {};
    const delay = typeof input.delayMs === "number" ? input.delayMs : 2200;
    const shouldFail = Boolean(input.shouldFail);

    return new Promise(function resolveMock(resolve, reject) {
      global.setTimeout(function completeMock() {
        if (shouldFail || String(input.imageUrl || "").includes("imgtoprompt-force-error")) {
          reject(new Error("Mock analyze request failed."));
          return;
        }

        const result = cloneResult();
        result.image_url = input.imageUrl || "";
        resolve(result);
      }, delay);
    });
  }

  root.mockApi = {
    mockAnalyzeImage: mockAnalyzeImage
  };
})(globalThis);
