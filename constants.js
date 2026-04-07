(function initConstants(global) {
  const root = global.ImgtoPrompt || (global.ImgtoPrompt = {});

  root.constants = {
    APP_NAME: "ImgtoPrompt",
    MENU_ID: "imgtoprompt-analyze-image",
    ROOT_ID: "imgtoprompt-root",
    CARD_ID: "imgtoprompt-card",

    PANEL_STATE: {
      COLLAPSED: "collapsed",
      ANALYZING: "analyzing",
      RESULT: "result",
      ERROR: "error",
      EMPTY: "empty"
    },

    VIEW_MODE: {
      ZH: "zh",
      EN: "en",
      JSON: "json"
    },

    DETAIL_LEVEL: {
      DEFAULT: "default",
      ENHANCED: "enhanced"
    },

    MESSAGE_TYPE: {
      OPEN_AND_ANALYZE: "IMGTOPROMPT_OPEN_AND_ANALYZE",
      ANALYZE_REQUEST: "IMGTOPROMPT_ANALYZE_REQUEST",
      ANALYZE_SUCCESS: "IMGTOPROMPT_ANALYZE_SUCCESS",
      ANALYZE_ERROR: "IMGTOPROMPT_ANALYZE_ERROR"
    },

    STORAGE_KEY: {
      PANEL_POSITION: "imgtoprompt_panel_position"
    },

    UI_TEXT: {
      brand: "IMGTOPROMPT",
      analyzingTitle: "正在分析",
      analyzingDesc: "正在生成提示词...",
      resultTitle: "分析结果",
      emptyTitle: "未识别到图片",
      emptyDesc: "请在 Pinterest 图片上右键后重试。",
      errorTitle: "分析失败",
      errorDesc: "请求失败，请稍后重试。",
      retry: "重试",
      analyzeNow: "分析图片",
      enhanceAnalyze: "增强分析",
      enhancing: "增强分析中...",
      copy: "复制",
      copySuccess: "已复制到剪贴板",
      promptLabel: "Prompt",
      jsonLabel: "结构化结果",
      close: "关闭"
    },

    DEFAULTS: {
      panelWidth: 360,
      panelMinHeight: 320,
      dragPadding: 12,
      progressTickMs: 90,
      imageBase64MaxEdge: 960,
      imageBase64JpegQuality: 0.78,
      imageEncodeTimeoutMs: 8000
    }
  };
})(globalThis);
