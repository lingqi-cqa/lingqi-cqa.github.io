/* 财悟·AI财务助手 — 云端同步层（本地优先 local-first）
 * 架构：localStorage 作为工作副本（保证离线/即时）；
 *       开启 SYNC_BACKEND 且已登录时，每次写入异步推送后端，登录时整表拉取。
 *       服务端数据库按 user_id 隔离，是跨设备权威存储。
 *
 * 约定（与服务端一致）：
 *   PUT/POST /api/tx      整表替换交易（数组）
 *   PUT/POST /api/goals   整表替换目标（数组）
 *   PUT      /api/budgets 整表替换预算（对象）
 *   GET 上述三个接口         拉取整表
 */
(function () {
  'use strict';
  const cfg = () => window.CW_CONFIG || {};
  const base = () => (cfg().API_BASE || '');
  const KEY = 'cw_session';

  function token() { try { return (JSON.parse(localStorage.getItem(KEY) || 'null') || {}).token; } catch { return null; } }
  function cloudOn() { return !!cfg().SYNC_BACKEND && !!token(); }

  async function apiBase() {
    if (window.CWApiBase) {
      try {
        const b = await window.CWApiBase.resolve();
        return b === false ? false : b;
      } catch { return false; }
    }
    return base();
  }

  async function send(method, path, body) {
    if (!cloudOn()) return null;
    const b = await apiBase();
    if (b === false) throw new Error('backend offline');
    const res = await fetch(b + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(path + ' ' + res.status);
    return res.json().catch(() => ({}));
  }

  async function pushTx(list) { try { await send('POST', '/api/tx', list); } catch (e) { console.warn('[sync] tx', e.message); } }
  async function pushGoals(list) { try { await send('POST', '/api/goals', list); } catch (e) { console.warn('[sync] goals', e.message); } }
  async function pushBudgets(obj) { try { await send('PUT', '/api/budgets', obj); } catch (e) { console.warn('[sync] budgets', e.message); } }

  async function pullAll() {
    if (!cloudOn()) return false;
    try {
      const [t, g, b] = await Promise.all([
        send('GET', '/api/tx'), send('GET', '/api/goals'), send('GET', '/api/budgets')
      ]);
      if (Array.isArray(t)) localStorage.setItem('cw_tx', JSON.stringify(t));
      if (Array.isArray(g)) localStorage.setItem('cw_goals', JSON.stringify(g));
      if (b && typeof b === 'object') localStorage.setItem('cw_budgets', JSON.stringify(b));
      return true;
    } catch (e) { console.warn('[sync] pull', e.message); return false; }
  }

  window.Sync = { cloudOn, pushTx, pushGoals, pushBudgets, pullAll };
})();
