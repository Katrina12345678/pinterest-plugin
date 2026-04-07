# ImgtoPrompt (Chrome Extension + Local Backend)

ImgtoPrompt 是一个运行在 Pinterest 图片详情页上的 Chrome 扩展。  
当前版本为真实请求模式：扩展（前端先转 base64）-> 本地后端 -> KIMI（单模型）。

## 功能概览
- 仅在 `pinterest.com` 生效
- 右键图片菜单触发（`ImgtoPrompt`）
- 深色悬浮卡片（可拖拽）
- 分析进度态 -> 结果态
- 结果支持：Prompt 编辑、标签展示、中/EN/JSON 视图切换、复制
- 固定使用 KIMI（`KIMI_MODEL`）
- 接口失败时进入错误状态
- `mockApi.js` 保留，仅手动调试时启用（默认关闭）

## 项目结构
```text
ImgtoPrompt/
├─ manifest.json
├─ background.js
├─ content.js
├─ styles.css
├─ popup.html
├─ popup.js
├─ package.json
├─ .env.example
├─ .gitignore
├─ server/
│  ├─ index.js
│  └─ upstreamClient.js
├─ utils/
│  ├─ constants.js
│  ├─ dom.js
│  ├─ imageLocator.js
│  ├─ mockApi.js
│  └─ api.js
└─ assets/
   ├─ LOGO.png
   ├─ icon-16.png
   ├─ icon-32.png
   ├─ icon-48.png
   └─ icon-128.png
```

## 后端接口说明
### 本地后端
- `POST http://localhost:3001/api/analyze-image`
- 请求体：
```json
{
  "imageUrl": "https://xxx.com/xxx.jpg",
  "imageDataUrl": "data:image/jpeg;base64,..."
}
```
- 返回体（与前端当前结构一致）：
```json
{
  "summary_zh": "...",
  "summary_en": "...",
  "tags": ["..."],
  "prompt_zh": "...",
  "prompt_en": "...",
  "json_result": {}
}
```

### 上游模型接口（由后端调用）
- URL：`KIMI_API_URL`（代码会自动补全到 `/chat/completions`）
- Model：`KIMI_MODEL`
- Body：包含文本 + `image_url` 的多模态 `messages` 结构
- 图片处理：扩展前端先下载图片并转换为 `data:image/...;base64,...`，后端不再下载原图

## .env 说明
- 后端会读取项目根目录 `.env`：
  - `PORT`：本地服务端口（默认 `3001`）
  - `KIMI_API_URL`：KIMI 接口基础地址（建议完整 `.../chat/completions`）
  - `KIMI_API_KEY`：KIMI API Key（也可兼容使用 `UPSTREAM_API_KEY`）
  - `KIMI_MODEL`：KIMI 模型名（默认 `kimi-k2.5`）
  - `UPSTREAM_API_URL`：KIMI 旧字段兼容（可选）
  - `UPSTREAM_API_KEY`：KIMI 旧字段兼容（可选）
  - `UPSTREAM_TIMEOUT_MS`：上游请求超时毫秒（建议 `60000`）
  - `ANALYZE_CACHE_TTL_MS`：同图分析缓存时长毫秒（默认 `600000`，即 10 分钟）
  - `DEBUG_UPSTREAM_RAW`：是否打印上游完整原始 body（`true/false`，默认 `false`）

## 如何启动后端
> 需要 Node.js 18+

```bash
npm install
npm run server:start
```

开发热更新（可选）：
```bash
npm run server:dev
```

## 如何加载扩展并联调
1. 启动本地后端（见上一步）
2. 打开 `chrome://extensions/`
3. 开启开发者模式
4. 点击“重新加载”当前扩展（或“加载已解压的扩展程序”并选项目目录）
5. 打开 Pinterest 图片详情页（URL 含 `/pin/`）
6. 在图片上右键点击 `ImgtoPrompt`

## 调试与故障排查
- 后端健康检查：
```bash
curl http://localhost:3001/health
```
- 性能日志（后端终端）：
  - `[KIMI][TIMING] image_prepare_pipeline | from_extension`
  - `[KIMI][TIMING] analyze_total`
- 常见失败场景：
  - 未启动后端：前端会显示错误状态（无法连接本地后端）
  - KIMI 接口不可用或返回非 2xx：后端返回错误，前端显示错误态

## Mock 模式说明
- `utils/mockApi.js` 已保留
- 默认不使用 mock
- 仅在显式传 `useMock: true` 时启用（调试兜底）
