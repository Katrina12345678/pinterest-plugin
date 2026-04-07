(function initImageLocator(global) {
  const root = global.ImgtoPrompt || (global.ImgtoPrompt = {});
  const dom = root.dom;

  const PREFERRED_SELECTORS = [
    '[data-test-id="closeup-image"] img',
    '[data-test-id="pin-closeup-image"] img',
    'div[data-test-id*="closeup"] img',
    "main img"
  ];

  function normalizeUrl(url) {
    if (!url) {
      return "";
    }

    try {
      return new URL(url, global.location.href).href;
    } catch (error) {
      return url;
    }
  }

  function isLikelyAvatar(img) {
    const hints = [img.alt || "", img.className || "", img.id || ""]
      .join(" ")
      .toLowerCase();

    return hints.includes("avatar") || hints.includes("profile") || hints.includes("user");
  }

  function isCandidateImage(img) {
    if (!img || !dom.isVisible(img)) {
      return false;
    }

    const src = normalizeUrl(img.currentSrc || img.src);
    if (!src || src.startsWith("data:")) {
      return false;
    }

    const rect = img.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 160) {
      return false;
    }

    if (isLikelyAvatar(img)) {
      return false;
    }

    return true;
  }

  function scoreImage(img) {
    // Multi-factor scoring to avoid brittle single-selector matching.
    const rect = img.getBoundingClientRect();
    const viewportW = global.innerWidth;
    const viewportH = global.innerHeight;
    const viewportCenterX = viewportW / 2;
    const viewportCenterY = viewportH / 2;

    const area = rect.width * rect.height;
    const viewportArea = Math.max(viewportW * viewportH, 1);
    const areaScore = Math.min(area / viewportArea, 1) * 60;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = Math.hypot(centerX - viewportCenterX, centerY - viewportCenterY);
    const maxDistance = Math.hypot(viewportCenterX, viewportCenterY);
    const centerScore = (1 - Math.min(distance / maxDistance, 1)) * 20;

    const qualityScore = Math.min((img.naturalWidth || rect.width) / 1200, 1) * 10;

    let semanticScore = 0;
    if (img.closest('[data-test-id="closeup-image"]')) {
      semanticScore += 30;
    }
    if (img.closest('[data-test-id*="closeup"]')) {
      semanticScore += 15;
    }
    if (img.closest("main")) {
      semanticScore += 10;
    }

    return areaScore + centerScore + qualityScore + semanticScore;
  }

  function getImagesFromPreferredSelectors() {
    const set = new Set();

    PREFERRED_SELECTORS.forEach(function eachSelector(selector) {
      document.querySelectorAll(selector).forEach(function eachImage(img) {
        set.add(img);
      });
    });

    document.querySelectorAll("img").forEach(function eachImage(img) {
      set.add(img);
    });

    return Array.from(set);
  }

  function findBestPinterestImage(preferredUrl) {
    const preferred = normalizeUrl(preferredUrl);

    if (preferred) {
      return {
        url: preferred,
        source: "context_menu",
        score: Number.POSITIVE_INFINITY,
        element: null
      };
    }

    const candidates = getImagesFromPreferredSelectors()
      .filter(isCandidateImage)
      .map(function mapImage(img) {
        return {
          element: img,
          url: normalizeUrl(img.currentSrc || img.src),
          score: scoreImage(img)
        };
      })
      .filter(function filterValid(item) {
        return Boolean(item.url);
      })
      .sort(function sortByScore(a, b) {
        return b.score - a.score;
      });

    if (!candidates.length) {
      return null;
    }

    return {
      url: candidates[0].url,
      source: "dom_locator",
      score: candidates[0].score,
      element: candidates[0].element
    };
  }

  root.imageLocator = {
    findBestPinterestImage: findBestPinterestImage,
    normalizeUrl: normalizeUrl
  };
})(globalThis);
