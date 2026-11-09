/* ============================================================
   今日喂小猪 —— 轻游戏化：每日签到喂食，纯前端 localStorage 记录连续天数
   - 不依赖登录 / 后端，localStorage 即可
   - 每天只能「真正喂」一次；重复点击给温和提示，不打断
   - 连续天数越多，小猪越长胖（头像轻微放大），文案升级
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'cw_pig_feed_v1';
  var DAY = 86400000;

  var root = document.getElementById('feedPig');
  var btn = document.getElementById('fpBtn');
  var bubble = document.getElementById('fpBubble');
  var pigImg = document.getElementById('fpPigImg');
  var streakEl = document.getElementById('fpStreak');
  var countEl = document.getElementById('fpCount');
  var dot = document.getElementById('fpDot');
  if (!root || !btn) return; // 页面没放这个组件就不执行

  var bubbleTimer = null;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dayDiff(from, to) {
    var a = from.split('-').map(Number), b = to.split('-').map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / DAY);
  }

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
      return {
        last: typeof s.last === 'string' ? s.last : '',
        streak: Number(s.streak) || 0,
        total: Number(s.total) || 0
      };
    } catch (e) {
      return { last: '', streak: 0, total: 0 };
    }
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 隐私模式忽略 */ }
  }

  /* ---------- 文案 ---------- */
  function streakLine(n) {
    if (n >= 7) return '连续 ' + n + ' 天 · 存钱罐级别';
    if (n >= 3) return '连续 ' + n + ' 天 · 越喂越胖';
    return '连续 ' + n + ' 天';
  }
  function feedMessage(n) {
    if (n >= 7) return '连续喂食 ' + n + ' 天，小猪胖成存钱罐了！🎉';
    if (n >= 3) return '连续喂食 ' + n + ' 天，小猪更胖了！';
    if (n === 2) return '连续喂食 2 天，小猪记住你啦～';
    return '第 1 天！小猪开始攒钱啦 💰';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var s = load();
    var fed = s.last === todayStr();
    var n = s.streak;

    if (streakEl) {
      streakEl.textContent = n > 0 ? streakLine(n) : '今天还没喂哦';
      streakEl.classList.toggle('is-hot', n >= 3);
    }
    btn.classList.toggle('is-fed', fed);
    if (dot) dot.style.display = fed ? 'none' : '';
    if (countEl) {
      countEl.textContent = n > 99 ? '99+' : String(n);
      countEl.hidden = !(n > 0);
    }
    btn.setAttribute('aria-label', fed
      ? '今日已喂小猪，已连续 ' + n + ' 天'
      : '今日喂小猪，当前连续 ' + n + ' 天');

    // 连续天数越多，头像越“胖”（上限 1.16 倍，避免撑破圆形）
    if (pigImg) {
      var scale = 1 + Math.min(n, 8) * 0.02;
      pigImg.style.setProperty('--pig-scale', scale.toFixed(3));
    }
  }

  /* ---------- 气泡提示 ---------- */
  function say(html, ms) {
    if (!bubble) return;
    bubble.innerHTML = html;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () { bubble.classList.remove('show'); }, ms || 3600);
  }

  /* ---------- 动画 ---------- */
  function animate(cls) {
    if (!pigImg) return;
    var host = pigImg.parentNode;
    host.classList.remove('jump', 'wiggle');
    // 强制重排，确保同一次点击也能重新播放
    void host.offsetWidth;
    host.classList.add(cls);
    setTimeout(function () { host.classList.remove(cls); }, 700);
  }

  function particles() {
    if (!pigImg || !root) return;
    var emojis = ['💰', '✨', '🪙', '🐷', '💛'];
    for (var i = 0; i < 5; i++) {
      (function (i) {
        var sp = document.createElement('span');
        sp.className = 'fp-float';
        sp.textContent = emojis[i % emojis.length];
        sp.style.setProperty('--dx', (Math.random() * 64 - 32).toFixed(0) + 'px');
        sp.style.setProperty('--rot', (Math.random() * 46 - 23).toFixed(0) + 'deg');
        sp.style.animationDelay = (i * 55) + 'ms';
        sp.style.left = '30px';
        root.appendChild(sp);
        setTimeout(function () { sp.remove(); }, 1500 + i * 60);
      })(i);
    }
  }

  /* ---------- 核心：喂一次 ---------- */
  function feed() {
    var s = load();
    var today = todayStr();

    if (s.last === today) {
      animate('wiggle');
      say('今天已经喂过啦，明天再来～<br><b>已连续 ' + s.streak + ' 天</b>', 2800);
      return { fed: false, streak: s.streak, alreadyFed: true };
    }

    var d = s.last ? dayDiff(s.last, today) : null;
    s.streak = (d === 1) ? (s.streak || 1) + 1 : 1;   // 断签则从 1 重新开始
    s.total = (s.total || 0) + 1;
    s.last = today;
    save(s);

    animate('jump');
    particles();
    say(feedMessage(s.streak), 3800);
    render();

    return { fed: true, streak: s.streak, total: s.total, message: feedMessage(s.streak) };
  }

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    feed();
  });

  // 跨天回来时刷新状态（例如挂着页面到第二天）
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) render();
  });

  render();

  // 供自动化验收调用
  window.__feedPig = { state: load, feed: feed, render: render, todayStr: todayStr };
})();
