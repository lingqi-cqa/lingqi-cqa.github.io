/* 财悟·AI财务助手 — 后端地址自动发现
 *
 * 解决的问题：页面不一定是从后端同源打开的。
 *   常见情况 A：用 http://localhost:3000/login.html 打开   → 同源，直接可用
 *   常见情况 B：双击本地文件（file://）或 IDE/预览面板的静态服务打开
 *               → 此时 /api/* 会打到「静态服务器」上，POST 一律返回 405 (Method Not Allowed)
 *
 * 本模块在发起任何 API 请求前，先按候选顺序探测 /api/status：
 *   1) js/config.js 里手填的 API_BASE（若填了）
 *   2) 同源（当前页面所在域名）
 *   3) http://localhost:3000 / http://127.0.0.1:3000（仅非 https 页面，避开混合内容拦截）
 * 第一个真正返回 JSON 且 {ok:true} 的地址即被采用，并写入 localStorage 缓存。
 *
 * 对页面其它脚本只需：
 *   await window.CWApiBase.resolve()      // 拿到可用 base（'' 表示同源，null 表示全部失败）
 *   window.CWApiBase.url('/api/auth/login')
 */
(function () {
  'use strict';

  const CACHE_KEY = 'cw_api_base';
  const LOCAL_CANDIDATES = ['http://localhost:3000', 'http://127.0.0.1:3000'];
  const STATUS_PATHS = ['/api/status', '/api/health'];

  let resolved = null;    // null=未探测；''=同源；'http://...'=具体地址；false=全部失败
  let resolving = null;   // 进行中的探测 Promise（避免并发重复探测）
  let lastStatus = null;  // 最近一次成功拿到的 /api/status 结果

  const cfg = () => (window.CW_CONFIG = window.CW_CONFIG || {});
  const trimEnd = (u) => String(u || '').replace(/\/+$/, '');

  function readCache() {
    try { return localStorage.getItem(CACHE_KEY); } catch { return null; }
  }
  function writeCache(v) {
    try { localStorage.setItem(CACHE_KEY, v); } catch { /* 隐私模式忽略 */ }
  }

  /** 候选地址列表（去重、按优先级） */
  function candidates() {
    const list = [];
    const push = (v) => { if (v !== null && v !== undefined && list.indexOf(v) === -1) list.push(v); };

    const explicit = trimEnd(cfg().API_BASE);
    if (explicit) push(explicit);

    const protocol = location.protocol;
    const isHttp = protocol === 'http:' || protocol === 'https:';
    const isFile = protocol === 'file:';

    // 同源（file:// 下无同源概念，跳过）
    if (isHttp) push('');

    // 仅在非 https 页面尝试本地后端，否则会被浏览器按混合内容拦截
    if (protocol !== 'https:') {
      const cached = trimEnd(readCache());
      if (cached) push(cached);
      LOCAL_CANDIDATES.forEach(push);
    }

    if (isFile) {
      // file:// 没有同源，但本地后端若在跑也能连上（上面已加入候选）
    }
    return list;
  }

  /** 探测单个 base 是否是可用的后端：要求返回 JSON 且 ok===true */
  async function ping(base) {
    for (const path of STATUS_PATHS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      try {
        const res = await fetch(base + path, {
          method: 'GET',
          signal: ctrl.signal,
          cache: 'no-store',
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) continue;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('json') === -1) continue;   // 静态服务器返回 HTML → 不是后端
        const data = await res.json();
        if (data && data.ok === true) return data;
      } catch (e) {
        /* 网络失败 / 超时 / CORS → 换下一个候选 */
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  /**
   * 解析可用后端地址。
   * @param {boolean} force 强制重新探测（例如刚遇到 405，怀疑地址变了）
   * @returns {Promise<string|false>} '' = 同源可用；'http://...' = 具体地址；false = 全部失败
   */
  async function resolve(force) {
    if (!force) {
      if (resolved !== null) return resolved;
      if (resolving) return resolving;
    }

    resolving = (async () => {
      const list = candidates();
      for (const base of list) {
        const s = await ping(base);
        if (s) {
          resolved = base;
          lastStatus = s;
          cfg().API_BASE = base;
          writeCache(base);
          window.CW_BACKEND_STATUS = s;
          window.CW_API_BASE = base;
          return base;
        }
      }
      // 全部失败：保留「未连接」状态，让上层走本地降级
      resolved = false;
      lastStatus = null;
      window.CW_BACKEND_STATUS = null;
      window.CW_API_BASE = '';
      return false;
    })();

    try {
      return await resolving;
    } finally {
      resolving = null;
    }
  }

  /** 同步取当前 base（未探测时退回 config 里的值） */
  function get() {
    if (resolved === null || resolved === undefined) return trimEnd(cfg().API_BASE);
    return resolved === false ? '' : resolved;
  }

  /** 拼出完整 URL */
  function url(path) {
    return get() + path;
  }

  /** 作废缓存，下次请求重新探测 */
  function invalidate() {
    resolved = null;
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
  }

  window.CWApiBase = {
    resolve,
    get,
    url,
    invalidate,
    getStatus: () => lastStatus,
    isOnline: () => resolved !== null && resolved !== false
  };
})();
