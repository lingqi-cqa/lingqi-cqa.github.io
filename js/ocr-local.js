/* 财悟·AI财务助手 — 纯前端小票 OCR（无需任何后端）
 * 原理：按需加载 Tesseract.js（WebAssembly），在浏览器里直接对小票/支付截图做中英文识别，
 *      再用本地解析器从小票文本里抽取「金额 / 商家 / 日期 / 分类」，全程不上传服务器。
 *
 * 对外 API：
 *   window.LocalOCR.recognize(image, onProgress) -> Promise<result>
 *   result = {
 *     engineFailed: boolean,      // OCR 引擎不可用（CDN 加载失败等）
 *     text, lines,                // 原始识别文本
 *     amount,                     // 推荐金额（字符串，保留 2 位小数）
 *     amountCandidates: [..],     // 其它候选金额，供用户改选
 *     merchant, date, category,   // 商家 / 日期(YYYY-MM-DD) / 分类 key
 *     elapsed
 *   }
 *
 * 设计取舍：
 *  - 不伪造数据。识别不出就返回空值，由调用方提示手动填写。
 *  - worker 复用，第二次起识别快很多。
 *  - 语言包首次约 10–20MB，给出进度回调；超时自动失败降级。
 */
(function () {
  'use strict';

  // 本地内置引擎：直接指向项目根目录下的 vendor/tesseract/，离线可用、不依赖外网 CDN
  // （以本脚本 js/ocr-local.js 所在目录为基准，回退到项目根，再进入 vendor）
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || location.href;
  var VENDOR = new URL('../vendor/tesseract/', SCRIPT_SRC).href;
  // CDN 仅作为「本地文件缺失」时的兜底
  var CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  var CDN_FALLBACK = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
  var LOAD_TIMEOUT = 25000;   // 加载 OCR 引擎脚本的超时
  var OCR_TIMEOUT = 150000;   // 单次识别超时（中文模型首次较慢）

  /* ---------------- 分类关键词（key 与 app.js 的 CATEGORIES 保持一致） ---------------- */
  var CAT_WORDS = {
    food: ['蜜雪', '奶茶', '咖啡', '瑞幸', '星巴克', '肯德基', 'KFC', '麦当劳', 'McDonald', '必胜客', '海底捞', '美团', '饿了么', '外卖', '食堂', '餐厅', '饭店', '餐饮', '小吃', '烧烤', '火锅', '包子', '饺子', '面包', '蛋糕', '甜品', '水果', '食品', '饮料', '零食', '面馆', '米线', '麻辣烫', '沙县', '黄焖', '卤味', '茶饮', '烘焙', '酒馆', '料理', '寿司', '汉堡', '披萨', '粥', '早餐', '午餐', '晚餐'],
    transport: ['滴滴', '打车', '出租车', '高德', '曹操', 'T3出行', '地铁', '轨道交通', '公交', '加油', '中石油', '中石化', '壳牌', '停车', '高速', '高铁', '铁路', '火车', '航空', '机票', '单车', '哈啰', '青桔', '摩拜', '出行', '车费', '油费', 'ETC'],
    shopping: ['淘宝', '天猫', '京东', '拼多多', '唯品会', '苏宁', '得物', '闲鱼', '小红书', '商城', '百货', '购物', '服饰', '优衣库', '无印良品', 'MUJI', '名创优品', '化妆品', '护肤', '屈臣氏', '丝芙兰', '数码', '手机', '电脑', '家电', '日用品', '母婴', '超市', '便利店', '沃尔玛', '永辉', '家乐福', '大润发', '盒马', '华润万家', '物美', '全家', '罗森', '7-11', '711'],
    home: ['房租', '物业', '水费', '电费', '燃气', '煤气', '网费', '宽带', '话费', '电信', '移动', '联通', '公积金', '房贷', '家居', '装修', '家具', '宜家', '五金'],
    fun: ['电影', '影院', '万达', 'CGV', '游戏', 'Steam', '充值', '会员', 'KTV', '旅游', '门票', '景区', '演唱会', '大麦', '演出', '健身', '游泳', '娱乐', '剧本杀', '密室', '桌游', '爱奇艺', '腾讯视频', '网易云', '优酷', 'B站', '哔哩哔哩'],
    medical: ['医院', '药店', '药房', '大药房', '诊所', '体检', '门诊', '挂号', '口腔', '牙科', '眼科', '医疗', '疫苗', '同仁堂', '海王星辰', '老百姓大药房'],
    edu: ['书店', '图书', '课程', '培训', '网课', '学费', '辅导', '考试', '教育', '教材', '文具', '得到', '知识星球', '新东方', '学而思', '驾校'],
    other_e: ['捐赠', '公益', '罚款', '手续费', '服务费', '利息', '快递', '顺丰', '中通', '圆通', '韵达', '邮政']
  };
  var CAT_ALIAS = {};
  Object.keys(CAT_WORDS).forEach(function (k) {
    CAT_WORDS[k].forEach(function (w) {
      var low = w.toLowerCase();
      if (!CAT_ALIAS[low]) CAT_ALIAS[low] = k;
    });
  });

  function predictCategory(text) {
    if (!text) return '';
    var s = String(text).toLowerCase();
    var best = '', bestLen = 0;
    for (var w in CAT_ALIAS) {
      if (s.indexOf(w) !== -1 && w.length > bestLen) { best = CAT_ALIAS[w]; bestLen = w.length; }
    }
    return best;
  }

  /* ---------------- 工具 ---------------- */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function fmtAmount(n) { return (Math.round(n * 100) / 100).toFixed(2); }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true; reject(new Error('加载 OCR 引擎超时'));
      }, LOAD_TIMEOUT);
      s.onload = function () { if (done) return; done = true; clearTimeout(timer); resolve(); };
      s.onerror = function () { if (done) return; done = true; clearTimeout(timer); reject(new Error('加载 OCR 引擎失败')); };
      document.head.appendChild(s);
    });
  }

  var engineLoading = null;
  function ensureEngine() {
    if (window.Tesseract) return Promise.resolve();
    if (engineLoading) return engineLoading;
    // 优先加载本地内置引擎，缺失时再退回 CDN
    engineLoading = loadScript(VENDOR + 'tesseract.min.js')
      .catch(function () { return loadScript(CDN); })
      .catch(function () { return loadScript(CDN_FALLBACK); })
      .then(function () {
        if (!window.Tesseract) throw new Error('OCR 引擎未就绪');
      }).catch(function (e) {
        engineLoading = null;
        throw e;
      });
    return engineLoading;
  }

  /* ---------------- worker 复用 ---------------- */
  var workerPromise = null;
  var progressCb = null;

  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = ensureEngine().then(function () {
      return window.Tesseract.createWorker('chi_sim+eng', 1, {
        workerPath: VENDOR + 'worker.min.js', // 本地完整文件路径
        corePath: VENDOR,              // 本地目录，自动拼接 tesseract-core[-simd].wasm.js（SIMD 自动选择）
        langPath: VENDOR + 'lang-data/', // 本地目录，自动拼接 <lang>.traineddata.gz
        logger: function (m) {
          if (!progressCb || !m || !m.status) return;
          // 真实阶段映射（注意 worker 上报的 status 是空格，不是连字符）
          var STAGE = {
            'loading tesseract core': 8,
            'initializing tesseract': 14,
            'loading language traineddata': 30,
            'initializing api': 46
          };
          if (m.status === 'recognizing text' && typeof m.progress === 'number') {
            progressCb(Math.min(99, Math.round(m.progress * 44) + 52));
          } else if (STAGE[m.status] != null) {
            progressCb(STAGE[m.status]);
          } else {
            progressCb(5);
          }
        },
        errorHandler: function (e) { console.warn('[LocalOCR]', e); }
      });
    }).then(function (w) {
      // 小票多为单列文本块，PSM 6 更稳；保留词间空格便于分行解析
      return w.setParameters({
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: '6'
      }).then(function () { return w; }).catch(function () { return w; });
    }).catch(function (e) {
      workerPromise = null;
      throw e;
    });
    return workerPromise;
  }

  function withTimeout(p, ms, msg) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(msg || '识别超时')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  /* ---------------- 文本解析 ---------------- */

  // 金额提示词（出现在这些词附近的行，数字更可能是总金额）
  var AMOUNT_HINT = /(合计|总计|总金额|总额|实付|实收|应付|应收|消费金额|付款金额|支付金额|小计|金额|Total|TOTAL|Amount|AMOUNT|SUM|Balance)/;
  // 需要整行跳过的（日期/时间/单号/联系方式）
  var LINE_SKIP = /(20\d{2}\s*[-/.年]\s*\d{1,2})|(\d{1,2}:\d{2})|(单号|订单号|流水号|票号|收银|营业员|会员号|积分|电话|手机|Tel|TEL|No\.|NO\.|发票|二维码)/;

  function numsIn(line) {
    var out = [];
    var re = /(\d{1,3}(?:,\d{3})+|\d+)(?:[.．](\d{1,2}))?/g;
    var m;
    while ((m = re.exec(line)) !== null) {
      var intPart = m[1].replace(/,/g, '');
      var v = parseFloat(intPart + (m[2] ? '.' + m[2] : ''));
      if (!isFinite(v)) continue;
      out.push({ v: v, dec: !!m[2], raw: m[0], at: m.index });
    }
    return out;
  }

  function collectAmounts(lines) {
    var strong = [], weak = [], loose = [];

    lines.forEach(function (line) {
      if (LINE_SKIP.test(line)) return;
      var nums = numsIn(line);
      if (!nums.length) return;

      var isHint = AMOUNT_HINT.test(line);
      nums.forEach(function (n) {
        if (n.v <= 0 || n.v > 99999.99) return;
        // 排除像年份的裸整数
        if (!n.dec && n.v >= 1990 && n.v <= 2099) return;
        if (isHint) {
          // 关键词行：优先带小数的数（一般是行尾金额）
          strong.push(n);
        } else {
          weak.push(n);
        }
        loose.push(n);
      });
    });

    // 优先级：关键词行且带小数 > 关键词行 > 普通行且带小数（同级内金额大的靠前）
    var seen = {}, out = [];
    // 先按 strong 优先级给出顺序，再对同级别按金额从大到小
    var groups = [
      strong.filter(function (n) { return n.dec; }),
      strong.filter(function (n) { return !n.dec; }),
      weak.filter(function (n) { return n.dec; })
    ];
    groups.forEach(function (g) {
      g.sort(function (a, b) { return b.v - a.v; });
      g.forEach(function (n) {
        var key = n.v.toFixed(2);
        if (seen[key]) return;
        seen[key] = 1;
        out.push(round2(n.v));
      });
    });
    // 兜底：如果强候选为空，取全文最大的带小数数字
    if (!out.length) {
      loose.sort(function (a, b) { return b.v - a.v; });
      loose.forEach(function (n) {
        var key = n.v.toFixed(2);
        if (seen[key]) return;
        seen[key] = 1;
        out.push(round2(n.v));
      });
    }
    return out.slice(0, 5);
  }

  function pickDate(text, lines) {
    var now = new Date();
    var y = now.getFullYear();

    // 2026-10-29 / 2026/10/29 / 2026.10.29 / 2026年10月29日
    var m = text.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
    if (m) {
      var Y = parseInt(m[1], 10), M = parseInt(m[2], 10), D = parseInt(m[3], 10);
      if (M >= 1 && M <= 12 && D >= 1 && D <= 31) return Y + '-' + pad2(M) + '-' + pad2(D);
    }
    // 10-29 或 10月29日（补当前年）
    var m2 = text.match(/(?:^|[^\d])(\d{1,2})\s*[-/月]\s*(\d{1,2})(?:\s*日|[^\d]|$)/);
    if (m2) {
      var M2 = parseInt(m2[1], 10), D2 = parseInt(m2[2], 10);
      if (M2 >= 1 && M2 <= 12 && D2 >= 1 && D2 <= 31) {
        var d = new Date(y, M2 - 1, D2);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      }
    }
    // 8 位数字 20261029
    var m3 = text.match(/(20\d{2})(\d{2})(\d{2})/);
    if (m3) {
      var Y3 = parseInt(m3[1], 10), M3 = parseInt(m3[2], 10), D3 = parseInt(m3[3], 10);
      if (M3 >= 1 && M3 <= 12 && D3 >= 1 && D3 <= 31) return Y3 + '-' + pad2(M3) + '-' + pad2(D3);
    }
    return '';
  }

  var MERCHANT_SKIP = /(发票|小票|收据|订单|单号|流水|票号|日期|时间|收银|营业员|欢迎|谢谢|惠顾|地址|电话|微信|支付宝|支付|会员|积分|二维码|NO\.|Tel|TEL|机号|终端|商户号|批次)/i;

  function pickMerchant(lines) {
    var cands = [];
    var limit = Math.min(lines.length, 8);
    for (var i = 0; i < limit; i++) {
      var L = lines[i];
      if (!L || L.length < 2 || L.length > 24) continue;
      if (/^[\d\s\-:/.．¥￥%*#]+$/.test(L)) continue;           // 纯数字/符号
      if (MERCHANT_SKIP.test(L)) continue;
      var zh = (L.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (zh < 2) continue;                                     // 至少要 2 个汉字
      var score = 0;
      if (predictCategory(L)) score += 8;                        // 命中商家关键词，最可信
      score += Math.min(zh, 10) * 0.5;
      score += Math.max(0, 6 - i) * 0.8;                          // 越靠前越像店名
      cands.push({ L: L, score: score, i: i });
    }
    if (!cands.length) return '';
    cands.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    var name = cands[0].L.replace(/^[*#\-\s]+/, '').replace(/\s{2,}/g, ' ').trim();
    return name.slice(0, 24);
  }

  function parseReceiptText(raw) {
    var text = String(raw || '').replace(/\r/g, '');
    var lines = text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    var amounts = collectAmounts(lines);
    var merchant = pickMerchant(lines);
    var date = pickDate(text, lines);
    var category = predictCategory(merchant) || predictCategory(lines.join(' ')) || '';

    return {
      text: text,
      lines: lines,
      amount: amounts.length ? fmtAmount(amounts[0]) : '',
      amountCandidates: amounts.slice(1),
      merchant: merchant,
      date: date,
      category: category
    };
  }

  /* ---------------- 图片预处理（放大 + 灰度，提升小票识别率） ---------------- */
  function preprocess(src, maxW) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) return resolve(src);
          // 小图放大到合适尺寸（小票文字很小时 OCR 容易糊）
          var target = Math.min(maxW || 1600, Math.max(1000, w * 1.6));
          var scale = target / w;
          if (scale > 3) scale = 3;
          var cw = Math.round(w * scale), ch = Math.round(h * scale);
          var cv = document.createElement('canvas');
          cv.width = cw; cv.height = ch;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, cw, ch);
          // 灰度 + 轻对比增强
          var data = ctx.getImageData(0, 0, cw, ch);
          var p = data.data;
          for (var i = 0; i < p.length; i += 4) {
            var g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
            g = (g - 128) * 1.25 + 128;               // 提高对比
            g = g < 0 ? 0 : (g > 255 ? 255 : g);
            p[i] = p[i + 1] = p[i + 2] = g;
          }
          ctx.putImageData(data, 0, 0);
          resolve(cv.toDataURL('image/png'));
        } catch (e) {
          resolve(src); // 任何异常都退回原图
        }
      };
      img.onerror = function () { resolve(src); };
      img.src = src;
    });
  }

  /* ---------------- 主入口 ---------------- */
  function recognize(image, onProgress, onStage) {
    var started = Date.now();
    progressCb = typeof onProgress === 'function' ? onProgress : null;
    var stage = typeof onStage === 'function' ? onStage : function () {};
    if (progressCb) progressCb(0);

    stage('① 正在加载 OCR 引擎脚本（本地）…');
    return ensureEngine()
      .then(function () {
        stage('② 引擎脚本已加载，正在创建识别核心（Web Worker）…');
        return preprocess(image);
      })
      .then(function (prepared) {
        return withTimeout(getWorker(), 60000, 'OCR 引擎初始化超时');
      }).then(function (worker) {
        stage('③ 识别核心就绪，开始识别文字…');
        return withTimeout(
          worker.recognize(image).catch(function () {
            // 首次失败时，用预处理后的灰度图再试一次
            return preprocess(image, 2000).then(function (p2) { return worker.recognize(p2); });
          }),
          OCR_TIMEOUT, '识别超时（图片可能过大或网络较慢）'
        );
      }).then(function (res) {
        var text = (res && res.data && res.data.text) || '';
        var out = parseReceiptText(text);
        out.elapsed = Date.now() - started;
        out.engineFailed = false;
        if (progressCb) progressCb(100);
        return out;
      }).catch(function (err) {
        // 引擎级失败：标记出来，让调用方降级为「手动填写」，绝不返回编造数据
        var msg = (err && err.message) || '未知错误';
        try { if (workerPromise) { workerPromise.then(function (w) { try { w.terminate(); } catch (e) {} }); } } catch (e) {}
        workerPromise = null;
        return {
          engineFailed: true,
          error: msg,
          text: '', lines: [],
          amount: '', amountCandidates: [], merchant: '', date: '', category: '',
          elapsed: Date.now() - started
        };
      }).then(function (r) {
        progressCb = null;
        return r;
      });
  }

  window.LocalOCR = {
    recognize: recognize,
    parseText: parseReceiptText,      // 便于调试/单测：直接喂文本
    predictCategory: predictCategory,
    isReady: function () { return !!workerPromise; }
  };
})();
