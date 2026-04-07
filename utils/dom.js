(function initDomUtils(global) {
  const root = global.ImgtoPrompt || (global.ImgtoPrompt = {});

  function createElement(tag, options) {
    const el = document.createElement(tag);
    const opts = options || {};

    if (opts.className) {
      el.className = opts.className;
    }
    if (opts.text) {
      el.textContent = opts.text;
    }
    if (opts.html) {
      el.innerHTML = opts.html;
    }
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function eachAttr(key) {
        el.setAttribute(key, opts.attrs[key]);
      });
    }
    if (opts.dataset) {
      Object.keys(opts.dataset).forEach(function eachData(key) {
        el.dataset[key] = opts.dataset[key];
      });
    }

    return el;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function isVisible(el) {
    if (!el) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    const style = global.getComputedStyle(el);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function showToast(text, duration) {
    const toast = document.querySelector(".itp-toast");
    if (!toast) {
      return;
    }

    toast.textContent = text;
    toast.classList.add("is-visible");

    global.clearTimeout(showToast._timer);
    showToast._timer = global.setTimeout(function hide() {
      toast.classList.remove("is-visible");
    }, duration || 1400);
  }

  function makeDraggable(options) {
    const opts = options || {};
    const dragHandle = opts.handle;
    const target = opts.target;

    if (!dragHandle || !target) {
      return function noop() {};
    }

    let isDragging = false;
    let originX = 0;
    let originY = 0;
    let startX = 0;
    let startY = 0;

    function onMouseDown(event) {
      if (event.button !== 0) {
        return;
      }

      isDragging = true;
      target.classList.add("is-dragging");

      const current = opts.getCurrentPosition();
      startX = current.x;
      startY = current.y;
      originX = event.clientX;
      originY = event.clientY;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      event.preventDefault();
    }

    function onMouseMove(event) {
      if (!isDragging) {
        return;
      }

      const bounds = opts.getBounds();
      const nextX = clamp(startX + (event.clientX - originX), bounds.minX, bounds.maxX);
      const nextY = clamp(startY + (event.clientY - originY), bounds.minY, bounds.maxY);

      opts.onMove({ x: nextX, y: nextY });
    }

    function onMouseUp() {
      if (!isDragging) {
        return;
      }

      isDragging = false;
      target.classList.remove("is-dragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      if (opts.onEnd) {
        opts.onEnd(opts.getCurrentPosition());
      }
    }

    dragHandle.addEventListener("mousedown", onMouseDown);

    return function cleanup() {
      dragHandle.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }

  root.dom = {
    createElement: createElement,
    clamp: clamp,
    isVisible: isVisible,
    copyToClipboard: copyToClipboard,
    showToast: showToast,
    makeDraggable: makeDraggable
  };
})(globalThis);
