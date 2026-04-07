importScripts("utils/constants.js", "utils/mockApi.js", "utils/api.js");

(function initBackground(global) {
  const core = global.ImgtoPrompt || {};
  const constants = core.constants;
  const api = core.api;

  if (!constants || !api) {
    return;
  }

  function inferImageMimeType(contentTypeHeader, imageUrl, bytes) {
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
    if (fromHeader === "image/webp") {
      return "image/webp";
    }

    if (bytes && bytes.length >= 12) {
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      if (isPng) {
        return "image/png";
      }
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (isJpeg) {
        return "image/jpeg";
      }
      const isWebp =
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50;
      if (isWebp) {
        return "image/webp";
      }
    }

    const lowerUrl = String(imageUrl || "").toLowerCase();
    if (lowerUrl.includes(".png")) {
      return "image/png";
    }
    if (lowerUrl.includes(".webp")) {
      return "image/webp";
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
    sizes.forEach(function eachSize(size) {
      try {
        const next = new URL(original);
        const nextPath = next.pathname.replace(/\/(originals|1200x|736x|564x|474x|236x)\//i, `/${size}/`);
        if (nextPath !== next.pathname) {
          next.pathname = nextPath;
          candidates.push(next.toString());
        }
      } catch (error) {
        // Ignore malformed URL transformation.
      }
    });
    candidates.push(original);
    return Array.from(new Set(candidates));
  }

  function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  async function fetchImageAsDataUrl(imageUrl) {
    const sourceUrl = String(imageUrl || "").trim();
    if (!sourceUrl) {
      throw new Error("未找到可分析的图片链接。");
    }

    const timeoutMs = Number(constants.DEFAULTS && constants.DEFAULTS.imageEncodeTimeoutMs) || 8000;
    const candidates = buildImageUrlCandidates(sourceUrl);
    const errors = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const candidateUrl = candidates[index];
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetch(candidateUrl, {
          method: "GET",
          headers: {
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
          },
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) {
          errors.push(`候选图 ${index + 1} HTTP ${response.status}`);
          continue;
        }

        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        if (!bytes.length) {
          errors.push(`候选图 ${index + 1} 内容为空`);
          continue;
        }

        const mimeType = inferImageMimeType(response.headers.get("content-type"), candidateUrl, bytes);
        const base64 = arrayBufferToBase64(arrayBuffer);
        return {
          sourceUrl: candidateUrl,
          dataUrl: `data:${mimeType};base64,${base64}`
        };
      } catch (error) {
        if (error && error.name === "AbortError") {
          errors.push(`候选图 ${index + 1} 下载超时`);
        } else {
          errors.push(`候选图 ${index + 1} 下载失败`);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new Error(
      `图片下载失败，请确认图片链接可访问。${errors.length ? `(${errors.join("；")})` : ""}`
    );
  }

  function createContextMenu() {
    chrome.contextMenus.removeAll(function onRemoved() {
      chrome.contextMenus.create({
        id: constants.MENU_ID,
        title: constants.APP_NAME,
        contexts: ["image"],
        documentUrlPatterns: ["https://*.pinterest.com/*", "https://pinterest.com/*"]
      });
    });
  }

  chrome.runtime.onInstalled.addListener(function onInstalled() {
    createContextMenu();
  });

  chrome.runtime.onStartup.addListener(function onStartup() {
    createContextMenu();
  });

  chrome.contextMenus.onClicked.addListener(function onMenuClicked(info, tab) {
    if (info.menuItemId !== constants.MENU_ID) {
      return;
    }
    if (!tab || typeof tab.id !== "number") {
      return;
    }

    chrome.tabs.sendMessage(
      tab.id,
      {
        type: constants.MESSAGE_TYPE.OPEN_AND_ANALYZE,
        payload: {
          imageUrl: info.srcUrl || "",
          pageUrl: info.pageUrl || tab.url || "",
          source: "context_menu"
        }
      },
      function onResponse() {
        if (chrome.runtime.lastError) {
          // Content script may not be available in current page.
          console.warn("[ImgtoPrompt] sendMessage failed:", chrome.runtime.lastError.message);
        }
      }
    );
  });

  chrome.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
    if (!message || message.type !== constants.MESSAGE_TYPE.ANALYZE_REQUEST) {
      return false;
    }

    const payload = message.payload || {};
    const imageUrl = payload.imageUrl || "";
    const imageDataUrl = typeof payload.imageDataUrl === "string" ? payload.imageDataUrl.trim() : "";
    const forceMock = false;
    const useMock = forceMock || payload.useMock === true;

    const imageDataPromise =
      useMock || imageDataUrl
        ? Promise.resolve(imageDataUrl)
        : fetchImageAsDataUrl(imageUrl).then(function onResolved(result) {
            return result && result.dataUrl ? result.dataUrl : "";
          });

    imageDataPromise
      .then(function withImageData(resolvedImageDataUrl) {
        return api.analyzeImage(imageUrl, {
          useMock: useMock,
          imageDataUrl: resolvedImageDataUrl
        });
      })
      .then(function onSuccess(data) {
        sendResponse({
          type: constants.MESSAGE_TYPE.ANALYZE_SUCCESS,
          payload: { data: data }
        });
      })
      .catch(function onError(error) {
        sendResponse({
          type: constants.MESSAGE_TYPE.ANALYZE_ERROR,
          payload: {
            message: error && error.message ? error.message : "Unknown analyze error",
            code: error && error.code ? error.code : "",
            type: error && error.type ? error.type : "",
            upstream: error && error.upstream ? error.upstream : null
          }
        });
      });

    return true;
  });
})(globalThis);
