/* 财悟·AI财务助手 — 全局配置（前端唯一开关来源）
 *
 * 默认策略：**自动适配**。页面启动时会请求后端 /api/status：
 *   - 后端在线且配了模型 Key  → AI 对话自动走真实大模型（通义千问/豆包/DeepSeek）
 *   - 后端在线且配了 OCR 密钥 → 小票识别自动走云端 OCR（更准）
 *   - 后端不在 / 没配密钥     → 自动降级：AI 用本地规则引擎，小票用浏览器内 OCR（Tesseract）
 *
 * 所以：**不填任何东西也能用**；想升级就只填后端 .env 里的 Key，前端不用动。
 *
 * 下面三项只在你需要「强制指定」时才改：
 *  - SYNC_BACKEND: true  → 账号与账单数据存到服务器数据库（按账号隔离）；false → 存本地浏览器
 *  - AI_BACKEND / OCR_BACKEND: 手动强制开启/关闭；AUTO_DETECT=true 时以探测结果为准
 *  - API_BASE: 后端地址。同源部署（node server/server.js、Vercel、Cloudflare）留空即可
 */
window.CW_CONFIG = {
  SYNC_BACKEND: true,   // 后端在线 → 账号与账单入库（按账号隔离）；后端没起 → 自动回落本地，不影响使用
  AI_BACKEND: false,
  OCR_BACKEND: false,
  AUTO_DETECT: true,   // 自动探测后端能力（推荐）
  LOCAL_OCR: true,     // 云端 OCR 不可用时，用浏览器内 OCR 识别小票（无需后端/密钥）
  API_BASE: ''
};
