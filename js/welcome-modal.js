/* =========================================================
   登录激励弹窗（财悟·AI）
   登录成功进入 dashboard 后，首次弹出励志+有趣的存钱激励窗。
   仅用 sessionStorage 标记控制「登录后首次」，刷新不会重复弹。
   ========================================================= */
(function () {
  'use strict';

  var JUST = 'cw_justLoggedIn';

  // 励志又好玩的存钱文案（每条随机展示一条）
  var QUOTES = [
    '🐷 欢迎回家！小猪饿了一整天，喂它一口钱，它就给你长胖一点点～',
    '💰 钱不是省出来的，是「先不买」攒出来的。今天忍住一笔，小猪就笑开花！',
    '🚀 你离财务自由，只差 9999 次「再想想」。今天先来第 1 次？',
    '🧋 别人在疯狂剁手，你在悄悄存钱——半年后，你请别人喝奶茶。',
    '💪 每存一笔，都是给未来的自己发工资。今天的工资，发了吗？',
    '👀 小猪偷偷预警：你不存钱，它就要搬家去隔壁家了哦～',
    '📈 存钱最爽的不是变富，是看余额往上涨，比拆快递还上头！',
    '✈️ 今天省下的不是钱，是明天说走就走的底气。',
    '🌙 钱包鼓鼓，睡觉香香。今晚先存一笔再睡，好不好？',
    '💚 别让明天的你，讨厌今天乱花钱的自己。存就完事了！',
    '🍱 工资到账先别飘，先喂饱小猪再考虑别的，它比双十一靠谱。',
    '🏆 存钱是场和自己的马拉松，今天多跑一步，离自由就近一步。'
  ];

  function greeting(h) {
    if (h >= 5 && h < 11) return { word: '早安', icon: '☀️' };
    if (h >= 11 && h < 14) return { word: '午安', icon: '🍱' };
    if (h >= 14 && h < 18) return { word: '下午好', icon: '🌤️' };
    if (h >= 18 && h < 23) return { word: '晚上好', icon: '🌆' };
    return { word: '夜深了', icon: '🌙' };
  }

  function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function close() {
    var mask = document.getElementById('welcomeMask');
    if (mask) mask.classList.remove('show');
  }

  // 「去存第一笔」：关闭弹窗 → 打开记账弹窗并预设「收入」类型
  function goSave() {
    close();
    var fab = document.getElementById('fab');
    if (fab) fab.click();              // app.js 绑定了 openTxModal
    var txModal = document.getElementById('txModal');
    if (txModal) {
      var incBtn = txModal.querySelector('#txSeg button[data-type="income"]');
      if (incBtn) incBtn.click();
    }
  }

  function init() {
    var flag = null;
    try { flag = sessionStorage.getItem(JUST); } catch (e) {}
    if (flag !== '1') return;          // 非「刚登录」不弹
    try { sessionStorage.removeItem(JUST); } catch (e) {}

    var session = null;
    try { session = JSON.parse(localStorage.getItem('cw_session') || 'null'); } catch (e) {}
    if (!session) return;

    var g = greeting(new Date().getHours());
    var name = (session.name && session.name.trim()) ? session.name.trim() : '存钱人';
    var quote = randomItem(QUOTES);
    var luck = 70 + Math.floor(Math.random() * 29); // 70~98 的趣味「存钱运势」

    var titleEl = document.getElementById('welcomeTitle');
    var quoteEl = document.getElementById('welcomeQuote');
    var luckEl = document.getElementById('welcomeLuck');
    var fillEl = document.getElementById('welcomeFill');

    if (titleEl) titleEl.textContent = g.icon + ' ' + g.word + '，' + name + '！';
    if (quoteEl) quoteEl.textContent = quote;
    if (luckEl) luckEl.textContent = '今日存钱运势 🔥 ' + luck + '%';
    if (quoteEl) quoteEl.setAttribute('data-luck', String(luck));

    var mask = document.getElementById('welcomeMask');
    if (mask) {
      mask.classList.add('show');
      // 进度条动画
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { if (fillEl) fillEl.style.width = luck + '%'; });
      });
    }
  }

  function bind() {
    init();
    var closeBtn = document.getElementById('welcomeClose');
    var laterBtn = document.getElementById('welcomeLater');
    var saveBtn = document.getElementById('welcomeSave');
    var mask = document.getElementById('welcomeMask');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (laterBtn) laterBtn.addEventListener('click', close);
    if (saveBtn) saveBtn.addEventListener('click', goSave);
    if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
