(function initPopup(global) {
  const constants =
    global.ImgtoPrompt && global.ImgtoPrompt.constants ? global.ImgtoPrompt.constants : null;
  const modeNode = document.getElementById("mode");
  const versionNode = document.getElementById("version");

  if (modeNode) {
    modeNode.textContent = "真实请求（KIMI 单模型）";
  }

  if (versionNode && chrome.runtime && chrome.runtime.getManifest) {
    const manifest = chrome.runtime.getManifest();
    versionNode.textContent = `版本 ${manifest.version} · 仅在 pinterest.com 生效`;
  }

  if (constants) {
    document.title = constants.APP_NAME;
  }
})(globalThis);
