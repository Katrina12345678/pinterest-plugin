(function initContentScript(global) {
  function isContextInvalidatedError(errorLike) {
    const message =
      (errorLike && errorLike.message) ||
      (errorLike && errorLike.reason && errorLike.reason.message) ||
      String(errorLike || "");
    return /Extension context invalidated/i.test(message);
  }

  function debugLog() {
    if (!global.__IMGTOPROMPT_DEBUG__) {
      return;
    }
    try {
      // eslint-disable-next-line no-console
      console.log.apply(console, arguments);
    } catch (error) {
      // Ignore debug log failures.
    }
  }

  function isMessageChannelClosedError(messageLike) {
    const message = String(messageLike || "");
    return (
      /A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received/i.test(
        message
      ) ||
      /The message port closed before a response was received/i.test(message)
    );
  }

  function installGlobalContextInvalidatedGuard() {
    if (global.__IMGTOPROMPT_CONTEXT_GUARD_INSTALLED__) {
      return;
    }
    global.__IMGTOPROMPT_CONTEXT_GUARD_INSTALLED__ = true;

    const onGlobalError = function onGlobalError(event) {
      if (!event) {
        return;
      }
      if (isContextInvalidatedError(event.error || event.message || event)) {
        try {
          if (typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
        } catch (error) {
          // Ignore guard-side errors.
        }
      }
    };

    const onUnhandledRejection = function onUnhandledRejection(event) {
      if (!event) {
        return;
      }
      if (isContextInvalidatedError(event.reason || event)) {
        try {
          if (typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
        } catch (error) {
          // Ignore guard-side errors.
        }
      }
    };

    const previousOnError = global.onerror;
    global.onerror = function guardedOnError(message, source, lineno, colno, error) {
      const matched = isContextInvalidatedError(error || message || "");
      if (matched) {
        return true;
      }
      if (typeof previousOnError === "function") {
        return previousOnError.call(this, message, source, lineno, colno, error);
      }
      return false;
    };

    const previousOnUnhandledRejection = global.onunhandledrejection;
    global.onunhandledrejection = function guardedOnUnhandledRejection(event) {
      const matched = isContextInvalidatedError((event && event.reason) || event || "");
      if (matched) {
        return true;
      }
      if (typeof previousOnUnhandledRejection === "function") {
        return previousOnUnhandledRejection.call(this, event);
      }
      return false;
    };

    global.addEventListener("error", onGlobalError, true);
    global.addEventListener("unhandledrejection", onUnhandledRejection, true);
  }

  installGlobalContextInvalidatedGuard();

  if (global.__IMGTOPROMPT_CONTROLLER__ && typeof global.__IMGTOPROMPT_CONTROLLER__.dispose === "function") {
    try {
      global.__IMGTOPROMPT_CONTROLLER__.dispose("bootstrap reinitialize");
    } catch (error) {
      // Ignore stale controller cleanup errors during re-injection.
    }
  }

  if (global.__IMGTOPROMPT_CONTENT_INITIALIZED__) {
    return;
  }
  global.__IMGTOPROMPT_CONTENT_INITIALIZED__ = true;

  const core = global.ImgtoPrompt || {};
  const constants = core.constants;
  const dom = core.dom;
  const imageLocator = core.imageLocator;

  if (!constants || !dom || !imageLocator) {
    global.__IMGTOPROMPT_CONTENT_INITIALIZED__ = false;
    return;
  }

  function getRuntimeIdSafe() {
    try {
      return global.chrome && chrome.runtime ? chrome.runtime.id : "";
    } catch (error) {
      return "";
    }
  }

  function isExtensionContextValid() {
    return Boolean(getRuntimeIdSafe());
  }

  function isPinterestDetailPage() {
    const host = global.location.hostname;
    const path = global.location.pathname;
    if (!/pinterest\.com$/i.test(host)) {
      return false;
    }
    return /\/pin\/\d+/i.test(path);
  }

  class ImgtoPromptController {
    constructor() {
      this.state = {
        panelState: constants.PANEL_STATE.COLLAPSED,
        activeView: constants.VIEW_MODE.ZH,
        progress: 0,
        hasEverOpened: false,
        analysisData: null,
        editedPrompts: {
          zh: "",
          en: ""
        },
        currentImageUrl: "",
        errorMessage: constants.UI_TEXT.errorDesc
      };

      this.position = { x: 0, y: 0 };
      this.lastUrl = global.location.href;
      this.progressTimer = null;
      this.progressToken = 0;
      this.routeCheckTimer = null;
      this.root = null;
      this.refs = {};
      this.cleanupDrag = null;
      this.cleanupTasks = [];
      this.domObserver = null;
      this.runtimeMessageHandler = null;
      this.disposed = false;
      this.contextCheckTimer = null;
    }

    init() {
      if (!isExtensionContextValid()) {
        debugLog("[ImgtoPrompt] init skipped: extension context unavailable.");
        return;
      }
      this.ensureRoot();
      this.bindUiEvents();
      this.bindRuntimeMessages();
      this.setupSpaListeners();
      this.setupDomObserver();
      this.setupContextWatch();
      this.loadPosition();
      this.handleRouteChange();
    }

    registerCleanup(fn) {
      if (typeof fn === "function") {
        this.cleanupTasks.push(fn);
      }
    }

    addDomListener(target, eventName, handler, options) {
      if (!target || typeof target.addEventListener !== "function") {
        return;
      }
      target.addEventListener(eventName, handler, options);
      this.registerCleanup(() => {
        try {
          target.removeEventListener(eventName, handler, options);
        } catch (error) {
          // Ignore cleanup failure.
        }
      });
    }

    handleContextError(scope, error) {
      const message = error && error.message ? error.message : String(error || "Unknown error");
      if (isMessageChannelClosedError(message)) {
        return message;
      }
      if (isContextInvalidatedError(message)) {
        debugLog(`[ImgtoPrompt] ${scope} context invalidated: ${message}`);
      } else {
        console.error(`[ImgtoPrompt] ${scope} failed: ${message}`);
      }
      if (/Extension context invalidated/i.test(message)) {
        this.dispose("extension context invalidated");
      }
      return message;
    }

    getRuntimeLastError(scope) {
      try {
        if (global.chrome && chrome.runtime && chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || "Unknown runtime error";
          if (!isMessageChannelClosedError(message)) {
            if (isContextInvalidatedError(message)) {
              debugLog(`[ImgtoPrompt] ${scope} runtime context invalidated: ${message}`);
            } else {
              console.error(`[ImgtoPrompt] ${scope} runtime error: ${message}`);
            }
          }
          if (/Extension context invalidated/i.test(message)) {
            this.dispose("extension context invalidated");
          }
          return message;
        }
      } catch (error) {
        return this.handleContextError(scope, error);
      }
      return "";
    }

    safeStorageGet(keys, callback) {
      if (!isExtensionContextValid()) {
        debugLog("[ImgtoPrompt] storage.get skipped: extension context unavailable.");
        callback({});
        return;
      }
      try {
        chrome.storage.local.get(keys, (result) => {
          if (this.disposed) {
            return;
          }
          const lastError = this.getRuntimeLastError("chrome.storage.local.get");
          if (lastError) {
            callback({});
            return;
          }
          callback(result || {});
        });
      } catch (error) {
        this.handleContextError("chrome.storage.local.get", error);
        callback({});
      }
    }

    safeStorageSet(payload) {
      if (!isExtensionContextValid()) {
        debugLog("[ImgtoPrompt] storage.set skipped: extension context unavailable.");
        return;
      }
      try {
        chrome.storage.local.set(payload, () => {
          this.getRuntimeLastError("chrome.storage.local.set");
        });
      } catch (error) {
        this.handleContextError("chrome.storage.local.set", error);
      }
    }

    safeSendMessage(message, callback) {
      const done = typeof callback === "function" ? callback : function noop() {};
      if (!isExtensionContextValid()) {
        done(null, "Extension context invalidated.");
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (this.disposed) {
            return;
          }
          const lastError = this.getRuntimeLastError("chrome.runtime.sendMessage");
          if (lastError) {
            done(null, lastError);
            return;
          }
          done(response, "");
        });
      } catch (error) {
        done(null, this.handleContextError("chrome.runtime.sendMessage", error));
      }
    }

    setupContextWatch() {
      this.contextCheckTimer = global.setInterval(() => {
        if (!isExtensionContextValid()) {
          debugLog("[ImgtoPrompt] Detected invalid extension context, disposing old content script.");
          this.dispose("context watch");
        }
      }, 1500);
      this.registerCleanup(() => {
        if (this.contextCheckTimer) {
          global.clearInterval(this.contextCheckTimer);
          this.contextCheckTimer = null;
        }
      });

      this.addDomListener(global, "error", (event) => {
        if (!event) {
          return;
        }
        if (isContextInvalidatedError(event.error || event.message || event)) {
          if (typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          this.dispose("window error: extension context invalidated");
        }
      });

      this.addDomListener(global, "unhandledrejection", (event) => {
        if (!event) {
          return;
        }
        if (isContextInvalidatedError(event.reason || event)) {
          if (typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          this.dispose("unhandled rejection: extension context invalidated");
        }
      });
    }

    dispose(reason) {
      if (this.disposed) {
        return;
      }
      this.disposed = true;
      global.clearInterval(this.progressTimer);
      global.clearInterval(this.routeCheckTimer);
      if (this.cleanupDrag) {
        try {
          this.cleanupDrag();
        } catch (error) {
          // Ignore cleanup failure.
        }
        this.cleanupDrag = null;
      }
      if (this.domObserver) {
        try {
          this.domObserver.disconnect();
        } catch (error) {
          // Ignore observer cleanup failure.
        }
        this.domObserver = null;
      }
      while (this.cleanupTasks.length > 0) {
        const task = this.cleanupTasks.pop();
        try {
          task();
        } catch (error) {
          // Ignore cleanup task failure.
        }
      }
      // Keep DOM node untouched to avoid fighting with a newly injected content script.
      if (global.__IMGTOPROMPT_CONTROLLER__ === this) {
        global.__IMGTOPROMPT_CONTROLLER__ = null;
      }
      global.__IMGTOPROMPT_CONTENT_INITIALIZED__ = false;
    }

    ensureRoot() {
      const existing = document.getElementById(constants.ROOT_ID);
      if (existing) {
        this.root = existing;
        this.collectRefs();
        return;
      }

      const rootEl = dom.createElement("div", {
        attrs: { id: constants.ROOT_ID },
        className: "itp-root"
      });

      rootEl.innerHTML = [
        '<button class="itp-fab" type="button" aria-label="Open ImgtoPrompt">✦</button>',
        `<section id="${constants.CARD_ID}" class="itp-card">`,
        '  <header class="itp-header itp-drag-handle">',
        `    <div class="itp-brand">${constants.UI_TEXT.brand}</div>`,
        `    <button class="itp-close" type="button" aria-label="${constants.UI_TEXT.close}">×</button>`,
        "  </header>",
        '  <h3 class="itp-title"></h3>',
        '  <div class="itp-content">',
        '    <section class="itp-view itp-view-analyzing">',
        '      <div class="itp-progress-row">',
        '        <div class="itp-progress-track"><span class="itp-progress-fill"></span></div>',
        '        <span class="itp-progress-value">0%</span>',
        "      </div>",
        `      <p class="itp-subtitle">${constants.UI_TEXT.analyzingDesc}</p>`,
        "    </section>",
        '    <section class="itp-view itp-view-result">',
        '      <div class="itp-editor-wrap">',
        `        <div class="itp-label">${constants.UI_TEXT.promptLabel}</div>`,
        '        <textarea class="itp-editor" spellcheck="false"></textarea>',
        '        <pre class="itp-json"></pre>',
        "      </div>",
        '      <div class="itp-tags"></div>',
        "    </section>",
        '    <section class="itp-view itp-view-empty">',
        '      <p class="itp-empty-title"></p>',
        '      <p class="itp-empty-desc"></p>',
        `      <button class="itp-retry" type="button">${constants.UI_TEXT.analyzeNow}</button>`,
        "    </section>",
        '    <section class="itp-view itp-view-error">',
        '      <p class="itp-empty-title"></p>',
        '      <p class="itp-empty-desc"></p>',
        `      <button class="itp-retry" type="button">${constants.UI_TEXT.retry}</button>`,
        "    </section>",
        "  </div>",
        '  <footer class="itp-footer">',
        '    <div class="itp-language-switch">',
        '      <button type="button" data-view="zh">中</button>',
        '      <button type="button" data-view="en">EN</button>',
        '      <button type="button" data-view="json">J</button>',
        "    </div>",
        `    <button class="itp-copy" type="button">${constants.UI_TEXT.copy}</button>`,
        "  </footer>",
        "</section>",
        '<div class="itp-toast" aria-live="polite"></div>'
      ].join("");

      document.body.appendChild(rootEl);
      this.root = rootEl;
      this.collectRefs();
      this.setDefaultPosition();
      this.applyPosition();
      this.setupDragging();
    }

    collectRefs() {
      this.refs = {
        fab: this.root.querySelector(".itp-fab"),
        card: this.root.querySelector(".itp-card"),
        close: this.root.querySelector(".itp-close"),
        title: this.root.querySelector(".itp-title"),
        dragHandle: this.root.querySelector(".itp-drag-handle"),
        viewAnalyzing: this.root.querySelector(".itp-view-analyzing"),
        viewResult: this.root.querySelector(".itp-view-result"),
        viewEmpty: this.root.querySelector(".itp-view-empty"),
        viewError: this.root.querySelector(".itp-view-error"),
        progressFill: this.root.querySelector(".itp-progress-fill"),
        progressValue: this.root.querySelector(".itp-progress-value"),
        editor: this.root.querySelector(".itp-editor"),
        jsonPre: this.root.querySelector(".itp-json"),
        tags: this.root.querySelector(".itp-tags"),
        footer: this.root.querySelector(".itp-footer"),
        languageButtons: Array.from(this.root.querySelectorAll(".itp-language-switch button")),
        copyButton: this.root.querySelector(".itp-copy"),
        emptyTitle: this.root.querySelector(".itp-view-empty .itp-empty-title"),
        emptyDesc: this.root.querySelector(".itp-view-empty .itp-empty-desc"),
        emptyRetry: this.root.querySelector(".itp-view-empty .itp-retry"),
        errorTitle: this.root.querySelector(".itp-view-error .itp-empty-title"),
        errorDesc: this.root.querySelector(".itp-view-error .itp-empty-desc"),
        errorRetry: this.root.querySelector(".itp-view-error .itp-retry")
      };
    }

    bindUiEvents() {
      this.addDomListener(this.refs.close, "click", () => {
        this.closePanel();
      });

      this.addDomListener(this.refs.fab, "click", () => {
        if (this.state.analysisData) {
          this.state.panelState = constants.PANEL_STATE.RESULT;
          this.render();
          return;
        }
        this.startAnalyzeFromPage("");
      });

      this.refs.languageButtons.forEach((button) => {
        this.addDomListener(button, "click", () => {
          const nextView = button.dataset.view;
          this.setView(nextView);
        });
      });

      this.addDomListener(this.refs.copyButton, "click", async () => {
        await this.copyCurrentViewContent();
      });

      this.addDomListener(this.refs.editor, "input", () => {
        if (this.state.activeView === constants.VIEW_MODE.ZH) {
          this.state.editedPrompts.zh = this.refs.editor.value;
        } else if (this.state.activeView === constants.VIEW_MODE.EN) {
          this.state.editedPrompts.en = this.refs.editor.value;
        }
      });

      this.addDomListener(this.refs.emptyRetry, "click", () => {
        this.startAnalyzeFromPage(this.state.currentImageUrl);
      });

      this.addDomListener(this.refs.errorRetry, "click", () => {
        this.startAnalyzeFromPage(this.state.currentImageUrl);
      });

      this.addDomListener(global, "resize", () => {
        this.clampPosition();
        this.applyPosition();
      });
    }

    bindRuntimeMessages() {
      if (!isExtensionContextValid()) {
        debugLog("[ImgtoPrompt] runtime listener skipped: extension context unavailable.");
        return;
      }

      this.runtimeMessageHandler = (message, sender, sendResponse) => {
        if (!message || message.type !== constants.MESSAGE_TYPE.OPEN_AND_ANALYZE) {
          return false;
        }

        const payload = message.payload || {};
        this.startAnalyzeFromPage(payload.imageUrl || "");
        sendResponse({ ok: true });
        return true;
      };

      try {
        chrome.runtime.onMessage.addListener(this.runtimeMessageHandler);
        this.registerCleanup(() => {
          try {
            if (global.chrome && chrome.runtime && chrome.runtime.onMessage && this.runtimeMessageHandler) {
              chrome.runtime.onMessage.removeListener(this.runtimeMessageHandler);
            }
          } catch (error) {
            this.handleContextError("chrome.runtime.onMessage.removeListener", error);
          }
          this.runtimeMessageHandler = null;
        });
      } catch (error) {
        this.handleContextError("chrome.runtime.onMessage.addListener", error);
      }
    }

    setupSpaListeners() {
      // Pinterest is SPA; observe History API + popstate + interval fallback.
      if (!global.__IMGTOPROMPT_HISTORY_PATCHED__) {
        global.__IMGTOPROMPT_HISTORY_PATCHED__ = true;

        const rawPushState = history.pushState;
        const rawReplaceState = history.replaceState;

        history.pushState = function pushStatePatched() {
          const result = rawPushState.apply(this, arguments);
          global.dispatchEvent(new Event("imgtoprompt:urlchange"));
          return result;
        };

        history.replaceState = function replaceStatePatched() {
          const result = rawReplaceState.apply(this, arguments);
          global.dispatchEvent(new Event("imgtoprompt:urlchange"));
          return result;
        };
      }

      const onUrlChange = () => {
        if (global.location.href !== this.lastUrl) {
          this.lastUrl = global.location.href;
          this.handleRouteChange();
        }
      };

      this.addDomListener(global, "popstate", onUrlChange);
      this.addDomListener(global, "imgtoprompt:urlchange", onUrlChange);
      this.routeCheckTimer = global.setInterval(onUrlChange, 700);
      this.registerCleanup(() => {
        if (this.routeCheckTimer) {
          global.clearInterval(this.routeCheckTimer);
          this.routeCheckTimer = null;
        }
      });
    }

    setupDomObserver() {
      // Pinterest may remount top-level containers; reattach root if removed.
      this.domObserver = new MutationObserver(() => {
        if (!document.getElementById(constants.ROOT_ID) && this.root) {
          document.body.appendChild(this.root);
        }
      });

      this.domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
      this.registerCleanup(() => {
        if (this.domObserver) {
          this.domObserver.disconnect();
          this.domObserver = null;
        }
      });
    }

    setupDragging() {
      if (this.cleanupDrag) {
        this.cleanupDrag();
      }

      this.cleanupDrag = dom.makeDraggable({
        target: this.refs.card,
        handle: this.refs.dragHandle,
        getCurrentPosition: () => ({ x: this.position.x, y: this.position.y }),
        getBounds: () => this.getPositionBounds(),
        onMove: (nextPosition) => {
          this.position = nextPosition;
          this.applyPosition();
        },
        onEnd: () => {
          this.persistPosition();
        }
      });
    }

    getPositionBounds() {
      const padding = constants.DEFAULTS.dragPadding;
      const cardWidth = this.refs.card.offsetWidth || constants.DEFAULTS.panelWidth;
      const cardHeight = this.refs.card.offsetHeight || 420;

      return {
        minX: padding,
        minY: padding,
        maxX: Math.max(global.innerWidth - cardWidth - padding, padding),
        maxY: Math.max(global.innerHeight - cardHeight - padding, padding)
      };
    }

    setDefaultPosition() {
      const width = constants.DEFAULTS.panelWidth;
      // Place the initial card closer to the main image area (with slight overlap),
      // instead of sticking too far to the right edge.
      const overlapOffset = Math.min(Math.max(global.innerWidth * 0.14, 140), 260);
      const x = Math.max(global.innerWidth - width - overlapOffset, 20);
      const y = Math.max(global.innerHeight * 0.2, 110);
      this.position = { x: x, y: y };
    }

    clampPosition() {
      const bounds = this.getPositionBounds();
      this.position = {
        x: dom.clamp(this.position.x, bounds.minX, bounds.maxX),
        y: dom.clamp(this.position.y, bounds.minY, bounds.maxY)
      };
    }

    applyPosition() {
      this.refs.card.style.left = `${Math.round(this.position.x)}px`;
      this.refs.card.style.top = `${Math.round(this.position.y)}px`;
    }

    loadPosition() {
      this.safeStorageGet([constants.STORAGE_KEY.PANEL_POSITION], (result) => {
        const pos = result[constants.STORAGE_KEY.PANEL_POSITION];
        if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
          this.position = { x: pos.x, y: pos.y };
        } else {
          this.setDefaultPosition();
        }
        this.clampPosition();
        this.applyPosition();
      });
    }

    persistPosition() {
      if (!isExtensionContextValid()) {
        debugLog("[ImgtoPrompt] persistPosition skipped: chrome.runtime.id unavailable.");
        return;
      }
      try {
        this.safeStorageSet({
          [constants.STORAGE_KEY.PANEL_POSITION]: this.position
        });
      } catch (error) {
        this.handleContextError("persistPosition", error);
      }
    }

    handleRouteChange() {
      this.render();
    }

    closePanel() {
      this.state.panelState = constants.PANEL_STATE.COLLAPSED;
      this.render();
    }

    setView(nextView) {
      if (!Object.values(constants.VIEW_MODE).includes(nextView)) {
        return;
      }
      this.state.activeView = nextView;
      this.renderResultView();
      this.renderViewTabs();
    }

    startAnalyzeFromPage(preferredImageUrl) {
      // Priority: context-menu srcUrl -> robust DOM locator fallback.
      const selected = imageLocator.findBestPinterestImage(preferredImageUrl);
      if (!selected || !selected.url) {
        this.showEmpty();
        return;
      }
      this.startAnalyzing(selected.url);
    }

    startAnalyzing(imageUrl) {
      this.progressToken += 1;
      const activeToken = this.progressToken;

      this.state.currentImageUrl = imageUrl;
      this.state.hasEverOpened = true;
      this.state.panelState = constants.PANEL_STATE.ANALYZING;
      this.state.progress = 0;
      this.render();
      this.runProgressAnimation(activeToken);

      this.safeSendMessage(
        {
          type: constants.MESSAGE_TYPE.ANALYZE_REQUEST,
          payload: { imageUrl: imageUrl }
        },
        (response, runtimeErrorMessage) => {
          if (activeToken !== this.progressToken) {
            return;
          }

          if (runtimeErrorMessage) {
            if (isMessageChannelClosedError(runtimeErrorMessage)) {
              // Expected during extension/service-worker reload; avoid noisy false error state.
              return;
            }
            this.showError(runtimeErrorMessage || constants.UI_TEXT.errorDesc);
            return;
          }

          if (!response) {
            this.showError(constants.UI_TEXT.errorDesc);
            return;
          }

          if (response.type === constants.MESSAGE_TYPE.ANALYZE_ERROR) {
            const msg = response.payload && response.payload.message;
            this.showError(msg || constants.UI_TEXT.errorDesc);
            return;
          }

          if (response.type !== constants.MESSAGE_TYPE.ANALYZE_SUCCESS) {
            this.showError(constants.UI_TEXT.errorDesc);
            return;
          }

          const payload = response.payload || {};
          this.completeAnalyze(payload.data || null, activeToken);
        }
      );
    }

    runProgressAnimation(token) {
      // Mock phase progress. Real API can replace this with streaming progress events.
      global.clearInterval(this.progressTimer);
      this.progressTimer = global.setInterval(() => {
        if (token !== this.progressToken) {
          global.clearInterval(this.progressTimer);
          return;
        }

        const next = Math.min(this.state.progress + (Math.random() * 7 + 2), 93);
        this.state.progress = next;
        this.renderAnalyzingView();
      }, constants.DEFAULTS.progressTickMs);
    }

    completeAnalyze(data, token) {
      if (!data) {
        this.showError(constants.UI_TEXT.errorDesc);
        return;
      }

      global.clearInterval(this.progressTimer);
      this.state.progress = 100;
      this.renderAnalyzingView();

      global.setTimeout(() => {
        if (token !== this.progressToken) {
          return;
        }

        this.state.analysisData = data;
        this.state.editedPrompts.zh = data.prompt_zh || "";
        this.state.editedPrompts.en = data.prompt_en || "";
        this.state.panelState = constants.PANEL_STATE.RESULT;
        this.state.activeView = constants.VIEW_MODE.ZH;
        this.render();
      }, 180);
    }

    showEmpty() {
      this.state.hasEverOpened = true;
      this.state.panelState = constants.PANEL_STATE.EMPTY;
      this.render();
    }

    showError(message) {
      global.clearInterval(this.progressTimer);
      this.state.hasEverOpened = true;
      this.state.errorMessage = message || constants.UI_TEXT.errorDesc;
      this.state.panelState = constants.PANEL_STATE.ERROR;
      this.render();
    }

    renderAnalyzingView() {
      if (this.state.panelState !== constants.PANEL_STATE.ANALYZING) {
        return;
      }
      this.refs.progressFill.style.width = `${Math.round(this.state.progress)}%`;
      this.refs.progressValue.textContent = `${Math.round(this.state.progress)}%`;
    }

    renderResultView() {
      const data = this.state.analysisData;
      if (!data) {
        return;
      }

      const isJson = this.state.activeView === constants.VIEW_MODE.JSON;
      const isZh = this.state.activeView === constants.VIEW_MODE.ZH;

      this.refs.editor.style.display = isJson ? "none" : "block";
      this.refs.jsonPre.style.display = isJson ? "block" : "none";

      if (isJson) {
        // JSON view is readonly and formatted for copy.
        this.refs.jsonPre.textContent = JSON.stringify(data.json_result || {}, null, 2);
      } else if (isZh) {
        this.refs.editor.value = this.state.editedPrompts.zh || "";
      } else {
        this.refs.editor.value = this.state.editedPrompts.en || "";
      }

      this.refs.tags.innerHTML = "";
      (data.tags || []).forEach((tag) => {
        const chip = dom.createElement("span", { className: "itp-chip", text: tag });
        this.refs.tags.appendChild(chip);
      });
    }

    renderViewTabs() {
      this.refs.languageButtons.forEach((button) => {
        const view = button.dataset.view;
        button.classList.toggle("is-active", view === this.state.activeView);
      });
    }

    async copyCurrentViewContent() {
      if (this.state.panelState !== constants.PANEL_STATE.RESULT || !this.state.analysisData) {
        return;
      }

      const data = this.state.analysisData;
      let text = "";

      if (this.state.activeView === constants.VIEW_MODE.JSON) {
        text = JSON.stringify(data.json_result || {}, null, 2);
      } else if (this.state.activeView === constants.VIEW_MODE.ZH) {
        text = this.state.editedPrompts.zh || "";
      } else {
        text = this.state.editedPrompts.en || "";
      }

      try {
        await dom.copyToClipboard(text);
        dom.showToast(constants.UI_TEXT.copySuccess);
      } catch (error) {
        dom.showToast("复制失败，请重试");
      }
    }

    render() {
      if (!this.root) {
        return;
      }

      const eligible = isPinterestDetailPage();
      if (!eligible) {
        this.root.classList.add("itp-hidden");
        return;
      }

      this.root.classList.remove("itp-hidden");
      this.clampPosition();
      this.applyPosition();

      const state = this.state.panelState;
      const showCard = state !== constants.PANEL_STATE.COLLAPSED;
      const showFab = state === constants.PANEL_STATE.COLLAPSED && this.state.hasEverOpened;

      this.refs.card.classList.remove(
        "itp-card--analyzing",
        "itp-card--result",
        "itp-card--empty",
        "itp-card--error"
      );
      if (state === constants.PANEL_STATE.ANALYZING) {
        this.refs.card.classList.add("itp-card--analyzing");
      } else if (state === constants.PANEL_STATE.RESULT) {
        this.refs.card.classList.add("itp-card--result");
      } else if (state === constants.PANEL_STATE.EMPTY) {
        this.refs.card.classList.add("itp-card--empty");
      } else if (state === constants.PANEL_STATE.ERROR) {
        this.refs.card.classList.add("itp-card--error");
      }

      this.refs.card.style.display = showCard ? "flex" : "none";
      this.refs.fab.style.display = showFab ? "inline-flex" : "none";

      if (!showCard) {
        return;
      }

      const titleMap = {
        [constants.PANEL_STATE.ANALYZING]: constants.UI_TEXT.analyzingTitle,
        [constants.PANEL_STATE.RESULT]: constants.UI_TEXT.resultTitle,
        [constants.PANEL_STATE.EMPTY]: constants.UI_TEXT.emptyTitle,
        [constants.PANEL_STATE.ERROR]: constants.UI_TEXT.errorTitle
      };

      this.refs.title.textContent = titleMap[state] || constants.UI_TEXT.resultTitle;
      this.refs.footer.style.display = state === constants.PANEL_STATE.RESULT ? "flex" : "none";

      this.refs.viewAnalyzing.style.display = state === constants.PANEL_STATE.ANALYZING ? "block" : "none";
      this.refs.viewResult.style.display = state === constants.PANEL_STATE.RESULT ? "block" : "none";
      this.refs.viewEmpty.style.display = state === constants.PANEL_STATE.EMPTY ? "block" : "none";
      this.refs.viewError.style.display = state === constants.PANEL_STATE.ERROR ? "block" : "none";

      if (state === constants.PANEL_STATE.ANALYZING) {
        this.renderAnalyzingView();
      } else if (state === constants.PANEL_STATE.RESULT) {
        this.renderResultView();
        this.renderViewTabs();
      } else if (state === constants.PANEL_STATE.EMPTY) {
        this.refs.emptyTitle.textContent = constants.UI_TEXT.emptyTitle;
        this.refs.emptyDesc.textContent = constants.UI_TEXT.emptyDesc;
      } else if (state === constants.PANEL_STATE.ERROR) {
        this.refs.errorTitle.textContent = constants.UI_TEXT.errorTitle;
        this.refs.errorDesc.textContent = this.state.errorMessage || constants.UI_TEXT.errorDesc;
      }
    }
  }

  const controller = new ImgtoPromptController();
  global.__IMGTOPROMPT_CONTROLLER__ = controller;
  try {
    controller.init();
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      controller.dispose("init exception: extension context invalidated");
      return;
    }
    global.__IMGTOPROMPT_CONTENT_INITIALIZED__ = false;
    global.__IMGTOPROMPT_CONTROLLER__ = null;
    try {
      console.error("[ImgtoPrompt] init failed:", error);
    } catch (logError) {
      // Ignore secondary logging errors.
    }
    return;
  }
})(globalThis);
