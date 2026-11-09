/* SmartPig · 一页看懂亮点页交互
   - 顶部导航滚动状态
   - 移动端汉堡菜单开合
   - 入场渐显（.reveal）
   与 landing.js 保持一致的轻量实现。 */
(function () {
  'use strict';

  var header = document.querySelector('.site-header');
  function syncHeader() {
    var menuOpen = false;
    var menu = document.getElementById('mobileMenu');
    if (menu) menuOpen = !menu.hidden;
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 12 || menuOpen);
  }
  window.addEventListener('scroll', syncHeader, { passive: true });

  var burger = document.getElementById('navBurger');
  var menu = document.getElementById('mobileMenu');
  if (burger && menu) {
    function setOpen(open) {
      menu.hidden = !open;
      menu.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      burger.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
      syncHeader();
    }
    burger.addEventListener('click', function () { setOpen(menu.hidden); });
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { setOpen(false); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { setOpen(false); burger.focus(); }
    });
  }
  syncHeader();

  /* 入场渐显 */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* 产品一览画廊：自动轮播 + 手动切换 */
  var gallery = document.getElementById('hlGallery');
  var track = document.getElementById('hlGalTrack');
  var dotsWrap = document.getElementById('hlGalDots');
  if (gallery && track) {
    var slides = Array.prototype.slice.call(track.children);
    var count = slides.length;
    var idx = 0;
    var timer = null;
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var DELAY = 4200;

    // 构建指示点
    if (dotsWrap) {
      for (var i = 0; i < count; i++) {
        var d = document.createElement('button');
        d.type = 'button';
        d.setAttribute('aria-label', '第 ' + (i + 1) + ' 张：' + (slides[i].getAttribute('data-label') || ''));
        (function (n) {
          d.addEventListener('click', function () { go(n, true); });
        })(i);
        dotsWrap.appendChild(d);
      }
    }
    function update() {
      // 百分比位移相对轨道自身宽度会失真，改为按单屏像素位移
      var w = slides[0] ? slides[0].getBoundingClientRect().width : 0;
      track.style.transform = 'translateX(' + (-idx * w) + 'px)';
      if (dotsWrap) {
        Array.prototype.forEach.call(dotsWrap.children, function (b, n) {
          b.classList.toggle('is-active', n === idx);
        });
      }
    }
    function go(n, manual) {
      idx = (n + count) % count;
      update();
      if (manual) restart();
    }
    function next() { go(idx + 1, false); }
    function prev() { go(idx - 1, false); }
    function start() { if (!timer && !reduceMotion) timer = setInterval(next, DELAY); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function restart() { stop(); start(); }

    var prevBtn = gallery.querySelector('.hl-gal-prev');
    var nextBtn = gallery.querySelector('.hl-gal-next');
    if (prevBtn) prevBtn.addEventListener('click', function () { prev(); restart(); });
    if (nextBtn) nextBtn.addEventListener('click', function () { next(); restart(); });

    gallery.addEventListener('mouseenter', stop);
    gallery.addEventListener('mouseleave', start);
    gallery.addEventListener('focusin', stop);
    gallery.addEventListener('focusout', start);
    gallery.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); next(); restart(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); restart(); }
    });

    update();
    start();

    // 窗口缩放时重算位移，保持当前屏对齐
    var rz;
    window.addEventListener('resize', function () {
      clearTimeout(rz);
      rz = setTimeout(update, 120);
    });
  }
})();
