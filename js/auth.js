/* 财悟·AI财务助手 — 鉴权层（前端）
 *
 * 三种运行形态（自动适配，无需手改）：
 *  1. SYNC_BACKEND=true 且后端在线   → 走后端 /api/auth，拿到 JWT，数据存服务器数据库（按账号隔离）
 *  2. SYNC_BACKEND=true 但后端没起   → **自动回落本地模式**，账号存本机浏览器，功能不中断
 *  3. SYNC_BACKEND=false            → 直接本地模式（纯演示）
 */
(function () {
  'use strict';
  const cfg = () => window.CW_CONFIG || {};
  const base = () => (cfg().API_BASE || '');
  const KEY = 'cw_session';

  function getSession() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
  function setSession(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
  function getToken() { const s = getSession(); return s && s.token; }
  function isCloud() { return !!cfg().SYNC_BACKEND && !!getToken(); }
  function logout() { localStorage.removeItem(KEY); }

  /* ---------------- 本地模式（无后端/后端不可达时兜底） ---------------- */
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function localRegister(email, name, password) {
    if (!emailRe.test(email)) throw new Error('请输入有效的邮箱地址');
    if (String(password).length < 6) throw new Error('密码至少 6 位');
    const users = JSON.parse(localStorage.getItem('cw_users') || '{}');
    if (users[email]) throw new Error('该邮箱已注册，请直接登录');
    users[email] = { name, password, createdAt: Date.now() };
    localStorage.setItem('cw_users', JSON.stringify(users));
    setSession({ email, name, token: null, offline: true });
    return { email, name, offline: true };
  }

  function localLogin(email, password) {
    const users = JSON.parse(localStorage.getItem('cw_users') || '{}');
    const u = users[email];
    if (!u || u.password !== password) throw new Error('邮箱或密码不正确');
    setSession({ email, name: u.name, token: null, offline: true });
    return { email, name: u.name, offline: true };
  }

  /* ---------------- 后端请求（区分「业务错误」与「连不上」） ---------------- */
  const STATIC_HOST_CODES = [404, 405, 501];   // 静态服务器对 POST /api/* 的典型响应

  /** 找到可用后端地址；找不到返回 false */
  async function apiBase() {
    if (window.CWApiBase) {
      try { return await window.CWApiBase.resolve(); } catch { return false; }
    }
    return base();
  }

  async function send(baseUrl, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      return await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function postJson(path, body) {
    let baseUrl = await apiBase();
    let r;

    try {
      if (baseUrl === false) throw new Error('no backend');
      r = await send(baseUrl, path, body);
      // 404/405/501 → 很可能打到了静态资源服务器（页面从预览/静态服务打开），换地址重试一次
      if (STATIC_HOST_CODES.indexOf(r.status) !== -1 && window.CWApiBase) {
        window.CWApiBase.invalidate();
        const next = await window.CWApiBase.resolve(true);
        if (next !== false && next !== baseUrl) {
          baseUrl = next;
          r = await send(baseUrl, path, body);
        }
      }
    } catch (e) {
      const err = new Error('无法连接后端服务');
      err.offline = true;      // 网络层失败 → 可安全回落本地
      throw err;
    }

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const isStatic = STATIC_HOST_CODES.indexOf(r.status) !== -1 && !data.error;
      const err = new Error(
        isStatic
          ? '当前页面没有连到后端服务（HTTP ' + r.status + '），无法校验云端账号'
          : (data.error || ('请求失败 (' + r.status + ')'))
      );
      err.status = r.status;   // 服务端明确拒绝（邮箱已注册、密码错等）→ 不回落
      if (isStatic) { err.offline = true; err.staticHost = true; }
      throw err;
    }
    return data;
  }

  // 页面若不是从后端同源打开，给出统一引导文案
  const STATIC_HOST_TIP = '请改用后端地址打开：http://localhost:3000/login.html（或你部署的域名），'
    + '并从项目根目录运行 启动.bat / npm start 确保后端已启动。';

  /* ---------------- 对外 API ---------------- */
  async function register(email, name, password) {
    email = String(email).trim().toLowerCase();
    if (!cfg().SYNC_BACKEND) return localRegister(email, name, password);
    try {
      const d = await postJson('/api/auth/register', { email, name, password });
      setSession({ email: d.user.email, name: d.user.name, token: d.token });
      return d.user;
    } catch (e) {
      if (e.offline) {                       // 后端没起 → 本地
        try {
          return localRegister(email, name, password);
        } catch (localErr) {
          if (e.staticHost) localErr.message += '（后端未连接，已切本地模式）';
          throw localErr;
        }
      }
      throw e;
    }
  }

  async function login(email, password) {
    email = String(email).trim().toLowerCase();
    if (!cfg().SYNC_BACKEND) return localLogin(email, password);
    try {
      const d = await postJson('/api/auth/login', { email, password });
      setSession({ email: d.user.email, name: d.user.name, token: d.token });
      return d.user;
    } catch (e) {
      if (e.offline) {                       // 后端没起 → 本地
        try {
          return localLogin(email, password);
        } catch (localErr) {
          if (e.staticHost) {
            // 后端没连上、本地也没这个账号 → 直接说清该怎么办，别让用户以为密码错了
            const err = new Error('未能连接后端服务（HTTP ' + (e.status || '—') + '），本机也没有这个账号。' + STATIC_HOST_TIP);
            err.staticHost = true;
            throw err;
          }
          throw localErr;
        }
      }
      throw e;
    }
  }

  window.Auth = { register, login, logout, getSession, getToken, isCloud, setSession, apiBase };
})();
