/* =========================================================
   财悟·AI财务助手 — 落地页交互（landing）
   纯原生 JS，无依赖。仅 index.html 加载。
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 顶栏滚动状态 ---------- */
  var header = document.querySelector('.site-header');

  function syncHeader() {
    if (!header) return;
    var menuOpen = burger && !menu.hidden;
    header.classList.toggle('is-scrolled', window.scrollY > 12 || !!menuOpen);
  }

  window.addEventListener('scroll', syncHeader, { passive: true });

  /* ---------- 移动端菜单 ---------- */
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

    burger.addEventListener('click', function () {
      setOpen(menu.hidden);
    });

    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        setOpen(false);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) {
        setOpen(false);
        burger.focus();
      }
    });
  }

  syncHeader();

  /* ---------- 入场渐显（仅首屏以下内容） ---------- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) {
      el.classList.add('is-visible');
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -5% 0px' }
    );
    reveals.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ---------- FAQ 手风琴（单开） ---------- */
  var items = Array.prototype.slice.call(document.querySelectorAll('.faq-item'));

  items.forEach(function (item) {
    var trigger = item.querySelector('.faq-trigger');
    if (!trigger) return;

    trigger.addEventListener('click', function () {
      var wasOpen = item.classList.contains('is-open');

      items.forEach(function (other) {
        other.classList.remove('is-open');
        var t = other.querySelector('.faq-trigger');
        var p = other.querySelector('.faq-answer');
        if (t) t.setAttribute('aria-expanded', 'false');
        if (p) p.setAttribute('aria-hidden', 'true');
      });

      if (!wasOpen) {
        item.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        var panel = item.querySelector('.faq-answer');
        if (panel) panel.removeAttribute('aria-hidden');
      }
    });
  });
})();
