/* =========================================================
   SmartPig 存钱罐动效（Piggy Motion）
   一笔钱的进出，都给一个小窗口 + 一段动画：
     · in  存入：硬币抛进罐口 → 罐子一沉 → 金币长高 → 进度前进
     · out 消费：罐子一惊 → 硬币被甩出罐口 → 罐子瘪下去 → 进度回退
   用法：
     PiggyMotion.save({ amount: 200, title: '存入 · ✈️ 旅行基金',
                        fillFrom: .45, fillTo: .47,
                        progress: { from: 45, to: 47, sub: '还差 ¥5,300' } })
     PiggyMotion.spend({ amount: 38, title: '支出 · 🍜 餐饮', ... })
   依赖：css/piggy-motion.css
   ========================================================= */
(function () {
  'use strict';

  var TOTAL = 9;                         // 罐内金币总枚数（一眼看出"满没满"）
  // 3 层金字塔，横向 14% 一档（26px 的金币刚好相切），能数清是一枚枚硬币而不是一坨。
  var ROWS = [
    { y: 0, xs: [29, 43, 57, 71] },
    { y: 16, xs: [36, 50, 64] },
    { y: 32, xs: [43, 57] }
  ];

  var TPL = [
    '<div class="pm-panel" data-mode="in">',
    '  <button class="pm-x" type="button" aria-label="关闭">×</button>',
    '  <div class="pm-eyebrow"><span class="pm-dot"></span><span class="pm-eb-txt"></span></div>',
    '  <div class="pm-stage">',
    '    <div class="pm-shadow"></div>',
    '    <div class="pm-jar">',
    '      <div class="pm-ear l"></div><div class="pm-ear r"></div>',
    '      <div class="pm-cap"></div><div class="pm-slot"></div>',
    '      <div class="pm-body">',
    '        <div class="pm-coins"></div>',
    '        <i class="pm-sheen"></i><i class="pm-sheen b"></i>',
    '        <div class="pm-face">',
    '          <i class="pm-eye l"></i><i class="pm-eye r"></i>',
    '          <i class="pm-cheek l"></i><i class="pm-cheek r"></i>',
    '          <i class="pm-snout"><b></b><b></b></i>',
    '        </div>',
    '      </div>',
    '      <div class="pm-leg l"></div><div class="pm-leg r"></div>',
    '      <div class="pm-fly"></div>',
    '    </div>',
    '  </div>',
    '  <div class="pm-amt">+¥0.00</div>',
    '  <div class="pm-line"></div>',
    '  <div class="pm-prog">',
    '    <div class="pm-prog-txt"><span class="pm-pl"></span><span class="pm-pr"></span></div>',
    '    <div class="pm-bar"><i></i></div>',
    '  </div>',
    '  <div class="pm-hint">轻点任意处关闭</div>',
    '</div>'
  ].join('');

  var root = null, panel = null, jar = null, face = null;
  var coinsWrap = null, flyLayer = null, coins = [];
  var amtEl = null, lineEl = null, ebEl = null, plEl = null, prEl = null, barEl = null;
  var timers = [], numRaf = 0;
  var busy = false, closing = false, queue = null;

  /* ---------- 小工具 ---------- */
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function clamp01(v) { v = Number(v); return !isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function money(v) {
    return Math.abs(Number(v) || 0).toLocaleString('zh-CN', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }
  function burst(el, cls, ms) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;                 // 强制重排，同一帧里重播
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, ms || 560);
  }

  /* ---------- 建 DOM（懒加载，只建一次） ---------- */
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'pm-mask';
    root.id = 'pmMask';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '存钱罐动效');
    root.style.display = 'none';
    root.innerHTML = TPL;
    document.body.appendChild(root);

    panel = root.querySelector('.pm-panel');
    jar = root.querySelector('.pm-jar');
    face = root.querySelector('.pm-face');
    coinsWrap = root.querySelector('.pm-coins');
    flyLayer = root.querySelector('.pm-fly');
    amtEl = root.querySelector('.pm-amt');
    lineEl = root.querySelector('.pm-line');
    ebEl = root.querySelector('.pm-eb-txt');
    plEl = root.querySelector('.pm-pl');
    prEl = root.querySelector('.pm-pr');
    barEl = root.querySelector('.pm-bar i');

    // 15 枚金币一次建好，之后只切 class，避免反复增删节点
    ROWS.forEach(function (row) {
      row.xs.forEach(function (x) {
        var c = document.createElement('i');
        c.className = 'pm-coin';
        c.style.setProperty('--x', x + '%');
        c.style.setProperty('--y', row.y + 'px');
        coinsWrap.appendChild(c);
        coins.push(c);
      });
    });

    root.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && busy) close();
    });
  }

  /* ---------- 金币堆 ---------- */
  function setFill(f) {
    var n = Math.round(clamp01(f) * TOTAL);
    for (var i = 0; i < TOTAL; i++) coins[i].classList.toggle('on', i < n);
    return n;
  }
  function dropCoin(i) {
    var c = coins[i];
    if (!c) return;
    c.classList.add('on');
    c.classList.remove('drop');
    void c.offsetWidth;
    c.classList.add('drop');
    setTimeout(function () { c.classList.remove('drop'); }, 470);
  }
  function ejectCoin(i) {
    var c = coins[i];
    if (!c) return;
    c.classList.add('eject');
    setTimeout(function () { c.classList.remove('eject', 'on'); }, 380);
  }

  /* ---------- 金额滚动 ---------- */
  function currentAmt() {
    var v = parseFloat(String(amtEl.textContent).replace(/[^\d.]/g, ''));
    return isFinite(v) ? v : 0;
  }
  function tweenTo(to, dur) {
    var from = currentAmt();
    var sign = panel.dataset.mode === 'in' ? '+' : '-';
    var t0 = performance.now();
    dur = dur || 240;
    if (numRaf) cancelAnimationFrame(numRaf);
    function step(t) {
      var k = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      amtEl.textContent = sign + '¥' + money(from + (to - from) * e);
      if (k < 1) numRaf = requestAnimationFrame(step);
      else { numRaf = 0; amtEl.textContent = sign + '¥' + money(to); }
    }
    numRaf = requestAnimationFrame(step);
  }

  /* ---------- 进度条 ---------- */
  var progLabel = '目标进度';
  function setBar(p, instant) {
    p = Math.round(Math.max(0, Math.min(100, p)) * 10) / 10;
    if (instant) { barEl.style.transition = 'none'; barEl.style.width = p + '%'; void barEl.offsetWidth; barEl.style.transition = ''; }
    else barEl.style.width = p + '%';
    if (plEl) plEl.innerHTML = esc(progLabel) + ' <b>' + Math.round(p) + '%</b>';
  }

  /* ---------- 飞行硬币 ---------- */
  function flyIn(seq, count) {
    var w = document.createElement('div');
    w.className = 'pm-fly-coin';
    w.innerHTML = '<i></i>';
    flyLayer.appendChild(w);

    var dx = (seq % 2 ? 1 : -1) * (13 + Math.random() * 13);
    var tilt = (seq % 2 ? 1 : -1) * 12;

    // 只做 2D 摆动 + 一点点倾斜：圆形硬币用 rotateX 会翻成一条线，看起来像消失了
    // 起点压到 -56px：再高就会飞出卡片上沿，手机端会飘在半透明遮罩上
    var a = w.animate([
      { transform: 'translate(' + dx + 'px,-56px) rotate(' + (-tilt) + 'deg) scale(.8)', opacity: 0, offset: 0 },
      { transform: 'translate(' + (dx * .66) + 'px,-32px) rotate(' + (-tilt * .4) + 'deg) scale(.9)', opacity: 1, offset: .3 },
      { transform: 'translate(0px,-16px) rotate(' + (tilt * .35) + 'deg) scale(1.04)', opacity: 1, offset: .76 },
      { transform: 'translate(0px,-2px) rotate(0deg) scale(.94)', opacity: 1, offset: 1 }
    ], { duration: 360, easing: 'cubic-bezier(.4,.05,.9,.55)', fill: 'both' });

    var kill = function () { if (w.parentNode) w.remove(); };
    a.finished.then(kill).catch(kill);
    setTimeout(kill, 900);
  }

  function flyOut(seq, count) {
    var w = document.createElement('div');
    w.className = 'pm-fly-coin';
    w.innerHTML = '<i></i>';
    flyLayer.appendChild(w);
    var side = seq % 2 ? 1 : -1;

    var a = w.animate([
      { transform: 'translate(0px,-2px) rotate(0deg) scale(.94)', opacity: 1, offset: 0 },
      { transform: 'translate(' + (16 * side) + 'px,-22px) rotate(' + (14 * side) + 'deg) scale(1.08)', opacity: 1, offset: .3 },
      { transform: 'translate(' + (88 * side) + 'px,26px) rotate(' + (40 * side) + 'deg) scale(.9)', opacity: .95, offset: .7 },
      { transform: 'translate(' + (152 * side) + 'px,128px) rotate(' + (72 * side) + 'deg) scale(.46)', opacity: 0, offset: 1 }
    ], { duration: 700, easing: 'cubic-bezier(.36,.06,.7,.5)', fill: 'both' });

    var kill = function () { if (w.parentNode) w.remove(); };
    a.finished.then(kill).catch(kill);
    setTimeout(kill, 1100);
  }

  function ping() {
    var p = document.createElement('i');
    p.className = 'pm-ping';
    jar.appendChild(p);
    setTimeout(function () { if (p.parentNode) p.remove(); }, 560);
  }

  /* ---------- 收尾 ---------- */
  function close() {
    if (!busy || closing) return;
    closing = true;
    clearTimers();
    root.classList.add('is-out');
    setTimeout(function () {
      root.style.display = 'none';
      root.classList.remove('is-out');
      panel.classList.remove('is-in');
      flyLayer.innerHTML = '';
      if (numRaf) { cancelAnimationFrame(numRaf); numRaf = 0; }
      busy = false; closing = false;
      var q = queue; queue = null;
      if (q) setTimeout(function () { play(q); }, 240);   // 批量记账时合并成一次补播
    }, 240);
  }

  /* ---------- 主入口 ---------- */
  function play(o) {
    o = o || {};
    var amount = Number(o.amount);
    if (!isFinite(amount) || amount <= 0) return false;
    o.amount = amount;
    var mode = o.mode === 'out' ? 'out' : 'in';

    if (busy) {
      if (queue && queue.mode === mode) {
        queue.amount += amount;
        if (o.fillTo != null) queue.fillTo = o.fillTo;
        if (o.progress) queue.progress = o.progress;
      } else {
        queue = o;
      }
      return false;
    }

    busy = true;
    closing = false;
    build();
    clearTimers();

    var fillFrom = o.fillFrom != null ? clamp01(o.fillFrom) : (mode === 'in' ? 0.42 : 0.52);
    var fillTo = o.fillTo != null ? clamp01(o.fillTo) : fillFrom;
    var pr = o.progress || null;
    var pFrom = pr && pr.from != null ? Number(pr.from) : fillFrom * 100;
    var pTo = pr && pr.to != null ? Number(pr.to) : fillTo * 100;
    progLabel = (pr && pr.label) || (mode === 'in' ? '目标进度' : '罐子充盈度');

    /* 复位 */
    root.style.display = 'grid';
    root.classList.remove('is-out');
    panel.dataset.mode = mode;
    panel.classList.remove('is-in');
    face.classList.remove('is-shock', 'is-happy');
    jar.classList.remove('gulp', 'shock', 'deflate');
    flyLayer.innerHTML = '';

    /* 文案 */
    ebEl.textContent = o.title || (mode === 'in' ? '存入存钱罐' : '一笔支出');
    lineEl.textContent = o.line || (mode === 'in' ? '硬币落进去了，罐子沉了一点' : '钱被拿走了，罐子轻了一点');
    amtEl.textContent = (mode === 'in' ? '+' : '-') + '¥0.00';
    if (prEl) prEl.textContent = pr && pr.sub ? pr.sub : '';
    if (plEl) plEl.innerHTML = esc(progLabel) + ' <b>' + Math.round(pFrom) + '%</b>';

    /* 初始金币：无过渡铺好 */
    coinsWrap.classList.add('no-anim');
    var baseN = setFill(fillFrom);
    setBar(pFrom, true);
    void coinsWrap.offsetWidth;
    coinsWrap.classList.remove('no-anim');

    /* 面板入场 */
    void panel.offsetWidth;
    panel.classList.add('is-in');

    if (mode === 'in') runIn(o, baseN, pFrom, pTo);
    else runOut(o, baseN, pFrom, pTo);

    return true;
  }

  function runIn(o, baseN, pFrom, pTo) {
    var amount = o.amount;
    var count = amount >= 2000 ? 5 : amount >= 500 ? 3 : amount >= 100 ? 2 : 1;
    var per = amount / count;
    var acc = 0;
    var HIT = 360;                                  // 硬币飞行时长

    for (var i = 0; i < count; i++) {
      (function (i) {
        var t0 = 70 + i * 200;
        later(function () { flyIn(i, count); }, t0);
        later(function () {
          burst(jar, 'gulp', 470);
          ping();
          acc += per;
          tweenTo(acc, 250);
          if (baseN + i + 1 <= TOTAL) dropCoin(baseN + i);
          setBar(pFrom + (pTo - pFrom) * (i + 1) / count);
          if (i === count - 1) {
            lateHappy();
          }
        }, t0 + HIT);
      })(i);
    }

    var endAt = 70 + (count - 1) * 200 + HIT;
    later(function () {
      lineEl.textContent = o.doneLine || (
        amount >= 1000 ? '轰的一声，罐子沉了一大截' :
        amount >= 100 ? '叮！罐子又沉了一点' : '一枚硬币，也是开始'
      );
    }, endAt + 200);
    later(close, endAt + (o.hold || 1200));
  }

  function lateHappy() {
    face.classList.add('is-happy');
    setTimeout(function () { face.classList.remove('is-happy'); }, 760);
  }

  function runOut(o, baseN, pFrom, pTo) {
    var amount = o.amount;
    var count = amount >= 500 ? 4 : amount >= 100 ? 3 : 2;
    var per = amount / count;
    var acc = 0;

    later(function () {
      burst(jar, 'shock', 540);
      face.classList.add('is-shock');
    }, 140);

    for (var i = 0; i < count; i++) {
      (function (i) {
        var t0 = 300 + i * 178;
        later(function () {
          if (baseN - i > 0) ejectCoin(baseN - i - 1);
          flyOut(i, count);
          acc += per;
          tweenTo(acc, 240);
          setBar(pFrom + (pTo - pFrom) * (i + 1) / count);
        }, t0);
      })(i);
    }

    var endAt = 300 + (count - 1) * 178;
    later(function () {
      burst(jar, 'deflate', 520);
    }, endAt + 170);
    later(function () {
      lineEl.textContent = o.doneLine || (
        amount >= 500 ? '这一笔下去，罐子明显轻了' :
        amount >= 100 ? '钱被拿走了，罐子瘪了一点' : '小钱也是钱，罐子记得'
      );
    }, endAt + 420);
    later(function () { face.classList.remove('is-shock'); }, endAt + 640);
    later(close, endAt + (o.hold || 1300));
  }

  /* ---------- 对外 ---------- */
  window.PiggyMotion = {
    play: play,
    save: function (o) { o = o || {}; o.mode = 'in'; return play(o); },
    spend: function (o) { o = o || {}; o.mode = 'out'; return play(o); },
    close: close,
    isBusy: function () { return busy; },
    /* 供自动化验收 */
    __state: function () {
      return {
        busy: busy,
        mode: panel ? panel.dataset.mode : '',
        amount: amtEl ? amtEl.textContent : '',
        onCoins: coins.filter(function (c) { return c.classList.contains('on'); }).length,
        totalCoins: coins.length,
        bar: barEl ? barEl.style.width : '',
        line: lineEl ? lineEl.textContent : '',
        eyebrow: ebEl ? ebEl.textContent : '',
        flying: flyLayer ? flyLayer.children.length : 0
      };
    }
  };
})();
