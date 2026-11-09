/* =========================================================
   财悟·AI财务助手 — 仪表盘逻辑（纯前端演示）
   数据保存在 localStorage，无后端。
   新增：食物热量估算、AI 提醒、分类预算预警、
        ECharts 数据可视化、储蓄目标 AI 预测、AI 智能体对话。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 会话校验（支持游客演示模式） ---------------- */
  // 无登录态时不再强制跳登录，而是进入「游客演示模式」：加载示例数据、全局只读。
  let session = JSON.parse(localStorage.getItem('cw_session') || 'null');
  const DEMO = !session;                 // true = 游客只读演示
  if (!session) {
    session = { guest: true, name: '游客', email: 'guest@demo.local' };
  }

  /* ---------------- 分类配置 ---------------- */
  const CATEGORIES = {
    expense: [
      { key: 'food', name: '餐饮美食', emoji: '🍜' },
      { key: 'transport', name: '交通出行', emoji: '🚌' },
      { key: 'shopping', name: '购物', emoji: '🛍️' },
      { key: 'home', name: '居住', emoji: '🏠' },
      { key: 'fun', name: '休闲娱乐', emoji: '🎮' },
      { key: 'medical', name: '医疗健康', emoji: '💊' },
      { key: 'edu', name: '学习教育', emoji: '📚' },
      { key: 'other_e', name: '其他支出', emoji: '💸' }
    ],
    income: [
      { key: 'salary', name: '工资收入', emoji: '💰' },
      { key: 'part', name: '兼职', emoji: '🧑‍💻' },
      { key: 'invest', name: '投资理财', emoji: '📈' },
      { key: 'gift', name: '红包礼金', emoji: '🧧' },
      { key: 'other_i', name: '其他收入', emoji: '✨' }
    ]
  };
  function catMeta(type, key) {
    const list = CATEGORIES[type] || [];
    return list.find(c => c.key === key) || { name: key, emoji: '💸' };
  }
  const catName = (key) => (catMeta('expense', key).name || catMeta('income', key).name || key);

  /* ---------------- 消费心理账户（让每笔钱都有"情绪记忆"） ---------------- */
  // 把交易映射成用户能共情的账户名：悦己钱 / 隐形损耗 / 生存饭 / 快乐税 ...
  function spendPersona(t) {
    if (!t || t.type === 'income') return null;
    const text = `${t.note || ''} ${t.food || ''} ${t.merchant || ''}`.toLowerCase();
    const cat = t.category;
    if (cat === 'food') {
      if (/食堂|餐厅|饭店|吃饭|午餐|晚餐|早餐|包子|米饭|面条|面馆|快餐|工作餐|公司食堂|单位食堂|盖饭|麻辣烫|食堂饭/.test(text)) return '生存饭';
      if (/奶茶|咖啡|瑞幸|星巴克|甜品|蛋糕|零食|饮料|水果|啤酒|红酒|火锅|烧烤|聚餐|宵夜|外卖|肯德基|麦当劳|必胜客|海底捞|炸鸡|烤肉|日料/.test(text)) return '悦己钱';
      return '悦己钱';
    }
    if (cat === 'shopping') return '隐形损耗';
    if (cat === 'fun') return '快乐税';
    if (cat === 'edu') return '投资自己';
    if (cat === 'medical') return '健康投资';
    if (cat === 'gift') return '人情往来';
    if (cat === 'transport') return '通勤成本';
    if (cat === 'home') return '固定开销';
    return '日常开销';
  }
  const PERSONA_KEY = {
    '悦己钱': 'yueji', '隐形损耗': 'loss', '生存饭': 'survive', '快乐税': 'fun',
    '投资自己': 'invest', '健康投资': 'health', '人情往来': 'social',
    '通勤成本': 'commute', '固定开销': 'fixed', '日常开销': 'daily'
  };
  const personaKey = (p) => PERSONA_KEY[p] || 'daily';
  // 本周起始日（周一）
  function weekStart(iso) {
    const x = new Date(iso + 'T00:00:00');
    if (isNaN(x)) return iso;
    const day = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - day);
    return x.toISOString().slice(0, 10);
  }
  // ===== AI 洞察气泡：真实大模型逐笔点评（带缓存 / 本地兜底） =====
  const LS_INSIGHT = 'cw_insights';
  function getInsightCache() { try { return JSON.parse(localStorage.getItem(LS_INSIGHT) || '{}') || {}; } catch (e) { return {}; } }
  function saveInsightCache(o) {
    const keys = Object.keys(o);
    if (keys.length > 240) {
      keys.sort((a, b) => (o[a].at || 0) - (o[b].at || 0));
      keys.slice(0, keys.length - 240).forEach(k => { delete o[k]; });
    }
    try { localStorage.setItem(LS_INSIGHT, JSON.stringify(o)); } catch (e) { /* 超配额忽略 */ }
  }
  // 内容指纹：备注/金额/日期/标签变了就重新生成
  function txSig(t) {
    const s = [t.note || '', t.amount, t.date, (t.tags || []).join(','), t.category].join('|');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function txHour(t) {
    const d = new Date(Number(t.createdAt) || (t.date + 'T12:00:00'));
    return isNaN(d.getTime()) ? null : d.getHours();
  }
  // 这笔消费的真实上下文：本周第几笔、本月累计、占比、距上次多久——喂给 AI，点评才不会空
  function insightCtx(t) {
    const all = getTx();
    const persona = spendPersona(t);
    const mk = (t.date || '').slice(0, 7);
    const wk = weekStart(t.date);
    const same = (x) => x.type === 'expense' && !x.intercepted && spendPersona(x) === persona;
    const weekN = all.filter(x => same(x) && x.date >= wk && x.date <= t.date).length || 1;
    const monthList = all.filter(x => x.type === 'expense' && !x.intercepted && mk && (x.date || '').slice(0, 7) === mk);
    const sameMonth = monthList.filter(same);
    const monthSameTotal = sameMonth.reduce((s, x) => s + x.amount, 0);
    const monthExpense = monthList.reduce((s, x) => s + x.amount, 0);
    const earlier = sameMonth.filter(x => x.date < t.date).map(x => x.date).sort();
    const daysSinceLast = earlier.length
      ? Math.round((new Date(t.date + 'T00:00:00') - new Date(earlier[earlier.length - 1] + 'T00:00:00')) / 86400000)
      : null;
    return {
      persona, hour: txHour(t), weekN, monthSameTotal, monthExpense,
      sharePct: monthExpense ? Math.round(monthSameTotal / monthExpense * 100) : 0,
      monthTxCount: monthList.length, daysSinceLast
    };
  }
  // 只在"值得说一句"的记录上出现，不打扰每一笔
  function shouldComment(t, c) {
    if (!t || t.type !== 'expense' || t.intercepted) return false;
    if (t.amount >= 100) return true;
    if (c.weekN >= 3) return true;
    if (c.hour != null && (c.hour >= 22 || c.hour < 5)) return true;
    if ((t.tags || []).some(x => /冲动|凑单|直播间|免密|情绪/.test(x))) return true;
    if (c.persona === '隐形损耗' && t.amount >= 30) return true;
    if (c.sharePct >= 30) return true;
    return false;
  }
  // 本地兜底：用真实数字+多句式生成，保证不是同一句模板
  function localInsight(t, c) {
    const p = c.persona;
    const amt = fmt(t.amount);
    const night = c.hour != null && (c.hour >= 22 || c.hour < 5);
    const name = String(t.note || '').trim() || '这笔';
    const total = fmt(Math.round(c.monthSameTotal));
    const pool = [];
    if (p === '悦己钱') {
      if (c.weekN >= 3) pool.push(`${night ? '夜里' : '这周'}已经第 ${c.weekN} 次悦己了，${amt} 单看不多，这一类本月已经花掉 ${total}。`);
      if (night) pool.push(`深夜 ${c.hour} 点的${name}，多半是情绪在替你结账，明天再看可能就没那么想要。`);
      pool.push(`这 ${amt} 记在悦己钱上，本月这类占你支出的 ${c.sharePct}%——开心可以，别让它变成默认选项。`);
      pool.push(`想喝想吃的时候，先看看本周第 ${c.weekN} 次这个数字，自己动手能省下大半。`);
    } else if (p === '隐形损耗') {
      pool.push(`${name}这种买的时候顺手，用起来没几回，${amt} 就是这么一点点漏出去的。`);
      if (c.weekN >= 2) pool.push(`本周第 ${c.weekN} 笔隐形损耗，累计 ${total}，够你吃好几顿实在的饭了。`);
      pool.push(`付款前停三秒：这件东西下个月还会被你想起来吗？`);
      pool.push(`${amt} 不算大，但它每月出现 ${c.weekN} 次以上，就成了账单里最没存在感的窟窿。`);
    } else if (p === '生存饭') {
      pool.push(`这顿 ${amt} 花得值${c.weekN >= 5 ? `，本周第 ${c.weekN} 顿了` : ''}。饭钱别省，省下来的是体力和状态。`);
      pool.push(`生存饭本月 ${total}，占支出 ${c.sharePct}%，比例还算稳，这一块不用动。`);
    } else if (p === '社交局') {
      pool.push(`本月第 ${c.weekN} 次社交局，${amt} 花的是关系，但被迫凑的局可以少去一次。`);
      pool.push(`社交这块本月 ${total}，占 ${c.sharePct}%；下次换个便宜的地方，人还是那些人。`);
    } else if (p === '投资自己') {
      pool.push(`${amt} 花在自己身上，是本月最不像损耗的一笔——但记得真的用起来。`);
      pool.push(`成长投入本月 ${total}，别让它停在付款完成那一刻。`);
    } else {
      pool.push(`${name} ${amt}，本月同类累计 ${total}，先记着，月底回头看更直观。`);
      pool.push(`这笔 ${amt} 已经进账本，同类本月第 ${c.weekN} 次，占比 ${c.sharePct}%。`);
    }
    const n = parseInt(txSig(t), 36);
    return pool[n % pool.length];
  }
  // 生成队列：同屏多条合并成一次请求，避免刷屏；失败则保留本地文案并冷却
  const _insQ = [];
  const _insInflight = new Set();
  let _insTimer = null, _insDownAt = 0;
  function queueInsight(t, c) {
    if (_insInflight.has(t.id) || _insQ.some(x => x.id === t.id)) return;
    if (Date.now() - _insDownAt < 5 * 60 * 1000) return;   // 大模型刚失败，5 分钟内不再打扰
    if (!CONFIG.AUTO_DETECT && !CONFIG.AI_BACKEND) return;
    _insQ.push({ t, c });
    if (!_insTimer) _insTimer = setTimeout(flushInsights, 180);
  }
  async function flushInsights() {
    _insTimer = null;
    const batch = _insQ.splice(0, 4);
    if (!batch.length) return;
    const items = batch.map(({ t, c }) => ({
      id: t.id,
      note: String(t.note || '').slice(0, 30),
      amount: t.amount,
      persona: c.persona,
      categoryName: catName(t.category),
      date: t.date,
      hour: c.hour,
      tags: t.tags || [],
      weekN: c.weekN,
      monthSameTotal: Math.round(c.monthSameTotal),
      monthTxCount: c.monthTxCount,
      daysSinceLast: c.daysSinceLast
    }));
    batch.forEach(({ t }) => _insInflight.add(t.id));
    try {
      const res = await fetch(apiUrl('/api/insights'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const cache = getInsightCache();
      (data.insights || []).forEach(x => {
        const hit = batch.find(b => b.t.id === x.id);
        if (!hit || !x.text) return;
        cache[x.id] = { h: txSig(hit.t), text: x.text, model: x.model || '', at: Date.now() };
        applyInsight(x.id, x.text);
      });
      saveInsightCache(cache);
      if (!(data.insights || []).length && (data.errors || []).length) { _insDownAt = Date.now(); markInsightFallback(); }
    } catch (e) {
      _insDownAt = Date.now();
      markInsightFallback();
      console.warn('[insight] 真实 AI 不可用，已用本地点评兜底：', e.message);
    } finally {
      batch.forEach(({ t }) => _insInflight.delete(t.id));
      if (_insQ.length && Date.now() - _insDownAt > 5 * 60 * 1000) _insTimer = setTimeout(flushInsights, 220);
    }
  }
  // 真实 AI 拿不到时，不再挂着"生成中"，如实标注为本地点评
  function markInsightFallback() {
    document.querySelectorAll('.ai-bubble.ai-thinking').forEach(el => {
      el.classList.remove('ai-thinking');
      const s = el.querySelector('.ai-src');
      if (s) { s.classList.remove('ai-src-wait'); s.classList.add('ai-src-local'); s.textContent = '本地点评'; }
    });
  }
  function applyInsight(id, text) {
    document.querySelectorAll(`[data-insight="${id}"]`).forEach(el => {
      el.classList.add('ai-live');
      el.innerHTML = `<span class="ai-src">AI 实时</span>${esc(text)}`;
    });
  }
  // 返回 { id, text, src, pending } 或 null
  function aiInsight(t) {
    if (!t || t.type === 'income' || t.intercepted) return null;
    const c = insightCtx(t);
    if (!shouldComment(t, c)) return null;
    const cache = getInsightCache();
    const hit = cache[t.id];
    if (hit && hit.h === txSig(t) && hit.text) return { id: t.id, text: hit.text, src: 'ai', pending: false };
    queueInsight(t, c);
    return { id: t.id, text: localInsight(t, c), src: 'local', pending: true };
  }

  /* ---------------- 报告五维场景（刚需 / 社交 / 情绪 / 成长 / 冲动） ---------------- */
  const REPORT_BUCKETS = [
    { key: 'survive', name: '生存饭', tag: '刚需', emoji: '🍚', desc: '吃饭、食堂这类维持基本生活的钱，永远不该被建议削减' },
    { key: 'social', name: '社交局', tag: '半刚需', emoji: '🍻', desc: '聚餐、请客、聚会、KTV、剧本杀这类花在关系上的钱' },
    { key: 'yueji', name: '悦己钱', tag: '情绪消费', emoji: '🎮', desc: '奶茶、咖啡、甜品、电影、游戏、会员这类为了开心花的钱' },
    { key: 'growth', name: '成长投入', tag: '正向消费', emoji: '📚', desc: '买书、买课、培训、健身这类投资自己的钱' },
    { key: 'loss', name: '隐形损耗', tag: '冲动消费', emoji: '🕳️', desc: '凑单、自动续费、直播间冲动下单、买了闲置的小物件' }
  ];
  function reportBucket(t) {
    if (!t || t.type !== 'expense') return null;
    const text = `${t.note || ''} ${t.food || ''} ${t.merchant || ''}`;
    const tagStr = (t.tags || []).join(' ');
    const cat = t.category;
    // 成长投入（正向）
    if (cat === 'edu') return 'growth';
    if (/书|课程|网课|培训|教材|学费|知识|健身|learn/i.test(text) && cat !== 'food') return 'growth';
    // 社交局（半刚需）
    if (cat === 'gift') return 'social';
    if (/聚餐|请客|聚会|火锅|烧烤|海底捞|烤肉|日料|局|KTV|剧本杀|桌游|密室|演唱会|酒局/.test(text)) return 'social';
    // 悦己钱（情绪消费）
    if (/奶茶|咖啡|瑞幸|星巴克|甜品|蛋糕|零食|饮料|水果|盲盒|手办|游戏|电影|会员|追剧/.test(text) && cat !== 'shopping') return 'yueji';
    // 隐形损耗（冲动消费）
    if (/凑单|小物件|日用品|自动续费|续费|订阅|没用|闲置|小垃圾/.test(text)) return 'loss';
    if (tagStr.includes('凑单') || tagStr.includes('免密支付') || tagStr.includes('直播间')) return 'loss';
    if (cat === 'shopping') return 'loss';
    if (cat === 'fun') return 'yueji';
    if (cat === 'food') {
      if (/食堂|餐厅|饭店|吃饭|午餐|晚餐|早餐|包子|米饭|面条|面馆|快餐|工作餐|盖饭|麻辣烫|鸡蛋|馒头|粥/.test(text)) return 'survive';
      return 'yueji';
    }
    if (cat === 'home' || cat === 'transport' || cat === 'medical') return 'survive';
    return 'yueji';
  }

  /* ---------------- 商家/备注 → 分类智能预判 ---------------- */
  const MERCHANT_KEYWORDS = {
    food: ['蜜雪冰城', '奶茶', '咖啡', '瑞幸', '星巴克', '肯德基', '麦当劳', '麦当劳', '必胜客', '海底捞', '美团', '饿了么', '外卖', '食堂', '餐厅', '饭店', '小吃', '烧烤', '火锅', '包子', '早餐', '午餐', '晚餐', '宵夜', '面包', '蛋糕', '甜品', '水果', '便利店', '超市', '吃饭', '聚餐', '饮料', '啤酒', '零食'],
    transport: ['滴滴', '打车', '出租车', '高德', '曹操', '地铁', '公交', '加油', '中石油', '中石化', '停车', '高铁', '火车', '机票', '飞机', '摩拜', '单车', '共享单车', '打车费', '油费', '过路费', '出行', '车费'],
    shopping: ['淘宝', '京东', '拼多多', '天猫', '唯品会', '衣服', '鞋', '包', '化妆品', '护肤品', '数码', '手机', '电脑', '家电', '日用品', '母婴', '购物', '商城', '得物', '闲鱼'],
    home: ['房租', '物业', '水电', '电费', '水费', '燃气', '网费', '宽带', '话费', '公积金', '房贷', '房租水电', '家居', '装修', '家具'],
    fun: ['电影', '影院', '游戏', '充值', '会员', 'KTV', '旅游', '门票', '演唱会', '演出', '健身', '游泳', '娱乐', '剧本杀', '密室', '桌游', '视频会员', '网易云', '腾讯视频', '爱奇艺'],
    medical: ['医院', '药店', '药房', '诊所', '体检', '看病', '挂号', '药', '牙齿', '口腔', '眼科', '医疗', '保险', '疫苗'],
    edu: ['书', '课程', '培训', '网课', '学费', '辅导', '考试', '学习', '教材', '知识星球', '得到', 'Coursera', '教育'],
    other_e: ['捐赠', '捐款', '公益', '罚款', '手续费', '利息', '其他']
  };
  const CAT_KEY_ALIAS = {};
  Object.keys(MERCHANT_KEYWORDS).forEach(k => MERCHANT_KEYWORDS[k].forEach(w => { if (!CAT_KEY_ALIAS[w]) CAT_KEY_ALIAS[w] = k; }));
  function predictCategory(text) {
    if (!text) return null;
    const s = String(text);
    let best = null, bestLen = 0;
    for (const w in CAT_KEY_ALIAS) {
      if (s.includes(w) && w.length > bestLen) { best = CAT_KEY_ALIAS[w]; bestLen = w.length; }
    }
    return best; // 命中返回分类 key，否则 null
  }

  /* ---------------- 食物热量库（每标准份） ---------------- */
  const FOOD_CAL = {
    '米饭': 230, '米': 230, '面条': 280, '面': 280, '馒头': 220, '包子': 220, '饺子': 250, '粥': 100,
    '鸡蛋': 70, '蛋': 70, '牛奶': 150, '豆浆': 120, '面包': 265, '油条': 230, '煎饼': 300, '酸奶': 100,
    '苹果': 95, '香蕉': 105, '橘子': 60, '橙': 60, '梨': 90, '西瓜': 60, '葡萄': 70, '草莓': 32, '芒果': 90,
    '汉堡': 500, '薯条': 300, '炸鸡': 400, '披萨': 266, '可乐': 140, '奶茶': 300, '咖啡': 50, '啤酒': 150, '红酒': 125, '果汁': 120,
    '红烧肉': 450, '瘦肉': 150, '鸡肉': 165, '鸡腿': 250, '鸡翅': 200, '鱼': 120, '虾': 90, '牛肉': 250, '羊肉': 200, '排骨': 350,
    '青菜': 50, '白菜': 40, '土豆': 160, '番茄': 30, '黄瓜': 30, '豆腐': 80, '火锅': 600, '麻辣烫': 400, '烧烤': 500, '寿司': 350, '沙拉': 150,
    '蛋糕': 350, '饼干': 180, '巧克力': 550, '冰淇淋': 200, '坚果': 600
  };
  const QTY_UNIT = /(\d+(?:\.\d+)?)\s*(份|个|两|碗|杯|瓶|根|块|片|串|盒|包|只|斤|条)?/;
  function estimateCalories(text) {
    if (!text || !text.trim()) return { total: 0, items: [], recognized: 0 };
    const parts = text.split(/[，,、/和+以及\s]+/).filter(Boolean);
    let total = 0; const items = [];
    parts.forEach(p => {
      let qty = 1, name = p;
      const m = p.match(QTY_UNIT);
      if (m) { qty = parseFloat(m[1]); name = p.slice(m[0].length); }
      let cal = 0, matched = null;
      for (const k in FOOD_CAL) {
        if (name.includes(k) || (k.includes(name) && name.length > 0)) {
          if (!matched || k.length > matched.length) { cal = FOOD_CAL[k]; matched = k; }
        }
      }
      if (!matched) cal = 220; // 未识别项按默认估算
      const c = Math.round(cal * qty);
      total += c;
      items.push({ name: name || '食物', qty, cal: c, matched: !!matched });
    });
    return { total, items, recognized: items.filter(i => i.matched).length };
  }

  /* ---------------- 数据访问（本地优先 + 云端同步） ---------------- */
  // 游客演示模式使用独立的 cw_demo_* 键，避免污染真实账号数据
  const DKEY = (k) => (DEMO ? 'cw_demo_' : 'cw_') + k;
  const LS_TX = DKEY('tx'), LS_GOALS = DKEY('goals'), LS_BUDGET = DKEY('budgets');
  // 只读拦截：游客态下任何写入都被拦截并提示，不落库、不同步
  function readonlyGuard(what) {
    if (DEMO) { toast('info', '🚧 游客演示', '当前为只读示例数据，登录后即可' + (what || '使用此功能')); return true; }
    return false;
  }
  function getTx() { try { return JSON.parse(localStorage.getItem(LS_TX) || '[]'); } catch { return []; } }
  function setTx(a) { if (readonlyGuard('记账并保存')) return; localStorage.setItem(LS_TX, JSON.stringify(a)); if (window.Sync) Sync.pushTx(a); }
  function getGoals() { try { return JSON.parse(localStorage.getItem(LS_GOALS) || '[]'); } catch { return []; } }
  function setGoals(a) { if (readonlyGuard('创建储蓄目标')) return; localStorage.setItem(LS_GOALS, JSON.stringify(a)); if (window.Sync) Sync.pushGoals(a); }
  function getBudgets() { try { return JSON.parse(localStorage.getItem(LS_BUDGET) || '{}'); } catch { return {}; } }
  function setBudgets(o) { if (readonlyGuard('设置预算')) return; localStorage.setItem(LS_BUDGET, JSON.stringify(o)); if (window.Sync) Sync.pushBudgets(o); }
  function getBudget(cat) { const b = getBudgets(); return b[cat] ? Number(b[cat]) : 0; }

  function id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------------- 工具 ---------------- */
  const fmt = (n) => '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // 存钱罐动效里的目标/余额，整数就够，带两位小数反而拖沓
  const fmt0 = (n) => '¥' + Math.round(Number(n) || 0).toLocaleString('zh-CN');
  const esc = (s) => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const monthKey = (iso) => iso.slice(0, 7);
  function addMonths(date, n) { const d = new Date(date); d.setMonth(d.getMonth() + n); return d; }
  function weekStart(date) { const d = new Date(date); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d; }

  /* ---------------- 演示数据 ---------------- */
  function seedIfEmpty() {
    // 云端模式：数据由服务器按账号提供，不写入本地演示数据
    if (window.Auth && Auth.isCloud()) return;
    const FLAG = DEMO ? 'cw_demo_seeded' : 'cw_seeded';
    if (!localStorage.getItem(FLAG)) {
      const now = new Date();
      const d = (o) => { const x = new Date(now); x.setDate(x.getDate() - o); return x.toISOString().slice(0, 10); };
      const lunch = estimateCalories('米饭1碗, 炒青菜1份, 鸡腿1个');
      // 直接写入当前键（演示态为 cw_demo_*），绕过只读拦截
      localStorage.setItem(LS_TX, JSON.stringify([
        { id: id(), type: 'income', category: 'salary', amount: 12000, date: d(14), note: '本月工资', createdAt: Date.now() },
        { id: id(), type: 'expense', category: 'food', amount: 45, date: d(11), note: '午餐', food: '米饭1碗, 炒青菜1份, 鸡腿1个', calories: lunch.total, createdAt: Date.now() },
        { id: id(), type: 'expense', category: 'transport', amount: 30, date: d(9), note: '打车', createdAt: Date.now() },
        { id: id(), type: 'expense', category: 'shopping', amount: 299, date: d(6), note: '衣服', createdAt: Date.now() },
        { id: id(), type: 'income', category: 'part', amount: 800, date: d(4), note: '周末兼职', createdAt: Date.now() },
        { id: id(), type: 'expense', category: 'food', amount: 1240, date: d(2), note: '本月外卖合计', food: '汉堡2份, 奶茶3杯, 炸鸡1份', calories: estimateCalories('汉堡2份, 奶茶3杯, 炸鸡1份').total, createdAt: Date.now() },
        { id: id(), type: 'expense', category: 'fun', amount: 68, date: d(1), note: '电影', createdAt: Date.now() }
      ]));
      localStorage.setItem(LS_GOALS, JSON.stringify([
        { id: id(), name: '旅行基金', target: 10000, saved: 4500, emoji: '✈️' },
        { id: id(), name: '应急备用金', target: 30000, saved: 12000, emoji: '🛡️' },
        { id: id(), name: '数码换新', target: 8000, saved: 2100, emoji: '💻' }
      ]));
      localStorage.setItem(LS_BUDGET, JSON.stringify({ food: 1500, transport: 400, shopping: 800 }));
      localStorage.setItem(FLAG, '1');
    }
  }

  /* ---------------- Toast 提醒 ---------------- */
  const toastWrap = document.getElementById('toastWrap');
  function toast(type, title, body) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML = `<div class="t-title">${esc(title)}</div><div class="t-body">${body}</div>`;
    toastWrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; }, 4200);
    setTimeout(() => { el.remove(); }, 4800);
  }

  /* ---------------- 聚合计算 ---------------- */
  function monthCategoryTotal(cat, m) {
    m = m || new Date().toISOString().slice(0, 7);
    return getTx().filter(t => t.type === 'expense' && t.category === cat && monthKey(t.date) === m)
      .reduce((s, t) => s + t.amount, 0);
  }
  function dayExpenseTotal(date) {
    return getTx().filter(t => t.type === 'expense' && t.date === date).reduce((s, t) => s + t.amount, 0);
  }
  function avgMonthlySurplus() {
    const tx = getTx(); const byMonth = {};
    tx.forEach(t => { const m = monthKey(t.date); byMonth[m] = (byMonth[m] || 0) + (t.type === 'income' ? t.amount : -t.amount); });
    const vals = Object.values(byMonth);
    if (!vals.length) return 0;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  function predictGoal(g) {
    const surplus = avgMonthlySurplus();
    const remain = Math.max(0, g.target - g.saved);
    const months = surplus > 0 ? Math.ceil(remain / surplus) : Infinity;
    const date = surplus > 0 && isFinite(months) ? addMonths(new Date(), months) : null;
    const needPerMonth = remain / 12;
    return { surplus, remain, months, date, needPerMonth };
  }

  /* ---------------- AI 提醒（记账后触发） ---------------- */
  function aiRemind(t) {
    const msgs = [];
    if (t.category === 'food' && t.calories) {
      if (t.calories >= 800) msgs.push({ type: 'warn', title: '🍽️ 热量偏高', body: `本餐约 <b>${t.calories}</b> 千卡，超过单餐建议上限(800)，注意控制～` });
      else msgs.push({ type: 'info', title: '🍽️ 热量估算', body: `本餐约 <b>${t.calories}</b> 千卡，较均衡，继续保持。` });
    }
    const b = getBudget(t.category);
    if (b > 0 && t.type === 'expense') {
      const used = monthCategoryTotal(t.category);
      if (used > b) msgs.push({ type: 'danger', title: '⚠️ 预算超支', body: `「${catName(t.category)}」本月已花 <b>${fmt(used)}</b>，超出预算 ${fmt(b)}（超 ${fmt(used - b)}）` });
      else if (used > b * 0.8) msgs.push({ type: 'warn', title: '⚠️ 预算告急', body: `「${catName(t.category)}」已用 <b>${Math.round(used / b * 100)}%</b>，接近月度预算` });
    }
    const dayTotal = dayExpenseTotal(t.date);
    if (dayTotal >= 500) msgs.push({ type: 'warn', title: '💡 今日支出提醒', body: `今日累计支出 <b>${fmt(dayTotal)}</b>，记得核对账单。` });
    // 异常消费识别（防诈骗视角）：作为醒目预警弹出
    detectAnomalies(t).forEach(a => {
      const type = a.sev === 'high' ? 'danger' : (a.sev === 'medium' ? 'warn' : 'info');
      msgs.push({ type, title: a.ico + ' ' + a.title, body: a.desc });
    });
    if (!msgs.length) msgs.push({ type: 'info', title: '✅ 已记录', body: `${catName(t.category)} ${fmt(t.amount)} 已保存，记账习惯 +1 👍` });
    msgs.forEach((m, i) => setTimeout(() => toast(m.type, m.title, m.body), i * 450));
  }

  /* ================= 冷静区：异常消费识别引擎 ================= */
  const LS_REPORTS = 'cw_reports';
  const LS_REPORT_CFG = 'cw_report_cfg';
  const LS_REVIEWED = 'cw_reviewed_alerts';
  function getReports() { try { return JSON.parse(localStorage.getItem(LS_REPORTS) || '[]'); } catch { return []; } }
  function setReports(a) { try { localStorage.setItem(LS_REPORTS, JSON.stringify(a)); } catch (_) {} }
  function getReportCfg() {
    let c = null; try { c = JSON.parse(localStorage.getItem(LS_REPORT_CFG) || 'null'); } catch (_) {}
    return Object.assign({
      auto: true, day: 1,
      sections: { overview: true, fiveDim: true, behavior: true, saving: true, structure: true, compare: true, health: true, risk: true, save: true, goal: true }
    }, c || {});
  }
  function setReportCfg(c) { try { localStorage.setItem(LS_REPORT_CFG, JSON.stringify(c)); } catch (_) {} }
  function getReviewed() { try { return JSON.parse(localStorage.getItem(LS_REVIEWED) || '{}'); } catch (_) { return {}; } }
  function setReviewed(o) { try { localStorage.setItem(LS_REVIEWED, JSON.stringify(o)); } catch (_) {} }

  // 单笔交易的异常识别（防诈骗视角）：返回 [{sig, sev, ico, title, desc}]
  function detectAnomalies(t) {
    const out = [];
    if (!t || t.type !== 'expense') return out;
    const tx = getTx();
    const hist = tx.filter(x => x.type === 'expense' && x.category === t.category && x.id !== t.id && x.amount > 0);
    const amts = hist.map(x => x.amount);
    const mean = amts.length ? amts.reduce((a, b) => a + b, 0) / amts.length : 0;
    const maxv = amts.length ? Math.max.apply(null, amts) : 0;
    // 1) 金额异常：远超该类别历史（均值 2.5 倍 或 历史最高 1.5 倍）
    if (t.amount >= 200 && ((mean > 0 && t.amount > mean * 2.5) || (maxv > 0 && t.amount > maxv * 1.5))) {
      out.push({ sig: 'amt', sev: 'high', ico: '🚨', title: '异常大额消费', desc: `「${catName(t.category)}」本笔 ${fmt(t.amount)}，而该类历史均仅 ${fmt(mean)}、最高 ${fmt(maxv)}，明显偏高，请确认是否为本人操作。` });
    }
    // 2) 深夜 / 凌晨消费（按记录时间）
    const ch = t.createdAt ? new Date(t.createdAt).getHours() : -1;
    if (ch >= 0 && ch <= 5) {
      out.push({ sig: 'night', sev: 'medium', ico: '🌙', title: '深夜消费', desc: `交易发生在凌晨 ${String(ch).padStart(2, '0')}:00 前后，深夜大额支付需警惕，确认是否本人操作。` });
    }
    // 3) 短时密集（2 小时内 ≥3 笔支出）
    const tTime = t.createdAt || new Date(t.date).getTime();
    const near = tx.filter(x => x.type === 'expense' && x.id !== t.id && Math.abs((x.createdAt || new Date(x.date).getTime()) - tTime) <= 2 * 3600 * 1000);
    if (near.length >= 2) {
      out.push({ sig: 'burst', sev: 'medium', ico: '⏱️', title: '短时密集消费', desc: `2 小时内出现 ${near.length + 1} 笔支出，留意是否被连续扣款。` });
    }
    // 4) 相同金额短时重复（盗刷 / 重复支付特征）
    const sameAmt = tx.filter(x => x.type === 'expense' && x.id !== t.id && Math.abs(x.amount - t.amount) < 0.01 && Math.abs((x.createdAt || new Date(x.date).getTime()) - tTime) <= 48 * 3600 * 1000);
    if (sameAmt.length >= 1 && t.amount >= 50) {
      out.push({ sig: 'dup', sev: 'high', ico: '🔁', title: '疑似重复扣款', desc: `近 48 小时内已有一笔相同金额 ${fmt(t.amount)} 的支出，可能是重复支付或盗刷，请核对账单。` });
    }
    // 5) 首笔大额新类别 / 新商户
    const seenCat = tx.some(x => x.type === 'expense' && x.category === t.category && x.id !== t.id);
    if (!seenCat && t.amount >= 500) {
      out.push({ sig: 'newcat', sev: 'medium', ico: '🆕', title: '新类别首笔大额', desc: `这是「${catName(t.category)}」类别的第一笔支出且金额较大（${fmt(t.amount)}），建议备注用途以便回溯。` });
    }
    // 6) 整数大额（弱信号，陌生商户多留心）
    if (t.amount >= 1000 && t.amount % 100 === 0) {
      out.push({ sig: 'round', sev: 'low', ico: '🔢', title: '整数大额留意', desc: `${fmt(t.amount)} 为整数整百金额，若是陌生商户请多留一个心眼。` });
    }
    return out;
  }

  /* ================= 三维度风险拦截（记账前的提示窗） =================
   * 维度一：防诈骗与盗刷 —— 消费行为突变 / 深夜高危消费
   * 维度二：防冲动与「拿铁因子」—— 高频小额（奶茶刺客）/ 预算提前透支
   * 维度三：消费场景预警 —— 校园贷 / 违规转账
   * 设计原则：命中即弹窗，把「可能是诈骗」和「可能是冲动」分开讲清楚，
   * 并且始终给用户三条出路：取消 / 放进冷静区 / 确认记录。
   */
  const LS_RISK_LOG = 'cw_risk_log';
  const RISK_DIM = { 1: '维度一 · 防诈骗与盗刷', 2: '维度二 · 防冲动 · 拿铁因子', 3: '维度三 · 消费场景预警' };
  const DRINK_RE = /奶茶|咖啡|拿铁|美式|摩卡|瑞幸|星巴克|喜茶|奈雪|蜜雪|茶百道|古茗|沪上阿姨|果汁|果茶|饮品|饮料|汽水|可乐|甜品|蛋糕|冰淇淋|雪糕|布丁|双皮奶/;
  const FRAUD_RE = /兼职|刷单|招聘|入职|内推|押金|保证金|培训费|课程费|学费|贷款|网贷|校园贷|分期|返利|垫付|代付|转账|汇款|解冻|验证码|刷脸|投资|理财课|博彩|充值返现|跑分|帮信|客服退款|征信/;

  function monthSpentYuan() {
    const m = localDay().slice(0, 7);
    return getTx().filter(t => t.type === 'expense' && !t.intercepted && monthKey(t.date) === m)
      .reduce((s, t) => s + Number(t.amount || 0), 0);
  }
  function totalBudgetYuan() {
    const b = getBudgets();
    return Object.keys(b).reduce((s, k) => s + (b[k] > 0 ? Number(b[k]) : 0), 0);
  }
  function daysLeftInMonth() {
    const d = new Date();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return Math.max(1, last - d.getDate());
  }

  // 返回命中的风险项；空数组 = 这笔很安全，直接放行
  function riskGuard(t) {
    const out = [];
    if (!t || t.type !== 'expense' || !(Number(t.amount) > 0)) return out;
    const amount = Number(t.amount);
    const note = String(t.note || '');
    const text = [note, t.food || '', (t.tags || []).join(' ')].join(' ');
    const hist = getTx().filter(x => x.type === 'expense' && !x.intercepted && Number(x.amount) > 0);
    const when = new Date(t.createdAt || Date.now());
    const hour = when.getHours();

    /* —— 维度一 · 消费行为突变 —— */
    const sameCat = hist.filter(x => x.category === t.category);
    const pool = sameCat.length >= 3 ? sameCat : hist;
    const mean = pool.length ? pool.reduce((s, x) => s + Number(x.amount), 0) / pool.length : 0;
    if (mean > 0 && amount >= Math.max(80, mean * 3)) {
      out.push({
        key: 'jump', dim: 1, sev: 'high', ico: '🚨', tag: '消费行为突变',
        title: '异常交易预警',
        line: `您的历史平均消费为 <b>${fmt(mean)}</b>，本次支出 <b>${fmt(amount)}</b>（约 <b>${(amount / mean).toFixed(1)} 倍</b>），远超您的常规水平。`,
        warn: '如非本人操作，请立即挂失银行卡！若本人操作，请点击「确认本人操作」。',
        ok: '确认本人操作'
      });
    }

    /* —— 维度一 · 深夜高危消费（23:00–05:59） —— */
    if (hour >= 23 || hour <= 5) {
      const nightWord = hour >= 23 ? '深夜' : '凌晨';
      const virtual = ['fun', 'shopping', 'other_e'].includes(t.category) ||
        /直播|游戏|充值|会员|虚拟|皮肤|打赏|盲盒|抽卡/.test(text);
      out.push({
        key: 'night', dim: 1, sev: 'medium', ico: '🌙', tag: '深夜高危消费',
        title: '深夜冲动拦截',
        line: `检测到您在 <b>${nightWord} ${String(hour).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}</b> 进行${virtual ? '虚拟' : '线上'}消费（${catName(t.category)} ${fmt(amount)}）。深夜是心理防线最弱的时候。`,
        warn: '请冷静 3 分钟，明天再看还买不买？',
        ok: '我已冷静，仍要记录',
        cool: true
      });
    }

    /* —— 维度二 · 高频小额（奶茶刺客） —— */
    if (DRINK_RE.test(text) && amount <= 80) {
      const since = (() => { const d = new Date(); d.setDate(d.getDate() - 6); return localDay(d); })();
      const same = hist.filter(x => (x.date || '') >= since && DRINK_RE.test([x.note || '', x.food || '', (x.tags || []).join(' ')].join(' ')));
      const cups = same.length + 1;
      if (cups >= 3) {
        const total = same.reduce((s, x) => s + Number(x.amount), 0) + amount;
        out.push({
          key: 'drink', dim: 2, sev: 'medium', ico: '🍬', tag: '高频小额消费',
          title: '「奶茶刺客」拦截',
          line: `过去一周您已喝下 <b>${cups}</b> 杯奶茶 / 咖啡，本周已累计花费 <b>${fmt(total)}</b>！距离月底还有 <b>${daysLeftInMonth()}</b> 天，您的「奶茶额度」已透支，建议改为白开水哦。`,
          warn: `一年按这个节奏大约是 <b>${fmt(total * 52)}</b>——够买一部新手机了。这杯真的非喝不可吗？`,
          ok: '就这一杯，记上',
          cool: true
        });
      }
    }

    /* —— 维度二 · 预算提前透支 —— */
    const tb = totalBudgetYuan();
    if (tb > 0) {
      const spent = monthSpentYuan();
      const leftBefore = tb - spent;
      const leftAfter = tb - spent - amount;
      if (leftBefore / tb < 0.2 || leftAfter / tb < 0.2) {
        const days = daysLeftInMonth();
        const broke = leftAfter < 0;
        out.push({
          key: 'budget', dim: 2, sev: 'high', ico: '📉', tag: '预算提前透支',
          title: '赤字风险预警',
          line: `本月预算 <b>${fmt(tb)}</b>，已花 <b>${fmt(spent)}</b>，剩余 <b>${Math.max(0, Math.round(leftBefore / tb * 100))}%</b>（${fmt(Math.max(0, leftBefore))}）。`,
          warn: broke
            ? `若确认此笔消费，本月预算将透支 <b>${fmt(-leftAfter)}</b>，接下来的 <b>${days}</b> 天只能选择食堂最低价套餐。是否继续？`
            : `若确认此笔消费，剩余 <b>${days}</b> 天日均只有 <b>${fmt(leftAfter / days)}</b>，将只能选择食堂最低价套餐。是否继续？`,
          ok: '仍然记账',
          cool: true
        });
      }
    }

    /* —— 维度三 · 校园贷 / 违规转账 —— */
    const fraud = String(note).match(FRAUD_RE);
    if (fraud) {
      out.push({
        key: 'fraud', dim: 3, sev: 'high', ico: '⚠️', tag: '校园贷 / 违规转账',
        title: '高危操作拦截',
        line: `检测到您正在记录与「<b>${esc(fraud[0])}</b>」相关的支出（${fmt(amount)}）。`,
        warn: '请警惕任何「先交钱再入职」或「无抵押网贷」，这是典型的校园诈骗套路！',
        tips: [
          '正规兼职不会先收费：凡是要交押金、培训费、保证金、服装费的，一律拒绝。',
          '不点陌生链接、不扫来历不明的二维码，验证码和刷脸验证绝不外借。',
          '已被要求转账？立即停止、截图留证，拨打 96110 或联系辅导员 / 家人。'
        ],
        ok: '我确认不是诈骗'
      });
    }

    const order = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => order[a.sev] - order[b.sev]);
  }

  function riskLog(t, risks, action) {
    try {
      const log = JSON.parse(localStorage.getItem(LS_RISK_LOG) || '[]');
      log.push({ at: Date.now(), date: t.date, amount: t.amount, category: t.category, note: t.note || '', keys: risks.map(r => r.key), action });
      localStorage.setItem(LS_RISK_LOG, JSON.stringify(log.slice(-200)));
    } catch (_) {}
  }
  const RISK_ACTION_LABEL = { cancel: '已取消', cool: '已放冷静区', confirm: '已确认记录' };
  const RISK_KEY_LABEL = { jump: '消费行为突变', night: '深夜高危', drink: '高频小额', budget: '预算透支', fraud: '校园贷/转账' };
  function riskLogSummary(days) {
    let log = [];
    try { log = JSON.parse(localStorage.getItem(LS_RISK_LOG) || '[]'); } catch (_) {}
    const since = Date.now() - (days || 7) * 864e5;
    const recent = log.filter(x => (x.at || 0) >= since);
    const blocked = recent.filter(x => x.action === 'cancel' || x.action === 'cool');
    return { recent, blockedN: blocked.length, saved: blocked.reduce((s, x) => s + Number(x.amount || 0), 0) };
  }

  // 提示窗：返回 Promise<{action:'cancel'|'cool'|'confirm'}>
  function showRiskDialog(risks, t) {
    return new Promise(resolve => {
      const old = document.getElementById('rgMask');
      if (old) old.remove();
      const high = risks.some(r => r.sev === 'high');
      // 确认按钮文案取「最该被确认」的那条规则：诈骗 > 盗刷 > 预算 > 深夜 > 奶茶
      const PRIORITY = ['fraud', 'jump', 'budget', 'night', 'drink'];
      const topRisk = PRIORITY.map(k => risks.find(r => r.key === k)).find(Boolean) || risks[0];
      const okLabel = (topRisk && topRisk.ok) || '确认记录';
      const mask = document.createElement('div');
      mask.id = 'rgMask';
      mask.className = 'rg-mask';
      mask.innerHTML = `
        <div class="rg-dialog" role="dialog" aria-modal="true" aria-labelledby="rgTitle">
          <div class="rg-head${high ? ' is-high' : ''}">
            <img src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" />
            <div class="rg-head-txt">
              <b id="rgTitle">SmartPig 风险拦截</b>
              <span>记账前，先替你把一脚刹车踩住<i class="rg-count"> · 命中 ${risks.length} 条规则</i></span>
            </div>
            <button class="rg-x" type="button" aria-label="关闭">×</button>
          </div>
          <div class="rg-body">
            ${risks.map(r => `
              <div class="rg-card sev-${r.sev}" data-risk="${r.key}">
                <div class="rg-card-top">
                  <div class="rg-ico">${r.ico}</div>
                  <div class="rg-h">
                    <span class="rg-tag">${RISK_DIM[r.dim]} · ${r.tag}</span>
                    <h4>${r.title}</h4>
                  </div>
                </div>
                <p class="rg-line">${r.line}</p>
                <div class="rg-warn">${r.warn}</div>
                ${r.tips ? `<ul class="rg-tips">${r.tips.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
              </div>`).join('')}
            <div class="rg-sum">本笔：<b>${catName(t.category)} ${fmt(t.amount)}</b>${t.date ? ' · ' + esc(t.date) : ''}${t.note ? ' · ' + esc(t.note) : ''}</div>
          </div>
          <div class="rg-foot">
            <button class="rg-btn rg-cancel" type="button">取消，我再想想</button>
            ${risks.some(r => r.cool) ? '<button class="rg-btn rg-cool" type="button">🧊 先放进冷静区</button>' : ''}
            <button class="rg-btn ${high ? 'rg-danger' : 'rg-primary'} rg-ok" type="button">${esc(okLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      const done = (action) => {
        mask.style.animation = 'rgFade .14s ease reverse forwards';
        setTimeout(() => mask.remove(), 130);
        document.removeEventListener('keydown', onKey);
        resolve({ action });
      };
      const onKey = (e) => { if (e.key === 'Escape') done('cancel'); };
      document.addEventListener('keydown', onKey);
      mask.querySelector('.rg-x').addEventListener('click', () => done('cancel'));
      mask.querySelector('.rg-cancel').addEventListener('click', () => done('cancel'));
      const coolBtn = mask.querySelector('.rg-cool');
      if (coolBtn) coolBtn.addEventListener('click', () => done('cool'));
      mask.querySelector('.rg-ok').addEventListener('click', () => done('confirm'));
      mask.addEventListener('click', (e) => { if (e.target === mask) done('cancel'); });
      // 焦点落在「取消」上：默认不鼓励冲动确认
      setTimeout(() => { const c = mask.querySelector('.rg-cancel'); if (c) c.focus(); }, 30);
    });
  }


  // 汇总当前所有预警（逐笔异常 + 预算 + 月度风险），带已读状态
  function computeAlerts() {
    const tx = getTx();
    const reviewed = getReviewed();
    const alerts = [];
    const curM = new Date().toISOString().slice(0, 7);
    const since = Date.now() - 90 * 864e5;
    tx.filter(t => t.type === 'expense' && (t.createdAt || new Date(t.date).getTime()) >= since).forEach(t => {
      detectAnomalies(t).forEach(a => {
        alerts.push({ id: 'a:' + t.id + ':' + a.sig, sev: a.sev, ico: a.ico, title: a.title, desc: a.desc, ts: t.date, txId: t.id, fraud: (a.sig === 'dup' || a.sig === 'amt' || a.sig === 'burst') });
      });
    });
    const budgets = getBudgets();
    Object.keys(budgets).forEach(k => {
      if (budgets[k] > 0) {
        const used = monthCategoryTotal(k, curM);
        if (used > budgets[k]) alerts.push({ id: 'b:' + k + ':' + curM, sev: 'high', ico: '🚨', title: `「${catName(k)}」预算超支`, desc: `本月已花 ${fmt(used)}，超预算 ${fmt(used - budgets[k])}（超 ${Math.round((used / budgets[k] - 1) * 100)}%）。`, ts: curM + '-01', fraud: true });
        else if (used > budgets[k] * 0.8) alerts.push({ id: 'bw:' + k + ':' + curM, sev: 'medium', ico: '⚠️', title: `「${catName(k)}」预算告急`, desc: `本月已用 ${Math.round(used / budgets[k] * 100)}%，接近月度预算上限。`, ts: curM + '-01' });
      }
    });
    computeRisks().forEach(r => {
      if (r.sev === 'high' || r.sev === 'medium') alerts.push({ id: 'r:' + r.title, sev: r.sev, ico: r.ico, title: r.title, desc: r.desc, ts: curM + '-01', fraud: r.sev === 'high' });
    });
    const seen = {};
    alerts.forEach(a => { if (seen[a.id]) { a.dup = true; } seen[a.id] = 1; a.reviewed = !!reviewed[a.id]; });
    const order = { high: 0, medium: 1, low: 2 };
    alerts.sort((a, b) => (order[a.sev] - order[b.sev]) || (b.ts || '').localeCompare(a.ts || ''));
    return alerts.filter(a => !a.dup);
  }
  function unreviewedAlerts() { return computeAlerts().filter(a => !a.reviewed); }
  function alertBadgeCount() { return unreviewedAlerts().filter(a => a.sev === 'high' || a.sev === 'medium').length; }
  function reviewAlert(id, val) { const r = getReviewed(); if (val === false) delete r[id]; else r[id] = 1; setReviewed(r); }

  // 刷新导航徽标
  function refreshAlertBadge() {
    const el = document.getElementById('alertBadge');
    if (!el) return;
    const n = alertBadgeCount();
    if (n > 0) { el.textContent = n > 99 ? '99+' : n; el.style.display = ''; }
    else el.style.display = 'none';
  }

  /* ---------------- 食物明细预览联动 ---------------- */
  function wireFoodPreview(catSelId, boxId, tagId, textId, tagsId) {
    const catSel = document.getElementById(catSelId);
    const box = document.getElementById(boxId);
    const tag = document.getElementById(tagId);
    const text = document.getElementById(textId);
    const tags = document.getElementById(tagsId);
    if (!catSel || !box) return;
    const update = () => {
      const isFood = catSel.value === 'food';
      box.style.display = isFood ? 'block' : 'none';
      if (!isFood) return;
      const r = estimateCalories(text.value);
      tag.textContent = r.total + ' 千卡';
      tags.innerHTML = text.value.trim()
        ? r.items.map(it => `<span class="food-tag">${esc(it.name || '食物')} ×${it.qty} <b>${it.cal}千卡</b></span>`).join('')
        : '';
    };
    catSel.addEventListener('change', update);
    text.addEventListener('input', update);
    update();
  }

  /* ---------------- 渲染路由 ---------------- */
  const pageEl = document.getElementById('page');
  const pageTitle = document.getElementById('pageTitle');
  const TITLES = { home: '我的钱袋子', quick: '一笔入魂', manage: '钱去哪了', goals: '小目标', ai: '消费教练', health: '财务免疫力', alerts: '冷静区' };
  let activeCharts = [];
  function disposeCharts() { activeCharts.forEach(c => c && c.dispose && c.dispose()); activeCharts = []; }

  function navigate(page, opt) {
    disposeCharts();
    chartFocusMonth = (opt && opt.focus) || null;
    document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    pageTitle.textContent = TITLES[page] || '概览';
    if (page === 'home') renderHome();
    else if (page === 'quick') renderQuick();
    else if (page === 'manage') renderManage();
    else if (page === 'goals') renderGoals();
    else if (page === 'ai') renderAI();
    else     if (page === 'health') renderHealth();
    else if (page === 'alerts') renderAlerts();
    if (topnav) topnav.classList.remove('open'); // 移动端切换页面后收起导航
    refreshAlertBadge();
  }

  /* ---------------- 首页数据卡：冲击力对比行 ---------------- */
  function homeImpactCard() {
    const tx = getTx();
    const curM = new Date().toISOString().slice(0, 7);
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = lastDay - now.getDate();
    const budgets = getBudgets();
    const CAT_NICK = { food: '生存饭', shopping: '悦己钱', fun: '悦己钱', transport: '赶路钱', housing: '窝居钱', daily: '日用钱', entertainment: '玩乐钱', study: '充电钱' };
    const cats = Object.keys(budgets).filter(k => budgets[k] > 0);
    // 1) 超预算：最该警惕
    for (const k of cats) {
      const used = monthCategoryTotal(k, curM);
      if (used > budgets[k]) {
        const nick = CAT_NICK[k] || catName(k);
        return `<div class="impact-card tone-warn"><span class="ic-emo">🟡</span><div><b>本月「${nick}」已超预算 ${fmt(used - budgets[k])}</b>，考虑挪用下月额度吗？<span class="ic-sub">已花 ${fmt(used)} / 预算 ${fmt(budgets[k])}</span></div></div>`;
      }
    }
    // 2) 重点类目额度剩余
    const pick = cats.includes('food') ? 'food' : (cats[0] || null);
    if (pick) {
      const used = monthCategoryTotal(pick, curM);
      const remain = Math.max(0, budgets[pick] - used);
      const ratio = budgets[pick] ? remain / budgets[pick] : 1;
      const safe = ratio > 0.15;
      const nick = CAT_NICK[pick] || catName(pick);
      const daily = daysLeft > 0 ? remain / daysLeft : remain;
      const tail = daysLeft > 0
        ? `距离月底还有 <b>${daysLeft}</b> 天（日均可用 ${fmt(daily)}，${safe ? '安全 🟢' : '告急 🟡'}）`
        : `今天是月底，撑住就是满分收官 🧊`;
      return `<div class="impact-card ${safe ? 'tone-safe' : 'tone-warn'}"><span class="ic-emo">${safe ? '🟢' : '🟡'}</span><div>本月「${nick}」额度还剩 <b>${fmt(remain)}</b>，${tail}<span class="ic-sub">已花 ${fmt(used)} / 预算 ${fmt(budgets[pick])}</span></div></div>`;
    }
    // 3) 兜底
    return `<div class="impact-card tone-safe"><span class="ic-emo">🟢</span><div>本月已记录 <b>${tx.length}</b> 笔收支，继续保持清醒消费 🧊</div></div>`;
  }

  /* ---------------- 概览 ---------------- */
  function renderHome() {
    const tx = getTx(); const goals = getGoals();
    const curMonth = new Date().toISOString().slice(0, 7);
    let income = 0, expense = 0;
    tx.forEach(t => { if (monthKey(t.date) === curMonth) { if (t.type === 'income') income += t.amount; else expense += t.amount; } });
    const balance = income - expense;
    const goalTotal = goals.reduce((s, g) => s + Number(g.saved), 0);
    const goalTarget = goals.reduce((s, g) => s + Number(g.target), 0);
    const goalPct = goalTarget ? Math.round(goalTotal / goalTarget * 100) : 0;
    const recent = [...tx].filter(t => !t.intercepted)
      .sort((a, b) => (b.date + b.createdAt) - (a.date + a.createdAt)).slice(0, 5);

    // —— 醒目预警横幅（未确认的 高/中 风险）——
    const alertList = unreviewedAlerts().filter(a => a.sev === 'high' || a.sev === 'medium');
    const pendingReport = localStorage.getItem('cw_report_pending');
    let bannerHtml = '';
    if (alertList.length) {
      const urgent = alertList.some(a => a.sev === 'high');
      bannerHtml += `
      <div class="alert-banner sev-${urgent ? 'high' : 'medium'}" id="alertBanner">
        <div class="ab-ico">🧊</div>
        <div class="ab-body">
          <div class="ab-title">冷静区 · 已帮你守住 <b>${tx.length}</b> 笔钱${alertList.length ? `，还有 <b>${alertList.length}</b> 笔待你冷静确认` : ''}</div>
          <div class="ab-list">${alertList.slice(0, 3).map(a => `<span class="ab-chip sev-${a.sev}">${a.ico} ${esc(a.title)}</span>`).join('')}${alertList.length > 3 ? `<span class="ab-more">+${alertList.length - 3}</span>` : ''}</div>
        </div>
        <button class="ab-btn" id="abGoAlerts">进入冷静区</button>
      </div>`;
    }
    if (pendingReport) {
      bannerHtml += `
      <div class="report-ready" id="reportReady">
        <div class="rr-ico">📄</div>
        <div class="rr-body"><div class="rr-title">${pendingReport} 月度财务报告已自动生成</div><div class="rr-sub">含收支对比、省钱建议与风险提醒，点击查看完整分析。</div></div>
        <button class="rr-btn" id="abGoReport">查看报告</button>
      </div>`;
    }

    pageEl.innerHTML = `
      ${bannerHtml}
      <div class="stat-grid">
        <div class="stat"><div class="ico">💼</div><div class="lbl">本月结余</div>
          <div class="val ${balance >= 0 ? 'income' : 'expense'}">${fmt(balance)}</div>
          <div class="trend ${balance >= 0 ? 'income' : 'expense'}">${balance >= 0 ? '▲ 收支为正' : '▼ 注意超支'}</div></div>
        <div class="stat"><div class="ico">📥</div><div class="lbl">本月收入</div>
          <div class="val income">${fmt(income)}</div><div class="trend text-2">累计 ${tx.filter(t => t.type === 'income').length} 笔</div></div>
        <div class="stat"><div class="ico">📤</div><div class="lbl">本月支出</div>
          <div class="val expense">${fmt(expense)}</div><div class="trend text-2">累计 ${tx.filter(t => t.type === 'expense').length} 笔</div></div>
        <div class="stat"><div class="ico">🎯</div><div class="lbl">储蓄进度</div>
          <div class="val">${goalPct}%</div><div class="trend text-2">${fmt(goalTotal)} / ${fmt(goalTarget)}</div></div>
      </div>
      ${homeImpactCard()}
      <div class="grid-form-main">
        <div class="panel">
          <h4>⚡ 快速记一笔</h4>
          <p class="muted" style="margin:0 0 14px;font-size:13.5px">选择类型与金额，秒级完成。</p>
          <div class="seg" id="homeSeg" style="margin-bottom:14px">
            <button type="button" class="active exp" data-type="expense">支出</button>
            <button type="button" data-type="income">收入</button>
          </div>
          <div class="field"><label>金额（¥）</label><input type="number" id="homeAmt" step="0.01" min="0" placeholder="0.00" /></div>
          <div class="field"><label>分类</label><select id="homeCat"></select></div>
          <button class="btn btn-primary btn-block" id="homeAdd">保存这笔</button>
        </div>
        <div class="panel">
          <h4>🕑 最近记录</h4>
          ${recent.length ? `<div class="list">${recent.map(t => rowItem(t)).join('')}</div>` : emptyState('📝', '还没有记录，去记一笔吧')}
          <div style="margin-top:14px"><button class="btn btn-ghost btn-sm" data-goto="manage">查看全部</button></div>
        </div>
      </div>`;

    const homeType = { v: 'expense' };
    const homeSeg = document.getElementById('homeSeg');
    fillCatSelect(document.getElementById('homeCat'), homeType.v);
    homeSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      homeSeg.querySelectorAll('button').forEach(x => x.classList.remove('active', 'exp', 'inc'));
      b.classList.add('active', b.dataset.type === 'expense' ? 'exp' : 'inc');
      homeType.v = b.dataset.type; fillCatSelect(document.getElementById('homeCat'), homeType.v);
    }));
    document.getElementById('homeAdd').addEventListener('click', () => {
      const amt = parseFloat(document.getElementById('homeAmt').value);
      const cat = document.getElementById('homeCat').value;
      if (!amt || amt <= 0) { alert('请输入有效金额'); return; }
      addTx({ type: homeType.v, amount: amt, category: cat, date: new Date().toISOString().slice(0, 10), note: '' }, { onSaved: () => renderHome() });
    });
    pageEl.querySelector('[data-goto="manage"]').addEventListener('click', () => navigate('manage'));

    // 首页预警横幅 → 跳转
    const abGo = document.getElementById('abGoAlerts');
    if (abGo) abGo.addEventListener('click', () => navigate('alerts'));
    const abRep = document.getElementById('abGoReport');
    if (abRep) abRep.addEventListener('click', () => { localStorage.removeItem('cw_report_pending'); aiTab = 'report'; navigate('ai'); });
    refreshAlertBadge();
  }
  function renderQuick() {
    const tx = getTx();
    const recent = [...tx].filter(t => !t.intercepted)
      .sort((a, b) => (b.date + b.createdAt) - (a.date + a.createdAt)).slice(0, 8);
    const SCENE_TAGS = ['🌙 深夜冲动', '📱 直播间', '🛍️ 凑单', '😭 情绪不佳', '💳 免密支付'];
    pageEl.innerHTML = `
      <div class="page-head"><div><h3>无痛记账</h3><p>极简记录，剩下的交给 AI 教练。支持语音、账单截图与场景智能归类。</p></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-ghost" id="openVoice">🎙️ 语音记账</button>
          <button class="btn btn-ghost" id="openReceipt">🧾 小票识别</button>
          <button class="btn btn-primary" id="openQuickModal">＋ 记一笔</button>
        </div></div>
      <div class="grid-form-main">
        <div class="panel">
          <h4>📝 新增记录</h4>
          <div class="seg" id="qSeg" style="margin-bottom:14px">
            <button type="button" class="active exp" data-type="expense">支出</button>
            <button type="button" data-type="income">收入</button>
          </div>
          <div class="field">
            <label>金额（¥）</label>
            <input type="number" id="qAmt" step="0.01" min="0" placeholder="0.00" />
            <div class="amt-hint" id="qAmtHint">💡 让用户在记账的瞬间感受到钱的去向。</div>
          </div>
          <div class="field"><label>分类</label><select id="qCat"></select></div>
          <div class="food-box" id="qFoodBox" style="display:none">
            <div class="fb-head"><span class="lbl">🍽️ 食物明细（AI 估算热量）</span>
              <span class="calorie-tag" id="qCalTag">0 千卡</span></div>
            <input type="text" id="qFoodText" placeholder="例如：米饭1碗, 红烧肉1份, 可乐1瓶" />
            <div class="food-tags" id="qFoodTags"></div>
          </div>
          <div class="field"><label>当时场景 / 消费情绪</label>
            <div class="scene-tags" id="qSceneTags">
              ${SCENE_TAGS.map(s => `<button type="button" class="scene-tag" data-tag="${s}">${s}</button>`).join('')}
            </div>
          </div>
          <div class="field"><label>日期</label><input type="date" id="qDate" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div class="field"><label>备注</label><input type="text" id="qNote" placeholder="比如：和室友的夜宵、买了一件没用的凑单品…" maxlength="60" /></div>
          <button class="btn btn-primary btn-block" id="qAdd">🟢 记账，并清空冲动</button>
        </div>
        <div class="panel">
          <h4>👣 消费足迹</h4>
          ${recent.length ? `<div class="list">${recent.map(t => rowItem(t)).join('')}</div>` : emptyState('👣', '还没有足迹，去记一笔吧')}
        </div>
      </div>`;

    const qType = { v: 'expense' };
    const qSeg = document.getElementById('qSeg');
    fillCatSelect(document.getElementById('qCat'), qType.v);
    qSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      qSeg.querySelectorAll('button').forEach(x => x.classList.remove('active', 'exp', 'inc'));
      b.classList.add('active', b.dataset.type === 'expense' ? 'exp' : 'inc');
      qType.v = b.dataset.type; fillCatSelect(document.getElementById('qCat'), qType.v);
    }));
    wireFoodPreview('qCat', 'qFoodBox', 'qCalTag', 'qFoodText', 'qFoodTags');

    // 金额输入 → 出现灰色小字提示（记账瞬间感受钱的去向）
    const qAmt = document.getElementById('qAmt');
    const qAmtHint = document.getElementById('qAmtHint');
    qAmt.addEventListener('input', () => {
      qAmtHint.style.display = parseFloat(qAmt.value) > 0 ? 'flex' : 'none';
    });

    // 当时场景 / 消费情绪：一键多选
    const pickedScenes = new Set();
    document.querySelectorAll('#qSceneTags .scene-tag').forEach(b => {
      b.addEventListener('click', () => {
        b.classList.toggle('on');
        const tag = b.dataset.tag;
        if (b.classList.contains('on')) pickedScenes.add(tag); else pickedScenes.delete(tag);
      });
    });

    document.getElementById('qAdd').addEventListener('click', () => {
      const amt = parseFloat(document.getElementById('qAmt').value);
      if (!amt || amt <= 0) { alert('请输入有效金额'); return; }
      const cat = document.getElementById('qCat').value;
      const noteVal = document.getElementById('qNote').value.trim();
      const extra = {};
      if (qType.v === 'expense' && cat === 'food') {
        const r = estimateCalories(document.getElementById('qFoodText').value);
        extra.food = document.getElementById('qFoodText').value.trim();
        extra.calories = r.total;
      }
      if (pickedScenes.size) extra.tags = [...pickedScenes];
      addTx(Object.assign({ type: qType.v, amount: amt, category: cat, date: document.getElementById('qDate').value, note: noteVal }, extra), {
        onSaved: () => {
          // 按钮轻微缩小回弹
          const btn = document.getElementById('qAdd');
          if (btn) {
            btn.classList.remove('btn-bounce');
            void btn.offsetWidth;
            btn.classList.add('btn-bounce');
          }
          // 短促 Toast（悦己钱有专属文案）
          const persona = spendPersona({ type: qType.v, category: cat, note: noteVal, food: extra.food || '' });
          const msg = persona === '悦己钱' ? '已记录，这笔属于悦己钱哦～' : '已记录。钱花在刀刃上啦！';
          toast('success', '🟢 记好了', msg);
          setTimeout(renderQuick, 300);
        }
      });
    });
    document.getElementById('openQuickModal').addEventListener('click', openTxModal);
    document.getElementById('openVoice').addEventListener('click', openVoiceModal);
    document.getElementById('openReceipt').addEventListener('click', openReceiptModal);
  }

  /* ---------------- 记账管理 + ECharts ---------------- */
  let manageFilter = { type: 'all', month: 'all', tab: 'list', cmpA: null, cmpB: null };
  // 从「消费报表」跳过来时，图表聚焦到报表那个月（否则默认本月）
  let chartFocusMonth = null;
  function renderManage() {
    disposeCharts();
    const months = [...new Set(getTx().map(t => monthKey(t.date)))].sort().reverse();
    const opt = (v, lbl, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${lbl}</option>`;
    pageEl.innerHTML = `
      <div class="page-head"><div><h3>记账管理</h3><p>明细、消费排行、跨月对比，一键导出账单。</p></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" id="openBudget">⚙️ 设置预算</button>
          <button class="btn btn-primary btn-sm" id="openExport">📤 导出账单</button>
        </div></div>

      <div class="panel" style="margin-bottom:18px">
        <h4>📊 分类预算概览（本月）</h4>
        ${budgetOverviewHTML()}
      </div>

      <div class="subtabs" id="manageTabs">
        <button class="subtab ${manageFilter.tab === 'list' ? 'active' : ''}" data-tab="list">账单明细</button>
        <button class="subtab ${manageFilter.tab === 'rank' ? 'active' : ''}" data-tab="rank">消费排行</button>
        <button class="subtab ${manageFilter.tab === 'compare' ? 'active' : ''}" data-tab="compare">月度对比</button>
      </div>
      <div id="manageSub"></div>`;

    document.getElementById('openBudget').addEventListener('click', openBudgetModal);
    document.getElementById('openExport').addEventListener('click', openExportModal);
    document.querySelectorAll('#manageTabs .subtab').forEach(b => b.addEventListener('click', () => {
      manageFilter.tab = b.dataset.tab; chartFocusMonth = null; renderManage();
    }));
    renderManageSub(months, opt);
  }

  function budgetOverviewHTML() {
    const tx = getTx();
    const budgets = getBudgets();
    const catKeys = new Set([...tx.filter(t => t.type === 'expense').map(t => t.category), ...Object.keys(budgets)]);
    const arr = [...catKeys].map(k => {
      const b = getBudget(k); const used = monthCategoryTotal(k);
      const pct = b ? Math.min(100, Math.round(used / b * 100)) || 0 : 0;
      return { k, b, used, pct, over: b && used > b };
    }).filter(x => x.b);
    if (!arr.length) return '<div class="muted" style="font-size:13.5px">尚未设置预算，点击右上角「设置预算」。</div>';
    return arr.map(x => `<div class="budget-row ${x.over ? 'over' : ''}">
        <div class="br-top"><span class="nm">${catMeta('expense', x.k).emoji} ${catName(x.k)}</span>
          <span class="val">${fmt(x.used)} / ${fmt(x.b)}（${x.pct}%${x.over ? ' · 已超支' : ''}）</span></div>
        <div class="br-bar"><i style="width:${x.pct}%"></i></div>
      </div>`).join('');
  }

  function renderManageSub(months, opt) {
    const sub = document.getElementById('manageSub');
    if (manageFilter.tab === 'rank') return renderRank(sub);
    if (manageFilter.tab === 'compare') return renderCompare(sub, months, opt);
    // 账单明细
    disposeCharts();
    const tx = getTx();
    let list = [...tx];
    if (manageFilter.type !== 'all') list = list.filter(t => t.type === manageFilter.type);
    if (manageFilter.month !== 'all') list = list.filter(t => monthKey(t.date) === manageFilter.month);
    list.sort((a, b) => (b.date + b.createdAt) - (a.date + a.createdAt));
    const sumInc = list.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const sumExp = list.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    sub.innerHTML = `
      <div class="chart-grid" style="margin-bottom:18px">
        <div class="chart-box"><h4>近 6 个月收支对比</h4><div class="chart" id="chartMonth"></div></div>
        <div class="chart-box"><h4>${chartFocusMonth ? Number(chartFocusMonth.slice(0, 4)) + ' 年 ' + Number(chartFocusMonth.slice(5, 7)) + ' 月支出结构' : '本月支出结构'}</h4><div class="chart" id="chartCat"></div></div>
        <div class="chart-box" style="grid-column:1 / -1"><h4>本周每日支出</h4><div class="chart" id="chartWeek"></div></div>
      </div>
      <div class="panel">
        <div class="inline" style="margin-bottom:12px">
          <div class="field" style="margin:0"><label>类型</label>
            <select id="fType">${opt('all', '全部', manageFilter.type)}${opt('income', '收入', manageFilter.type)}${opt('expense', '支出', manageFilter.type)}</select></div>
          <div class="field" style="margin:0"><label>月份</label>
            <select id="fMonth">${opt('all', '全部月份', manageFilter.month)}${months.map(m => opt(m, m, manageFilter.month)).join('')}</select></div>
        </div>
        <p class="muted" style="font-size:13px;margin:0 0 12px">共 ${list.length} 笔 · 收入 ${fmt(sumInc)} · 支出 ${fmt(sumExp)}</p>
        ${list.length ? tableHTML(list) : emptyState('🔍', '没有符合条件的记录')}
      </div>`;
    document.getElementById('fType').addEventListener('change', e => { manageFilter.type = e.target.value; renderManage(); });
    document.getElementById('fMonth').addEventListener('change', e => {
      manageFilter.month = e.target.value;
      chartFocusMonth = e.target.value === 'all' ? null : e.target.value;
      renderManage();
    });
    sub.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (confirm('确定删除这笔记录？')) { setTx(getTx().filter(t => t.id !== b.dataset.del)); renderManage(); }
    }));
    renderCharts();
  }

  function tableHTML(list) {
    return `<table class="table">
      <thead><tr><th>日期</th><th>分类</th><th>备注</th><th>标签</th><th>类型</th><th style="text-align:right">金额</th><th></th></tr></thead>
      <tbody>${list.map(t => {
        const c = catMeta(t.type, t.category);
        const cal = (t.type === 'expense' && t.category === 'food' && t.calories) ? `🔥${t.calories}千卡` : '';
        const tags = (t.tags && t.tags.length) ? `<span class="tag-list">${t.tags.map(x => `<span class="tg">${esc(x)}</span>`).join('')}</span>` : '—';
        return `<tr>
          <td>${t.date}</td>
          <td><span class="cat-pill">${c.emoji} ${c.name}</span></td>
          <td>${esc((t.note || '—') + (cal ? ' · ' + cal : ''))}</td>
          <td>${tags}</td>
          <td>${t.type === 'income' ? '<span class="income">收入</span>' : '<span class="expense">支出</span>'}</td>
          <td style="text-align:right" class="amt ${t.type === 'income' ? 'income' : 'expense'}">${t.type === 'income' ? '+' : '-'}${fmt(t.amount).slice(1)}</td>
          <td style="text-align:right"><button class="btn btn-danger btn-sm" data-del="${t.id}">删除</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  function renderCharts() {
    if (typeof echarts === 'undefined') {
      ['chartMonth', 'chartCat', 'chartWeek'].forEach(idn => {
        const el = document.getElementById(idn);
        if (el) el.innerHTML = '<div class="chart-fallback">📡 图表组件需联网加载 ECharts<br/>请联网后刷新，或部署到可访问 CDN 的环境。</div>';
      });
      return;
    }
    const tx = getTx();
    const now = new Date();

    // 近 6 月收支
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(addMonths(now, -i).toISOString().slice(0, 7));
    const incM = {}, expM = {};
    months.forEach(m => { incM[m] = 0; expM[m] = 0; });
    tx.forEach(t => { const m = monthKey(t.date); if (m in incM) { if (t.type === 'income') incM[m] += t.amount; else expM[m] += t.amount; } });
    const c1 = echarts.init(document.getElementById('chartMonth'));
    c1.setOption({
      tooltip: { trigger: 'axis' }, legend: { data: ['收入', '支出'] },
      grid: { left: 56, right: 16, top: 40, bottom: 28 },
      xAxis: { type: 'category', data: months }, yAxis: { type: 'value' },
      series: [
        { name: '收入', type: 'bar', data: months.map(m => +incM[m].toFixed(2)), itemStyle: { color: '#2f9e44', borderRadius: [4, 4, 0, 0] } },
        { name: '支出', type: 'bar', data: months.map(m => +expM[m].toFixed(2)), itemStyle: { color: '#e03131', borderRadius: [4, 4, 0, 0] } }
      ]
    });
    activeCharts.push(c1);

    // 支出结构（默认本月；从报表跳进来时锁定报表月份）
    const curM = chartFocusMonth || now.toISOString().slice(0, 7);
    const byCat = {};
    tx.forEach(t => { if (t.type === 'expense' && monthKey(t.date) === curM) byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
    const pieData = Object.entries(byCat).map(([k, v]) => ({ name: catName(k), value: +v.toFixed(2) }));
    const c2 = echarts.init(document.getElementById('chartCat'));
    c2.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
      legend: { bottom: 0, type: 'scroll' },
      color: ['#23B883', '#0C6A4B', '#F08C00', '#E8590C', '#B08968', '#8C8778', '#E5484D', '#74B816'],
      series: [{ type: 'pie', radius: ['42%', '68%'], avoidLabelOverlap: true, label: { formatter: '{b}\n{d}%' }, data: pieData.length ? pieData : [{ name: '暂无支出', value: 1, itemStyle: { color: '#e4e9f0' } }] }]
    });
    activeCharts.push(c2);

    // 本周每日支出
    const ws = weekStart(now);
    const days = [], expD = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(ws); d.setDate(ws.getDate() + i);
      days.push('周' + '日一二三四五六'[d.getDay()]);
      const key = d.toISOString().slice(0, 10);
      expD.push(+tx.filter(t => t.type === 'expense' && t.date === key).reduce((s, t) => s + t.amount, 0).toFixed(2));
    }
    const c3 = echarts.init(document.getElementById('chartWeek'));
    c3.setOption({
      tooltip: { trigger: 'axis' }, grid: { left: 56, right: 16, top: 24, bottom: 28 },
      xAxis: { type: 'category', data: days }, yAxis: { type: 'value' },
      series: [{ type: 'line', smooth: true, data: expD, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#0C6A4B' }, lineStyle: { color: '#0C6A4B', width: 3 } }]
    });
    activeCharts.push(c3);
  }

  /* ---------------- 消费排行 ---------------- */
  function renderRank(sub) {
    disposeCharts();
    const tx = getTx();
    const expense = tx.filter(t => t.type === 'expense');
    const byCat = {}; expense.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
    const catRank = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const top10 = [...expense].sort((a, b) => b.amount - a.amount).slice(0, 10);
    const curM = new Date().toISOString().slice(0, 7);
    const dayMap = {}; expense.forEach(t => { if (monthKey(t.date) === curM) dayMap[t.date] = (dayMap[t.date] || 0) + t.amount; });
    const dayEntries = Object.entries(dayMap).sort((a, b) => b[1] - a[1]);
    const topDay = dayEntries[0];
    const dayCount = Object.keys(dayMap).length;
    sub.innerHTML = `
      <div class="panel" style="margin-bottom:18px">
        <h4>🏆 本月花钱最多的一天</h4>
        ${topDay ? `<div style="display:flex;gap:22px;flex-wrap:wrap;align-items:center">
          <div><div class="muted" style="font-size:12px">日期</div><div style="font-size:22px;font-weight:700">${topDay[0]}</div></div>
          <div><div class="muted" style="font-size:12px">支出</div><div class="val expense" style="font-size:22px">${fmt(topDay[1])}</div></div>
          <div class="muted" style="font-size:13px">本月共 <b>${dayCount}</b> 天有支出记录，这一天最"壕" 💸</div>
        </div>` : '<div class="muted">本月还没有支出记录。</div>'}
      </div>
      <div class="rank-grid">
        <div class="chart-box"><h4>分类支出排行</h4><div class="chart" id="chartCatRank"></div></div>
        <div class="chart-box"><h4>单品消费 Top 10</h4><div class="chart" id="chartTop10"></div></div>
        <div class="chart-box" style="grid-column:1 / -1"><h4>本月每日支出排行</h4><div class="chart" id="chartDayRank"></div></div>
      </div>`;
    if (typeof echarts === 'undefined') {
      ['chartCatRank', 'chartTop10', 'chartDayRank'].forEach(idn => { const el = document.getElementById(idn); if (el) el.innerHTML = '<div class="chart-fallback">📡 图表组件需联网加载 ECharts<br/>请联网后刷新。</div>'; });
      return;
    }
    const c1 = echarts.init(document.getElementById('chartCatRank'));
    c1.setOption({
      grid: { left: 92, right: 36, top: 10, bottom: 20 }, tooltip: { trigger: 'axis', formatter: p => `${p[0].name}<br/>¥${p[0].value}` },
      xAxis: { type: 'value' }, yAxis: { type: 'category', data: catRank.map(x => catName(x[0])).reverse() },
      series: [{ type: 'bar', data: catRank.map(x => +x[1].toFixed(2)).reverse(), itemStyle: { color: '#23B883', borderRadius: [0, 6, 6, 0] }, label: { show: true, position: 'right', formatter: '¥{c}' } }]
    });
    activeCharts.push(c1);
    const c2 = echarts.init(document.getElementById('chartTop10'));
    c2.setOption({
      grid: { left: 150, right: 44, top: 10, bottom: 20 }, tooltip: { trigger: 'axis', formatter: p => `${p[0].name}<br/>¥${p[0].value}` },
      xAxis: { type: 'value' }, yAxis: { type: 'category', data: top10.map(t => `${(t.note || '—').slice(0, 8)}·${catName(t.category)}`).reverse() },
      series: [{ type: 'bar', data: top10.map(t => +t.amount.toFixed(2)).reverse(), itemStyle: { color: '#f08c00', borderRadius: [0, 6, 6, 0] }, label: { show: true, position: 'right', formatter: '¥{c}' } }]
    });
    activeCharts.push(c2);
    const c3 = echarts.init(document.getElementById('chartDayRank'));
    c3.setOption({
      grid: { left: 56, right: 16, top: 22, bottom: 30 }, tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: dayEntries.map(x => x[0].slice(5)) }, yAxis: { type: 'value' },
      series: [{ type: 'bar', data: dayEntries.map(x => +x[1].toFixed(2)), itemStyle: { color: '#e8590c', borderRadius: [4, 4, 0, 0] }, markPoint: { data: [{ type: 'max', name: '最多' }], itemStyle: { color: '#e03131' } } }]
    });
    activeCharts.push(c3);
  }

  /* ---------------- 月度对比 ---------------- */
  function renderCompare(sub, months, opt) {
    disposeCharts();
    const tx = getTx();
    const avail = months.length ? months : [new Date().toISOString().slice(0, 7)];
    const m1 = manageFilter.cmpA || avail[0];
    const m2 = manageFilter.cmpB || avail[Math.min(1, avail.length - 1)] || avail[0];
    const stat = (m) => {
      const f = tx.filter(t => monthKey(t.date) === m);
      const inc = f.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
      const exp = f.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
      return { m, inc, exp, surplus: inc - exp, count: f.length };
    };
    const a = stat(m1), b = stat(m2);
    const delta = (x, y) => y ? ((x - y) / y * 100) : 0;
    const dExp = delta(b.exp, a.exp), dInc = delta(b.inc, a.inc), dSur = delta(b.surplus, a.surplus);
    const fmtPct = (d) => `<span class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(0)}%</span>`;
    sub.innerHTML = `
      <div class="compare-selects">
        <div class="field" style="margin:0"><label>对比月份 A</label><select id="cmpA">${avail.map(m => opt(m, m, m1)).join('')}</select></div>
        <div class="field" style="margin:0"><label>对比月份 B</label><select id="cmpB">${avail.map(m => opt(m, m, m2)).join('')}</select></div>
      </div>
      <div class="compare-grid">
        <div class="compare-card"><div class="cc-top">${a.m}</div>
          <div>收入 <b class="income">${fmt(a.inc)}</b></div>
          <div>支出 <b class="expense">${fmt(a.exp)}</b></div>
          <div>结余 <b class="${a.surplus >= 0 ? 'income' : 'expense'}">${fmt(a.surplus)}</b></div>
          <div class="muted" style="font-size:12.5px;margin-top:4px">${a.count} 笔</div></div>
        <div class="compare-card"><div class="cc-top">${b.m}</div>
          <div>收入 <b class="income">${fmt(b.inc)}</b></div>
          <div>支出 <b class="expense">${fmt(b.exp)}</b></div>
          <div>结余 <b class="${b.surplus >= 0 ? 'income' : 'expense'}">${fmt(b.surplus)}</b></div>
          <div class="muted" style="font-size:12.5px;margin-top:4px">${b.count} 笔</div></div>
      </div>
      <div class="panel" style="margin-top:18px">
        <h4>📊 ${a.m} vs ${b.m} 收支对比</h4>
        <div class="chart" id="chartCompare"></div>
      </div>
      <div class="report-card" style="margin-top:18px"><h4><img class="brand-inline" src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" /> AI 跨月诊断</h4>
        <div class="ai-insight">${compareInsight(a, b, dExp, dInc, dSur)}</div>
        <p class="muted" style="font-size:12.5px;margin-top:8px">相对变化（B 对比 A）：收入 ${fmtPct(dInc)} · 支出 ${fmtPct(dExp)} · 结余 ${fmtPct(dSur)}</p>
      </div>`;
    document.getElementById('cmpA').addEventListener('change', e => { manageFilter.cmpA = e.target.value; renderManage(); });
    document.getElementById('cmpB').addEventListener('change', e => { manageFilter.cmpB = e.target.value; renderManage(); });
    if (typeof echarts === 'undefined') {
      const el = document.getElementById('chartCompare'); if (el) el.innerHTML = '<div class="chart-fallback">📡 图表组件需联网加载 ECharts</div>';
    } else {
      const c = echarts.init(document.getElementById('chartCompare'));
      c.setOption({
        tooltip: { trigger: 'axis' }, legend: { data: [a.m, b.m] },
        grid: { left: 56, right: 16, top: 40, bottom: 28 },
        xAxis: { type: 'category', data: ['收入', '支出', '结余'] }, yAxis: { type: 'value' },
        series: [
          { name: a.m, type: 'bar', data: [+a.inc.toFixed(2), +a.exp.toFixed(2), +a.surplus.toFixed(2)], itemStyle: { color: '#23B883', borderRadius: [4, 4, 0, 0] } },
          { name: b.m, type: 'bar', data: [+b.inc.toFixed(2), +b.exp.toFixed(2), +b.surplus.toFixed(2)], itemStyle: { color: '#f08c00', borderRadius: [4, 4, 0, 0] } }
        ]
      });
      activeCharts.push(c);
    }
  }
  function compareInsight(a, b, dExp, dInc, dSur) {
    const parts = [];
    parts.push(`<b>${b.m}</b> 相比 <b>${a.m}</b>：收入变化 ${fmtDelta(dInc)}，支出变化 ${fmtDelta(dExp)}，结余变化 ${fmtDelta(dSur)}。`);
    if (dExp > 10 && dExp > dInc) parts.push('⚠️ 支出增速明显快于收入，需重点管控；建议为 Top 支出类别设置预算防线，削减可选项目。');
    if (dSur > 0) parts.push('✅ 本期结余改善，储蓄能力在提升，可把多出的部分优先转入储蓄目标账户。');
    if (a.exp === 0 || b.exp === 0) parts.push('其中一个月份暂无支出数据，记录更完整后对比更精准。');
    if (parts.length === 1) parts.push('两月数据相近，财务结构较稳定，可继续维持。');
    return parts.join('<br/>');
  }
  function fmtDelta(d) { return (d >= 0 ? '+' : '') + d.toFixed(0) + '%'; }

  /* ---------------- 储蓄目标 + AI 评估 ---------------- */
  function renderGoals() {
    const goals = getGoals();
    pageEl.innerHTML = `
      <div class="page-head"><div><h3>储蓄目标</h3><p>设定目标，AI 预测达成时间并给出调整建议。</p></div>
        <button class="btn btn-primary" id="addGoal">＋ 新建目标</button></div>
      ${goals.length ? `<div class="goal-grid">${goals.map(g => {
        const pct = Math.min(100, Math.round(g.saved / g.target * 100)) || 0;
        const remain = Math.max(0, g.target - g.saved);
        const p = predictGoal(g);
        const predTxt = p.surplus > 0
          ? `按当前月均结余 <b>${fmt(p.surplus)}</b>，约 <b>${p.months}</b> 个月（${p.date.getFullYear()}/${p.date.getMonth() + 1}）达成`
          : `当前月均结余为负或为零，需先提升结余才能自动达成`;
        const tip = p.surplus > 0
          ? `若想在 <b>12 个月</b>内达成，建议每月为该目标存入 <b>${fmt(p.needPerMonth)}</b>（当前月均结余 ${fmt(p.surplus)}，差额 ${fmt(Math.max(0, p.needPerMonth - p.surplus))}/月）`
          : `建议削减非必要支出或增加收入，使月均净结余转正后再设定节奏`;
        return `<div class="goal-card">
          <div class="gc-top"><div style="font-size:18px;font-weight:700">${g.emoji} ${esc(g.name)}</div>
            <button class="btn btn-ghost btn-sm" data-edit="${g.id}">编辑</button></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-2);margin-bottom:8px">
            <span>${fmt(g.saved)}</span><span>目标 ${fmt(g.target)}</span></div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
            <span class="badge ${pct >= 100 ? '' : 'badge-soft'}">${pct}%${pct >= 100 ? ' · 已达成 🎉' : ''}</span>
            <span class="muted" style="font-size:12.5px">还需 ${fmt(remain)}</span></div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <input type="number" class="goalAddInput" data-id="${g.id}" placeholder="存入金额" step="0.01" min="0"
              style="flex:1;padding:9px 11px;border:1px solid var(--border-strong);border-radius:9px;font-family:inherit" />
            <button class="btn btn-primary btn-sm" data-save="${g.id}">存入</button></div>
          <button class="btn btn-ghost btn-sm btn-block" data-delgoal="${g.id}" style="margin-top:8px">删除目标</button>
          <div class="ai-pred">
            <div class="ap-title"><img class="brand-inline" src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" /> AI 达成预测</div>
            <div class="ap-row"><span class="k">剩余</span><span class="v">${fmt(remain)}</span>
              <span class="k">当前进度</span><span class="v">${pct}%</span></div>
            <div class="ap-tip">${predTxt}。<br/>${tip}。</div>
          </div>
        </div>`;
      }).join('')}</div>` : emptyState('🎯', '还没有储蓄目标，点击右上角新建')}
    `;

    document.getElementById('addGoal').addEventListener('click', () => openGoalModal());
    pageEl.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const g = goals.find(x => x.id === b.dataset.edit); openGoalModal(g);
    }));
    pageEl.querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', () => {
      const inp = pageEl.querySelector(`.goalAddInput[data-id="${b.dataset.save}"]`);
      const v = parseFloat(inp.value);
      if (!v || v <= 0) { alert('请输入存入金额'); return; }
      const gs = getGoals(); const g = gs.find(x => x.id === b.dataset.save);
      const before = Number(g.saved) || 0;
      g.saved = before + v; setGoals(gs);
      // 存钱罐动效：硬币一枚枚落进罐子，进度条往前走
      if (window.PiggyMotion) {
        const tgt = Math.max(1, Number(g.target) || 1);
        window.PiggyMotion.save({
          amount: v,
          title: '存入 · ' + g.emoji + ' ' + g.name,
          fillFrom: before / tgt,
          fillTo: g.saved / tgt,
          progress: {
            from: Math.min(100, before / tgt * 100),
            to: Math.min(100, g.saved / tgt * 100),
            label: '目标进度',
            sub: '还差 ' + fmt0(Math.max(0, g.target - g.saved))
          }
        });
      }
      inp.value = '';
      renderGoals();
    }));
    pageEl.querySelectorAll('[data-delgoal]').forEach(b => b.addEventListener('click', () => {
      if (confirm('确定删除该目标？')) { setGoals(getGoals().filter(g => g.id !== b.dataset.delgoal)); renderGoals(); }
    }));
  }

  /* ---------------- 后端接入开关（自动探测 + 手动覆盖） ---------------- */
  // 与 js/config.js 的 window.CW_CONFIG 对齐；AUTO_DETECT=true 时启动会自动探测 /api/status
  const CONFIG = Object.assign(
    { SYNC_BACKEND: false, AI_BACKEND: false, OCR_BACKEND: false, AUTO_DETECT: true, LOCAL_OCR: true, API_BASE: '' },
    window.CW_CONFIG || {}
  );
  // 后端能力快照（供界面显示「AI 已连接 / 本地模式」）
  const BACKEND = { online: false, llmReady: false, ocrReady: false, llmLabel: '', ocrProvider: '', llmDegraded: '', llmHint: '' };

  /**
   * 探测后端能力，自动决定各通道：
   *   - AI：llm.ready → 通义千问/豆包等真实大模型；否则本地规则引擎
   *   - 小票：ocr.ready → 云端 OCR；否则浏览器内 OCR（Tesseract）
   * 探测失败（后端没起）时全部降级，功能不受影响。
   */
  async function detectBackend() {
    if (!CONFIG.AUTO_DETECT) return BACKEND;
    try {
      let s = null;
      if (window.CWApiBase) {
        // 统一由 api-base.js 自动定位后端（同源 → 缓存 → localhost:3000）
        const b = await window.CWApiBase.resolve();
        s = b === false ? null : window.CWApiBase.getStatus();
        if (s) CONFIG.API_BASE = window.CWApiBase.get();
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch((CONFIG.API_BASE || '') + '/api/status', { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('status ' + res.status);
        s = await res.json();
      }
      if (!s) throw new Error('backend offline');
      BACKEND.online = true;
      BACKEND.llmReady = !!(s.llm && s.llm.ready);
      BACKEND.ocrReady = !!(s.ocr && s.ocr.ready);
      BACKEND.llmLabel = (s.llm && s.llm.label) || '';
      BACKEND.ocrProvider = (s.ocr && s.ocr.provider) || '';
      // 后端记录了上次调用失败原因 → 首屏就如实显示「不可用」，不必等用户先踩一次坑
      if (s.llm && s.llm.lastError && s.llm.lastError.code) {
        BACKEND.llmDegraded = s.llm.lastError.code;
        BACKEND.llmHint = s.llm.lastError.hint || '';
      }
      // 自动覆盖手动开关（后端可用就启用；不可用则保持关闭，走本地能力）
      CONFIG.AI_BACKEND = BACKEND.llmReady;
      CONFIG.OCR_BACKEND = BACKEND.ocrReady;
    } catch (e) {
      BACKEND.online = false;
      CONFIG.AI_BACKEND = false;
      CONFIG.OCR_BACKEND = false;
    }
    return BACKEND;
  }
  // 通道状态文案（给用户看，避免「到底连没连上」的困惑）
  function aiChannelLabel() {
    if (BACKEND.llmDegraded) {
      const map = { NO_ENTITLEMENT: '本地智能体 · 模型额度未开通', RATE_LIMITED: '本地智能体 · 模型限流中', INVALID_KEY: '本地智能体 · Key 无效', OLLAMA_OFFLINE: '本地智能体 · 未装 Ollama（装后免费用）', NO_BALANCE: '本地智能体 · 云端余额不足' };
      return map[BACKEND.llmDegraded] || '本地智能体 · 模型不可用';
    }
    if (CONFIG.AI_BACKEND) return (BACKEND.llmLabel || '大模型') + ' · 已连接';
    return BACKEND.online ? '本地智能体 · 未配模型 Key' : '本地智能体 · 离线演示';
  }
  function ocrChannelLabel() {
    if (CONFIG.OCR_BACKEND) {
      return (BACKEND.ocrProvider === 'local') ? '后端本地 OCR · 已连接' : '云端 OCR · ' + (BACKEND.ocrProvider || '已连接');
    }
    return CONFIG.LOCAL_OCR ? '浏览器内 OCR（本地运行）' : '手动填写';
  }
  // 本地日期（不用 toISOString，避免 UTC 跨天/跨月导致「今天」错位）
  function localDay(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }
  // 生成给大模型的财务快照：除了汇总，还带上真实账单明细，
  // 这样「我的上一笔支出是什么」「查一下某天的消费」才能真的答出来（否则模型只会说无法获取记录）。
  function buildChatContext() {
    const tx = getTx();
    const curM = localDay().slice(0, 7);
    const inc = tx.filter(t => t.type === 'income' && monthKey(t.date) === curM).reduce((s, t) => s + t.amount, 0);
    const exp = tx.filter(t => t.type === 'expense' && monthKey(t.date) === curM).reduce((s, t) => s + t.amount, 0);
    const h = computeHealth();
    // 新到旧排序：先按日期，同日再按创建时间
    const sorted = tx.slice().sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')) || ((b.createdAt || 0) - (a.createdAt || 0)));
    const brief = (t) => ({
      date: t.date,
      type: t.type === 'income' ? '收入' : '支出',
      amount: Math.round(Number(t.amount || 0) * 100) / 100,
      category: (catMeta(t.type, t.category).name || t.category),
      note: String(t.note || '').slice(0, 24)
    });
    const records = sorted.slice(0, 60).map(brief);
    const lastExpense = (() => { const t = sorted.find(x => x.type === 'expense'); return t ? brief(t) : null; })();
    const lastIncome = (() => { const t = sorted.find(x => x.type === 'income'); return t ? brief(t) : null; })();
    // 近 14 天按天汇总，覆盖「某天花了多少 / 那天有记录吗」
    const dayMap = {};
    tx.forEach(t => {
      if (t.type !== 'expense' || !t.date) return;
      const d = dayMap[t.date] || (dayMap[t.date] = { date: t.date, expense: 0, count: 0 });
      d.expense += Number(t.amount || 0); d.count += 1;
    });
    const days = Object.keys(dayMap).sort((a, b) => b.localeCompare(a)).slice(0, 14)
      .map(k => ({ date: k, expense: Math.round(dayMap[k].expense * 100) / 100, count: dayMap[k].count }));
    // 分类汇总：模型算不准「哪类花得最多」，先把结果算好给它
    const agg = (list) => {
      const m = {};
      list.filter(t => t.type === 'expense').forEach(t => {
        const name = catMeta('expense', t.category).name || t.category;
        const o = m[name] || (m[name] = { name: name, amount: 0, count: 0 });
        o.amount += Number(t.amount || 0); o.count += 1;
      });
      return Object.keys(m).map(k => m[k]).sort((a, b) => b.amount - a.amount).slice(0, 6)
        .map(o => ({ name: o.name, amount: Math.round(o.amount * 100) / 100, count: o.count }));
    };
    const monthTx = tx.filter(t => monthKey(t.date) === curM);
    return {
      today: localDay(),
      month: curM,
      income: Math.round(inc),
      expense: Math.round(exp),
      surplus: Math.round(avgMonthlySurplus()),
      health: h.total,
      goals: getGoals().map(g => ({ name: g.name, saved: Math.round(g.saved), target: Math.round(g.target) })),
      totalCount: tx.length,
      recordsTruncated: tx.length > records.length,
      lastExpense: lastExpense,
      lastIncome: lastIncome,
      records: records,
      days: days,
      byCategoryMonth: agg(monthTx),
      byCategoryAll: agg(tx)
    };
  }
  // 统一取后端地址（已由 api-base.js 自动定位；未定位时回退同源）
  function apiUrl(path) {
    if (window.CWApiBase) return window.CWApiBase.url(path);
    return (CONFIG.API_BASE || '') + path;
  }
  async function callBackendChat(message, history) {
    // 历史带上 AI 侧回答（去掉 HTML），模型才不会把旧问题当成新问题重复回答
    const plain = (s) => String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const hist = (Array.isArray(history) ? history : [])
      .filter(m => m && (m.role === 'user' || m.role === 'ai'))
      .slice(-8)
      .map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: plain(m.html) }));
    const res = await fetch(apiUrl('/api/chat'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: hist, context: buildChatContext() })
    });
    if (!res.ok) {
      // 后端会返回 { code, hint }，把「额度没开通 / 限流 / Key 错」区分开，便于精确提示
      let info = {};
      try { info = await res.json(); } catch (e) {}
      const err = new Error(info.hint || info.message || ('chat http ' + res.status));
      err.code = info.code || 'HTTP_' + res.status;
      err.hint = info.hint || '';
      err.httpStatus = res.status;
      throw err;
    }
    const data = await res.json();
    return data.reply;
  }
  async function callBackendOcr(dataUrl) {
    const res = await fetch(apiUrl('/api/ocr'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl })
    });
    if (!res.ok) throw new Error('ocr http ' + res.status);
    return await res.json(); // 期望 { amount, merchant, date, category }
  }

  /* ---------------- 财务教练：六大智能能力 ---------------- */
  let chatHistory = [];
  let aiTab = 'chat';
  const QUICK_QS = [
    '帮我生成上个月的消费分析报表',
    '我的收入是2000，帮我分配各类预算',
    '我怎么存钱最快？',
    '学生适合什么理财？',
    '我每个月存200一年有多少？',
    '怎么降低不必要消费？',
    '我这个月花得最多的是哪类？',
    '我的储蓄目标多久能达成？'
  ];

  function renderAI() {
    disposeCharts();
    pageEl.innerHTML = `
      <div class="page-head" style="align-items:flex-end">
        <div><h3>消费教练</h3><p>六大 AI 能力：对话问答 · 资产配置 · 预测建模 · 风险识别 · 自动报告 · 预算调节。</p></div>
        <span class="badge ${CONFIG.AI_BACKEND ? '' : 'badge-soft'}">${esc(aiChannelLabel())}</span>
      </div>
      <div class="subtabs" id="aiTabs">
        ${[['chat', '💬 对话问答'], ['allocate', '🧩 资产配置'], ['forecast', '📈 财务预测'], ['risk', '🚨 风险识别'], ['report', '📄 自动报告'], ['budget', '🎚️ 预算调节']]
          .map(([k, l]) => `<button class="subtab ${aiTab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}
      </div>
      <div id="aiSub"></div>`;
    pageEl.querySelectorAll('#aiTabs .subtab').forEach(b => b.addEventListener('click', () => { aiTab = b.dataset.tab; renderAI(); }));
    renderAISub();
  }

  function renderAISub() {
    const sub = document.getElementById('aiSub');
    if (!sub) return;
    if (aiTab === 'allocate') return renderAllocate(sub);
    if (aiTab === 'forecast') return renderForecast(sub);
    if (aiTab === 'risk') return renderRisk(sub);
    if (aiTab === 'report') return renderReport(sub);
    if (aiTab === 'budget') return renderBudgetAdjust(sub);
    return renderChat(sub);
  }

  /* ---------- 1. 对话问答（通义千问） ---------- */
  // 模型不可用时给出「可照做」的修复引导，而不是干巴巴的报错
  function aiFixGuide() {
    const code = BACKEND.llmDegraded;
    if (!code) return '';
    const G = {
      NO_ENTITLEMENT: {
        t: '通义千问已配好 Key，但账号还没「开通模型服务」',
        d: '服务商返回 <code>AccessDenied.Unpurchased</code>：Key 是通过校验的，只是这个阿里云账号没有订购任何模型，所以一律拒绝受理。这一步必须在控制台点一次「开通」，代码改不了。',
        steps: [
          '打开 <a href="https://bailian.console.aliyun.com/" target="_blank" rel="noopener">bailian.console.aliyun.com</a>，用**同一个**阿里云账号登录',
          '首页右上角（或「模型广场」）点 <b>「开通服务」</b>——免费，不需要付费',
          '在模型广场搜 <code>qwen-plus</code> → 点 <b>「立即开通」</b>，领取新用户免费额度（100 万 tokens / 180 天）',
          '回到本页点上面的 <b>🔄 重新检测</b>，状态变绿即可'
        ],
        tip: '若你的 Key 是<b>子工作空间</b>的（前缀 <code>sk-ws-</code> 即工作空间级），还需在「工作空间 → 模型配额」里给该空间分配额度，否则空间内额度为 0。'
      },
      RATE_LIMITED: {
        t: '模型额度 / 频率已达上限',
        d: '服务商返回 <code>Throttling.RateQuota</code>。免费额度通常有严格的 QPS 与总量限制。',
        steps: ['等 1～2 分钟再点「重新检测」', '若长期如此，说明该模型的免费额度已用尽，需在百炼控制台充值或换模型'],
        tip: ''
      },
      INVALID_KEY: {
        t: 'API Key 无效',
        d: '服务商返回 401：Key 不存在、被吊销，或复制时漏了字符 / 带了空格。',
        steps: ['到百炼控制台「API-KEY 管理」重新创建并完整复制', '打开 <code>server/.env</code>，替换 <code>DASHSCOPE_API_KEY=</code> 后面的值', '重启服务后点「重新检测」'],
        tip: ''
      }
    }[code];
    if (!G) {
      return `<div class="ai-fix-card"><h5>⚠️ 大模型调用失败（${esc(code)}）</h5>
        <p>${esc(BACKEND.llmHint || '请检查服务端日志。')}</p></div>`;
    }
    return `<div class="ai-fix-card">
      <h5>⚠️ ${G.t}</h5>
      <p>${G.d}</p>
      <ol>${G.steps.map((s) => `<li>${s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('')}</ol>
      ${G.tip ? `<p class="ai-fix-tip">💡 ${G.tip}</p>` : ''}
      <p class="ai-fix-foot">在此期间，下方对话与其余五大能力全部可用（本地引擎），不影响你继续使用。</p>
    </div>`;
  }

  function renderChat(sub) {
    const tx = getTx();
    const insights = buildInsights(tx);
    if (!chatHistory.length) {
      chatHistory.push({ role: 'ai', html: `你好，我是 <b>SmartPig 小助手</b>，你的消费教练${CONFIG.AI_BACKEND ? '（通义千问驱动）' : '（演示智能体）'}。理财、存钱、消费、储蓄目标都可以问我，支持无限次对话。` });
    }
    sub.innerHTML = `
      <div class="ai-status-bar">
        <span class="ai-dot ${BACKEND.llmDegraded ? 'warn' : (CONFIG.AI_BACKEND ? 'ok' : 'idle')}"></span>
        <span class="ai-status-text">当前通道：<b>${esc(aiChannelLabel())}</b>${BACKEND.llmDegraded && BACKEND.llmHint ? ` · ${esc(BACKEND.llmHint)}` : ''}</span>
        <button class="btn btn-ghost btn-sm" id="aiRetest">🔄 重新检测</button>
      </div>
      ${aiFixGuide()}
      <div class="ai-card" style="margin-bottom:18px">
        <h4><img class="brand-inline" src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" /> SmartPig AI 洞察</h4>
        <p style="color:#B5B0A4;margin:0;font-size:13.5px">基于你全部 ${tx.length} 笔记录分析</p>
        ${insights.length ? insights.map(i => `<div class="ai-insight">${i}</div>`).join('') : '<div class="ai-insight">记录越多，洞察越精准。先去记几笔吧～</div>'}
      </div>
      <div class="panel" style="padding:0;overflow:hidden">
        <div class="chat-box">
          <div class="chat-log" id="chatLog"></div>
          <div class="chat-input">
            <input type="text" id="chatInput" placeholder="问点财务问题，例如：我怎么存钱最快？" />
            <button id="chatSend">发送</button>
          </div>
        </div>
        <div class="chat-quick" id="chatQuick">${QUICK_QS.map(q => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <div class="api-note" style="padding:0 14px 14px">${BACKEND.llmDegraded
          ? `💡 大模型当前不可用（<code>${esc(BACKEND.llmDegraded)}</code>）：${esc(BACKEND.llmHint || '')} 已自动切换到<strong>本地智能体</strong>，回答照常，无限问答不受影响。恢复后刷新页面即用回大模型。`
          : CONFIG.AI_BACKEND
          ? `💡 已接入<strong>${esc(BACKEND.llmLabel || '本地大模型')}</strong>（后端 <code>/api/chat</code> 代理，密钥在服务端），回答会结合你的真实账单，无限问答。`
          : '💡 当前为<strong>本地演示智能体</strong>（规则引擎，无需联网/密钥，无限问答）。接入真实「通义千问」：把 <code>js/config.js</code> 的 <code>AI_BACKEND</code> 设为 <code>true</code>，并在 <code>server/.env</code> 设 <code>LLM_PROVIDER=qwen</code> + <code>DASHSCOPE_API_KEY</code>（密钥只放服务端）。'}</div>
      </div>`;

    const log = document.getElementById('chatLog');
    const renderLog = () => {
      log.innerHTML = chatHistory.map(m => {
        const wide = /bp-card|bp-done|sr-card/.test(m.html);
        return `
        <div class="msg ${m.role}${wide ? ' msg-wide' : ''}">
          <div class="avatar">${m.role === 'ai' ? '<img class="brand-avatar" src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" />' : '🙂'}</div>
          <div class="bubble${wide ? ' bubble-wide' : ''}">${m.html}</div>
        </div>`;
      }).join('');
      log.scrollTop = log.scrollHeight;
      if (log.__bpRefresh) log.__bpRefresh();
      if (log.__srRefresh) log.__srRefresh();
    };
    renderLog();
    // 预算方案卡片（AI 页对话同样支持「一句话分配预算 + 一键执行」）
    const bpState = BP_STATE.page || (BP_STATE.page = { plan: null, awaitIncome: false });
    wireBudgetCard(log, (html) => { chatHistory.push({ role: 'ai', html }); renderLog(); });
    wireReportCard(log);

    const ask = async (q) => {
      q = (q || '').trim(); if (!q) return;
      chatHistory.push({ role: 'user', html: esc(q) });
      renderLog();
      // 要报表 → 直接由本地数据出详细报表，不让模型自由发挥
      const reportStep = srChatStep(q);
      if (reportStep) { chatHistory.push({ role: 'ai', html: reportStep }); renderLog(); srRevealTop(log); return; }
      const budgetStep = budgetChatStep(q, bpState);
      if (budgetStep) { chatHistory.push({ role: 'ai', html: budgetStep }); renderLog(); return; }
      let reply, note = '';
      // 已知模型不可用时不再反复请求，直接用本地引擎（避免每条消息都等一次失败）
      if (CONFIG.AI_BACKEND && !BACKEND.llmDegraded) {
        try {
          reply = await callBackendChat(q, chatHistory);
        } catch (err) {
          BACKEND.llmDegraded = err.code || 'UNKNOWN';
          BACKEND.llmHint = err.hint || err.message || '';
          if (!BACKEND._warned) {
            BACKEND._warned = true;
            toast('warn', 'AI 已切换到本地智能体', BACKEND.llmHint || '大模型暂不可用，先将就用本地引擎回答');
          }
          const badge = document.querySelector('.page-head .badge');
          if (badge) { badge.textContent = aiChannelLabel(); badge.className = 'badge badge-soft'; }
          note = `<div class="ai-fallback-note">⚠️ 大模型暂不可用（${esc(BACKEND.llmDegraded)}），以下由本地智能体回答。${esc(BACKEND.llmHint)}</div>`;
          reply = agentReply(q, getTx());
        }
      } else {
        reply = agentReply(q, getTx());
      }
      chatHistory.push({ role: 'ai', html: note + reply });
      renderLog();
    };
    document.getElementById('chatSend').addEventListener('click', () => { const i = document.getElementById('chatInput'); ask(i.value); i.value = ''; });
    document.getElementById('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') { const i = e.target; ask(i.value); i.value = ''; } });
    sub.querySelectorAll('#chatQuick button').forEach(b => b.addEventListener('click', () => ask(b.dataset.q)));

    // 重新检测：在控制台开通额度后点一下即可生效，无需重启服务
    const retest = document.getElementById('aiRetest');
    if (retest) retest.addEventListener('click', async () => {
      retest.disabled = true; retest.textContent = '检测中…';
      const prevDegraded = BACKEND.llmDegraded;
      BACKEND.llmDegraded = '';
      try {
        const r = await callBackendChat('你好，请回复"已连接"两个字', []);
        BACKEND.llmHint = '';
        BACKEND._warned = false;
        toast('success', '✅ 大模型已连通', '现在由通义千问实时回答：' + String(r).slice(0, 40));
      } catch (e) {
        BACKEND.llmDegraded = e.code || 'UNKNOWN';
        BACKEND.llmHint = e.hint || e.message || '';
        if (prevDegraded === BACKEND.llmDegraded) {
          toast('warn', '仍不可用', BACKEND.llmHint || '请按提示在控制台开通模型服务后重试');
        }
      }
      renderAI();
    });
  }

  /* ---------- 2. AI 资产智能配置 ---------- */
  function computeAllocation() {
    const surplus = avgMonthlySurplus();
    const avgExp = monthlyAvg('expense') || 0;
    const savedTotal = getGoals().reduce((s, g) => s + Number(g.saved), 0);
    const emergencyNeed = avgExp * 6;
    const emergencyGap = Math.max(0, emergencyNeed - savedTotal);
    const h = computeHealth();
    const riskScore = Math.round(h.dims.save * 0.5 + h.dims.rational * 0.5);
    let profile, buckets;
    if (riskScore >= 75) {
      profile = '进取型';
      buckets = [['货币基金/现金', 20], ['债券/固收', 20], ['指数基金/股票', 40], ['黄金/大宗', 10], ['保险保障', 10]];
    } else if (riskScore >= 55) {
      profile = '稳健型';
      buckets = [['货币基金/现金', 30], ['债券/固收', 30], ['指数基金/股票', 25], ['黄金/大宗', 10], ['保险保障', 5]];
    } else {
      profile = '保守型';
      buckets = [['货币基金/现金', 50], ['债券/固收', 30], ['指数基金/股票', 10], ['黄金/大宗', 5], ['保险保障', 5]];
    }
    const monthlyInvest = Math.max(0, Math.round(surplus * 0.7));
    return { surplus, avgExp, savedTotal, emergencyNeed, emergencyGap, riskScore, profile, buckets, monthlyInvest, health: h };
  }
  function renderAllocate(sub) {
    disposeCharts();
    const a = computeAllocation();
    const colors = ['#23B883', '#4C6EF5', '#F08C00', '#E8590C', '#9C36B5'];
    sub.innerHTML = `
      <div class="stat-grid" style="margin-bottom:18px">
        <div class="stat"><div class="ico">💧</div><div class="lbl">月可投资金</div><div class="val income">${fmt(a.monthlyInvest)}</div><div class="trend text-2">按结余的 70%</div></div>
        <div class="stat"><div class="ico">🛡️</div><div class="lbl">应急金目标</div><div class="val">${fmt(a.emergencyNeed)}</div><div class="trend text-2">6 个月支出</div></div>
        <div class="stat"><div class="ico">📉</div><div class="lbl">应急金缺口</div><div class="val ${a.emergencyGap > 0 ? 'expense' : 'income'}">${fmt(a.emergencyGap)}</div><div class="trend text-2">${a.emergencyGap > 0 ? '需优先补足' : '已达标'}</div></div>
        <div class="stat"><div class="ico">🎚️</div><div class="lbl">风险偏好</div><div class="val">${a.profile}</div><div class="trend text-2">评分 ${a.riskScore}</div></div>
      </div>
      <div class="chart-grid">
        <div class="chart-box"><h4>建议资产配置</h4><div class="chart" id="chartAlloc" style="height:320px"></div></div>
        <div class="panel"><h4>🧩 配置建议（AI）</h4>
          <div class="alloc-legend">${a.buckets.map(([n, p], i) => `<div class="al-row"><span class="dot" style="background:${colors[i]}"></span><span class="al-n">${n}</span><b>${p}%</b><span class="al-a">${fmt(a.monthlyInvest * p / 100)}/月</span></div>`).join('')}</div>
          <div class="ai-insight" style="margin-top:14px">${a.emergencyGap > 0
            ? `你目前应急金缺口约 <b>${fmt(a.emergencyGap)}</b>，建议先把每月可投资金优先补足应急金（货币基金/现金），达标后再按「${a.profile}」比例配置。`
            : `应急金已覆盖约 6 个月支出，可按「${a.profile}」比例定投，长期坚持复利效果更佳。`}</div>
          <div class="ai-insight">风险偏好基于你的<b>储蓄能力 ${a.health.dims.save}</b> 与<b>消费理性度 ${a.health.dims.rational}</b> 综合评估。投资有风险，配置仅供参考。</div>
        </div>
      </div>`;
    if (typeof echarts === 'undefined') { const el = document.getElementById('chartAlloc'); if (el) el.innerHTML = '<div class="chart-fallback">📡 图表组件需联网加载 ECharts</div>'; return; }
    const c = echarts.init(document.getElementById('chartAlloc'));
    c.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
      legend: { bottom: 0, textStyle: { fontSize: 12 } },
      color: colors,
      series: [{ type: 'pie', radius: ['42%', '68%'], avoidLabelOverlap: true, label: { formatter: '{b}\n{d}%' }, data: a.buckets.map(([n, p]) => ({ name: n, value: p })) }]
    });
    activeCharts.push(c);
  }

  /* ---------- 3. AI 财务预测建模 ---------- */
  function computeForecast() {
    const surplus = avgMonthlySurplus();
    const savedTotal = getGoals().reduce((s, g) => s + Number(g.saved), 0);
    const months = [];
    for (let i = 0; i <= 6; i++) months.push(addMonths(new Date(), i));
    const labels = months.map(d => `${d.getMonth() + 1}月`);
    const s = surplus;
    const mid = months.map((_, i) => Math.round(savedTotal + s * i));
    const opt = months.map((_, i) => Math.round(savedTotal + s * 1.2 * i));
    const con = months.map((_, i) => Math.round(savedTotal + s * 0.8 * i));
    return { surplus, savedTotal, labels, mid, opt, con, year1: Math.round(savedTotal + s * 12) };
  }
  function renderForecast(sub) {
    disposeCharts();
    const f = computeForecast();
    sub.innerHTML = `
      <div class="stat-grid" style="margin-bottom:18px">
        <div class="stat"><div class="ico">📈</div><div class="lbl">月均净结余</div><div class="val ${f.surplus >= 0 ? 'income' : 'expense'}">${fmt(f.surplus)}</div><div class="trend text-2">预测基础</div></div>
        <div class="stat"><div class="ico">🏦</div><div class="lbl">当前累计储蓄</div><div class="val">${fmt(f.savedTotal)}</div><div class="trend text-2">来自储蓄目标</div></div>
        <div class="stat"><div class="ico">🗓️</div><div class="lbl">6 个月后预计</div><div class="val">${fmt(f.mid[6])}</div><div class="trend text-2">中性情景</div></div>
        <div class="stat"><div class="ico">🎯</div><div class="lbl">一年后预计</div><div class="val">${fmt(f.year1)}</div><div class="trend text-2">中性情景</div></div>
      </div>
      <div class="panel" style="margin-bottom:18px"><h4>📈 未来 6 个月资产预测（三情景）</h4><div class="chart" id="chartForecast" style="height:340px"></div></div>
      <div class="ai-card">
        <h4><img class="brand-inline" src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" /> AI 预测结论</h4>
        <div class="ai-insight">${f.surplus > 0
          ? `按当前节奏，每月净结余约 <b>${fmt(f.surplus)}</b>，一年可再积累 <b>${fmt(f.surplus * 12)}</b>。若收入提升或支出再降 10%，可加速达成。`
          : `你当前的月均净结余为 <b>${fmt(f.surplus)}</b>（≤0），储蓄难有增长。建议先开源节流：压缩 Top 支出类别、取消闲置订阅，把结余转正后预测才有效。`}</div>
        <div class="ai-insight">预测基于历史月均结余线性外推，未计入投资收益与突发大额支出，仅作趋势参考。</div>
      </div>`;
    if (typeof echarts === 'undefined') { const el = document.getElementById('chartForecast'); if (el) el.innerHTML = '<div class="chart-fallback">📡 图表组件需联网加载 ECharts</div>'; return; }
    const c = echarts.init(document.getElementById('chartForecast'));
    c.setOption({
      tooltip: { trigger: 'axis' }, legend: { data: ['乐观(+20%)', '中性', '保守(-20%)'] },
      grid: { left: 64, right: 20, top: 40, bottom: 30 },
      xAxis: { type: 'category', data: f.labels }, yAxis: { type: 'value', name: '¥' },
      series: [
        { name: '乐观(+20%)', type: 'line', smooth: true, data: f.opt, lineStyle: { color: '#2f9e44' }, itemStyle: { color: '#2f9e44' } },
        { name: '中性', type: 'line', smooth: true, data: f.mid, lineStyle: { color: '#4C6EF5', width: 3 }, itemStyle: { color: '#4C6EF5' } },
        { name: '保守(-20%)', type: 'line', smooth: true, data: f.con, lineStyle: { color: '#f08c00' }, itemStyle: { color: '#f08c00' } }
      ]
    });
    activeCharts.push(c);
  }

  /* ---------- 4. AI 消费风险识别 ---------- */
  function computeRisks() {
    const tx = getTx();
    const expense = tx.filter(t => t.type === 'expense');
    const curM = new Date().toISOString().slice(0, 7);
    const prev = addMonths(new Date(), -1).toISOString().slice(0, 7);
    const risks = [];
    const inc = tx.filter(t => t.type === 'income' && monthKey(t.date) === curM).reduce((s, t) => s + t.amount, 0);
    const exp = expense.filter(t => monthKey(t.date) === curM).reduce((s, t) => s + t.amount, 0);
    if (inc > 0 && exp > inc) risks.push({ sev: 'high', ico: '🔴', title: '本月支出已超收入', desc: `收入 ${fmt(inc)}，支出 ${fmt(exp)}，结余为负，需立即压缩非必要支出。` });
    const budgets = getBudgets();
    Object.keys(budgets).forEach(k => {
      if (budgets[k] > 0) { const used = monthCategoryTotal(k, curM); if (used > budgets[k]) risks.push({ sev: 'high', ico: '🚨', title: `「${catName(k)}」预算超支`, desc: `已花 ${fmt(used)}，超预算 ${fmt(used - budgets[k])}。` }); }
    });
    const cur = {}, pre = {};
    expense.forEach(t => { const m = monthKey(t.date); if (m === curM) cur[t.category] = (cur[t.category] || 0) + t.amount; if (m === prev) pre[t.category] = (pre[t.category] || 0) + t.amount; });
    Object.keys(cur).forEach(k => {
      if (pre[k] > 0 && cur[k] > pre[k] * 1.5 && cur[k] - pre[k] > 200)
        risks.push({ sev: 'medium', ico: '📈', title: `「${catName(k)}」环比激增`, desc: `上月 ${fmt(pre[k])} → 本月 ${fmt(cur[k])}，增长 ${Math.round((cur[k] / pre[k] - 1) * 100)}%，注意是否有冲动消费。` });
    });
    expense.filter(t => t.amount >= 500).sort((a, b) => b.amount - a.amount).slice(0, 3).forEach(t => {
      risks.push({ sev: 'medium', ico: '💸', title: `大额支出 ${fmt(t.amount)}`, desc: `${catName(t.category)} · ${t.date}${t.note ? ' · ' + esc(t.note) : ''}，占本月支出 ${exp ? Math.round(t.amount / exp * 100) : 0}%。` });
    });
    const small = expense.filter(t => t.amount < 50 && monthKey(t.date) === curM);
    if (small.length >= 8) risks.push({ sev: 'medium', ico: '☕', title: '高频小额（拿铁因子）', desc: `本月 ${small.length} 笔低于 50 元支出，合计 ${fmt(small.reduce((s, t) => s + t.amount, 0))}，建议每周复盘。` });
    if (!Object.keys(budgets).length) risks.push({ sev: 'low', ico: '🎯', title: '尚未设置预算', desc: '缺少预算防线，建议为 Top3 支出类别设置月度预算。' });
    if (!risks.length) risks.push({ sev: 'ok', ico: '✅', title: '暂未发现明显风险', desc: '支出结构健康，继续保持记账与预算习惯。' });
    return risks;
  }
  function renderRisk(sub) {
    const risks = computeRisks();
    const order = { high: 0, medium: 1, low: 2, ok: 3 };
    risks.sort((a, b) => order[a.sev] - order[b.sev]);
    const label = { high: '高风险', medium: '中风险', low: '提示', ok: '良好' };
    sub.innerHTML = `
      <div class="panel">
        <h4>🚨 AI 消费风险识别</h4>
        <p class="muted" style="font-size:13.5px;margin:0 0 14px">基于本月账单与上月对比，自动扫描超支、激增、大额与高频小额等风险。</p>
        ${risks.map(r => `<div class="risk-item sev-${r.sev}"><div class="ri-ico">${r.ico}</div><div class="ri-body"><div class="rt"><span class="sev sev-${r.sev}">${label[r.sev]}</span> ${r.title}</div><div class="rb">${r.desc}</div></div></div>`).join('')}
      </div>`;
  }

  /* ---------- 5. AI 全自动财务报告 ---------- */
  function buildReport() {
    const tx = getTx();
    const budgets = getBudgets();
    const _now = new Date();
    const _ym = (y, m) => { const d = new Date(y, m, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
    const curM = _ym(_now.getFullYear(), _now.getMonth());
    const inc = tx.filter(t => t.type === 'income' && monthKey(t.date) === curM).reduce((s, t) => s + t.amount, 0);
    const exp = tx.filter(t => t.type === 'expense' && monthKey(t.date) === curM).reduce((s, t) => s + t.amount, 0);
    const surplus = inc - exp;
    const saveRate = inc > 0 ? Math.round(surplus / inc * 100) : 0;
    const byCat = {};
    tx.filter(t => t.type === 'expense' && monthKey(t.date) === curM).forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const h = computeHealth();
    const goals = getGoals();
    const risks = computeRisks().filter(r => r.sev === 'high' || r.sev === 'medium');
    const goalLines = goals.map(g => `${esc(g.name)}：${fmt(g.saved)} / ${fmt(g.target)}（${Math.round(g.saved / g.target * 100)}%）`).join('；') || '暂无目标';
    const dimName = { balance: '收支均衡', budget: '预算执行', save: '储蓄能力', rational: '消费理性', reserve: '应急储备' };

    // —— 对比分析：与上月环比（本地时区安全，避免 toISOString 跨月偏移）——
    const curDate = new Date(_now.getFullYear(), _now.getMonth(), 1);
    const prevM = _ym(_now.getFullYear(), _now.getMonth() - 1);
    const prevInc = tx.filter(t => t.type === 'income' && monthKey(t.date) === prevM).reduce((s, t) => s + t.amount, 0);
    const prevExp = tx.filter(t => t.type === 'expense' && monthKey(t.date) === prevM).reduce((s, t) => s + t.amount, 0);
    const prevSurplus = prevInc - prevExp;
    const pct = (a, b) => (b > 0 ? Math.round((a - b) / b * 100) : (a > 0 ? 100 : 0));
    const prevByCat = {};
    tx.filter(t => t.type === 'expense' && monthKey(t.date) === prevM).forEach(t => { prevByCat[t.category] = (prevByCat[t.category] || 0) + t.amount; });
    const catKeys = [...new Set([...Object.keys(byCat), ...Object.keys(prevByCat)])];
    const catDelta = catKeys.map(k => ({ k, cur: byCat[k] || 0, pre: prevByCat[k] || 0 }))
      .filter(x => x.cur > 0 || x.pre > 0).sort((a, b) => Math.abs(b.cur - b.pre) - Math.abs(a.cur - a.pre)).slice(0, 4);
    const hasPrev = prevInc > 0 || prevExp > 0;
    const momDelta = exp - prevExp;
    const momPct = prevExp > 0 ? Math.round(momDelta / prevExp * 100) : 0;

    // —— 五维场景归集 ——
    const curExpTx = tx.filter(t => t.type === 'expense' && monthKey(t.date) === curM);
    const preExpTx = tx.filter(t => t.type === 'expense' && monthKey(t.date) === prevM);
    const sumBuckets = (list) => {
      const o = {}; REPORT_BUCKETS.forEach(b => o[b.key] = 0);
      list.forEach(t => { const b = reportBucket(t); if (b && o[b] != null) o[b] += t.amount; });
      return o;
    };
    const curB = sumBuckets(curExpTx);
    const preB = sumBuckets(preExpTx);

    // 深夜信号：显式「深夜冲动」标签 / 夜宵等关键词
    const isLate = (t) => (t.tags || []).some(x => /深夜/.test(x)) || /夜宵|宵夜|深夜|凌晨|半夜/.test((t.note || '') + (t.food || ''));
    const nonEssentialTx = curExpTx.filter(t => { const b = reportBucket(t); return b === 'yueji' || b === 'loss'; });
    const nonEssentialTotal = nonEssentialTx.reduce((s, t) => s + t.amount, 0);
    const lateTotal = nonEssentialTx.filter(isLate).reduce((s, t) => s + t.amount, 0);
    const nightShare = nonEssentialTotal > 0 ? Math.round(lateTotal / nonEssentialTotal * 100) : 0;

    // 情绪不佳标签 + 隐形损耗峰值日
    const emotionTx = curExpTx.filter(t => (t.tags || []).some(x => /情绪不佳/.test(x)));
    const lossTx = curExpTx.filter(t => reportBucket(t) === 'loss');
    const lossTotal = lossTx.reduce((s, t) => s + t.amount, 0);
    const topLossTx = lossTx.slice().sort((a, b) => b.amount - a.amount)[0];

    const dims = REPORT_BUCKETS.map(b => {
      const cur = curB[b.key] || 0, pre = preB[b.key] || 0;
      const delta = cur - pre;
      const p = prevExp > 0 ? Math.round(delta / (pre || 1) * 100) : (delta > 0 ? 100 : 0);
      return { key: b.key, name: b.name, tag: b.tag, emoji: b.emoji, desc: b.desc, cur, pre, delta, pct: p, insight: '' };
    });
    const maxV = Math.max(1, ...dims.map(d => Math.max(d.cur, d.pre)));
    dims.forEach(d => { d.curW = Math.round(d.cur / maxV * 100); d.preW = Math.round(d.pre / maxV * 100); });
    const byKey = {}; dims.forEach(d => byKey[d.key] = d);

    // —— 每类 AI 扎心点评 ——
    {
      const d = byKey.survive;
      if (!hasPrev) d.insight = `生存饭是刚需底线，本月 ${fmt(d.cur)}。省钱也绝不能砍这一块，下一顿去食堂点个肉菜吧。`;
      else if (d.delta < 0) d.insight = `生存饭降了 ${fmt(-d.delta)}，是因为这周吃太多泡面了吗？记住，省钱绝不能以牺牲健康为代价，下一顿去食堂点个肉菜吧。`;
      else if (d.delta > 0) d.insight = `生存饭涨了 ${fmt(d.delta)}。若是物价/饭量变化还好，若在用外卖硬撑，别忘了食堂更划算。`;
      else d.insight = `生存饭与上月持平，底线守得很稳。好好吃饭，别拿健康省钱。`;
    }
    {
      const d = byKey.social;
      if (!d.cur && !d.pre) d.insight = `本月还没有社交局记录。朋友约饭也可以有，但记得选性价比高的局。`;
      else if (d.delta > 0) d.insight = `这月聚餐有点多哦，是不是又参与了没必要的「凑局」？下次朋友约饭，可以试试提议去操场散步代替。`;
      else d.insight = `社交局降了 ${fmt(-d.delta)}，关系没降温、钱包先回血，挺会拿捏的。`;
    }
    {
      const d = byKey.yueji;
      if (d.delta > 0) d.insight = `悦己钱全月涨了 ${Math.abs(d.pct)}%，其中 ${nightShare}% 发生在深夜。算法和情绪又在掏空你了，下次半夜想买，记得先放进冷静区。`;
      else if (d.cur > 0) d.insight = `悦己钱降了 ${fmt(-d.delta)}，情绪消费踩了刹车，继续保持。`;
      else d.insight = `本月没有悦己钱，情绪很稳。偶尔奖励自己一下也没关系。`;
    }
    {
      const d = byKey.growth;
      if (d.delta < 0) d.insight = `买书/买课的钱变少了？如果是闲置了，建议先把手头的资源用完再买新的。`;
      else if (d.cur > 0) d.insight = `成长投入 ${fmt(d.cur)}，这是唯一越花越赚的账户，保持。`;
      else d.insight = `本月没有成长投入。哪怕每月 50 块买本书，也是在给未来的自己加薪。`;
    }
    {
      const d = byKey.loss;
      if (d.delta > 0) d.insight = `本月的「隐形刺客」是：${topLossTx ? esc(topLossTx.note || catName(topLossTx.category)) : '凑单小物件'}。下个月把这笔钱省下来，够你加好几次鸡腿了。`;
      else if (d.cur > 0) d.insight = `隐形损耗降了 ${fmt(-d.delta)}，凑单/续费的手被你自己按住了 👍。`;
      else d.insight = `本月没有隐形损耗，凑单的坑你躲过去了 👍。`;
    }

    // —— 一句话总评 ——
    const overspend = surplus < 0 || (hasPrev && momPct > 10);
    const verdict = overspend ? 'overspend' : 'healthy';
    const verdictText = overspend
      ? '超支预警！本月隐形损耗激增，生活费活不到下周三了，快来看看怎么抢救。🆘'
      : '本月生存饭占比稳定，成长投入增加，你正在夺回生活费的掌控权！🏆';

    // —— 行为洞察 ——
    let nightText;
    if (!nonEssentialTotal) nightText = '本月还没有非刚需消费，钱包很安静。';
    else if (nightShare >= 30) nightText = `你这个月有 ${nightShare}% 的非刚需消费（悦己钱+隐形损耗）发生在深夜。深夜的冲动，正在偷走你的选择基金。`;
    else nightText = `非刚需里只有 ${nightShare}% 发生在深夜，比大多数人克制，情绪管理在线 👍`;

    let triggerText;
    if (emotionTx.length) triggerText = `你有 ${emotionTx.length} 笔消费被标记为「情绪不佳」，合计 ${fmt(emotionTx.reduce((s, t) => s + t.amount, 0))}。情绪不是错，但让它替你刷卡就亏了，下次先深呼吸 10 分钟。`;
    else if (lossTx.length >= 2) {
      const byDay = {}; lossTx.forEach(t => byDay[t.date] = (byDay[t.date] || 0) + t.amount);
      const days = Object.entries(byDay).sort((a, b) => b[1] - a[1]);
      const avg = lossTotal / Object.keys(byDay).length;
      const ratio = avg > 0 ? days[0][1] / avg : 1;
      triggerText = ratio >= 1.8
        ? `我注意到你在 ${days[0][0]} 前后的隐形损耗是平时的 ${ratio.toFixed(1)} 倍（${fmt(days[0][1])}）。是不是压力大就想花钱？`
        : `本月隐形损耗比较分散，没有明显的「情绪爆发日」，这种稳定性很值钱。`;
    } else triggerText = `本月没有明显的情绪化消费高峰。如果压力大，试试用散步/运动代替下单。`;

    const refundTx = curExpTx.filter(t => /退款|退货|退换/.test((t.note || '') + (t.merchant || '')));
    const refundText = refundTx.length
      ? `本月有 ${refundTx.length} 笔退款/退货记录，说明冲动下单后你清醒过来了。下次下单前先放购物车 24 小时，能少退一半。`
      : `本月没有记录到退款，要么没冲动下单，要么冲动还没被退货提醒。保持清醒 👍`;

    // —— 省钱建议：方案 A/B/C（红线：不借钱·不向家里要·不砍生存饭）——
    const treatFood = curExpTx.filter(t => t.category === 'food' && /奶茶|咖啡|瑞幸|星巴克|外卖|甜品|饮料/.test((t.note || '') + (t.food || '')));
    const treatTotal = treatFood.reduce((s, t) => s + t.amount, 0);
    const planA_save = treatTotal > 0 ? Math.round(treatTotal * 0.4) : 0;
    const planA = {
      key: 'A', title: '无痛平替', save: planA_save,
      desc: treatTotal > 0
        ? `你的「悦己钱」里，奶茶/咖啡/外卖约 ${fmt(treatTotal)}/月。把其中一半换成自制挂耳/茶包，每月能无痛省下 ${fmt(planA_save)}，口味还不打折。`
        : `本月没有奶茶/咖啡/外卖支出，这条先跳过。把省下的钱定投到「小目标」里吧。`
    };
    const subTx = lossTx.filter(t => /会员|续费|订阅|自动/.test((t.note || '') + (t.merchant || '')));
    const subTotal = subTx.reduce((s, t) => s + t.amount, 0);
    const planB_save = subTx.length ? subTotal : Math.round(lossTotal * 0.3);
    const planB = {
      key: 'B', title: '截断隐形损耗', save: planB_save,
      desc: lossTotal > 0
        ? (subTx.length
            ? `发现 ${subTx.length} 笔会员/续费（${fmt(subTotal)}）。不常用的视频/音乐会员关掉，能省 ${fmt(planB_save)}；剩下的凑单小物件，下单前先问 AI。`
            : `本月隐形损耗 ${fmt(lossTotal)}，多是凑单小物件。下次买东西前先问 AI，砍掉 30% 的冲动，每月约省 ${fmt(planB_save)}。`)
        : `本月没有隐形损耗，凑单的坑你躲过去了 👍`
    };
    const socialTx = curExpTx.filter(t => reportBucket(t) === 'social');
    const socialTotal = socialTx.reduce((s, t) => s + t.amount, 0);
    const planC_save = socialTotal > 0 ? Math.round(socialTotal * 0.25) : 0;
    const planC = {
      key: 'C', title: '社交降级', save: planC_save,
      desc: socialTotal > 0
        ? `本月社交局 ${fmt(socialTotal)}。下个月把一次「去商场吃大餐」改成「学校周边野餐/桌游」，体验一样好，能省下 ${fmt(planC_save)}。`
        : `本月没有社交局支出。下次聚会可以主动提议低成本玩法，省钱又不扫兴。`
    };
    const plans = [planA, planB, planC];
    const saveTotal = plans.reduce((s, p) => s + p.save, 0);
    const redline = '不借钱 · 不向家里要 · 不砍生存饭';

    const overview = { total: exp, delta: momDelta, pct: momPct, hasPrev, income: inc, surplus, saveRate, health: h.total, verdict, verdictText,
      topCats: top.map(([k, v]) => ({ name: catName(k), amount: v })) };
    const behavior = { night: { share: nightShare, text: nightText }, trigger: { text: triggerText }, refund: { text: refundText } };

    const sections = [
      { key: 'overview', h: '一、全局概览', body: `本月总支出 <b>${fmt(exp)}</b>${hasPrev ? `，较上月${momDelta <= 0 ? '🔻下降' : '🔺上升'} ${fmt(Math.abs(momDelta))}（${Math.abs(momPct)}%）` : ''}。${verdictText}` },
      { key: 'fiveDim', h: '二、五维对比', body: dims.map(d => `${d.emoji} ${d.name} ${fmt(d.cur)}（${d.delta > 0 ? '🔺涨' : d.delta < 0 ? '🔻降' : '持平'} ${fmt(Math.abs(d.delta))}${hasPrev ? `，${Math.abs(d.pct)}%` : ''}）`).join('；') },
      { key: 'behavior', h: '三、行为洞察', body: `🌙 深夜：${nightText}<br/>💥 情绪：${triggerText}<br/>↩️ 退款：${refundText}` },
      { key: 'saving', h: '四、省钱建议', body: `🛑 红线：${redline}<br/>` + plans.map(p => `方案 ${p.key} · ${p.title}：${p.desc}（约省 ${fmt(p.save)}）`).join('<br/>') + `<br/>💡 合计每月可无痛省下约 ${fmt(saveTotal)}。` }
    ];
    const title = `${new Date().getFullYear()} 年 ${new Date().getMonth() + 1} 月 · AI 财务报告`;
    return { title, sections, month: curM, overview, dims, behavior, saving: { plans, total: saveTotal, redline } };
  }
  const REP_SEC_LABELS = { overview: '全局概览', fiveDim: '五维对比', behavior: '行为洞察', saving: '省钱建议' };
  function pushReport() {
    const r = buildReport();
    r.createdAt = Date.now();
    const reports = getReports();
    const i = reports.findIndex(x => x.month === r.month);
    if (i >= 0) reports[i] = r; else reports.unshift(r);
    setReports(reports.slice(0, 12));
    return r;
  }
  function autoGenerateMonthlyReport() {
    if (DEMO) return;                     // 游客演示态不写真实账号的报告数据
    const cfg = getReportCfg();
    if (!cfg.auto) return;
    const now = new Date();
    const curM = now.toISOString().slice(0, 7);
    const day = now.getDate();
    const reports = getReports();
    if (reports.some(x => x.month === curM)) return;       // 本月已生成
    if (day < cfg.day) return;                              // 未到设定生成日
    const r = pushReport();
    try { localStorage.setItem('cw_report_pending', r.month); } catch (_) {}
    return r;
  }
  function richReportHtml(r, cfg) {
    const on = (k) => cfg.sections[k] !== false;
    const o = r.overview;
    const parts = [];
    if (on('overview')) {
      parts.push(`
        <div class="report-section rep-part">
          <h5>一、全局概览 <span class="rep-sub">一眼看懂这个月混得怎么样</span></h5>
          <div class="rep-hero ${o.verdict}">
            <div class="rh-main">
              <div class="rh-label">本月总支出</div>
              <div class="rh-num">${fmt(o.total)}</div>
              ${o.hasPrev
                ? `<div class="rh-delta ${o.delta <= 0 ? 'down' : 'up'}">${o.delta <= 0 ? '🔻 下降' : '🔺 上升'} ${fmt(Math.abs(o.delta))} · 较上月 ${Math.abs(o.pct)}%</div>`
                : `<div class="rh-delta">本月暂无上月对比，攒满两个月就能看到变化</div>`}
            </div>
            <div class="rh-verdict">
              <div class="rv-ico">${o.verdict === 'healthy' ? '🏆' : '🆘'}</div>
              <div class="rv-text" data-verdict="${verdSig(r)}">${verdictHtml(r)}</div>
            </div>
            <div class="rh-mini">
              <span>收入 <b>${fmt(o.income)}</b></span>
              <span>结余 <b>${fmt(o.surplus)}</b></span>
              <span>储蓄率 <b>${o.saveRate}%</b></span>
            </div>
          </div>
        </div>`);
    }
    if (on('fiveDim')) {
      parts.push(`
        <div class="report-section rep-part">
          <h5>二、五维对比 <span class="rep-sub">哪里涨了，哪里降了</span></h5>
          <div class="dim-legend"><span class="lg pre">◀ 左：上月</span><span class="lg cur">右：本月 ▶</span><span class="lg up">🔺 上涨</span><span class="lg down">🔻 下降</span></div>
          ${r.dims.map(d => `
            <div class="dim-row">
              <div class="dim-head">
                <span class="dim-name">${d.emoji} ${d.name}<i class="dim-tag">${d.tag}</i></span>
                <span class="dim-num">本月 <b>${fmt(d.cur)}</b>
                  <span class="dim-delta ${d.delta > 0 ? 'up' : d.delta < 0 ? 'down' : 'flat'}">${d.delta > 0 ? '🔺 +' : d.delta < 0 ? '🔻 -' : ''}${fmt(Math.abs(d.delta))}${o.hasPrev ? `，${d.delta >= 0 ? '↑' : '↓'}${Math.abs(d.pct)}%` : ''}</span>
                </span>
              </div>
              <div class="dd-bar">
                <div class="dd-side left"><div class="dd-fill pre" style="width:${d.preW}%"></div></div>
                <div class="dd-axis"></div>
                <div class="dd-side right"><div class="dd-fill cur ${d.delta > 0 ? 'up' : d.delta < 0 ? 'down' : 'flat'}" style="width:${d.curW}%"></div></div>
              </div>
              <div class="dim-lbls"><span class="muted">上月 ${fmt(d.pre)}</span><span class="muted">本月 ${fmt(d.cur)}</span></div>
              <div class="dim-insight${getDimCache()[dimSig(r, d)] ? ' ai-live' : ''}" data-dim-insight="${dimSig(r, d)}">${dimInsightHtml(r, d)}</div>
            </div>`).join('')}
        </div>`);
    }
    if (on('behavior')) {
      const cards = [
        ['🌙', '深夜消费图鉴', 'night', r.behavior.night.text],
        ['💥', '情绪触发点', 'trigger', r.behavior.trigger.text],
        ['↩️', '退款率分析', 'refund', r.behavior.refund.text]
      ];
      parts.push(`
        <div class="report-section rep-part">
          <h5>三、行为洞察 <span class="rep-sub">为什么涨了？</span></h5>
          <div class="beh-grid">
            ${cards.map(([ico, t, key, txt]) => {
              const sig = behSig(r, key, txt);
              return `<div class="beh-card"><div class="bc-ico">${ico}</div><div class="bc-title">${t}</div>
                <div class="bc-text${getBehCache()[sig] ? ' ai-live' : ''}" data-beh="${sig}">${behInsightHtml(sig, txt)}</div></div>`;
            }).join('')}
          </div>
        </div>`);
    }
    if (on('saving')) {
      parts.push(`
        <div class="report-section rep-part">
          <h5>四、省钱建议 <span class="rep-sub">可执行的行动指南</span></h5>
          <div class="save-redline">🛑 红线：${r.saving.redline} —— 省钱也要有尊严、有健康</div>
          <div class="save-plans">
            ${r.saving.plans.map(p => `
              <div class="save-plan">
                <div class="sp-head"><span class="sp-badge">方案 ${p.key}</span><span class="sp-title">${p.title}</span></div>
                <div class="sp-desc">${p.desc}</div>
                <div class="sp-save">每月约省 <b>${fmt(p.save)}</b></div>
              </div>`).join('')}
          </div>
          <div class="save-total">💡 三招合计，每月可无痛省下约 <b>${fmt(r.saving.total)}</b>（不砍生存饭的前提下）</div>
        </div>`);
    }
    return parts.join('') || '<p class="muted">当前未勾选任何板块，请在「报表设置」中开启。</p>';
  }
  function legacyReportHtml(r, cfg) {
    const shown = r.sections.filter(s => cfg.sections[s.key] !== false);
    return shown.map(s => `<div class="report-section"><h5>${s.h}</h5><p>${s.body}</p></div>`).join('') || '<p class="muted">当前未勾选任何板块，请在「报表设置」中开启。</p>';
  }
  /* ---------------- 报告·五维 AI 点评（真实大模型，带缓存） ---------------- */
  const LS_DIM = 'cw_report_dims';
  function getDimCache() { try { return JSON.parse(localStorage.getItem(LS_DIM) || '{}') || {}; } catch (e) { return {}; } }
  function saveDimCache(o) { try { localStorage.setItem(LS_DIM, JSON.stringify(o)); } catch (e) { /* 忽略配额 */ } }
  function dimSig(r, d) { return `${r.month || ''}|${d.key}|${Math.round(d.cur)}|${Math.round(d.pre)}`; }
  function dimInsightHtml(r, d) {
    const c = getDimCache()[dimSig(r, d)];
    if (c && c.text) return `<span class="ai-src">AI 实时</span>${esc(c.text)}`;
    return `<span class="ai-src ai-src-wait">AI 生成中</span>${d.insight}`;
  }
  async function hydrateDimComments(r) {
    const dims = (r.dims || []).filter(d => d.cur + d.pre > 0);
    if (!dims.length) return;
    const cache = getDimCache();
    const todo = dims.filter(d => { const c = cache[dimSig(r, d)]; return !(c && c.text); });
    if (!todo.length) return;
    const exp = (r.overview && r.overview.total) || 0;
    const items = todo.map(d => ({
      kind: 'dim', id: dimSig(r, d), name: d.name, tag: d.tag, desc: d.desc,
      cur: Math.round(d.cur), pre: Math.round(d.pre), delta: Math.round(d.delta), pct: d.pct,
      hasPrev: !!(r.overview && r.overview.hasPrev),
      sharePct: exp ? Math.round(d.cur / exp * 100) : null
    }));
    const markLocal = () => document.querySelectorAll('.dim-insight .ai-src-wait')
      .forEach(s => { s.classList.remove('ai-src-wait'); s.classList.add('ai-src-local'); s.textContent = '本地点评'; });
    try {
      const res = await fetch(apiUrl('/api/insights'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const c2 = getDimCache();
      let got = 0;
      (data.insights || []).forEach(x => {
        if (!x.text) return;
        got++;
        c2[x.id] = { text: x.text, at: Date.now() };
        document.querySelectorAll(`[data-dim-insight="${x.id}"]`).forEach(el => {
          el.classList.add('ai-live');
          el.innerHTML = `<span class="ai-src">AI 实时</span>${esc(x.text)}`;
        });
      });
      saveDimCache(c2);
      if (!got) markLocal();
    } catch (e) {
      markLocal();
      console.warn('[report] 五维 AI 点评不可用，已用本地版本：', e.message);
    }
  }

  /* ---------------- 报告·行为洞察点评（真实大模型，带缓存） ---------------- */
  const LS_BEH = 'cw_report_beh';
  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
  function getBehCache() { try { return JSON.parse(localStorage.getItem(LS_BEH) || '{}') || {}; } catch (e) { return {}; } }
  function saveBehCache(o) { try { localStorage.setItem(LS_BEH, JSON.stringify(o)); } catch (e) { /* 忽略配额 */ } }
  function behSig(r, key, text) { return `${(r && r.month) || ''}|${key}|${hashStr(text || '')}`; }
  function behInsightHtml(sig, text) {
    const c = getBehCache()[sig];
    if (c && c.text) return `<span class="ai-src">AI 实时</span>${esc(c.text)}`;
    return `<span class="ai-src ai-src-wait">AI 生成中</span>${text}`;
  }
  async function hydrateBehComments(r) {
    if (!r.behavior) return;
    const topics = [
      ['night', '深夜消费图鉴', r.behavior.night && r.behavior.night.text],
      ['trigger', '情绪触发点', r.behavior.trigger && r.behavior.trigger.text],
      ['refund', '退款率分析', r.behavior.refund && r.behavior.refund.text]
    ].filter(x => x[2]);
    if (!topics.length) return;
    const cache = getBehCache();
    const todo = topics.filter(([key, , txt]) => { const c = cache[behSig(r, key, txt)]; return !(c && c.text); });
    if (!todo.length) return;
    const items = todo.map(([key, name, txt]) => ({
      kind: 'beh', id: behSig(r, key, txt), topic: name, localText: txt, month: r.month
    }));
    const markLocal = () => document.querySelectorAll('.bc-text .ai-src-wait')
      .forEach(s => { s.classList.remove('ai-src-wait'); s.classList.add('ai-src-local'); s.textContent = '本地点评'; });
    try {
      const res = await fetch(apiUrl('/api/insights'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const c2 = getBehCache();
      let got = 0;
      (data.insights || []).forEach(x => {
        if (!x.text) return;
        got++;
        c2[x.id] = { text: x.text, at: Date.now() };
        document.querySelectorAll(`[data-beh="${x.id}"]`).forEach(el => {
          el.classList.add('ai-live');
          el.innerHTML = `<span class="ai-src">AI 实时</span>${esc(x.text)}`;
        });
      });
      saveBehCache(c2);
      if (!got) markLocal();
    } catch (e) {
      markLocal();
      console.warn('[report] 行为洞察 AI 点评不可用，已用本地版本：', e.message);
    }
  }

  /* ---------------- 报告·一句话总评（真实大模型，带缓存） ---------------- */
  const LS_VERDICT = 'cw_report_verdict';
  function getVerdictCache() { try { return JSON.parse(localStorage.getItem(LS_VERDICT) || '{}') || {}; } catch (e) { return {}; } }
  function saveVerdictCache(o) { try { localStorage.setItem(LS_VERDICT, JSON.stringify(o)); } catch (e) { /* 忽略配额 */ } }
  function verdSig(r) {
    const o = r && r.overview; if (!o) return 'na';
    return `${r.month || ''}|${Math.round(o.total)}|${Math.round(o.income)}|${Math.round(o.surplus)}|${o.saveRate}|${o.hasPrev ? 1 : 0}|${o.pct}|${Math.round(o.delta)}|${o.health != null ? Math.round(o.health) : 'x'}|${o.verdict}`;
  }
  function verdictHtml(r) {
    const o = r && r.overview; if (!o) return '';
    const c = getVerdictCache()[verdSig(r)];
    if (c && c.text) return `<span class="ai-src">AI 实时</span>${esc(c.text)}`;
    return `<span class="ai-src ai-src-wait">AI 生成中</span>${esc(o.verdictText)}`;
  }
  async function hydrateVerdict(r) {
    const o = r && r.overview; if (!o) return;
    const sig = verdSig(r);
    const cache = getVerdictCache();
    if (cache[sig] && cache[sig].text) {
      const el = document.querySelector(`[data-verdict="${sig}"]`);
      if (el) { el.classList.add('ai-live'); el.innerHTML = `<span class="ai-src">AI 实时</span>${esc(cache[sig].text)}`; }
      return;
    }
    const item = {
      kind: 'verdict', id: sig, tone: o.verdict, month: r.month,
      total: Math.round(o.total), income: Math.round(o.income), surplus: Math.round(o.surplus),
      saveRate: o.saveRate, delta: Math.round(o.delta), pct: o.pct, hasPrev: o.hasPrev,
      health: o.health != null ? o.health : null,
      topCats: Array.isArray(o.topCats) ? o.topCats.map((c) => ({ name: c.name, amount: Math.round(c.amount || 0) })) : []
    };
    const markLocal = () => {
      const el = document.querySelector(`[data-verdict="${sig}"]`);
      if (el) el.innerHTML = `<span class="ai-src ai-src-local">本地点评</span>${esc(o.verdictText)}`;
    };
    try {
      const res = await fetch(apiUrl('/api/insights'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [item] }) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const c2 = getVerdictCache();
      let got = 0;
      (data.insights || []).forEach((x) => {
        if (!x.text) return; got++; c2[x.id] = { text: x.text, at: Date.now() };
        const el = document.querySelector(`[data-verdict="${x.id}"]`);
        if (el) { el.classList.add('ai-live'); el.innerHTML = `<span class="ai-src">AI 实时</span>${esc(x.text)}`; }
      });
      saveVerdictCache(c2);
      if (!got) markLocal();
    } catch (e) { markLocal(); console.warn('[report] 总评 AI 不可用，已用本地版本：', e.message); }
  }

  function renderReport(sub, rep) {
    const cfg = getReportCfg();
    const r = rep || buildReport();
    const isStored = !!rep;
    const bodyHtml = r.overview ? richReportHtml(r, cfg) : legacyReportHtml(r, cfg);
    const plain = () => `${r.title}\n\n` + r.sections.map(s => `【${s.h}】\n${s.body.replace(/<[^>]+>/g, '')}`).join('\n\n');
    sub.innerHTML = `
      <div class="panel">
        <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h4 style="margin:0">📄 ${r.title}${isStored ? ' <span class="rep-tag">历史存档</span>' : ''}</h4>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${isStored ? '<button class="btn btn-ghost btn-sm" id="repBack">← 返回本月</button>' : `
              <button class="btn btn-ghost btn-sm" id="repSettings">⚙️ 报表设置</button>
              <button class="btn btn-ghost btn-sm" id="repRefresh">🔄 重新生成</button>`}
            <button class="btn btn-ghost btn-sm" id="repCopy">📋 复制</button>
            <button class="btn btn-primary btn-sm" id="repDownload">⬇️ 下载</button>
          </div>
        </div>
        ${!isStored ? `<div class="report-settings" id="repSettingsBox" style="display:none"></div>` : ''}
        <div class="report-body" id="reportBody">
          ${bodyHtml}
        </div>
        <p class="muted" style="font-size:12.5px;margin:14px 0 0">报告由引擎基于你的账单自动生成${CONFIG.AI_BACKEND ? '，可进一步由通义千问润色' : ''}。数据仅存于你的账户。</p>
      </div>
      ${renderReportHistory(r.month)}`;

    // 五维点评交给真实大模型（异步替换，已缓存的不再请求）
    if (r.dims && r.overview) hydrateDimComments(r);
    if (r.behavior) hydrateBehComments(r);
    if (r.overview) hydrateVerdict(r);

    // 报表设置面板
    const sBox = document.getElementById('repSettingsBox');
    if (sBox && !isStored) {
      const secKeys = Object.keys(REP_SEC_LABELS);
      sBox.innerHTML = `
        <div class="rs-row"><label class="rs-switch"><input type="checkbox" id="rsAuto" ${cfg.auto ? 'checked' : ''}/> 每月自动生成报告（到达设定日期后自动存档并提醒）</label></div>
        <div class="rs-row"><span>生成日期：每月第</span><input type="number" id="rsDay" min="1" max="28" value="${cfg.day}" style="width:64px"/> <span>天</span></div>
        <div class="rs-row"><span class="rs-label">包含板块：</span>${secKeys.map(k => `<label class="rs-check"><input type="checkbox" data-sec="${k}" ${cfg.sections[k] !== false ? 'checked' : ''}/> ${REP_SEC_LABELS[k]}</label>`).join('')}</div>
        <div class="rs-actions"><button class="btn btn-primary btn-sm" id="rsSave">保存设置</button><button class="btn btn-ghost btn-sm" id="rsGen">立即生成本月报告</button></div>`;
      document.getElementById('rsSave').addEventListener('click', () => {
        const c = getReportCfg();
        c.auto = document.getElementById('rsAuto').checked;
        c.day = Math.min(28, Math.max(1, parseInt(document.getElementById('rsDay').value) || 1));
        secKeys.forEach(k => { c.sections[k] = sBox.querySelector(`[data-sec="${k}"]`).checked; });
        setReportCfg(c); toast('info', '已保存', '报表设置已更新'); renderReport(sub);
      });
      document.getElementById('rsGen').addEventListener('click', () => { pushReport(); toast('info', '已生成', '本月报告已存档'); renderReport(sub); });
    }

    const back = document.getElementById('repBack');
    if (back) back.addEventListener('click', () => renderReport(sub));
    const setBtn = document.getElementById('repSettings');
    if (setBtn) setBtn.addEventListener('click', () => { sBox.style.display = sBox.style.display === 'none' ? 'block' : 'none'; });
    const refBtn = document.getElementById('repRefresh');
    if (refBtn) refBtn.addEventListener('click', () => renderReport(sub));
    document.getElementById('repCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(plain()); toast('info', '已复制', '报告内容已复制到剪贴板'); }
      catch { alert('复制失败，请手动选择文本'); }
    });
    document.getElementById('repDownload').addEventListener('click', () => {
      const blob = new Blob([plain()], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'SmartPig财务报告.txt'; a.click(); URL.revokeObjectURL(a.href);
    });
    // 历史报告点击查看
    sub.querySelectorAll('[data-rep-month]').forEach(b => b.addEventListener('click', () => {
      const m = b.dataset.repMonth; const found = getReports().find(x => x.month === m); if (found) renderReport(sub, found);
    }));
  }
  function renderReportHistory(curMonth) {
    const reports = getReports();
    if (!reports.length) return '';
    return `
      <div class="panel" style="margin-top:18px">
        <h4 style="margin:0 0 12px">🗂️ 历史报告（近 12 个月）</h4>
        <div class="rep-history">
          ${reports.map(r => `<button class="rep-hist-item ${r.month === curMonth ? 'active' : ''}" data-rep-month="${r.month}">
            <span class="rh-m">${r.month}</span><span class="rh-t">${esc(r.title.split('·')[0].trim())}</span></button>`).join('')}
        </div>
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">自动生成的报告会在这里存档，点击任意月份查看当时分析。</p>
      </div>`;
  }

  /* ---------- 6. AI 自适应预算调节 ---------- */
  function catMonthlyAvg(cat) {
    const tx = getTx().filter(t => t.type === 'expense' && t.category === cat);
    const byM = {};
    tx.forEach(t => { byM[monthKey(t.date)] = (byM[monthKey(t.date)] || 0) + t.amount; });
    const vals = Object.values(byM);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  function computeBudgetSuggestions() {
    const tx = getTx();
    const cats = [...new Set(tx.filter(t => t.type === 'expense').map(t => t.category))];
    return cats.map(k => {
      const avg = catMonthlyAvg(k);
      const cur = getBudget(k);
      const suggested = Math.max(0, Math.round(avg * 0.95 / 10) * 10);
      return { k, avg, cur, suggested };
    }).filter(r => r.avg > 0);
  }
  function renderBudgetAdjust(sub) {
    const rows = computeBudgetSuggestions();
    const totalSug = rows.reduce((s, r) => s + r.suggested, 0);
    sub.innerHTML = `
      <div class="panel">
        <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h4 style="margin:0">🎚️ AI 自适应预算调节</h4>
          <button class="btn btn-primary btn-sm" id="applyAllBudgets" ${rows.length ? '' : 'disabled'}>一键应用建议</button>
        </div>
        <p class="muted" style="font-size:13.5px;margin:0 0 14px">基于各类别历史月均支出的 <b>95%</b> 生成建议预算（略收紧以促进储蓄）。当前 vs 建议：</p>
        ${rows.length ? rows.map(r => `<div class="budget-row">
          <div class="br-top"><span class="nm">${catMeta('expense', r.k).emoji} ${catName(r.k)}</span>
            <span class="val">现 ${r.cur ? fmt(r.cur) : '未设置'} → 建议 <b>${fmt(r.suggested)}</b></span></div>
          <div class="br-bar"><i style="width:${r.cur ? Math.min(100, Math.round(r.avg / r.cur * 100)) : 100}%"></i></div>
        </div>`).join('') : '<div class="muted" style="font-size:13.5px">暂无足够支出数据生成建议，先记几笔吧。</div>'}
        ${rows.length ? `<p class="muted" style="font-size:13px;margin:14px 0 0">建议预算合计：<b>${fmt(totalSug)}</b>（按月）</p>` : ''}
      </div>`;
    const btn = document.getElementById('applyAllBudgets');
    if (btn) btn.addEventListener('click', () => {
      if (!rows.length) return;
      const b = getBudgets();
      rows.forEach(r => { b[r.k] = r.suggested; });
      setBudgets(b);
      toast('info', '✅ 已应用', 'AI 建议预算已写入，可在记账管理查看');
      renderBudgetAdjust(sub);
    });
  }

  /* 智能体回答（规则引擎） */
  function agentReply(q, tx) {
    const s = q.toLowerCase();
    const has = (...k) => k.some(x => s.includes(x));
    const expense = tx.filter(t => t.type === 'expense');
    const income = tx.filter(t => t.type === 'income');

    if (has('你好', 'hi', '在吗', '你是', '介绍')) {
      return '我是 <b>SmartPig 小助手</b>，你的消费教练。我可以：<br/>· 分析你的支出结构<br/>· 估算餐饮热量<br/>· 预测储蓄目标达成时间<br/>· 给出省钱与预算建议<br/>试试问我："我怎么存钱最快？" 或 "学生适合什么理财？"';
    }

    /* —— 具体账单查询：上一笔 / 某一天 / 本月 / 最近几笔（本地引擎也能"查账"，不再说无法获取） —— */
    {
      const sorted = tx.slice().sort((a, b) =>
        String(b.date || '').localeCompare(String(a.date || '')) || ((b.createdAt || 0) - (a.createdAt || 0)));
      const askLast = /(上一笔|上笔|最近一笔|最后一笔|最新的.*(支出|消费|收入)|最近.*(支出|消费|收入|记录|账单))/.test(q);
      const askRecords = /(消费记录|支出记录|收入记录|账单明细|明细|查.{0,4}(记录|账单|消费|支出|花)|都花(了)?(多少|什么|哪些)|花了(多少|什么|哪些)|几笔)/.test(q);
      const lineOf = (t) => {
        const c = catMeta(t.type, t.category);
        return `${esc(t.date)} · ${c.emoji} ${esc(c.name)} <b>${fmt(t.amount)}</b>${t.note ? '（' + esc(String(t.note).slice(0, 20)) + '）' : ''}`;
      };
      const rangeOf = (qq) => {
        const now = new Date(); const y = now.getFullYear(); const mo = now.getMonth() + 1;
        const pad = n => String(n).padStart(2, '0');
        const mk = (yy, mm, dd) => `${yy}-${pad(mm)}-${pad(dd)}`;
        const lastDay = (yy, mm) => new Date(yy, mm, 0).getDate();
        let m;
        if ((m = qq.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/))) {
          const d = mk(+m[1], +m[2], +m[3]); return { start: d, end: d, label: `${+m[1]}年${+m[2]}月${+m[3]}日`, level: 'day' };
        }
        if ((m = qq.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/))) {
          const d = mk(y, +m[1], +m[2]); return { start: d, end: d, label: `${+m[1]}月${+m[2]}日`, level: 'day' };
        }
        if (/昨天/.test(qq)) { const d = new Date(now.getTime() - 864e5); const ds = mk(d.getFullYear(), d.getMonth() + 1, d.getDate()); return { start: ds, end: ds, label: '昨天（' + ds + '）', level: 'day' }; }
        if (/前天/.test(qq)) { const d = new Date(now.getTime() - 1728e5); const ds = mk(d.getFullYear(), d.getMonth() + 1, d.getDate()); return { start: ds, end: ds, label: '前天（' + ds + '）', level: 'day' }; }
        if (/今天|今日/.test(qq)) { const ds = mk(y, mo, now.getDate()); return { start: ds, end: ds, label: '今天（' + ds + '）', level: 'day' }; }
        if (/(上个月|上月)/.test(qq)) { const py = mo === 1 ? y - 1 : y; const pm = mo === 1 ? 12 : mo - 1; return { start: mk(py, pm, 1), end: mk(py, pm, lastDay(py, pm)), label: `${py}年${pm}月`, level: 'month' }; }
        if (/(本月|这个月|当月)/.test(qq)) return { start: mk(y, mo, 1), end: mk(y, mo, lastDay(y, mo)), label: `${y}年${mo}月`, level: 'month' };
        return null;
      };
      const r = rangeOf(q);
      if (askLast) {
        const t = sorted.find(x => x.type === 'expense');
        if (!t) return '你还没有支出记录哦。点右上角「一笔入魂」记第一笔，我马上帮你查 📝';
        const prev = sorted.filter(x => x.type === 'expense').slice(1, 3);
        return `你最近一笔支出是 <b>${lineOf(t)}</b>。<br/>` +
          (prev.length ? `再往前：<br/>${prev.map(x => '· ' + lineOf(x)).join('<br/>')}<br/>` : '') +
          '想看某天的？直接说「查一下 10月31日 的消费」就行。';
      }
      if (r && (r.level === 'day' || askRecords)) {
        const hits = tx.filter(t => t.date && t.date >= r.start && t.date <= r.end);
        const exp = hits.filter(t => t.type === 'expense');
        const inc = hits.filter(t => t.type === 'income');
        const sum = arr => arr.reduce((a, t) => a + Number(t.amount || 0), 0);
        if (!hits.length) return `<b>${r.label}</b> 这天没有记账记录。可能是还没记，也可能那天真的没花钱——想补记的话去「一笔入魂」补一笔就好 🙂`;
        const top = exp.slice().sort((a, b) => b.amount - a.amount).slice(0, 8);
        return `<b>${r.label}</b> 共 <b>${hits.length}</b> 笔记录：支出 <b>${fmt(sum(exp))}</b>（${exp.length} 笔）` +
          (inc.length ? `，收入 <b>${fmt(sum(inc))}</b>（${inc.length} 笔）` : '') + '。<br/>' +
          (top.length ? top.map(x => '· ' + lineOf(x)).join('<br/>') : '') +
          (exp.length > 8 ? `<br/>……另有 ${exp.length - 8} 笔较小的支出未列出。` : '');
      }
      if (r && r.level === 'month' && askRecords && !/最多|哪类|结构/.test(q)) {
        const hits = tx.filter(t => t.date && t.date >= r.start && t.date <= r.end);
        if (!hits.length) return `<b>${r.label}</b> 还没有记账记录。`;
        const byCat = {}; hits.filter(t => t.type === 'expense').forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
        const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
        return `<b>${r.label}</b> 共 <b>${hits.length}</b> 笔记录，支出 <b>${fmt(hits.filter(t => t.type === 'expense').reduce((a, t) => a + t.amount, 0))}</b>。<br/>` +
          (top.length ? '花得最多的几类：<br/>' + top.map(([k, v]) => `· ${catName(k)} <b>${fmt(v)}</b>`).join('<br/>') : '');
      }
      if (askRecords && !r) {
        const recent = sorted.slice(0, 6);
        if (!recent.length) return '还没有任何记录。先记一笔，我就能帮你查账了 📝';
        return `你最近的 ${recent.length} 笔记录：<br/>${recent.map(x => '· ' + lineOf(x)).join('<br/>')}<br/>想看某一天的，可以说「查一下 10月31日 的消费」。`;
      }
    }

    if (has('学生', '大学生', '校园', '刚工作', '理财小白', '小白')) {
      return '学生/新手的理财优先级：<br/>① <b>先建立应急金</b>：存够 1~3 个月生活费放货币基金；<br/>② <b>记账控支出</b>：收入有限，先管住"拿铁因子"；<br/>③ <b>小额定投</b>：每月 100~300 元定投宽基指数基金，重在养成习惯；<br/>④ <b>投资自己</b>：技能/证书的长期回报往往最高；<br/>⑤ <b>远离高风险</b>：不碰杠杆、不追热点、警惕"高收益"骗局。';
    }
    if (has('最快', '快速存钱', '存钱最快', '怎么存', '如何存')) {
      const surplus = avgMonthlySurplus();
      return `存钱最快的核心是"<b>先储蓄后消费</b>"：<br/>① 工资到账当天，自动转出 <b>30%</b> 进独立储蓄/目标账户；<br/>② 砍掉 60 天未用的订阅与高频小额支出（拿铁因子）；<br/>③ 设预算防线，超 80% 预警；<br/>④ 应急金（3~6 个月支出）先放货币基金，再考虑定投。<br/>你当前月均结余约 <b>${fmt(surplus)}</b>，把储蓄率提到 30%，积累会明显加快 💪`;
    }
    if (has('每个月存', '每月存', '一年有多少', '一年能存', '一年存')) {
      const m = q.match(/([0-9]+(?:\.[0-9]+)?)/);
      const per = m ? parseFloat(m[1]) : 200;
      return `每月存 <b>${fmt(per)}</b>：<br/>· 一年 = <b>${fmt(per * 12)}</b>（${per} × 12）<br/>· 若放年化约 2% 的货币基金，一年约 <b>${fmt(per * 12 * 1.02)}</b><br/>· 若定投年化约 6% 的指数基金（有波动），一年约 <b>${fmt(per * 12 * 1.06)}</b><br/>关键不在利率，而在<b>坚持</b>和<b>先存后花</b>。`;
    }
    if (has('不必要', '冲动消费', '降低消费', '少花', '控制消费', '乱花')) {
      return '降低不必要消费的 4 个方法：<br/>① <b>24 小时冷静期</b>：非必需品先放购物车一天再决定；<br/>② <b>揪出拿铁因子</b>：奶茶、外卖、会员等高频小额，每周复盘一次；<br/>③ <b>预算硬约束</b>：为餐饮/购物设月度上限，超支即停；<br/>④ <b>让花钱有痛感</b>：用单独卡/现金支付，减少无感消费。<br/>想让我分析你哪类支出最该砍，可以问我"我花得最多的是哪类？"';
    }
    if (has('热量', '卡路里', '吃了', '饮食', '胖', '这顿')) {
      const foodTx = expense.filter(t => t.category === 'food' && t.calories);
      const total = foodTx.reduce((a, t) => a + (t.calories || 0), 0);
      const curM = new Date().toISOString().slice(0, 7);
      const monthCal = foodTx.filter(t => monthKey(t.date) === curM).reduce((a, t) => a + (t.calories || 0), 0);
      if (!total) return '你还没记录带热量的餐饮哦。在「快速记账」选「餐饮美食」并填写食物明细（如 米饭1碗, 鸡腿1个），我会帮你估算热量 🍱';
      return `你已记录餐饮热量合计约 <b>${total}</b> 千卡，本月约 <b>${monthCal}</b> 千卡。<br/>成年人日均建议摄入 1800–2200 千卡，单餐建议 ≤800 千卡。若某餐偏高，下一餐可用蔬菜、蛋白替代主食来平衡 ⚖️`;
    }
    if (has('最多', '哪类', '支出结构', '花在')) {
      const byCat = {}; expense.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
      const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
      if (!sorted.length) return '目前还没有支出记录哦。';
      const c = catMeta('expense', sorted[0][0]);
      const total = expense.reduce((s, t) => s + t.amount, 0);
      return `你花得最多的是 <b>${c.name}</b>，累计 <b>${fmt(sorted[0][1])}</b>，占总支出 <b>${Math.round(sorted[0][1] / total * 100)}%</b>。<br/>建议为它设置月度预算（记账管理 → 设置预算），超过 80% 我会主动预警 🔔`;
    }
    if (has('结余', '净', '赚', '剩', '存下来')) {
      const inc = income.reduce((s, t) => s + t.amount, 0);
      const exp = expense.reduce((s, t) => s + t.amount, 0);
      const surplus = avgMonthlySurplus();
      return `累计收入 <b>${fmt(inc)}</b>，支出 <b>${fmt(exp)}</b>，净结余 <b>${fmt(inc - exp)}</b>。<br/>近月平均月结余约 <b>${fmt(surplus)}</b>，这是你储蓄与抗风险的基础 💪`;
    }
    if (has('预算', '超支', '限额')) {
      const b = getBudgets(); const keys = Object.keys(b);
      if (!keys.length) return '你还没设置分类预算。告诉我月收入，我直接算好每个分类该分多少并帮你设上，比如：「我的收入是 2000，帮我分配预算」🐷';
      const lines = keys.map(k => { const used = monthCategoryTotal(k); const over = used > b[k]; return `· ${catName(k)}：${fmt(used)} / ${fmt(b[k])} ${over ? '（<b>已超支</b>）' : `（${Math.round(used / b[k] * 100)}%）`}`; }).join('<br/>');
      return `当前预算使用情况：<br/>${lines}<br/>想重新分一套？说「我的收入是 XXXX，帮我分配预算」，我算好金额给你确认。<br/>提示：预算建议按历史均值的 1.1 倍设定，既有约束又不至于总超支。`;
    }
    if (has('储蓄', '目标', '存钱', '达成', '多久')) {
      const goals = getGoals();
      if (!goals.length) return '你还没有储蓄目标。在「储蓄目标」新建一个，我会按你的月结余预测达成时间并给调整建议 🎯';
      const surplus = avgMonthlySurplus();
      const lines = goals.map(g => { const p = predictGoal(g); const t = surplus > 0 ? `${p.months} 个月（约 ${p.date.getFullYear()}/${p.date.getMonth() + 1}）` : '需先提升月结余'; return `· ${esc(g.name)}：剩余 ${fmt(p.remain)}，预计 <b>${t}</b>`; }).join('<br/>');
      return `储蓄目标评估：<br/>${lines}<br/>想更快达成？把每月工资到账后的 <b>30%</b> 优先转入目标账户，而非先花后存 🏦`;
    }
    if (has('省钱', '建议', '怎么', '规划', '理财')) {
      return '三步稳健理财建议：<br/>① <b>先储蓄后消费</b>：工资到账先转 30% 进目标；<br/>② <b>控「拿铁因子」</b>：取消 60 天未用的自动续费，削减高频小额支出；<br/>③ <b>设预算防线</b>：为 Top3 支出类别设月度上限，超支即预警。需要我针对某类具体分析吗？';
    }
    if (has('豆包', '大模型', 'ai 智能体', '智能体', '接入', 'api', '模型')) {
      return '现在的我是<b>本地演示智能体</b>（规则引擎，零成本、零联网）。若要接入「豆包」等真实大模型：在<b>后端</b>调用火山引擎方舟 API（API Key 只放服务端，绝不能进前端），前端把对话发到你自己的 <code>/api/chat</code> 代理即可，安全性和效果都更好 🔐';
    }
    return '我已记下你的问题。你可以问我：<br/>· "这个月花得最多的是哪类？"<br/>· "我的结余有多少？"<br/>· "今天这顿多少热量？"<br/>· "我的储蓄目标多久能达成？"<br/>· "我该怎么省钱？"';
  }

  function buildInsights(tx) {
    const out = [];
    if (!tx.length) return out;
    const expense = tx.filter(t => t.type === 'expense');
    const byCat = {};
    expense.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
    const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    if (sorted.length) {
      const [topKey, topVal] = sorted[0]; const c = catMeta('expense', topKey);
      const total = expense.reduce((s, t) => s + t.amount, 0);
      out.push(`你支出最多的是 <b>${c.name}</b>，累计 <b>${fmt(topVal)}</b>，占总支出 <b>${Math.round(topVal / total * 100)}%</b>。若每月削减 20%，一年可省 <b>${fmt(topVal * 0.2 * 12)}</b>。`);
    }
    const small = expense.filter(t => t.amount < 50);
    if (small.length >= 5) {
      const sTotal = small.reduce((s, t) => s + t.amount, 0);
      out.push(`检测到 <b>${small.length}</b> 笔低于 ¥50 的小额支出，合计 <b>${fmt(sTotal)}</b>。这类"拿铁因子"最易被忽视，建议每周复盘一次。`);
    }
    const goals = getGoals();
    if (goals.length) {
      const g = goals.slice().sort((a, b) => (a.saved / a.target) - (b.saved / b.target))[0];
      out.push(`目标 <b>${esc(g.name)}</b> 已完成 <b>${Math.round(g.saved / g.target * 100)}%</b>。建议把每月结余的 30% 优先存入，可更快达成。`);
    }
    return out;
  }

  /* ---------------- 公共组件 ---------------- */
  function rowItem(t) {
    const c = catMeta(t.type, t.category);
    const cal = (t.type === 'expense' && t.category === 'food' && t.calories) ? ` 🔥${t.calories}` : '';
    const persona = spendPersona(t);
    const sub = persona
      ? `<span class="persona-tag pt-${personaKey(persona)}">${persona}</span>`
      : `<span class="li-cat">${c.name}</span>`;
    const insight = aiInsight(t);
    const regret = t.intercepted
      ? `<span class="regret-done">🙅 已拦截</span>`
      : (t.type === 'expense'
        ? `<button class="regret-btn" data-regret="${esc(t.id)}" title="后悔了？不删除，转入冷静区·冲动账本"><span class="rg-ico">🙅</span><span class="rg-txt">后悔了</span></button>`
        : '');
    return `<div class="list-item${t.intercepted ? ' li-intercepted' : ''}">
      <div class="li-ico" style="background:${t.type === 'income' ? 'var(--income-soft)' : 'var(--expense-soft)'};color:${t.type === 'income' ? 'var(--income)' : 'var(--expense)'}">${c.emoji}</div>
      <div class="li-main">
        <div class="li-title">${esc(t.note || c.name)}${cal}</div>
        <div class="li-sub">${sub} · ${t.date}</div>
        ${insight ? `<div class="ai-bubble${insight.src === 'ai' ? ' ai-live' : ' ai-thinking'}" data-insight="${esc(insight.id)}"><span class="ai-src${insight.src === 'ai' ? '' : ' ai-src-wait'}">${insight.src === 'ai' ? 'AI 实时' : 'AI 生成中'}</span>${esc(insight.text)}</div>` : ''}
      </div>
      <div class="li-right">
        <div class="li-amt ${t.type === 'income' ? 'income' : 'expense'}">${t.type === 'income' ? '+' : '-'}${fmt(t.amount).slice(1)}</div>
        ${regret}
      </div>
    </div>`;
  }
  function emptyState(ico, text) { return `<div class="empty"><div class="em-ico">${ico}</div><div>${text}</div></div>`; }
  // 记账统一入口：先过三维度风险拦截，命中就弹窗，用户决定后才落库
  function addTx(t, opts) {
    opts = opts || {};
    const risks = opts.noGuard ? [] : riskGuard(t);
    if (risks.length) {
      showRiskDialog(risks, t).then(res => {
        if (res.action === 'cancel') {             // 用户被劝住了：记一笔拦截日志，不落库
          riskLog(t, risks, 'cancel');
          if (opts.onCancel) opts.onCancel();
          return;
        }
        if (res.action === 'cool') {
          t.intercepted = true; t.interceptedAt = Date.now();
          t.tags = (t.tags || []).concat('🧊 冷静区');
        }
        commitTx(t, risks, res.action);
        if (opts.onSaved) opts.onSaved(res.action);
      });
      return false;
    }
    commitTx(t, [], 'none');
    if (opts.onSaved) opts.onSaved('none');
    return true;
  }
  function commitTx(t, risks, action) {
    const tx = getTx();
    tx.push(Object.assign({ id: id(), createdAt: Date.now() }, t));
    setTx(tx);
    if (risks && risks.length) {
      riskLog(t, risks, action);
      if (action === 'cool') toast('info', '🧊 已放进冷静区', '这笔不进本月支出统计，明天再决定要不要花');
    }
    aiRemind(t);
    refreshAlertBadge();
    piggyTakeMoney(t, action);
  }
  // 花掉一笔：存钱罐里被拿走一枚枚硬币（冷静区不扣钱，不放这段）
  function piggyTakeMoney(t, action) {
    if (!window.PiggyMotion || action === 'cool' || t.type !== 'expense') return;
    const c = catMeta(t.type, t.category);
    const mk = monthKey(t.date || new Date().toISOString().slice(0, 10));
    const inMonth = x => !x.intercepted && monthKey(x.date) === mk;
    const spent = getTx().filter(x => x.type === 'expense' && inMonth(x)).reduce((s, x) => s + x.amount, 0);
    const budgets = getBudgets();
    const totalBudget = Object.keys(budgets).reduce((s, k) => s + (Number(budgets[k]) || 0), 0);
    let from, to, label, sub;
    if (totalBudget > 0) {
      from = (totalBudget - (spent - t.amount)) / totalBudget;
      to = (totalBudget - spent) / totalBudget;
      label = '本月预算剩余';
      sub = '还剩 ' + fmt0(Math.max(0, totalBudget - spent));
    } else {
      const inc = getTx().filter(x => x.type === 'income' && monthKey(x.date) === mk).reduce((s, x) => s + x.amount, 0);
      from = inc > 0 ? (inc - (spent - t.amount)) / inc : 0.55;
      to = inc > 0 ? (inc - spent) / inc : 0.4;
      label = '本月结余';
      sub = '结余 ' + fmt0(Math.max(0, inc - spent));
    }
    window.PiggyMotion.spend({
      amount: t.amount,
      title: '支出 · ' + c.emoji + ' ' + c.name,
      fillFrom: Math.max(0.08, Math.min(1, from)),
      fillTo: Math.max(0.06, Math.min(1, to)),
      progress: {
        from: Math.max(0, Math.min(100, from * 100)),
        to: Math.max(0, Math.min(100, to * 100)),
        label: label,
        sub: sub
      }
    });
  }
  // 后悔药：不删除，转入冷静区·冲动账本（标记已拦截）
  function interceptTx(txId) {
    const tx = getTx();
    const t = tx.find(x => x.id === txId);
    if (!t) return;
    t.intercepted = true;
    t.interceptedAt = Date.now();
    setTx(tx);
    toast('warn', '🙅 已转入冷静区', '这笔没删，只是被收进「冲动账本」，月底看看你拦下了多少冲动');
  }
  function fillCatSelect(sel, type) { sel.innerHTML = CATEGORIES[type].map(c => `<option value="${c.key}">${c.emoji} ${c.name}</option>`).join(''); }

  /* ---------------- 模态框：记账 ---------------- */
  const txModal = document.getElementById('txModal');
  const txSeg = document.getElementById('txSeg');
  let modalType = 'expense';
  function openTxModal() {
    fillCatSelect(document.getElementById('txCategory'), modalType);
    document.getElementById('txAmount').value = '';
    document.getElementById('txDate').value = new Date().toISOString().slice(0, 10);
    document.getElementById('txNote').value = '';
    document.getElementById('txTags').value = '';
    if (document.getElementById('txCatHint')) document.getElementById('txCatHint').textContent = '';
    document.getElementById('txFoodText').value = '';
    if (document.getElementById('txCalTag')) document.getElementById('txCalTag').textContent = '0 千卡';
    if (document.getElementById('txFoodTags')) document.getElementById('txFoodTags').innerHTML = '';
    document.getElementById('txErr').textContent = '';
    wireFoodPreview('txCategory', 'txFoodBox', 'txCalTag', 'txFoodText', 'txFoodTags');
    ['txAmount', 'txDate', 'txNote', 'txCategory'].forEach(fid => {
      const el = document.getElementById(fid);
      if (el) { el.addEventListener('input', renderTxAlert); el.addEventListener('change', renderTxAlert); }
    });
    renderTxAlert();
    txModal.classList.add('show');
  }
  function closeTxModal() { txModal.classList.remove('show'); }
  // 记账弹窗实时异常预警
  function txPreviewAnomalies() {
    const amt = parseFloat(document.getElementById('txAmount').value);
    const cat = document.getElementById('txCategory').value;
    const date = document.getElementById('txDate').value;
    const note = document.getElementById('txNote').value;
    if (!amt || amt <= 0 || modalType !== 'expense') return [];
    const pseudo = { id: 'preview', type: 'expense', amount: amt, category: cat, date: date || new Date().toISOString().slice(0, 10), note, createdAt: Date.now() };
    return detectAnomalies(pseudo);
  }
  function renderTxAlert() {
    const box = document.getElementById('txAlert');
    if (!box) return;
    const an = txPreviewAnomalies();
    if (!an.length) { box.style.display = 'none'; box.innerHTML = ''; box.dataset.high = ''; return; }
    const high = an.some(a => a.sev === 'high');
    box.dataset.high = high ? '1' : '';
    box.className = 'tx-alert sev-' + (high ? 'high' : 'medium') + (high ? ' pulse' : '');
    box.innerHTML = `
      <div class="txa-head">🚨 疑似异常消费，保存时会弹窗请你确认</div>
      ${an.map(a => `<div class="txa-item"><span class="txa-ico">${a.ico}</span><div><div class="txa-t">${a.title}</div><div class="txa-d">${a.desc}</div></div></div>`).join('')}`;
    box.style.display = 'block';
    try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
  }
  txSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    txSeg.querySelectorAll('button').forEach(x => x.classList.remove('active', 'exp', 'inc'));
    b.classList.add('active', b.dataset.type === 'expense' ? 'exp' : 'inc');
    modalType = b.dataset.type; fillCatSelect(document.getElementById('txCategory'), modalType);
  }));
  document.getElementById('txClose').addEventListener('click', closeTxModal);
  txModal.addEventListener('click', e => { if (e.target === txModal) closeTxModal(); });
  // 智能分类预判 + 标签快捷
  const txNoteEl = document.getElementById('txNote');
  txNoteEl.addEventListener('input', () => {
    const pred = predictCategory(txNoteEl.value);
    const hint = document.getElementById('txCatHint');
    if (pred) {
      const sel = document.getElementById('txCategory');
      if (sel.value !== pred) { sel.value = pred; sel.dispatchEvent(new Event('change')); }
      hint.innerHTML = `<img class="brand-inline" src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" /> AI 预判分类：<b>${catName(pred)}</b>（已自动选中）`;
    } else {
      hint.textContent = '';
    }
  });
  document.querySelectorAll('#txTagSuggest .ts-chip').forEach(c => c.addEventListener('click', () => {
    const inp = document.getElementById('txTags');
    const cur = inp.value.trim();
    const t = c.dataset.tag;
    if (!cur.split(/[,，、\s]+/).includes(t)) inp.value = cur ? cur + ', ' + t : t;
  }));
  document.getElementById('txForm').addEventListener('submit', e => {
    e.preventDefault();
    const amt = parseFloat(document.getElementById('txAmount').value);
    if (!amt || amt <= 0) { document.getElementById('txErr').textContent = '请输入有效金额'; return; }
    document.getElementById('txErr').textContent = '';
    const cat = document.getElementById('txCategory').value;
    const extra = {};
    if (modalType === 'expense' && cat === 'food') {
      const r = estimateCalories(document.getElementById('txFoodText').value);
      extra.food = document.getElementById('txFoodText').value.trim();
      extra.calories = r.total;
    }
    const tagStr = document.getElementById('txTags').value.trim();
    if (tagStr) extra.tags = tagStr.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    // 三维度风险拦截在 addTx 内部完成：命中则不立即落库，先弹提示窗
    addTx(Object.assign({ type: modalType, amount: amt, category: cat, date: document.getElementById('txDate').value, note: document.getElementById('txNote').value.trim() }, extra), {
      onSaved: () => { closeTxModal(); navigate('home'); },
      onCancel: () => { document.getElementById('txErr').textContent = '已取消，这笔没有记录。'; }
    });
  });

  /* ---------------- 模态框：目标 ---------------- */
  const goalModal = document.getElementById('goalModal');
  function openGoalModal(g) {
    document.getElementById('goalModalTitle').textContent = g ? '编辑储蓄目标' : '新建储蓄目标';
    document.getElementById('goalName').value = g ? g.name : '';
    document.getElementById('goalTarget').value = g ? g.target : '';
    document.getElementById('goalSaved').value = g ? g.saved : 0;
    document.getElementById('goalEmoji').value = g ? g.emoji : '🎯';
    document.getElementById('goalErr').textContent = '';
    goalModal.dataset.edit = g ? g.id : '';
    goalModal.classList.add('show');
  }
  function closeGoalModal() { goalModal.classList.remove('show'); }
  document.getElementById('goalClose').addEventListener('click', closeGoalModal);
  goalModal.addEventListener('click', e => { if (e.target === goalModal) closeGoalModal(); });
  document.getElementById('goalForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('goalName').value.trim();
    const target = parseFloat(document.getElementById('goalTarget').value);
    const saved = parseFloat(document.getElementById('goalSaved').value) || 0;
    const emoji = document.getElementById('goalEmoji').value.trim() || '🎯';
    if (!name) { document.getElementById('goalErr').textContent = '请填写目标名称'; return; }
    if (!target || target <= 0) { document.getElementById('goalErr').textContent = '请填写有效目标金额'; return; }
    const gs = getGoals(); const editId = goalModal.dataset.edit;
    if (editId) { const g = gs.find(x => x.id === editId); Object.assign(g, { name, target, saved, emoji }); }
    else gs.push({ id: id(), name, target, saved, emoji });
    setGoals(gs); closeGoalModal(); renderGoals();
  });

  /* ---------------- 模态框：预算 ---------------- */
  const budgetModal = document.getElementById('budgetModal');
  // preset：AI 方案里的金额（用户点「我要微调」时带进来，可直接改再保存）
  function openBudgetModal(preset) {
    const b = Object.assign({}, getBudgets(), preset || {});
    document.getElementById('budgetFields').innerHTML = CATEGORIES.expense.map(c => `
      <div class="field"><label>${c.emoji} ${c.name}（每月预算 ¥，留空=不限制）</label>
        <input type="number" min="0" step="0.01" data-cat="${c.key}" value="${b[c.key] || ''}" placeholder="不限制" /></div>
    `).join('');
    document.getElementById('budgetErr').textContent = '';
    budgetModal.classList.add('show');
  }
  function closeBudgetModal() { budgetModal.classList.remove('show'); }
  document.getElementById('budgetClose').addEventListener('click', closeBudgetModal);
  budgetModal.addEventListener('click', e => { if (e.target === budgetModal) closeBudgetModal(); });
  document.getElementById('budgetSave').addEventListener('click', () => {
    const b = {};
    document.querySelectorAll('#budgetFields input[data-cat]').forEach(inp => {
      const v = parseFloat(inp.value); if (v > 0) b[inp.dataset.cat] = v;
    });
    setBudgets(b); closeBudgetModal(); renderManage();
  });

  /* ---------------- 顶部导航 / Hero ---------------- */
  const topnav = document.getElementById('topnav');
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.addEventListener('click', () => {
    navigate(b.dataset.page);
    if (topnav) topnav.classList.remove('open'); // 移动端点击后收起
  }));
  const appMenuBtn = document.getElementById('appMenuBtn');
  if (appMenuBtn) appMenuBtn.addEventListener('click', () => { if (topnav) topnav.classList.toggle('open'); });

  // 后悔药：事件委托（页面重渲染后依然生效）
  pageEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.regret-btn');
    if (!btn) return;
    e.preventDefault();
    interceptTx(btn.dataset.regret);
    const active = document.querySelector('.nav-item.active');
    const page = active ? active.dataset.page : 'home';
    if (page === 'alerts') renderAlerts(); else if (page === 'quick') renderQuick(); else renderHome();
  });
  if (DEMO) {
    // 游客演示模式：隐藏悬浮记账按钮（只读），并把「退出」改为「登录」
    const fabEl = document.getElementById('fab');
    if (fabEl) fabEl.style.display = 'none';
    const loginBtn = document.getElementById('logoutBtn');
    if (loginBtn) {
      loginBtn.textContent = '登录';
      loginBtn.classList.remove('logout-btn');
      loginBtn.addEventListener('click', () => { location.href = 'login.html#register'; });
    }
  } else {
    document.getElementById('fab').addEventListener('click', openTxModal);
    document.getElementById('logoutBtn').addEventListener('click', () => { localStorage.removeItem('cw_session'); location.href = 'login.html'; });
  }

  /* ---------------- 图表自适应 ---------------- */
  window.addEventListener('resize', () => activeCharts.forEach(c => c && c.resize && c.resize()));

  /* ---------------- 语音极速记账 ---------------- */
  const voiceModal = document.getElementById('voiceModal');
  let voiceResult = null;
  function openVoiceModal() {
    voiceResult = null;
    document.getElementById('voiceTranscript').style.display = 'none';
    document.getElementById('voiceParsed').style.display = 'none';
    document.getElementById('voiceConfirm').style.display = 'none';
    document.getElementById('voiceErr').textContent = '';
    document.getElementById('voiceStatus').textContent = '点击麦克风开始（需 Chrome/Edge 且联网）';
    document.getElementById('micBtn').classList.remove('listening');
    document.getElementById('voiceManual').value = '';
    voiceModal.classList.add('show');
  }
  function closeVoiceModal() { voiceModal.classList.remove('show'); }
  function parseVoice(text) {
    text = String(text).trim();
    if (!text) return null;
    const res = { raw: text, type: 'expense', amount: 0, category: null, date: new Date().toISOString().slice(0, 10), note: '' };
    const unitM = text.match(/(\d+(?:\.\d+)?)\s*(块|元|块钱|圆)/);
    if (unitM) res.amount = parseFloat(unitM[1]);
    else { const anyM = text.match(/(\d+(?:\.\d+)?)/); if (anyM) res.amount = parseFloat(anyM[1]); }
    if (/(收入|工资|发工资|到账|赚|进账|收款|报销)/.test(text)) res.type = 'income';
    const now = new Date();
    if (/(昨天|昨日)/.test(text)) { const d = new Date(now); d.setDate(d.getDate() - 1); res.date = d.toISOString().slice(0, 10); }
    else if (/(前天)/.test(text)) { const d = new Date(now); d.setDate(d.getDate() - 2); res.date = d.toISOString().slice(0, 10); }
    else if (/(明天|明日)/.test(text)) { const d = new Date(now); d.setDate(d.getDate() + 1); res.date = d.toISOString().slice(0, 10); }
    res.category = predictCategory(text) || (res.type === 'income' ? 'salary' : 'other_e');
    let note = text
      .replace(/(\d+(?:\.\d+)?)\s*(块|元|块钱|圆|RMB|￥)?/g, ' ')
      .replace(/(今天|昨天|昨日|前天|明天|明日|花了|花费|消费|支出|收入|工资|发工资|到账|赚|进账|收款|报销|餐饮|吃饭|午餐|晚餐|早餐|夜宵|打车|外卖|买)/g, ' ')
      .replace(/\s+/g, ' ').trim();
    res.note = note;
    return res;
  }
  function showVoiceParsed(r) {
    document.getElementById('voiceParsed').style.display = 'grid';
    document.getElementById('voiceConfirm').style.display = 'block';
    document.getElementById('voiceParsed').innerHTML = `
      <div class="vp"><div class="k">类型</div><div class="v">${r.type === 'income' ? '收入' : '支出'}</div></div>
      <div class="vp"><div class="k">金额</div><div class="v">${fmt(r.amount)}</div></div>
      <div class="vp"><div class="k">分类</div><div class="v">${catName(r.category)}</div></div>
      <div class="vp"><div class="k">日期 / 备注</div><div class="v">${r.date}<br/><span style="font-size:13px;color:var(--text-2)">${esc(r.note || '—')}</span></div></div>`;
  }
  function startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const status = document.getElementById('voiceStatus');
    const btn = document.getElementById('micBtn');
    if (!SR) {
      status.textContent = '当前浏览器不支持语音，请用下方手动输入。';
      document.getElementById('voiceErr').textContent = '语音识别需 Chrome/Edge，并经由 https 或 localhost 访问。';
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN'; rec.interimResults = false; rec.maxAlternatives = 1;
    btn.classList.add('listening'); status.textContent = '正在聆听…请说话';
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      btn.classList.remove('listening'); status.textContent = '识别完成';
      document.getElementById('voiceTranscript').style.display = 'block';
      document.getElementById('voiceTranscript').innerHTML = `你说：<b>${esc(text)}</b>`;
      const r = parseVoice(text);
      if (!r || !r.amount) { document.getElementById('voiceErr').textContent = '未识别到金额，请重说或手动输入（如：今天午餐花了18块）。'; return; }
      voiceResult = r; showVoiceParsed(r);
    };
    rec.onerror = (e) => { btn.classList.remove('listening'); status.textContent = '识别失败：' + (e.error || '未知错误'); document.getElementById('voiceErr').textContent = '可改用下方手动输入文字识别。'; };
    rec.onend = () => btn.classList.remove('listening');
    try { rec.start(); } catch (err) { btn.classList.remove('listening'); status.textContent = '无法启动麦克风'; }
  }

  /* ---------------- 小票 / 截图 识别记账 ---------------- */

  // 判断一段文字是否「像商家名」：避免把小票里的数量/单价/金额残留行（如 "2.000 3.50/3.30 6.60"）
  // 误填进「备注/商家」字段。真实店名通常是几个汉字（沃尔玛超市、蜜雪冰城），不会含价格行特征。
  function isPlausibleMerchant(s) {
    if (!s) return false;
    const t = String(s).trim();
    if (t.length < 2 || t.length > 24) return false;
    if (/\d\.\d{3}/.test(t)) return false;                 // 千分位/数量式小数：2.000
    if ((t.match(/\d+\.\d+/g) || []).length >= 2) return false; // 两个及以上金额小数（单价+金额）
    if (/\/\s*\d/.test(t)) return false;                   // 价格分隔符：3.50/3.30
    if (/[a-zA-Z],\s*\d/.test(t)) return false;            // a,a0 类噪声
    if (!/[\u4e00-\u9fff]/.test(t)) return false;          // 至少含一个汉字
    return true;
  }

  const receiptModal = document.getElementById('receiptModal');
  function openReceiptModal() {
    document.getElementById('receiptPreview').style.display = 'none';
    document.getElementById('receiptFields').style.display = 'none';
    document.getElementById('receiptImg').src = '';
    document.getElementById('receiptRecog').textContent = '';
    receiptModal.classList.add('show');
  }
  function closeReceiptModal() { receiptModal.classList.remove('show'); }
  function handleReceiptFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      document.getElementById('receiptImg').src = dataUrl;
      document.getElementById('receiptPreview').style.display = 'block';

      const recog = document.getElementById('receiptRecog');
      const fields = document.getElementById('receiptFields');
      const amtInput = document.getElementById('rcAmount');
      const noteInput = document.getElementById('rcNote');
      const dateInput = document.getElementById('rcDate');
      const catSel = document.getElementById('rcCategory');

      // 先摆出表单，识别结果再回填；识别失败用户也能直接手填，不卡流程
      fields.style.display = 'block';
      fillCatSelect(catSel, 'expense');
      if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
      amtInput.value = '';
      noteInput.value = '';

      // 回填识别结果；cands 为其它候选金额，供用户一键改选
      const applyResult = (r, sourceLabel) => {
        // 只把「像商家名」的文本回填到备注；价格/数量残留一律不填，避免脏数据
        const shop = (r.merchant && isPlausibleMerchant(r.merchant)) ? r.merchant : '';
        if (r.amount) amtInput.value = r.amount;
        if (shop) noteInput.value = shop;
        if (r.date) dateInput.value = r.date;
        if (r.category) catSel.value = r.category;

        const cands = (r.amountCandidates || []).filter(v => v && String(v) !== String(r.amount));
        const candHtml = cands.length
          ? `<div class="rc-cand-row"><span class="rc-cand-tip">其它可能金额：</span>${cands.map(v => `<button type="button" class="rc-cand" data-amt="${v}">¥${v}</button>`).join('')}</div>`
          : '';
        const hasAmt = !!r.amount;
        recog.innerHTML = `
          <div class="rc-src">${sourceLabel}</div>
          ${hasAmt
            ? `✅ 识别到金额 <b>¥${r.amount}</b>${shop ? ` · 商家 <b>${esc(shop)}</b>` : ''}${r.category ? ` · 分类 <b>${catName(r.category)}</b>` : ''}`
            : `⚠️ 没能自动认出金额，请手动填写下方表单（可换一张更清晰的截图再试）`}
          ${candHtml}
          ${r.text ? `<details class="rc-raw"><summary>查看识别原文</summary><pre>${esc(r.text.slice(0, 1500))}</pre></details>` : ''}`;
        recog.querySelectorAll('.rc-cand').forEach(b => {
          b.addEventListener('click', () => { amtInput.value = b.dataset.amt; b.parentElement.querySelectorAll('.rc-cand').forEach(x => x.classList.remove('active')); b.classList.add('active'); });
        });
      };

      // ① 优先：后端 OCR（后端自带本地识别，无需密钥；若配了云端密钥则更准）
      recog.textContent = '🔍 正在发送到后端识别（图片仅在本地处理，不会离开本机）…';
      callBackendOcr(dataUrl).then(r => {
        const label = (r.source === 'local') ? '🖥️ 后端本地 OCR 识别' : '☁️ 云端 OCR 识别';
        applyResult({
          amount: r.amount, merchant: r.merchant, date: r.date, category: r.category,
          amountCandidates: r.amountCandidates || [], text: r.text || ''
        }, label);
      }).catch(err => {
        // 后端不可用（未启动 / 纯 file:// 打开）→ 自动降级浏览器内 OCR
        tryLocalOcr(err.message);
      });
      return;
    };

    // ② 浏览器内 OCR（Tesseract.js，无需后端/密钥）；③ 引擎不可用才让人手填
    function tryLocalOcr(cloudErrMsg) {
      const recog = document.getElementById('receiptRecog');
      if (!CONFIG.LOCAL_OCR || !window.LocalOCR) {
        recog.innerHTML = `⚠️ 未启用自动识别，请手动填写下方表单。${cloudErrMsg ? `<br/><span class="muted">云端 OCR 失败：${esc(cloudErrMsg)}</span>` : ''}`;
        return;
      }
      // file:// 下浏览器会拦截 Web Worker，OCR 必然失败，提前说明避免误判
      if (location.protocol === 'file:') {
        recog.innerHTML = `<div class="rc-src">⚠️ 当前是本地文件方式打开</div>
          浏览器内 OCR 需要通过 http 访问才能运行（安全策略限制 Web Worker）。<br/>
          请用项目里的 <b>启动.bat</b> 启动服务，再访问 <b>http://localhost:3000</b>。<br/>
          现在也可以直接在下方手动填写入账。`;
        return;
      }
      recog.innerHTML = `<div class="rc-src">${cloudErrMsg ? '☁️ 云端不可用 → 已切到 🧠 浏览器内 OCR' : '🧠 浏览器内 OCR（本地运行，图片不上传）'}</div>
        <div class="rc-progress"><i style="width:2%"></i></div>
        <div class="rc-progress-tip">正在加载本地识别引擎与中文模型（已内置，无需联网）…</div>`;
      const bar = recog.querySelector('.rc-progress i');
      const tip = recog.querySelector('.rc-progress-tip');

      LocalOCR.recognize(dataUrl, (p) => {
        if (bar) bar.style.width = Math.max(2, p) + '%';
        if (tip && p < 100) tip.textContent = `识别中… ${p}%`;
      }, (msg) => {
        if (tip) tip.textContent = msg;
      }).then(r => {
        if (r.engineFailed) {
          recog.innerHTML = `<div class="rc-src">🧠 浏览器内 OCR</div>
            ⚠️ OCR 引擎加载失败：${esc(r.error || '未知错误')}。
            <br/>请手动填写下方表单；若想让识别更准，可在后端 <code>server/.env</code> 配置腾讯云/百度 OCR 密钥。`;
          return;
        }
        if (!r.amount && !r.merchant) {
          recog.innerHTML = `<div class="rc-src">🧠 浏览器内 OCR</div>
            ⚠️ 这张图没能认出货单文字（可能太模糊/角度偏），请换一张清晰截图，或手动填写。
            ${r.text ? `<details class="rc-raw"><summary>查看识别原文</summary><pre>${esc(r.text.slice(0, 1500))}</pre></details>` : ''}`;
          return;
        }
        applyResult(r, `🧠 浏览器内 OCR 识别完成（${((r.elapsed || 0) / 1000).toFixed(1)}s）`);
      }).catch(err => {
        recog.innerHTML = `⚠️ 识别出错：${esc(err.message || '未知错误')}，请手动填写。`;
      });
    }

    reader.readAsDataURL(file);
  }

  /* ---------------- 账单导出 ---------------- */
  const exportModal = document.getElementById('exportModal');
  let exportRows = [];
  function openExportModal() {
    document.getElementById('expRange').value = 'month';
    document.getElementById('expCustomWrap').style.display = 'none';
    buildExport();
    exportModal.classList.add('show');
  }
  function closeExportModal() { exportModal.classList.remove('show'); }
  function exportDateRange() {
    const mode = document.getElementById('expRange').value;
    const now = new Date();
    let from, to;
    if (mode === 'month') { from = now.toISOString().slice(0, 7) + '-01'; to = now.toISOString().slice(0, 10); }
    else if (mode === 'year') { from = now.getFullYear() + '-01-01'; to = now.toISOString().slice(0, 10); }
    else if (mode === 'all') { from = '0000-01-01'; to = '9999-12-31'; }
    else { from = document.getElementById('expFrom').value || '0000-01-01'; to = document.getElementById('expTo').value || '9999-12-31'; }
    return { from, to };
  }
  function buildExport() {
    const { from, to } = exportDateRange();
    let rows = getTx().filter(t => t.date >= from && t.date <= to);
    rows.sort((a, b) => (a.date + a.createdAt) - (b.date + b.createdAt));
    exportRows = rows;
    const inc = rows.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const exp = rows.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    document.getElementById('expSummary').innerHTML = `
      <div class="es"><div class="k">笔数</div><div class="v">${rows.length}</div></div>
      <div class="es"><div class="k">收入</div><div class="v income">${fmt(inc)}</div></div>
      <div class="es"><div class="k">支出</div><div class="v expense">${fmt(exp)}</div></div>
      <div class="es"><div class="k">结余</div><div class="v ${inc - exp >= 0 ? 'income' : 'expense'}">${fmt(inc - exp)}</div></div>`;
    document.getElementById('expCount').textContent = rows.length;
    const head = ['日期', '类型', '分类', '金额', '备注', '标签'];
    const body = rows.map(t => {
      const cal = (t.type === 'expense' && t.category === 'food' && t.calories) ? ` 🔥${t.calories}千卡` : '';
      const tags = (t.tags || []).join('/');
      return [t.date, t.type === 'income' ? '收入' : '支出', catName(t.category), (t.type === 'income' ? '+' : '-') + t.amount, (t.note || '') + cal, tags];
    });
    const thead = document.querySelector('#expPreview thead');
    const tbody = document.querySelector('#expPreview tbody');
    thead.innerHTML = '<tr>' + head.map(h => `<th>${h}</th>`).join('') + '</tr>';
    tbody.innerHTML = body.length ? body.map(r => `<tr>${r.map(c => `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px">该范围内没有账单</td></tr>';
    document.getElementById('expErr').textContent = '';
  }
  function csvCell(v) { const s = String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function downloadCSV() {
    if (!exportRows.length) { document.getElementById('expErr').textContent = '没有可导出的账单'; return; }
    const head = ['日期', '类型', '分类', '金额', '备注', '标签'];
    const lines = [head.join(',')];
    exportRows.forEach(t => {
      const cal = (t.type === 'expense' && t.category === 'food' && t.calories) ? ` 🔥${t.calories}千卡` : '';
      const tags = (t.tags || []).join('/');
      const row = [t.date, t.type === 'income' ? '收入' : '支出', catName(t.category), (t.type === 'income' ? '+' : '-') + t.amount, (t.note || '') + cal, tags];
      lines.push(row.map(csvCell).join(','));
    });
    const csv = '﻿' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `SmartPig账单_${stamp}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('info', '✅ 导出成功', `已导出 ${exportRows.length} 笔账单为 CSV，可用 Excel 打开。`);
  }
  function copyExport() {
    if (!exportRows.length) { document.getElementById('expErr').textContent = '没有可复制的数据'; return; }
    const head = ['日期', '类型', '分类', '金额', '备注', '标签'];
    const lines = [head.join('\t')];
    exportRows.forEach(t => {
      const cal = (t.type === 'expense' && t.category === 'food' && t.calories) ? ` 🔥${t.calories}千卡` : '';
      const tags = (t.tags || []).join('/');
      lines.push([t.date, t.type === 'income' ? '收入' : '支出', catName(t.category), (t.type === 'income' ? '+' : '-') + t.amount, (t.note || '') + cal, tags].join('\t'));
    });
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('info', '已复制', '预览数据已复制到剪贴板')).catch(() => { document.getElementById('expErr').textContent = '复制失败，请手动选择复制'; });
    else document.getElementById('expErr').textContent = '当前环境不支持剪贴板，请直接导出 CSV。';
  }

  /* ---------------- 财务健康分 + AI 诊断 ---------------- */
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function monthlyAvg(type) {
    const tx = getTx(); const byM = {};
    tx.forEach(t => { if (t.type === type) { const m = monthKey(t.date); byM[m] = (byM[m] || 0) + t.amount; } });
    const vals = Object.values(byM);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  function computeHealth() {
    const tx = getTx(); const goals = getGoals(); const budgets = getBudgets();
    const expense = tx.filter(t => t.type === 'expense');
    const income = tx.filter(t => t.type === 'income');
    const incTotal = income.reduce((s, t) => s + t.amount, 0);
    const expTotal = expense.reduce((s, t) => s + t.amount, 0);
    const surplus = avgMonthlySurplus();
    // 1 收支均衡度
    let balance = 60;
    if (incTotal > 0) { const r = expTotal / incTotal; balance = r <= 0.85 ? Math.round(100 - Math.abs(r - 0.7) / 0.85 * 60) : Math.round(Math.max(0, 100 - (r - 0.85) * 120)); }
    balance = clamp(balance, 0, 100);
    // 2 预算执行力
    const budKeys = Object.keys(budgets);
    let budget = 60;
    if (budKeys.length) {
      let score = 0;
      budKeys.forEach(k => { const used = monthCategoryTotal(k); const b = budgets[k]; if (b > 0) { if (used <= b * 0.8) score += 100; else if (used <= b) score += Math.round(100 - (used - b) / b * 60); else score += Math.max(0, Math.round(40 - (used - b) / b * 80)); } });
      budget = Math.round(score / budKeys.length);
    }
    // 3 储蓄能力
    const avgInc = monthlyAvg('income');
    let save = avgInc > 0 ? clamp(Math.round(surplus / avgInc * 100 * 1.5), 0, 100) : (surplus > 0 ? 70 : 20);
    // 4 消费理性度
    const small = expense.filter(t => t.amount < 50).reduce((s, t) => s + t.amount, 0);
    const smallRatio = expTotal > 0 ? small / expTotal : 0;
    const byCat = {}; expense.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
    const top1 = Object.values(byCat).sort((a, b) => b - a)[0] || 0;
    const topRatio = expTotal > 0 ? top1 / expTotal : 0;
    let rational = clamp(100 - Math.round(smallRatio * 60) - Math.round(Math.max(0, topRatio - 0.3) * 80), 0, 100);
    // 5 应急储备能力
    const emergency = goals.find(g => /应急|备用|备用金|紧急/.test(g.name)) || goals[0];
    let reserve = 0;
    if (emergency && emergency.target > 0) reserve = clamp(Math.round(emergency.saved / emergency.target * 100), 0, 100);
    else { const mExpAvg = monthlyAvg('expense') || 1; const savedTotal = goals.reduce((s, g) => s + g.saved, 0); reserve = clamp(Math.round(savedTotal / mExpAvg / 6 * 100), 0, 100); }
    const dims = { balance, budget, save, rational, reserve };
    const total = Math.round((balance + budget + save + rational + reserve) / 5);
    return { dims, total, report: healthReport(dims, { incTotal, expTotal, surplus, smallRatio, topRatio, emergency }) };
  }
  function healthReport(d, ctx) {
    const names = { balance: '收支均衡度', budget: '预算执行力', save: '储蓄能力', rational: '消费理性度', reserve: '应急储备能力' };
    const weak = Object.entries(d).sort((a, b) => a[1] - b[1]);
    const items = [];
    weak.forEach(([k, v]) => {
      if (v >= 80) return;
      let ico = '💡', title = '', body = '';
      if (k === 'balance') { ico = '⚖️'; title = `收支均衡度偏弱（${v}分）`; body = ctx.expTotal > ctx.incTotal ? '本月支出已超过收入，建议压缩非必要支出或增加收入来源。' : '收入与支出比例可进一步优化，建议把结余稳定在收入的 20%~30%。'; }
      if (k === 'budget') { ico = '🎯'; title = `预算执行力待提升（${v}分）`; body = '部分分类已接近或超出月度预算，建议为高频支出类别设置预算，并在超 80% 时预警。'; }
      if (k === 'save') { ico = '🐖'; title = `储蓄能力偏弱（${v}分）`; body = ctx.surplus <= 0 ? '当前月均结余为负，建议"先储蓄后消费"，工资到账先转 30% 进目标。' : `月均结余 ${fmt(ctx.surplus)}，可进一步提高储蓄率至收入的 30%。`; }
      if (k === 'rational') { ico = '🧠'; title = `消费理性度待优化（${v}分）`; body = ctx.topRatio > 0.3 ? `支出过度集中于单一类别（占比 ${Math.round(ctx.topRatio * 100)}%），建议分散并控制大额冲动消费。` : `小额高频支出占比 ${Math.round(ctx.smallRatio * 100)}%，注意"拿铁因子"，每周复盘一次。`; }
      if (k === 'reserve') { ico = '🛡️'; title = `应急储备不足（${v}分）`; body = '建议建立覆盖 3~6 个月支出的应急备用金，优先存入「应急备用金」目标。'; }
      items.push({ ico, title, body });
    });
    if (!items.length) items.push({ ico: '🎉', title: '财务状况优秀', body: '五个维度均表现良好，继续保持良好的记账与储蓄习惯即可。' });
    return items;
  }
  function renderHealth() {
    disposeCharts();
    const h = computeHealth();
    const dims = h.dims;
    const ringColor = h.total >= 80 ? '#2f9e44' : h.total >= 60 ? '#f08c00' : '#e03131';
    const grade = h.total >= 85 ? '优秀' : h.total >= 70 ? '良好' : h.total >= 55 ? '中等' : '需改善';
    pageEl.innerHTML = `
      <div class="page-head"><div><h3>财务健康分</h3><p>综合 5 大维度为你打分，并给出 AI 诊断报告。</p></div></div>
      <div class="health-hero">
        <div class="health-ring">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="60" fill="none" stroke="var(--surface-2)" stroke-width="12"></circle>
            <circle cx="70" cy="70" r="60" fill="none" stroke="${ringColor}" stroke-width="12" stroke-linecap="round"
              stroke-dasharray="${2 * Math.PI * 60}" stroke-dashoffset="${2 * Math.PI * 60 * (1 - h.total / 100)}"></circle>
          </svg>
          <div class="hr-num"><b>${h.total}</b><span>综合分</span></div>
        </div>
        <div class="health-meta">
          <div class="grade">${grade}</div>
          <h3>你的财务健康评分</h3>
          <p class="muted" style="font-size:13.5px;margin:4px 0 0">分数越高代表收支结构越稳健、抗风险能力越强。满分 100。</p>
        </div>
      </div>
      <div class="health-dims">
        ${[['balance', '收支均衡度', dims.balance], ['budget', '预算执行力', dims.budget], ['save', '储蓄能力', dims.save], ['rational', '消费理性度', dims.rational], ['reserve', '应急储备能力', dims.reserve]].map(([k, n, v]) => {
          const col = v >= 80 ? '#2f9e44' : v >= 60 ? '#f08c00' : '#e03131';
          return `<div class="dim-card"><div class="dn">${n}</div><div class="dv" style="color:${col}">${v}</div><div class="dbar"><i style="width:${v}%;background:${col}"></i></div></div>`;
        }).join('')}
      </div>
      <div class="report-card" style="margin-top:18px">
        <h4><img class="brand-inline" src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" /> AI 诊断报告</h4>
        ${h.report.map(r => `<div class="report-item"><div class="ri-ico">${r.ico}</div><div class="ri-body"><div class="rt">${r.title}</div><div class="rb">${r.body}</div></div></div>`).join('')}
      </div>
      <div class="panel" style="margin-top:18px">
        <h4>📡 五维能力雷达图</h4>
        <div class="chart" id="chartHealth" style="height:340px"></div>
      </div>`;
    if (typeof echarts === 'undefined') { const el = document.getElementById('chartHealth'); if (el) el.innerHTML = '<div class="chart-fallback">📡 图表组件需联网加载 ECharts</div>'; return; }
    const c = echarts.init(document.getElementById('chartHealth'));
    c.setOption({
      tooltip: {}, radar: { indicator: [{ name: '收支均衡度', max: 100 }, { name: '预算执行力', max: 100 }, { name: '储蓄能力', max: 100 }, { name: '消费理性度', max: 100 }, { name: '应急储备能力', max: 100 }], radius: '68%' },
      series: [{ type: 'radar', data: [{ value: [dims.balance, dims.budget, dims.save, dims.rational, dims.reserve], areaStyle: { opacity: 0.25 }, lineStyle: { color: '#23B883', width: 2 }, itemStyle: { color: '#23B883' }, label: { show: true, formatter: p => (typeof p.value === 'number' ? p.value : '') } }] }]
    });
    activeCharts.push(c);
  }

  /* ---------------- 新功能弹窗事件绑定 ---------------- */
  document.getElementById('voiceClose').addEventListener('click', closeVoiceModal);
  voiceModal.addEventListener('click', e => { if (e.target === voiceModal) closeVoiceModal(); });
  document.getElementById('micBtn').addEventListener('click', startVoice);
  document.getElementById('voiceManualBtn').addEventListener('click', () => {
    const t = document.getElementById('voiceManual').value.trim();
    if (!t) { document.getElementById('voiceErr').textContent = '请输入一句话'; return; }
    document.getElementById('voiceTranscript').style.display = 'block';
    document.getElementById('voiceTranscript').innerHTML = `输入：<b>${esc(t)}</b>`;
    const r = parseVoice(t);
    if (!r || !r.amount) { document.getElementById('voiceErr').textContent = '未识别到金额，请换个说法（如：今天午餐花了18块餐饮）。'; return; }
    voiceResult = r; showVoiceParsed(r);
  });
  document.getElementById('voiceConfirm').addEventListener('click', () => {
    if (!voiceResult || !voiceResult.amount) { document.getElementById('voiceErr').textContent = '请先识别'; return; }
    const r = voiceResult;
    addTx({ type: r.type, amount: r.amount, category: r.category, date: r.date, note: r.note }, {
      onSaved: () => {
        closeVoiceModal();
        toast('info', '✅ 已入账', `语音记账成功：${catName(r.category)} ${fmt(r.amount)}`);
        navigate('home');
      }
    });
  });

  document.getElementById('receiptClose').addEventListener('click', closeReceiptModal);
  receiptModal.addEventListener('click', e => { if (e.target === receiptModal) closeReceiptModal(); });
  document.getElementById('receiptPick').addEventListener('click', () => document.getElementById('receiptFile').click());
  document.getElementById('receiptFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; handleReceiptFile(f); });
  document.getElementById('rcConfirm').addEventListener('click', () => {
    const amt = parseFloat(document.getElementById('rcAmount').value);
    if (!amt || amt <= 0) { document.getElementById('receiptRecog').textContent = '请输入有效金额'; return; }
    addTx({ type: 'expense', amount: amt, category: document.getElementById('rcCategory').value, date: document.getElementById('rcDate').value, note: document.getElementById('rcNote').value.trim() }, {
      onSaved: () => {
        closeReceiptModal();
        toast('info', '✅ 已入账', '小票识别记账成功');
        navigate('home');
      }
    });
  });

  document.getElementById('exportClose').addEventListener('click', closeExportModal);
  exportModal.addEventListener('click', e => { if (e.target === exportModal) closeExportModal(); });
  document.getElementById('expRange').addEventListener('change', e => { document.getElementById('expCustomWrap').style.display = e.target.value === 'custom' ? 'flex' : 'none'; buildExport(); });
  document.getElementById('expFrom').addEventListener('change', buildExport);
  document.getElementById('expTo').addEventListener('change', buildExport);
  document.getElementById('expDownload').addEventListener('click', downloadCSV);
  document.getElementById('expCopy').addEventListener('click', copyExport);

  /* ---------------- 冷静区页面 ---------------- */
  function renderAlerts() {
    const all = computeAlerts();
    const active = all.filter(a => !a.reviewed);
    const sevLabel = { high: '🚨 紧急', medium: '⚠️ 提醒', low: '💡 留意' };
    const sevOrder = { high: 0, medium: 1, low: 2 };
    const sorted = active.slice().sort((a, b) => (sevOrder[a.sev] - sevOrder[b.sev]) || (b.ts || '').localeCompare(a.ts || ''));
    // 冲动账本：被"后悔药"拦截的消费（本地月份，避免 toISOString 在 GMT+8 跨月偏移）
    const ymLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const currentMonth = ymLocal(new Date());
    const intercepted = getTx().filter(t => t.intercepted)
      .sort((a, b) => (b.interceptedAt || 0) - (a.interceptedAt || 0));
    const monthIntercepted = intercepted.filter(t => {
      const m = t.interceptedAt ? ymLocal(new Date(t.interceptedAt)) : (t.date || '').slice(0, 7);
      return m === currentMonth;
    });
    const rl = riskLogSummary(7);
    const fraudTips = [
      '🏦 银行/官方<b>绝不会</b>索要短信验证码、密码或要求你转账到"安全账户"。',
      '📱 陌生链接、二维码<b>不点不扫</b>；"退款""理赔"要先付款的一律是诈骗。',
      '💳 开启交易提醒，<b>单笔/单日限额</b>调低，可大幅降低盗刷损失。',
      '🔍 看到大额/重复扣款，先到官方 App 核对账单，再决定是否确认。'
    ];
    pageEl.innerHTML = `
      <div class="page-head"><div><h3>🧊 冷静区</h3><p>这里是你的消费冷静区，实时扫描异常与风险，仿银行级防诈骗提醒。每笔可疑支出都请冷静确认是否为本人操作。</p></div></div>

      <div class="fraud-card">
        <div class="fc-head">🛡️ 防诈骗小贴士 · 守住钱袋子</div>
        <ul class="fc-list">${fraudTips.map(t => `<li>${t}</li>`).join('')}</ul>
      </div>

      <div class="panel impulse-book" style="margin-top:18px">
        <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h4 style="margin:0">🙅 冲动账本（已拦截）</h4>
          <span class="impulse-stat">本月成功拦截 <b>${monthIntercepted.length}</b> 笔冲动消费 · 省下 ${fmt(monthIntercepted.reduce((s, t) => s + t.amount, 0))}</span>
        </div>
        ${monthIntercepted.length
          ? `<div class="list">${monthIntercepted.slice(0, 12).map(t => rowItem(t)).join('')}</div>`
          : `<div class="impulse-empty">本月还没有拦截记录。在「消费足迹」里对某笔冲动点一下 <b>🙅 后悔了</b>，它就会被收进这里——不会删除，只是标记为「已拦截」。</div>`}
      </div>

      <div class="panel" style="margin-top:18px">
        <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h4 style="margin:0">🛡️ 风险拦截记录（近 7 天）</h4>
          <span class="impulse-stat">拦下 <b>${rl.blockedN}</b> 笔 · 少花 ${fmt(rl.saved)}</span>
        </div>
        ${rl.recent.length
          ? `<div class="rl-list">${rl.recent.slice(-8).reverse().map(x => `
              <div class="rl-row">
                <span class="rl-tags">${(x.keys || []).map(k => `<i>${RISK_KEY_LABEL[k] || k}</i>`).join('')}</span>
                <span class="rl-main">${esc(catName(x.category))} <b>${fmt(x.amount)}</b>${x.note ? ' · ' + esc(x.note) : ''}</span>
                <span class="rl-act is-${x.action}">${RISK_ACTION_LABEL[x.action] || x.action}</span>
              </div>`).join('')}</div>`
          : `<div class="impulse-empty">近 7 天没有命中风险规则。记账时会自动扫描「异常大额 / 深夜消费 / 奶茶刺客 / 预算透支 / 校园贷」，命中即弹窗提醒。</div>`}
      </div>

      ${sorted.length ? `
      <div class="panel" style="margin-top:18px">
        <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h4 style="margin:0">⚠️ 待确认预警（${sorted.length}）</h4>
          <button class="btn btn-ghost btn-sm" id="alertReviewAll">全部标记为已知</button>
        </div>
        <div class="alert-list">
          ${sorted.map(a => `
            <div class="alert-item sev-${a.sev}">
              <div class="ai-ico">${a.ico}</div>
              <div class="ai-body">
                <div class="ai-row"><span class="sev-badge sev-${a.sev}">${sevLabel[a.sev]}</span><b>${esc(a.title)}</b>${a.fraud ? '<span class="fraud-tag">疑似风险</span>' : ''}</div>
                <div class="ai-desc">${a.desc}</div>
                <div class="ai-time">📅 ${esc(a.ts || '')} · 交易 ID ${esc((a.txId || a.id).slice(-6))}</div>
              </div>
              <div class="ai-actions">
                <button class="btn btn-ghost btn-sm" data-review="${esc(a.id)}">确认/忽略</button>
              </div>
            </div>`).join('')}
        </div>
      </div>` : `
      <div class="panel" style="margin-top:18px;text-align:center;padding:38px 18px">
        <div style="font-size:40px">✅</div>
        <h4 style="margin:10px 0 4px">太棒了，暂无待确认预警</h4>
        <p class="muted" style="margin:0">我们会持续监控你的每一笔消费，发现异常会第一时间在这里和首页提醒你。</p>
      </div>`}`;

    const bind = () => {
      const allBtn = document.getElementById('alertReviewAll');
      if (allBtn) allBtn.addEventListener('click', () => { active.forEach(a => reviewAlert(a.id, 1)); renderAlerts(); toast('info', '已确认', '全部预警标记为已知'); });
      pageEl.querySelectorAll('[data-review]').forEach(b => b.addEventListener('click', () => {
        const id = b.dataset.review; const a = all.find(x => x.id === id);
        reviewAlert(id, 1); renderAlerts();
      }));
    };
    bind();
    refreshAlertBadge();
  }

  /* ---------------- 游客演示横幅 ---------------- */
  /* ---------------- 游客演示：自动巡演（投屏/录屏友好） ---------------- */
  let demoTourTimer = null;
  let demoTourIdx = 0;
  const DEMO_TOUR_PAGES = ['home', 'quick', 'manage', 'goals', 'ai', 'health', 'alerts'];
  const DEMO_TOUR_LABELS = { home: '首页', quick: '一笔入魂', manage: '钱去哪了', goals: '小目标', ai: '消费教练', health: '财务免疫力', alerts: '冷静区' };
  function stopDemoTour(btn) {
    if (demoTourTimer) { clearInterval(demoTourTimer); demoTourTimer = null; }
    if (btn) btn.textContent = '▶ 自动巡演';
  }
  function toggleDemoTour(btn) {
    if (demoTourTimer) { stopDemoTour(btn); return; }
    btn.textContent = '⏸ 停止巡演';
    const step = () => {
      const idx = demoTourIdx % DEMO_TOUR_PAGES.length;
      const p = DEMO_TOUR_PAGES[idx];
      const el = document.querySelector('.nav-item[data-page="' + p + '"]');
      if (el) el.click();
      const tp = document.getElementById('tourProgress');
      if (tp) tp.textContent = '路演中 ' + (idx + 1) + '/' + DEMO_TOUR_PAGES.length + ' · ' + (DEMO_TOUR_LABELS[p] || p);
      demoTourIdx++;
    };
    step();
    demoTourTimer = setInterval(step, 4500);
  }

  function showDemoBanner(roadshow) {
    if (document.getElementById('demoBanner')) return;
    const bar = document.createElement('div');
    bar.id = 'demoBanner';
    bar.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;'
      + 'padding:9px 16px;background:linear-gradient(90deg,#16c08a,#0ea5e9);color:#fff;font-size:13.5px;'
      + 'line-height:1.4;box-shadow:0 2px 10px rgba(0,0,0,.14);z-index:9999;';
    const extra = roadshow
      ? '<a id="tourBack" href="highlight.html" style="color:#063;background:rgba(255,255,255,.92);'
        + 'padding:4px 12px;border-radius:999px;text-decoration:none;font-weight:700;">← 返回亮点页</a>'
        + '<span id="tourProgress" style="color:#063;background:rgba(255,255,255,.92);'
        + 'padding:4px 12px;border-radius:999px;font-weight:700;">路演中 1/' + DEMO_TOUR_PAGES.length + '</span>'
      : '';
    bar.innerHTML = '<span>🌟 <b>游客演示模式</b>：当前浏览的是示例数据（只读）。</span>'
      + '<a id="demoLogin" href="login.html#register" style="color:#063;background:rgba(255,255,255,.92);'
      + 'padding:4px 12px;border-radius:999px;text-decoration:none;font-weight:700;">登录 / 注册，记录你自己的账本 →</a>'
      + extra
      + '<button id="demoTour" type="button" style="color:#063;background:rgba(255,255,255,.92);border:0;'
      + 'padding:4px 12px;border-radius:999px;font-weight:700;cursor:pointer;">▶ 自动巡演</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    const tourBtn = document.getElementById('demoTour');
    if (tourBtn) tourBtn.addEventListener('click', () => toggleDemoTour(tourBtn));
  }

  /* ---------------- 初始化 ---------------- */
  async function boot() {
    document.getElementById('userName').textContent = session.name || '用户';
    document.getElementById('userEmail').textContent = session.email || '';
    document.getElementById('avatar').textContent = (session.name || 'U').slice(0, 1).toUpperCase();

    // 游客演示模式：顶部横幅提示 + 一键登录入口
    // roadshow = 从亮点页带 ?tour=1 进入（自动巡演 + 返回亮点页 + 进度提示）
    const roadshow = DEMO && /[?&]tour=1\b/.test(location.search);
    if (DEMO) showDemoBanner(roadshow);

    // 先探测后端能力（决定 AI / 小票走真实服务还是本地引擎）
    await detectBackend();

    // 云端模式：登录后先从服务器拉取整表（按账号隔离），失败则降级本地
    if (window.Auth && Auth.isCloud() && window.Sync) {
      const ok = await Sync.pullAll();
      if (!ok) toast('warn', '⚠️ 云端同步失败', '将以本地缓存展示，请检查网络或重新登录');
    }
    seedIfEmpty();
    autoGenerateMonthlyReport();   // 跨月自动生成并存档月度报告（首页横幅会提示）
    refreshAlertBadge();
    navigate('home');

    // 一键路演：从亮点页带 ?tour=1 进入时，自动启动巡演（仅游客演示态生效）
    if (roadshow) {
      // 若画廊「体验此功能」带了 #视图 锚点，先跳到对应视图再继续巡演
      const h = (location.hash || '').replace('#', '');
      const hi = h ? DEMO_TOUR_PAGES.indexOf(h) : -1;
      if (hi >= 0) {
        demoTourIdx = hi;
        const el = document.querySelector('.nav-item[data-page="' + h + '"]');
        if (el) setTimeout(() => el.click(), 400);
      }
      setTimeout(() => {
        const tb = document.getElementById('demoTour');
        if (tb) toggleDemoTour(tb);
      }, 700);
    }

    // 启动后给一条通道状态提示，让用户清楚「到底连上了没有」
    setTimeout(() => {
      if (BACKEND.online && BACKEND.llmReady) {
        toast('info', 'SmartPig AI 已连接', `${BACKEND.llmLabel} 在线，消费教练问答将使用真实大模型`);
      } else if (BACKEND.online) {
        toast('warn', '💡 AI 未接大模型', '后端已就绪，只差在 server/.env 填模型 Key；当前用本地智能体');
      }
    }, 800);
  }
  boot();

  /* ---------------- AI 预算规划：先把金额算死，再问一句「执行吗」 ---------------- */
  // 原则：数字全部由代码算（模型只负责说话），每个方案都带按钮，点一下才真正写库
  const BP_RATIO = [
    ['food', 0.32], ['home', 0.18], ['transport', 0.08], ['shopping', 0.10],
    ['fun', 0.06], ['edu', 0.05], ['medical', 0.03], ['other_e', 0.03]
  ];
  const BP_SAVE_RATE = 0.15;      // 先存后花：固定 15% 不进预算池
  const BP_PLANS = {};            // 方案暂存：卡片按钮通过 id 取回
  const BP_DONE = {};             // 已处理过的方案（id → 状态文案），重渲染后仍显示「已执行」
  const BP_STATE = {};            // 每个对话入口各自的「待确认方案 / 等收入」
  let BP_SEQ = 0;

  const bpMoney = (n) => '¥' + Math.round(Number(n) || 0).toLocaleString('zh-CN');

  // 预算要「好记」，不该出现 637.42 这种数字
  function bpRound(v) {
    if (v >= 2000) return Math.round(v / 100) * 100;
    if (v >= 500) return Math.round(v / 50) * 50;
    return Math.round(v / 10) * 10;
  }

  // 近 3 个月真实消费结构（少于 6 笔就不参考，免得被一两笔带跑）
  function bpHistoryShare() {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2);
    const from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const rows = getTx().filter(t => t.type === 'expense' && t.date && t.date >= from);
    if (rows.length < 6) return null;
    const byCat = {}; let total = 0;
    rows.forEach(t => { const a = Number(t.amount) || 0; byCat[t.category] = (byCat[t.category] || 0) + a; total += a; });
    if (total <= 0) return null;
    const share = {};
    Object.keys(byCat).forEach(k => { share[k] = byCat[k] / total; });
    return share;
  }

  // 收入 → 每个分类的具体金额（含储蓄建议）
  function budgetPlanFor(income) {
    income = Math.max(0, Math.round(Number(income) || 0));
    const hist = bpHistoryShare();
    const pool = income * (1 - BP_SAVE_RATE);   // 可分配池
    const base = 1 - BP_SAVE_RATE;
    const raw = BP_RATIO.map(([key, r]) => {
      const def = r / base;                     // 归一到 1
      const h = (hist && hist[key] != null) ? hist[key] : null;
      return { key: key, share: h == null ? def : def * 0.5 + h * 0.5 };
    });
    const sum = raw.reduce((s, x) => s + x.share, 0) || 1;
    const items = raw.map(x => {
      const m = catMeta('expense', x.key);
      return {
        key: x.key, name: m.name, emoji: m.emoji,
        share: x.share / sum,
        amount: Math.max(10, bpRound(pool * x.share / sum))
      };
    });
    // 取整尾差补给占比最大的分类，让合计正好等于可分配池
    const gap = Math.round(pool) - items.reduce((s, it) => s + it.amount, 0);
    if (gap) {
      const top = items.slice().sort((a, b) => b.amount - a.amount)[0];
      top.amount = Math.max(10, top.amount + gap);
    }
    const total = items.reduce((s, it) => s + it.amount, 0);
    return { income: income, items: items, total: total, save: Math.max(0, income - total), fromHistory: !!hist };
  }

  // 聊天里的方案卡片（明细 + 三个按钮）
  function budgetPlanHTML(plan) {
    const id = 'bp' + (++BP_SEQ);
    BP_PLANS[id] = plan;
    const rows = plan.items.map(it => {
      const pct = plan.income ? Math.round(it.amount / plan.income * 100) : 0;
      const w = Math.min(100, Math.round(pct * 2.2));
      return `<div class="bp-row" style="--w:${w}%">
          <span class="bp-ico">${it.emoji}</span>
          <span class="bp-nm">${esc(it.name)}</span>
          <b class="bp-amt">${bpMoney(it.amount)}</b>
          <span class="bp-pct">${pct}%</span>
        </div>`;
    }).join('');
    return `<div class="bp-card" data-plan="${id}">
        <div class="bp-head">
          <span class="bp-title">📊 月度分配方案</span>
          <span class="bp-income">月收入 ${bpMoney(plan.income)}</span>
        </div>
        <div class="bp-list">${rows}</div>
        <div class="bp-sum">
          <span>分类预算合计</span><b>${bpMoney(plan.total)}</b>
          <span class="bp-save-label">🪙 建议先存</span><b class="bp-save-num">${bpMoney(plan.save)}</b>
        </div>
        <div class="bp-tip">${plan.fromHistory
          ? '已按你最近 3 个月的真实消费结构微调，不是套模板。'
          : '按「先存 15%、再花 85%」分配，多记几笔账会更贴合你。'}设置后花超 80% 我会提醒你。</div>
        <div class="bp-acts">
          <button type="button" class="bp-btn bp-primary" data-bp="apply" data-plan="${id}">✅ 就按这个设置</button>
          <button type="button" class="bp-btn" data-bp="edit" data-plan="${id}">✏️ 我要微调</button>
          <button type="button" class="bp-btn bp-ghost" data-bp="drop" data-plan="${id}">先不用</button>
        </div>
      </div>`;
  }

  // 真正写入预算库（只有用户点了「执行」才会走到这里）
  function applyBudgetPlan(plan) {
    const obj = {};
    plan.items.forEach(it => { if (it.amount > 0) obj[it.key] = it.amount; });
    setBudgets(obj);
    try { localStorage.setItem('cw_budget_plan', JSON.stringify({ at: Date.now(), income: plan.income, items: obj })); } catch (_) {}
    return `<div class="bp-done">✅ 预算已设好 <b>${plan.items.length}</b> 个分类，合计 <b>${bpMoney(plan.total)}</b>，另有 <b>${bpMoney(plan.save)}</b> 建议直接存起来。</div>
      <div class="bp-done-sub">${plan.items.map(it => `${it.emoji}${esc(it.name)} ${bpMoney(it.amount)}`).join(' · ')}</div>
      <button type="button" class="bp-btn bp-primary bp-goto" data-bp="goto">去预算面板看看 →</button>`;
  }

  const BP_CN_NUM = { '一千': 1000, '两千': 2000, '二千': 2000, '三千': 3000, '四千': 4000, '五千': 5000, '六千': 6000, '七千': 7000, '八千': 8000, '九千': 9000, '一万': 10000, '两万': 20000, '三万': 30000 };

  // 从一句话里抠出月收入（2000 / 2k / 3千 / 1.5万 / 两千 都认）
  function bpExtractIncome(q) {
    const t = String(q || '').replace(/[,，\s]/g, '');
    for (const k in BP_CN_NUM) if (t.includes(k)) return BP_CN_NUM[k];
    let m;
    if ((m = t.match(/(\d+(?:\.\d+)?)([kK千万])/))) {
      return Math.round(parseFloat(m[1]) * (/[kK千]/.test(m[2]) ? 1000 : 10000));
    }
    if ((m = t.match(/(?:月?收入|月薪|工资|生活费|月入|到手|进账)(?:是|为|有|大概|大约|约|才|就)?(\d+(?:\.\d+)?)/))) return parseFloat(m[1]);
    if ((m = t.match(/^(\d+(?:\.\d+)?)(?:元|块)?$/))) return parseFloat(m[1]);
    if ((m = t.match(/(?:有|按|按照|一个月)(\d+(?:\.\d+)?)/))) return parseFloat(m[1]);
    return 0;
  }

  // 判断「在要预算方案」而不是「在查预算用得怎样」
  function bpIsAllocAsk(q) {
    const t = String(q || '').replace(/\s/g, '');
    if (/(分配|划分|怎么分|如何分|分一下|分一分|帮我分|规划一下|做个预算|制定预算|设置预算|设预算|定预算|各分类|各类|每个分类|类别预算|预算方案)/.test(t)) return true;
    if (/预算/.test(t) && /(帮我|给我|建议|安排|该|应该)/.test(t) && !/(还剩|剩余|超支|用了多少|执行|情况)/.test(t)) return true;
    return false;
  }
  function bpIsConfirm(q) {
    const t = String(q || '').replace(/[\s。.!！~～,，]/g, '');
    if (/(不|别|先不用|算了|取消|改|调|换)/.test(t) && !/^(好的?|嗯|可以|行|执行|确定|确认)/.test(t)) return false;
    return /^(好的?|好呀|好嘞|嗯+|可以|行|对的?|是的?|执行|确定|确认|就这(个|样)|按这个|照这个|没问题|ok|okay|中|安排)/i.test(t);
  }
  function bpIsDrop(q) {
    return /^(先不用|不用了|算了|不要|先不|取消|暂时不|别了|不了)/.test(String(q || '').replace(/[\s。.!！~～,，]/g, ''));
  }
  // 没给金额时，尽量猜一个：本月收入 → 历史月均收入
  function bpGuessIncome() {
    const curM = localDay().slice(0, 7);
    const tx = getTx();
    const inc = tx.filter(t => t.type === 'income' && monthKey(t.date) === curM)
      .reduce((s, t) => s + (Number(t.amount) || 0), 0);
    if (inc >= 100) return Math.round(inc);
    const byM = {};
    tx.filter(t => t.type === 'income' && t.date).forEach(t => {
      const m = monthKey(t.date); byM[m] = (byM[m] || 0) + (Number(t.amount) || 0);
    });
    const ms = Object.keys(byM).filter(m => byM[m] > 0);
    if (!ms.length) return 0;
    return Math.round(ms.reduce((s, m) => s + byM[m], 0) / ms.length);
  }

  // 每次提问前先过一遍：命中预算规划就直接给方案（不等模型、不跑偏）
  function budgetChatStep(q, state) {
    const t = String(q || '');
    const lead = (plan, extra) => `<div class="bp-lead">按 <b>${bpMoney(plan.income)}</b> ${extra || '算好了'}${plan.save > 0 ? `，先存 <b>${bpMoney(plan.save)}</b>` : ''}，剩下按下面分。要我直接帮你设上吗？</div>`;
    if (state.plan && bpIsDrop(t)) { state.plan = null; return '好，预算先不动。想设了随时喊我一声 🐷'; }
    if (state.plan && bpIsConfirm(t) && bpExtractIncome(t) < 100) {
      const plan = state.plan; state.plan = null;
      return applyBudgetPlan(plan);
    }
    if (state.awaitIncome) {
      const v = bpExtractIncome(t);
      if (v >= 100 && v <= 1000000) {
        state.awaitIncome = false;
        const plan = budgetPlanFor(v); state.plan = plan;
        return lead(plan) + budgetPlanHTML(plan);
      }
    }
    if (!bpIsAllocAsk(t)) return null;
    const inc = bpExtractIncome(t);
    if (inc >= 100 && inc <= 1000000) {
      const plan = budgetPlanFor(inc); state.plan = plan;
      return lead(plan) + budgetPlanHTML(plan);
    }
    const guess = bpGuessIncome();
    if (guess >= 100) {
      const plan = budgetPlanFor(guess); state.plan = plan;
      return lead(plan, `（本月收入）先算了一版`) + budgetPlanHTML(plan) +
        '<div class="bp-lead-sub">数字不对的话，直接说「按 3000 分」，我立刻重算。</div>';
    }
    state.awaitIncome = true;
    return '分配预算前得先知道你的月收入——直接说「我的收入是 2000，帮我分配」就行，我马上给你一份能一键执行的方案 🐷';
  }

  // 卡片按钮：执行 / 微调 / 跳过 / 去看预算
  function wireBudgetCard(root, say) {
    if (!root || root.dataset.bpWired) return;
    root.dataset.bpWired = '1';
    // 对话重渲染后（innerHTML 整段替换），已处理过的卡片仍要显示正确状态
    const refreshDoneMarks = () => {
      root.querySelectorAll('.bp-card').forEach(c => {
        const st = BP_DONE[c.dataset.plan];
        if (!st) return;
        const acts = c.querySelector('.bp-acts');
        if (acts) acts.innerHTML = '<span class="bp-mark">' + st + '</span>';
      });
    };
    root.__bpRefresh = refreshDoneMarks;
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bp]');
      if (!btn || !root.contains(btn)) return;
      const act = btn.dataset.bp;
      const pid = btn.dataset.plan;
      const plan = BP_PLANS[pid];
      const card = btn.closest('.bp-card');
      const acts = card ? card.querySelector('.bp-acts') : null;
      if (act === 'goto') {
        navigate('manage');
        const panel = document.getElementById('aiPanel');
        if (panel) panel.classList.remove('open');
        return;
      }
      if (act === 'edit' && plan) {
        if (acts) acts.innerHTML = '<span class="bp-mark">已在预算弹窗里打开，改完点保存就生效。</span>';
        openBudgetModal(planAmounts(plan));
        return;
      }
      if (act === 'drop') {
        BP_DONE[pid] = '已跳过，你的预算没有任何改动';
        if (acts) acts.innerHTML = '<span class="bp-mark">' + BP_DONE[pid] + '</span>';
        say && say('好，先不设。等你想清楚了随时找我 🐷');
        return;
      }
      if (act === 'apply' && plan) {
        BP_DONE[pid] = '✅ 已执行';
        if (acts) acts.innerHTML = '<span class="bp-mark">' + BP_DONE[pid] + '</span>';
        const html = applyBudgetPlan(plan);
        say && say(html);
        toast('success', '✅ 预算已设置', `${plan.items.length} 个分类，合计 ${bpMoney(plan.total)}`);
      }
    });
  }
  function planAmounts(plan) {
    const o = {};
    plan.items.forEach(it => { o[it.key] = it.amount; });
    return o;
  }

  /* =========================================================
     消费分析报表：一句话 → 详细报表卡 → 一键下载 / 一键看图表
     金额与结论全部由代码算（模型不参与），避免瞎编数字
     ========================================================= */
  const SR_STORE = {};           // 报表缓存：卡片按钮通过 id 取回
  const SR_DONE = {};            // 已下载状态（重渲染后仍保留）
  let SR_SEQ = 0;

  const srMoney = (n) => {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    return '¥' + (Number.isInteger(v)
      ? v.toLocaleString('zh-CN')
      : v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  };
  const srPct = (x) => Math.round((Number(x) || 0) * 100) + '%';
  const srNum = (n) => Math.round((Number(n) || 0) * 100) / 100;

  function srShiftMonth(mk, n) {
    const y = Number(mk.slice(0, 4));
    const m = Number(mk.slice(5, 7));
    const d = new Date(y, m - 1 + n, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function srMonthLabel(mk) {
    return Number(mk.slice(0, 4)) + ' 年 ' + Number(mk.slice(5, 7)) + ' 月';
  }
  function srDaysIn(mk) {
    return new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0).getDate();
  }
  function srDow(mk, day) {
    return new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, day).getDay();
  }

  // 是不是在「要一份消费报表 / 详细省钱分析」，而不是随口问一句怎么省钱
  function srIsAsk(q) {
    const t = String(q || '').replace(/\s/g, '');
    if (!t) return false;
    if (/(怎么|如何|能不能|可不可以).{0,8}(理财|基金|股票|投资|存钱)/.test(t)) return false;
    if (/(报表|月报|消费报告|消费分析|消费总结|消费画像|消费复盘|账单分析|花销分析|支出分析|月度总结|月度报告|财务体检|记账报告)/.test(t)) return true;
    if (/(分析|复盘|总结|梳理|整理).{0,8}(消费|花销|支出|账单)/.test(t)) return true;
    if (/(消费|花销|支出|账单).{0,8}(分析|复盘|总结|报表)/.test(t)) return true;
    if (/(省钱建议|省钱方案|省钱妙招|省钱办法|省钱清单)/.test(t) && /(详细|具体|一条条|列出来|给我|帮我|我的|来一)/.test(t)) return true;
    return false;
  }

  // 从提问里判断要看哪个月（默认上个月）
  function srPickMonth(q) {
    const t = String(q || '');
    const cur = localDay().slice(0, 7);
    let m = t.match(/(20\d{2})\s*[年\-\.\/]\s*(\d{1,2})(?!\d)/);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
      return m[1] + '-' + String(Number(m[2])).padStart(2, '0');
    }
    if (/前两个月|上上个月/.test(t)) return srShiftMonth(cur, -2);
    if (/上个?月|上一个月|上月/.test(t)) return srShiftMonth(cur, -1);
    if (/这个?月|本月|当月|这月/.test(t)) return cur;
    if ((m = t.match(/(\d{1,2})\s*月(?:份)?(?!\d)/))) {
      const mm = Number(m[1]);
      if (mm >= 1 && mm <= 12) {
        let y = Number(cur.slice(0, 4));
        if (mm > Number(cur.slice(5, 7))) y -= 1;
        return y + '-' + String(mm).padStart(2, '0');
      }
    }
    return srShiftMonth(cur, -1);
  }

  // 最近一个有记账记录的月份（用于目标月空白时兜底）
  function srLatestMonth() {
    const ms = [...new Set(getTx().filter(t => t && t.date).map(t => monthKey(t.date)))].sort();
    return ms.length ? ms[ms.length - 1] : null;
  }

  const SR_PERSONA_DESC = {
    '悦己钱': '让自己开心的小确幸（奶茶、外卖、聚餐）',
    '隐形损耗': '买完就忘的购物',
    '生存饭': '吃饱必需的饭钱',
    '快乐税': '娱乐消费',
    '投资自己': '学习 / 成长',
    '健康投资': '医疗 / 保健',
    '人情往来': '红包礼金',
    '通勤成本': '交通出行',
    '固定开销': '房租水电',
    '日常开销': '其他日常'
  };

  function buildSpendReport(mk) {
    const curMk = localDay().slice(0, 7);
    const daysIn = srDaysIn(mk);
    const isCur = mk === curMk;
    const elapsed = isCur ? Math.min(daysIn, new Date().getDate()) : daysIn;
    const all = getTx().filter(t => t && t.date && t.type && !t.intercepted);
    const rows = all.filter(t => monthKey(t.date) === mk);
    const exp = rows.filter(t => t.type === 'expense');
    const inc = rows.filter(t => t.type === 'income');
    const sum = (a) => a.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const expense = srNum(sum(exp));
    const income = srNum(sum(inc));
    const surplus = srNum(income - expense);
    const rate = income > 0 ? surplus / income : 0;
    const activeDays = new Set(exp.map(t => t.date)).size;
    const avgDay = srNum(expense / Math.max(1, elapsed));
    const prevMk = srShiftMonth(mk, -1);
    const prevExp = srNum(sum(all.filter(t => t.type === 'expense' && monthKey(t.date) === prevMk)));
    const delta = prevExp > 0 ? srNum(expense - prevExp) : 0;
    const deltaPct = prevExp > 0 ? (expense - prevExp) / prevExp : 0;

    // —— 分类结构 ——
    const map = {};
    exp.forEach(t => {
      const k = t.category || 'other_e';
      if (!map[k]) map[k] = { key: k, amount: 0, count: 0 };
      map[k].amount += Number(t.amount) || 0;
      map[k].count += 1;
    });
    const budgets = getBudgets();
    const cats = Object.keys(map).map(k => {
      const c = map[k];
      const meta = catMeta('expense', k);
      const prev = srNum(sum(all.filter(t => t.type === 'expense' && (t.category || 'other_e') === k && monthKey(t.date) === prevMk)));
      return {
        key: k, name: meta.name, emoji: meta.emoji,
        amount: srNum(c.amount), count: c.count,
        share: expense > 0 ? c.amount / expense : 0,
        avg: srNum(c.amount / c.count),
        prev: prev,
        deltaPct: prev > 0 ? (c.amount - prev) / prev : null,
        budget: Number(budgets[k]) || 0
      };
    }).sort((a, b) => b.amount - a.amount);

    const overBudgets = cats.filter(c => c.budget > 0 && c.amount > c.budget);
    const totalBudget = Object.keys(budgets).reduce((s, k) => s + (Number(budgets[k]) || 0), 0);

    // —— 最贵的几笔 ——
    const top = exp.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 6)
      .map(t => ({
        amount: srNum(t.amount), date: t.date,
        note: String(t.note || '').trim(),
        cat: catMeta('expense', t.category).name
      }));

    // —— 情绪账户 ——
    const pm = {};
    exp.forEach(t => { const p = spendPersona(t) || '日常开销'; pm[p] = (pm[p] || 0) + (Number(t.amount) || 0); });
    const personas = Object.keys(pm)
      .map(p => ({ name: p, amount: srNum(pm[p]), share: expense > 0 ? pm[p] / expense : 0 }))
      .sort((a, b) => b.amount - a.amount);

    // —— 小额高频 / 重复消费 ——
    const small = exp.filter(t => (Number(t.amount) || 0) <= 30);
    const smallSum = srNum(sum(small));
    const rep = {};
    exp.forEach(t => {
      const n = String(t.note || '').trim();
      if (!n || n.length > 12) return;
      if (!rep[n]) rep[n] = { note: n, count: 0, amount: 0, category: t.category };
      rep[n].count += 1;
      rep[n].amount += Number(t.amount) || 0;
    });
    const repeats = Object.keys(rep).map(k => rep[k]).filter(x => x.count >= 3)
      .map(x => ({ note: x.note, count: x.count, amount: srNum(x.amount), avg: srNum(x.amount / x.count), category: x.category }))
      .sort((a, b) => b.count - a.count || b.amount - a.amount).slice(0, 3);

    // —— 每日走势 / 工作日 vs 周末 ——
    const dd = (d) => mk + '-' + String(d).padStart(2, '0');
    const daily = [];
    for (let d = 1; d <= daysIn; d++) daily.push({ day: d, amount: srNum(sum(exp.filter(t => t.date === dd(d)))) });
    const peak = daily.slice().sort((a, b) => b.amount - a.amount)[0] || { day: 0, amount: 0 };
    let wAmt = 0, wN = 0, kAmt = 0, kN = 0;
    daily.forEach(x => {
      if ([0, 6].includes(srDow(mk, x.day))) { wAmt += x.amount; wN += 1; }
      else { kAmt += x.amount; kN += 1; }
    });

    const r = {
      mk: mk, label: srMonthLabel(mk), daysIn: daysIn, elapsed: elapsed, isCur: isCur,
      count: rows.length, expense: expense, income: income, surplus: surplus,
      rate: rate, activeDays: activeDays, avgDay: avgDay,
      prevMk: prevMk, prevExp: prevExp, delta: delta, deltaPct: deltaPct,
      cats: cats, top: top, personas: personas, daily: daily, peak: peak,
      weekendAvg: wN ? srNum(wAmt / wN) : 0,
      weekdayAvg: kN ? srNum(kAmt / kN) : 0,
      small: { count: small.length, sum: smallSum, share: expense > 0 ? smallSum / expense : 0 },
      repeats: repeats, overBudgets: overBudgets,
      budget: totalBudget > 0 ? { total: totalBudget, left: srNum(totalBudget - expense) } : null,
      note: '',
      generatedAt: new Date()
    };
    r.finds = srFinds(r);
    r.sugs = srSugs(r);
    return r;
  }

  function srFinds(r) {
    const out = [];
    const top = r.cats[0];
    if (top) {
      out.push({
        ico: top.emoji,
        t: '钱主要流向「' + esc(top.name) + '」：<b>' + srMoney(top.amount) + '</b>，占 <b>' + srPct(top.share) + '</b>' +
          (top.share >= 0.4 ? '（单一类目偏重，值得盯一下）' : '') + '。'
      });
    }
    if (r.prevExp > 0) {
      const up = r.delta > 0;
      out.push({
        ico: up ? '📈' : '📉',
        t: '比 ' + Number(r.prevMk.slice(5, 7)) + ' 月' + (up ? '多花' : '少花') + ' <b>' + srMoney(Math.abs(r.delta)) + '</b>（' +
          (up ? '+' : '-') + Math.abs(Math.round(r.deltaPct * 100)) + '%），' + (up ? '涨得有点快。' : '控制住了。')
      });
    } else {
      out.push({ ico: '🌱', t: '上个月没有可比的记账数据，这个月是第一个基准月。' });
    }
    if (r.top[0]) {
      const t0 = r.top[0];
      const times = r.avgDay > 0 ? (t0.amount / r.avgDay).toFixed(1) : '—';
      out.push({
        ico: '💥',
        t: '最大一笔 <b>' + srMoney(t0.amount) + '</b>（' + t0.date.slice(5) + ' ' + esc(t0.cat) +
          (t0.note ? ' · ' + esc(t0.note) : '') + '），是日均的 <b>' + times + '</b> 倍。'
      });
    }
    if (r.small.count >= 3) {
      out.push({
        ico: '🍬',
        t: '≤¥30 的小额消费 <b>' + r.small.count + '</b> 笔，合计 <b>' + srMoney(r.small.sum) +
          '</b>（占 ' + srPct(r.small.share) + '）—— 典型的「拿铁因子」。'
      });
    }
    if (r.repeats.length) {
      const x = r.repeats[0];
      out.push({
        ico: '🔁',
        t: '「' + esc(x.note) + '」重复 <b>' + x.count + '</b> 次，共 <b>' + srMoney(x.amount) +
          '</b>，平均每次 ' + srMoney(x.avg) + '。'
      });
    }
    if (r.weekendAvg > 0 && r.weekdayAvg > 0) {
      const hi = r.weekendAvg > r.weekdayAvg;
      const ratio = hi ? r.weekendAvg / r.weekdayAvg : r.weekdayAvg / r.weekendAvg;
      if (ratio >= 1.4) {
        out.push({
          ico: '🗓️',
          t: (hi ? '周末' : '工作日') + '日均 <b>' + srMoney(hi ? r.weekendAvg : r.weekdayAvg) + '</b>，是' +
            (hi ? '工作日' : '周末') + '的 <b>' + ratio.toFixed(1) + '</b> 倍。'
        });
      }
    }
    if (r.peak.amount > 0) {
      out.push({
        ico: '📅',
        t: '花得最猛的一天是 <b>' + Number(r.mk.slice(5, 7)) + ' 月 ' + r.peak.day + ' 日</b>，一天 <b>' +
          srMoney(r.peak.amount) + '</b>。'
      });
    }
    if (r.income > 0) {
      out.push({
        ico: r.rate >= 0.2 ? '🟢' : '🟡',
        t: '结余 <b>' + srMoney(r.surplus) + '</b>，结余率 <b>' + srPct(r.rate) + '</b>' +
          (r.rate >= 0.2 ? '，达到 20% 的健康线。' : '，还没到 20% 的健康线。')
      });
    } else {
      out.push({ ico: '🧾', t: '这个月没有记收入，结余率先空着 —— 先把支出结构看清。' });
    }
    return out;
  }

  function srSugs(r) {
    const out = [];
    const top = r.cats[0];
    if (top && top.amount >= 100) {
      const cut = Math.max(10, Math.round(top.amount * 0.15 / 10) * 10);
      out.push({
        ico: '✂️', save: cut, cat: top.key,
        t: '把「' + esc(top.name) + '」压 15%',
        d: '本月 ' + srMoney(top.amount) + '（' + srPct(top.share) + '，' + top.count + ' 笔，笔均 ' + srMoney(top.avg) +
          '）。把笔均往下压 15%，或者每周少点一次外卖，就够了。'
      });
    }
    if (r.small.count >= 3 && r.small.sum >= 50) {
      const cut = Math.max(10, Math.round(r.small.sum * 0.4 / 10) * 10);
      out.push({
        ico: '🍬', save: cut, cat: null,
        t: '掐掉四成「拿铁因子」',
        d: '≤¥30 的小额消费 ' + r.small.count + ' 笔、共 ' + srMoney(r.small.sum) +
          '。这类钱最没感觉：一周只给自己 2 次「随手买」额度，其余先丢冷静区。'
      });
    }
    if (r.repeats.length) {
      const x = r.repeats[0];
      const cut = Math.max(10, Math.round(x.avg * 4));
      out.push({
        ico: '🔁', save: cut, cat: x.category || null,
        t: '「' + esc(x.note) + '」一周少 1 次',
        d: '共 ' + x.count + ' 次、合计 ' + srMoney(x.amount) + '（平均每次 ' + srMoney(x.avg) +
          '）。一周少 1 次，一个月就省 ' + srMoney(cut) + '；换成自带水/食堂，效果一样。'
      });
    }
    if (r.income > 0) {
      const target = Math.round(r.income * 0.2);
      const gap = srNum(target - r.surplus);
      if (gap > 0) {
        out.push({
          ico: '🪙', save: Math.round(gap),
          t: '把结余率拉到 20%',
          d: '现在结余 ' + srMoney(r.surplus) + '（' + srPct(r.rate) + '），离 20%（' + srMoney(target) + '）还差 ' +
            srMoney(gap) + '。发薪日先转走 ' + srMoney(target) + '，剩下的才是能花的钱。'
        });
      } else if (r.rate >= 0.4) {
        out.push({
          ico: '🏦', save: 0,
          t: '结余率 ' + srPct(r.rate) + '，已经很好',
          d: '结余 ' + srMoney(r.surplus) + '，别让它躺在活期：拿 ' + srMoney(Math.round(r.surplus * 0.6)) +
            ' 存进「小目标」，剩下留作机动金。'
        });
      }
    } else {
      out.push({
        ico: '🧾', save: 0,
        t: '先补一笔收入记录',
        d: '没有收入就算不出结余率。把工资/生活费记一笔，「结余率」「多久攒够目标」这类指标才准。'
      });
    }
    if (r.overBudgets.length) {
      const x = r.overBudgets[0];
      out.push({
        ico: '📉', save: Math.round(x.amount - x.budget), cat: x.key,
        t: esc(x.name) + ' 超预算 ' + srMoney(x.amount - x.budget),
        d: '预算 ' + srMoney(x.budget) + '，实际 ' + srMoney(x.amount) + '。要么下月把这一类砍回来，要么把预算调到 ' +
          srMoney(Math.round(x.amount / 10) * 10) + ' 更现实。'
      });
    }
    if (r.top[0] && r.expense > 0 && r.top[0].amount / r.expense >= 0.3) {
      const t0 = r.top[0];
      out.push({
        ico: '💥', save: 0,
        t: '一笔占了整月的 ' + srPct(t0.amount / r.expense),
        d: t0.date.slice(5) + ' 的 ' + srMoney(t0.amount) + '（' + esc(t0.cat) + (t0.note ? ' · ' + esc(t0.note) : '') +
          '）把整月结构带偏了。下月把这笔记成明细、或拆成周预算，才看得清真正的日常花费。'
      });
    }
    out.sort((a, b) => (b.save || 0) - (a.save || 0));
    return out.slice(0, 4);
  }

  // 合计时按类目去重：同一类花费被「压 15%」和「超预算」同时提到，不能重复算钱
  function srSaveTotal(list) {
    let total = 0;
    const seen = {};
    list.forEach(s => {
      if (!s.save) return;
      const k = s.cat ? ('cat:' + s.cat) : ('own:' + s.t);
      if (seen[k]) return;
      seen[k] = 1;
      total += s.save;
    });
    return total;
  }

  function srLeadText(r) {
    if (!r.expense) {
      return r.income > 0
        ? '这个月只有收入记录、没有支出 —— 结构分析得等你有支出才做得出来。'
        : '这个月没有记账记录。';
    }
    const top = r.cats[0];
    const deltaTxt = r.prevExp > 0
      ? '，比 ' + Number(r.prevMk.slice(5, 7)) + ' 月' + (r.delta >= 0 ? '多' : '少') + '花 <b' +
        (r.delta >= 0 ? ' class="up"' : '') + '>' + srMoney(Math.abs(r.delta)) + '</b>（' +
        (r.delta >= 0 ? '+' : '-') + Math.abs(Math.round(r.deltaPct * 100)) + '%）'
      : '';
    return Number(r.mk.slice(5, 7)) + ' 月一共花了 <b>' + srMoney(r.expense) + '</b>（' + r.count + ' 笔）' + deltaTxt +
      '；钱主要去了「' + esc(top.name) + '」（' + srPct(top.share) + '）' +
      (r.income > 0 ? '，结余 <b>' + srMoney(r.surplus) + '</b>（结余率 ' + srPct(r.rate) + '）' : '') + '。';
  }

  function srCardHTML(r, compact) {
    const id = 'sr' + (++SR_SEQ);
    SR_STORE[id] = r;
    const catN = compact ? 4 : 6;
    const findN = compact ? 2 : 3;
    const sugN = compact ? 2 : 3;
    const rows = r.cats.slice(0, catN).map(c => `
      <div class="sr-row" style="--w:${Math.max(3, Math.round(c.share * 100))}%">
        <span class="sr-ico">${c.emoji}</span>
        <span class="sr-nm">${esc(c.name)}</span>
        <b class="sr-amt">${srMoney(c.amount)}</b>
        <span class="sr-pct">${srPct(c.share)}</span>
      </div>`).join('');
    const rest = r.cats.slice(catN);
    const more = rest.length
      ? `<div class="sr-row-sub">另有 ${rest.length} 个类目合计 ${srMoney(rest.reduce((s, c) => s + c.amount, 0))}，下载报表可看全</div>`
      : '';
    const finds = r.finds.slice(0, findN).map(f => `<li><em>${f.ico}</em>${f.t}</li>`).join('');
    const shownSugs = r.sugs.slice(0, sugN);
    const sugs = shownSugs.map(s => `
      <div class="sr-sug">
        <div class="sr-sug-t"><span>${s.ico} ${s.t}</span>${s.save > 0
          ? `<span class="sr-sug-save">省 ${srMoney(s.save)}/月</span>`
          : '<span class="sr-sug-save" style="color:#8A7A66;font-weight:600">建议动作</span>'}</div>
        <div class="sr-sug-d">${s.d}</div>
      </div>`).join('');
    const monthly = srSaveTotal(shownSugs);
    const totalHtml = monthly > 0
      ? `<div class="sr-total"><span>按建议做，每月约省</span><b>${srMoney(monthly)} · 一年 ${srMoney(monthly * 12)}</b></div>`
      : `<div class="sr-total"><span>这个月支出已经可控，重点是</span><b>把结余转进「小目标」</b></div>`;
    return `<div class="sr-card" data-report="${id}">
      <div class="sr-head">
        <span class="sr-badge">📄 消费分析报表</span>
        <span class="sr-month">${r.label} · ${r.count} 笔</span>
      </div>
      ${r.note ? `<div class="sr-note">${r.note}</div>` : ''}
      <div class="sr-lead">${srLeadText(r)}</div>
      <div class="sr-kpis">
        <div class="sr-kpi"><span>总支出</span><b>${srMoney(r.expense)}</b><i>日均 ${srMoney(r.avgDay)} · ${r.activeDays} 天有记账</i></div>
        <div class="sr-kpi"><span>总收入</span><b>${srMoney(r.income)}</b><i>${r.isCur ? '截至今天' : '全月'}</i></div>
        <div class="sr-kpi${r.surplus < 0 ? ' is-warn' : ''}"><span>结余</span><b>${srMoney(r.surplus)}</b><i>${r.income > 0 ? '结余率 ' + srPct(r.rate) : '无收入记录'}</i></div>
        <div class="sr-kpi"><span>最贵一笔</span><b>${r.top[0] ? srMoney(r.top[0].amount) : '—'}</b><i>${r.top[0] ? esc(r.top[0].cat) : '本月无支出'}</i></div>
      </div>
      <div class="sr-sec">💸 钱都去哪了</div>
      <div class="sr-rows">${rows || '<div class="sr-row-sub" style="margin-left:0">这个月没有支出记录</div>'}${more}</div>
      <div class="sr-sec">🔍 关键发现</div>
      <ul class="sr-finds">${finds}</ul>
      <div class="sr-sec">🧠 省钱建议</div>
      <div class="sr-sugs">${sugs || '<div class="sr-row-sub" style="margin-left:0">没有足够的支出数据，先多记几笔再来。</div>'}</div>
      ${totalHtml}
      <div class="sr-acts">
        <button type="button" class="sr-btn sr-primary" data-sr="dl" data-report="${id}">📥 下载完整报表</button>
        <button type="button" class="sr-btn" data-sr="chart" data-report="${id}">📊 看消费图表</button>
      </div>
      ${compact ? '' : '<div class="sr-row-sub" style="margin-left:0">报表是独立 HTML：可双击用浏览器打开，按 Ctrl+P（Mac：Command+P）直接存成 PDF，含分类明细、每日走势、Top 单笔、情绪账户与完整建议清单。</div>'}
    </div>`;
  }

  // 完整的可下载报表（自包含 HTML，样式内联，离线也能看）
  function srDocHTML(r) {
    const g = r.generatedAt;
    const stamp = g.getFullYear() + '-' + String(g.getMonth() + 1).padStart(2, '0') + '-' + String(g.getDate()).padStart(2, '0') +
      ' ' + String(g.getHours()).padStart(2, '0') + ':' + String(g.getMinutes()).padStart(2, '0');
    const maxDay = Math.max.apply(null, r.daily.map(x => x.amount).concat([1]));
    const bars = r.daily.map(x => `<div class="bar" title="${x.day} 日 ${srMoney(x.amount)}" style="height:${x.amount > 0 ? Math.max(4, Math.round(x.amount / maxDay * 100)) : 2}%${x.amount > 0 ? '' : ';background:#EDF6F1'}"></div>`).join('');
    const catRows = r.cats.map(c => `<tr>
        <td>${c.emoji} ${esc(c.name)}${c.budget > 0 ? `<span class="tag${c.amount > c.budget ? ' over' : ''}">预算 ${srMoney(c.budget)}</span>` : ''}</td>
        <td>${srMoney(c.amount)}</td>
        <td>${srPct(c.share)}</td>
        <td>${c.count}</td>
        <td>${srMoney(c.avg)}</td>
        <td class="${c.deltaPct == null ? '' : (c.deltaPct > 0 ? 'up' : 'down')}">${c.deltaPct == null ? '—' : (c.deltaPct > 0 ? '+' : '') + Math.round(c.deltaPct * 100) + '%'}</td>
      </tr>`).join('');
    const topRows = r.top.map((t, i) => `<tr>
        <td>${i + 1}</td><td>${t.date.slice(5)}</td><td>${esc(t.cat)}</td>
        <td>${esc(t.note || '—')}</td><td>${srMoney(t.amount)}</td>
        <td>${r.expense > 0 ? srPct(t.amount / r.expense) : '—'}</td>
      </tr>`).join('');
    const personaRows = r.personas.map(p => `<tr>
        <td>${esc(p.name)}</td><td>${srMoney(p.amount)}</td><td>${srPct(p.share)}</td>
        <td class="left">${esc(SR_PERSONA_DESC[p.name] || '其他日常')}</td>
      </tr>`).join('');
    const weekRows = (() => {
      const out = [];
      for (let i = 0; i < r.daily.length; i += 7) {
        const chunk = r.daily.slice(i, i + 7);
        out.push({ label: '第 ' + (out.length + 1) + ' 周（' + chunk[0].day + '–' + chunk[chunk.length - 1].day + ' 日）', amount: chunk.reduce((s, x) => s + x.amount, 0) });
      }
      return out;
    })().map(w => `<tr><td>${w.label}</td><td>${srMoney(w.amount)}</td><td>${r.expense > 0 ? srPct(w.amount / r.expense) : '—'}</td></tr>`).join('');
    const finds = r.finds.map(f => `<li>${f.ico} ${f.t}</li>`).join('');
    const sugBlocks = r.sugs.map((s, i) => `<div class="sug">
        <div class="sug-h"><b>${i + 1}. ${s.ico} ${s.t}</b><span>${s.save > 0 ? '预计省 ' + srMoney(s.save) + '/月' : '建议动作'}</span></div>
        <p>${s.d}</p>
        ${s.save > 0 ? `<p class="sug-cal">≈ 每月 ${srMoney(s.save)} · 一年 ${srMoney(s.save * 12)}</p>` : ''}
      </div>`).join('');
    const monthly = srSaveTotal(r.sugs);
    const budgetHtml = r.budget
      ? `<table><thead><tr><th>项目</th><th>金额</th><th>说明</th></tr></thead><tbody>
          <tr><td>分类预算合计</td><td>${srMoney(r.budget.total)}</td><td class="left">你已设置的月度上限总和</td></tr>
          <tr><td>本月实际支出</td><td>${srMoney(r.expense)}</td><td class="left">${r.budget.left >= 0 ? '在预算内，剩余 ' + srMoney(r.budget.left) : '已超预算 ' + srMoney(-r.budget.left)}</td></tr>
          ${r.overBudgets.length ? `<tr><td>超支类目</td><td>${r.overBudgets.length} 个</td><td class="left">${r.overBudgets.map(c => esc(c.name) + ' 超 ' + srMoney(c.amount - c.budget)).join('；')}</td></tr>` : '<tr><td>超支类目</td><td>0 个</td><td class="left">全部在预算内，保持住</td></tr>'}
        </tbody></table>`
      : '<p class="muted">本月还没有设置分类预算。在对话里说一句「我的收入是 3000，帮我分配各类预算」，我可以直接给你一份可一键执行的方案。</p>';
    const todo = r.sugs.filter(s => s.save > 0).map(s => `<li><input type="checkbox" /> <span>${s.t.replace(/<[^>]*>/g, '')}（预计 ${srMoney(s.save)}/月）</span></li>`).join('')
      || '<li><input type="checkbox" /> <span>把本月结余转进「小目标」，别留在活期</span></li>';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SmartPig 消费分析报表 · ${r.label}</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:26px 14px 40px;background:#FBF7F1;color:#2C3A33;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:840px;margin:0 auto;background:#fff;border:1px solid #F0E3D2;border-radius:16px;padding:34px 38px 28px;box-shadow:0 10px 30px rgba(160,120,80,.10)}
.brand{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:14px;border-bottom:1px dashed #EFE2D1}
.brand-l{display:flex;align-items:center;gap:9px}
.pig{width:38px;height:38px;border-radius:50%;background:#FFF3E4;display:flex;align-items:center;justify-content:center;font-size:21px}
.brand-l b{display:block;font-size:16px;letter-spacing:.3px}
.brand-l i{display:block;font-size:9.5px;letter-spacing:2.2px;color:#B08A63;font-style:normal}
.brand-r{text-align:right;font-size:12px;color:#8A7A66}
h1{font-size:24px;margin:20px 0 6px}
.sub{margin:0 0 16px;font-size:12.5px;color:#8A7A66}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0 4px}
.kpi{border:1px solid #F0E3D2;background:#FDFAF5;border-radius:12px;padding:11px 13px}
.kpi span{display:block;font-size:11px;color:#8A7A66}
.kpi b{display:block;font-size:19px;margin-top:3px;color:#1F5F49}
.kpi.warn b{color:#D9583C}
.kpi i{display:block;font-size:10.5px;color:#A0907C;font-style:normal;margin-top:2px}
h2{font-size:15px;margin:26px 0 10px;padding-left:9px;border-left:3px solid #2ECB90}
.lead{background:#FDFAF5;border:1px solid #F0E3D2;border-radius:12px;padding:12px 14px;font-size:13px;color:#3D4C44}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:7px 8px;border-bottom:1px solid #F4EBDE;text-align:right}
th{font-size:11px;color:#8A7A66;font-weight:600;background:#FDFAF5}
th:first-child,td:first-child{text-align:left}
td.left,th.left{text-align:left}
td.up{color:#D9583C}
td.down{color:#159C71}
.tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:5px;background:#F3F7F4;color:#7C8C82;font-size:10px}
.tag.over{background:#FDECE7;color:#C0482D}
.bars{display:flex;align-items:flex-end;gap:3px;height:96px;padding:6px 2px 0;border-bottom:1px solid #EFE2D1}
.bar{flex:1;background:linear-gradient(180deg,#7BE3BB,#2ECB90);border-radius:3px 3px 0 0;min-height:2px}
.axis{display:flex;justify-content:space-between;font-size:10.5px;color:#A0907C;margin-top:4px}
ul.finds{margin:0;padding-left:18px}
ul.finds li{margin-bottom:6px;font-size:12.5px}
.sug{border:1px solid #F0E3D2;border-radius:12px;padding:11px 13px;margin-bottom:9px;background:#FFFDF9}
.sug-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:13px}
.sug-h span{color:#D9583C;font-weight:700;font-size:12px;white-space:nowrap}
.sug p{margin:5px 0 0;font-size:12px;color:#5A6A60}
.sug-cal{margin-top:4px!important;color:#159C71!important}
.muted{font-size:12.5px;color:#8A7A66}
.todo{list-style:none;padding:0;margin:0}
.todo li{display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed #F2E7D8;font-size:12.5px}
.todo input{margin-top:4px}
.foot{margin-top:26px;padding-top:12px;border-top:1px dashed #EFE2D1;font-size:10.5px;color:#A0907C;line-height:1.7}
@media print{body{background:#fff;padding:0}.wrap{border:0;box-shadow:none;padding:0;max-width:none}}
@media (max-width:640px){.wrap{padding:20px 16px}.kpis{grid-template-columns:repeat(2,1fr)}h1{font-size:19px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div class="brand-l"><span class="pig">🐷</span><div><b>SmartPig</b><i>SMART BOOKKEEPING</i></div></div>
    <div class="brand-r">消费分析报表<br /><span>生成于 ${stamp}</span></div>
  </div>

  <h1>${r.label} 消费分析报表</h1>
  <p class="sub">基于你这个月的 ${r.count} 笔记账（${r.activeDays} 天有支出）自动生成。所有金额直接来自你的账单，未做估算。</p>

  <div class="kpis">
    <div class="kpi"><span>总支出</span><b>${srMoney(r.expense)}</b><i>日均 ${srMoney(r.avgDay)}</i></div>
    <div class="kpi"><span>总收入</span><b>${srMoney(r.income)}</b><i>${r.isCur ? '截至今天' : '全月合计'}</i></div>
    <div class="kpi${r.surplus < 0 ? ' warn' : ''}"><span>结余</span><b>${srMoney(r.surplus)}</b><i>${r.income > 0 ? '结余率 ' + srPct(r.rate) : '无收入记录'}</i></div>
    <div class="kpi"><span>最贵一笔</span><b>${r.top[0] ? srMoney(r.top[0].amount) : '—'}</b><i>${r.top[0] ? esc(r.top[0].cat) : '本月无支出'}</i></div>
  </div>

  <h2>一句话结论</h2>
  <p class="lead">${srLeadText(r)}</p>

  <h2>一、钱都去哪了</h2>
  <table>
    <thead><tr><th>分类</th><th>金额</th><th>占比</th><th>笔数</th><th>笔均</th><th>环比上月</th></tr></thead>
    <tbody>${catRows || '<tr><td colspan="6">本月没有支出记录</td></tr>'}</tbody>
  </table>

  <h2>二、每天的支出走势</h2>
  <div class="bars">${bars}</div>
  <div class="axis"><span>1 日</span><span>${Math.ceil(r.daysIn / 2)} 日</span><span>${r.daysIn} 日</span></div>
  <table style="margin-top:12px">
    <thead><tr><th>维度</th><th>金额</th><th>说明 / 对比</th></tr></thead>
    <tbody>
      <tr><td>周末日均</td><td>${srMoney(r.weekendAvg)}</td><td>工作日日均 ${srMoney(r.weekdayAvg)}</td></tr>
      <tr><td>花得最猛的一天</td><td>${srMoney(r.peak.amount)}</td><td>${Number(r.mk.slice(5, 7))} 月 ${r.peak.day} 日</td></tr>
      <tr><td>有记账的天数</td><td>${r.activeDays} 天</td><td>本月共 ${r.daysIn} 天</td></tr>
      ${weekRows}
    </tbody>
  </table>

  <h2>三、最贵的几笔</h2>
  <table>
    <thead><tr><th>#</th><th>日期</th><th>分类</th><th>备注</th><th>金额</th><th>占本月</th></tr></thead>
    <tbody>${topRows || '<tr><td colspan="6">本月没有支出记录</td></tr>'}</tbody>
  </table>

  <h2>四、情绪账户：这笔钱让你开心，还是心疼？</h2>
  <table>
    <thead><tr><th>账户</th><th>金额</th><th>占比</th><th>说明</th></tr></thead>
    <tbody>${personaRows || '<tr><td colspan="4">本月没有支出记录</td></tr>'}</tbody>
  </table>

  <h2>五、关键发现</h2>
  <ul class="finds">${finds}</ul>

  <h2>六、省钱建议（逐条可执行）</h2>
  ${sugBlocks || '<p class="muted">这个月数据太少，多记几笔我再给你算。</p>'}
  ${monthly > 0 ? `<p class="lead" style="margin-top:12px">合计：每月约省 <b>${srMoney(monthly)}</b>，一年约 <b>${srMoney(monthly * 12)}</b>（同一类花费被多条建议命中时只算一次）。省钱不是让自己难受，而是把这些钱换到更想要的地方。</p>` : ''}

  <h2>七、预算达成</h2>
  ${budgetHtml}

  <h2>八、下月行动清单</h2>
  <ul class="todo">${todo}</ul>

  <p class="foot">本报表由 SmartPig 依据你本地的记账数据自动生成，仅用于个人财务管理参考，不构成投资建议。<br />
  统计口径：支出/收入按记账日期归月；「结余率 = 结余 ÷ 收入」；环比为与上一个自然月对比。<br />
  生成时间：${stamp}</p>
</div>
</body>
</html>`;
  }

  function srDownload(r) {
    const name = 'SmartPig消费报表_' + r.mk + '.html';
    try {
      const blob = new Blob(['\ufeff' + srDocHTML(r)], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { a.remove(); URL.revokeObjectURL(url); } catch (e) {}
      }, 3000);
    } catch (err) {
      toast('warn', '下载失败了', '浏览器可能拦截了文件下载，允许本站下载后我再给你一份。');
    }
    return name;
  }

  // 一键跳到消费图表（记账管理页顶部的三张图），并把月份锁定到报表那个月
  function srGotoCharts(r) {
    manageFilter.tab = 'list';
    manageFilter.month = (r && r.mk) || 'all';
    navigate('manage', { focus: r ? r.mk : null });
    const panel = document.getElementById('aiPanel');
    if (panel) panel.classList.remove('open');
    setTimeout(() => {
      const el = document.querySelector('#manageSub .chart-grid') || document.querySelector('.chart-grid');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('info', '📊 已跳到消费图表', r ? '已切到 ' + r.label + ' 的支出结构，下方明细也同步到这一个月。' : '近 6 个月收支对比 / 支出结构 / 本周每日支出，都在这一屏。');
    }, 90);
  }

  // 两个对话入口（消费教练页 + 右下悬浮球）共用；compact = 窄面板里的精简版
  function srChatStep(q, compact) {
    if (!srIsAsk(q)) return null;
    const mk = srPickMonth(q);
    let r = buildSpendReport(mk);
    if (!r.count) {
      const alt = srLatestMonth();
      if (!alt) {
        return '我这一份账单都还没拿到呢 🐷 先去「一笔入魂」记两笔，回来我马上给你出详细报表 + 省钱建议。';
      }
      r = buildSpendReport(alt);
      r.note = srMonthLabel(mk) + '还没有记账记录，先用 <b>' + srMonthLabel(alt) + '</b> 的数据给你出一版（共 ' + r.count + ' 笔）。';
    }
    return srCardHTML(r, !!compact);
  }

  // 报表很长：渲染后把滚动条落到报表顶部，让人先看到结论而不是最后的按钮
  function srRevealTop(scroller) {
    if (!scroller) return;
    const cards = scroller.querySelectorAll('.sr-card');
    const card = cards[cards.length - 1];
    if (!card) return;
    const top = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
    scroller.scrollTop = Math.max(0, top);
  }

  function wireReportCard(root) {
    if (!root || root.dataset.srWired) return;
    root.dataset.srWired = '1';
    const refresh = () => {
      root.querySelectorAll('.sr-card').forEach(c => {
        if (!SR_DONE[c.dataset.report]) return;
        const b = c.querySelector('[data-sr="dl"]');
        if (b) { b.textContent = '✅ 已下载'; b.classList.add('sr-btn-done'); b.disabled = true; }
      });
    };
    root.__srRefresh = refresh;
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sr]');
      if (!btn || !root.contains(btn)) return;
      const r = SR_STORE[btn.dataset.report];
      if (!r) return;
      if (btn.dataset.sr === 'chart') { srGotoCharts(r); return; }
      if (btn.dataset.sr === 'dl') {
        const name = srDownload(r);
        SR_DONE[btn.dataset.report] = 1;
        refresh();
        toast('success', '📥 报表已下载', name + ' · 双击用浏览器打开，Ctrl+P（Mac：Command+P）可直接存成 PDF');
      }
    });
  }

  /* ---------------- 全局 AI 悬浮球（💬） ---------------- */
  function initAiFab() {
    const fab = document.getElementById('aiFab');
    const panel = document.getElementById('aiPanel');
    if (!fab || !panel) return;
    const logEl = panel.querySelector('.ai-panel-log');
    const input = panel.querySelector('.ai-panel-input');
    const sendBtn = panel.querySelector('.ai-panel-send');
    const closeBtn = panel.querySelector('.ai-panel-close');
    const micBtn = panel.querySelector('.ai-panel-mic');
    const speakBtn = panel.querySelector('.ai-panel-speak');
    const setBtn = panel.querySelector('.ai-panel-set');
    let history = [];
    // —— 语音：识别 + 合成（浏览器原生，零依赖）——
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micSupported = !!SpeechRecognition;
    const synth = window.speechSynthesis;
    let recognition = null;
    // —— 语音偏好持久化（localStorage），默认开启，AI 一开口就有声音 ——
    const LS_SPEAK = 'caiwu_ai_autoSpeak';
    const LS_VOICE = 'caiwu_ai_voice';
    const LS_RATE = 'caiwu_ai_rate';
    const LS_PITCH = 'caiwu_ai_pitch';
    const LS_PRESET = 'caiwu_ai_preset';
    const LS_PRESETS = 'caiwu_ai_voice_presets';
    let speakOn = localStorage.getItem(LS_SPEAK) !== 'off'; // 默认 on
    let chosenVoice = localStorage.getItem(LS_VOICE) || '';   // 当前系统音色名（''=系统默认）
    let curRate = parseFloat(localStorage.getItem(LS_RATE)) || 1.02;
    let curPitch = parseFloat(localStorage.getItem(LS_PITCH)) || 1;
    let curPresetId = localStorage.getItem(LS_PRESET) || '';
    let presets = [];
    try { presets = JSON.parse(localStorage.getItem(LS_PRESETS) || '[]') || []; } catch (_) { presets = []; }
    // 统一设置「自动语音播报」状态：同步按钮、弹窗开关、持久化
    const applySpeakState = (on) => {
      speakOn = !!on;
      if (speakBtn) {
        speakBtn.classList.toggle('on', speakOn);
        speakBtn.textContent = speakOn ? '🔊' : '🔇';
        speakBtn.title = speakOn ? '语音播报：开（点击关闭）' : '语音播报：关（点击开启）';
      }
      const cb = document.getElementById('aiAutoSpeak');
      if (cb) cb.checked = speakOn;
      try { localStorage.setItem(LS_SPEAK, speakOn ? 'on' : 'off'); } catch (_) {}
    };
    const stripHtml = (s) => String(s).replace(/<[^>]+>/g, '').replace(/[🤖🙂💬🔊🔇🎤×]/g, '').trim();
    const speak = (text) => {
      if (!synth || !speakOn) return;
      try { synth.cancel(); } catch (_) {}
      const u = new SpeechSynthesisUtterance(stripHtml(text));
      u.lang = 'zh-CN'; u.rate = curRate; u.pitch = curPitch;
      if (chosenVoice && synth.getVoices) {
        const v = synth.getVoices().find((x) => x.name === chosenVoice || x.voiceURI === chosenVoice);
        if (v) u.voice = v;
      }
      synth.speak(u);
    };
    const setMicState = (on) => {
      if (!micBtn) return;
      micBtn.classList.toggle('listening', !!on);
      const old = input.getAttribute('placeholder');
      if (on) { micBtn.dataset.ph = old || ''; input.setAttribute('placeholder', '🎤 聆听中…说完自动发送'); }
      else if (micBtn.dataset.ph) { input.setAttribute('placeholder', micBtn.dataset.ph); }
    };
    const buildRecognition = () => {
      if (!micSupported) return null;
      const r = new SpeechRecognition();
      r.lang = 'zh-CN'; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
      r.onresult = (e) => {
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) final += res[0].transcript; else interim += res[0].transcript;
        }
        if (final) { input.value = final; setMicState(false); ask(final); }
        else if (interim) { input.value = interim; }
      };
      r.onstart = () => { r.listening = true; };
      r.onerror = () => { r.listening = false; setMicState(false); };
      r.onend = () => { r.listening = false; setMicState(false); };
      return r;
    };
    if (micBtn) {
      if (!micSupported) { micBtn.title = '当前浏览器不支持语音输入（请使用 Chrome / Edge）'; micBtn.style.opacity = '.45'; }
      micBtn.addEventListener('click', () => {
        if (!micSupported) return;
        if (!recognition) recognition = buildRecognition();
        if (recognition && recognition.listening) { try { recognition.stop(); } catch (_) {} return; }
        try { recognition.start(); recognition.listening = true; setMicState(true); } catch (_) { setMicState(false); }
      });
    }
    if (speakBtn) {
      speakBtn.addEventListener('click', () => {
        applySpeakState(!speakOn);
        if (speakOn && synth) {
          if (synth.getVoices().length === 0) { try { synth.getVoices(); } catch (_) {} }
          const lastAi = history.filter((m) => m.role === 'ai').pop();
          if (lastAi) speak(lastAi.html);
        } else if (synth) { try { synth.cancel(); } catch (_) {} }
      });
    }
    // 初始化：应用持久化的语音偏好（默认开启 → AI 自动有声音）
    applySpeakState(speakOn);

    // —— AI 语音对话设置弹窗 ——
    const aiSettingsModal = document.getElementById('aiSettingsModal');
    const closeSettings = () => { if (aiSettingsModal) aiSettingsModal.classList.remove('show'); };
    if (setBtn) setBtn.addEventListener('click', () => { if (aiSettingsModal) aiSettingsModal.classList.add('show'); });
    if (aiSettingsModal) {
      aiSettingsModal.addEventListener('click', (e) => { if (e.target === aiSettingsModal) closeSettings(); });
      const xBtn = aiSettingsModal.querySelector('#aiSettingsClose');
      if (xBtn) xBtn.addEventListener('click', closeSettings);
      const cb = aiSettingsModal.querySelector('#aiAutoSpeak');
      if (cb) cb.addEventListener('change', () => applySpeakState(cb.checked));
      const micTag = aiSettingsModal.querySelector('#aiMicTag');
      if (micTag) {
        micTag.textContent = micSupported ? '可用' : '当前浏览器不支持';
        micTag.classList.add(micSupported ? 'ok' : 'no');
      }
      const sel = aiSettingsModal.querySelector('#aiVoiceSel');
      const rateInput = aiSettingsModal.querySelector('#aiRate');
      const pitchInput = aiSettingsModal.querySelector('#aiPitch');
      const rateOut = aiSettingsModal.querySelector('#aiRateOut');
      const pitchOut = aiSettingsModal.querySelector('#aiPitchOut');
      const presetName = aiSettingsModal.querySelector('#aiPresetName');
      const saveBtn = aiSettingsModal.querySelector('#aiSavePreset');
      const presetListEl = aiSettingsModal.querySelector('#aiPresetList');

      // 给系统音色起好听的别名，并标记推荐的自然语音（Neural 更自然）
      const VOICE_ALIAS = {
        'Microsoft Huihui - Chinese (Simplified)': '慧慧 · 女声温柔',
        'Microsoft Yaoyao - Chinese (Simplified)': '瑶瑶 · 女声明亮',
        'Microsoft Kangkang - Chinese (Simplified)': '康康 · 男声稳重',
        'Microsoft Xiaoxiao - Chinese (Simplified) (Neural)': '晓晓 · 女声自然 ★推荐',
        'Microsoft XiaoxiaoOnline (Natural) - Chinese (Simplified)': '晓晓 · 女声自然 ★推荐',
        'Microsoft Yunyang - Chinese (Simplified) (Neural)': '云扬 · 男声磁性 ★推荐',
        'Microsoft Yunxi - Chinese (Simplified) (Neural)': '云溪 · 男声清爽 ★推荐',
        'Microsoft Xiaoyi - Chinese (Simplified) (Neural)': '小艺 · 女声甜美 ★推荐',
        'Microsoft Yunjian - Chinese (Simplified) (Neural)': '云剑 · 男声浑厚 ★推荐'
      };
      const sexOf = (n) => /female|女|woman|女孩/i.test(n) ? '女声' : (/male|男|man|男孩/i.test(n) ? '男声' : '');
      const friendlyVoice = (v) => {
        const key = v.name || '';
        if (VOICE_ALIAS[key]) return VOICE_ALIAS[key];
        const sex = sexOf(key);
        const reco = /neural|online \(natural\)/i.test(key) ? ' ★推荐' : '';
        return (key || v.lang || '中文语音') + (sex ? ' · ' + sex : '') + reco;
      };

      const previewVoice = (voiceName, rate, pitch, text) => {
        if (!synth) return;
        try { synth.cancel(); } catch (_) {}
        const u = new SpeechSynthesisUtterance(text || '你好，我是你的理财小助手，这是测试声音。');
        u.lang = 'zh-CN'; u.rate = rate; u.pitch = pitch;
        if (voiceName && synth.getVoices) {
          const v = synth.getVoices().find((x) => x.name === voiceName || x.voiceURI === voiceName);
          if (v) u.voice = v;
        }
        try { synth.speak(u); } catch (_) {}
      };

      const fillVoiceOptions = () => {
        if (!synth || !synth.getVoices) return;
        const voices = synth.getVoices().filter((v) => /zh|cmn|Chinese|中文/i.test((v.lang || '') + ' ' + (v.name || '')));
        let html = '<option value="" data-kind="default">系统默认（中文）</option>';
        if (voices.length) {
          html += voices.map((v) => {
            const label = friendlyVoice(v);
            const reco = /★推荐/.test(label);
            return `<option value="${esc(v.name)}" data-kind="sys" data-voice="${esc(v.name)}"${reco ? ' class="ai-voice-opt-reco"' : ''}>${esc(label)}</option>`;
          }).join('');
        }
        if (presets.length) {
          html += '<optgroup label="✨ 我的自定义音色"></optgroup>';
          html += presets.map((p) => `<option value="${esc(p.id)}" data-kind="preset" data-voice="${esc(p.voice || '')}" data-rate="${p.rate}" data-pitch="${p.pitch}">${esc(p.name)}（${esc(p.voice ? p.voice : '系统默认')} · ${Number(p.rate).toFixed(2)}x · 音调${Number(p.pitch).toFixed(2)}）</option>`).join('');
        }
        sel.innerHTML = html;
        if (curPresetId && presets.some((p) => p.id === curPresetId)) sel.value = curPresetId;
        else if (chosenVoice) sel.value = chosenVoice;
        else sel.value = '';
      };

      const renderPresetList = () => {
        if (!presetListEl) return;
        if (!presets.length) { presetListEl.innerHTML = '<div class="ai-preset-empty">还没有自定义音色，调好语速音调后点「保存」即可收藏～</div>'; return; }
        presetListEl.innerHTML = presets.map((p) => `<div class="ai-preset-item" data-id="${esc(p.id)}">
          <span class="nm">${esc(p.name)}</span>
          <span class="meta">${esc(p.voice ? p.voice : '系统默认')} · ${Number(p.rate).toFixed(2)}x · 音调${Number(p.pitch).toFixed(2)}</span>
          <button type="button" class="tst" data-act="test">试听</button>
          <button type="button" class="del" data-act="del">删除</button>
        </div>`).join('');
        presetListEl.querySelectorAll('.ai-preset-item').forEach((el) => {
          const id = el.dataset.id;
          const p = presets.find((x) => x.id === id);
          if (!p) return;
          const testB = el.querySelector('[data-act=test]');
          const delB = el.querySelector('[data-act=del]');
          if (testB) testB.addEventListener('click', () => previewVoice(p.voice || '', p.rate, p.pitch));
          if (delB) delB.addEventListener('click', () => {
            presets = presets.filter((x) => x.id !== id);
            try { localStorage.setItem(LS_PRESETS, JSON.stringify(presets)); } catch (_) {}
            if (curPresetId === id) { curPresetId = ''; try { localStorage.setItem(LS_PRESET, ''); } catch (_) {} sel.value = chosenVoice || ''; }
            renderPresetList();
          });
        });
      };

      const syncSliders = () => {
        if (rateInput) rateInput.value = curRate;
        if (pitchInput) pitchInput.value = curPitch;
        if (rateOut) rateOut.textContent = Number(curRate).toFixed(2);
        if (pitchOut) pitchOut.textContent = Number(curPitch).toFixed(2);
      };

      // 初始化 UI
      syncSliders();
      fillVoiceOptions();
      renderPresetList();
      if (synth && 'onvoiceschanged' in synth) synth.onvoiceschanged = () => { fillVoiceOptions(); };

      // 音色切换（系统 / 自定义预设）
      sel.addEventListener('change', () => {
        const opt = sel.selectedOptions && sel.selectedOptions[0];
        const kind = opt && opt.dataset ? opt.dataset.kind : 'default';
        if (kind === 'preset') {
          const p = presets.find((x) => x.id === opt.value);
          if (p) { chosenVoice = p.voice || ''; curRate = Number(p.rate); curPitch = Number(p.pitch); curPresetId = p.id; }
        } else if (kind === 'sys') {
          chosenVoice = opt.dataset.voice || ''; curPresetId = '';
        } else { chosenVoice = ''; curPresetId = ''; }
        syncSliders();
        try { localStorage.setItem(LS_VOICE, chosenVoice); localStorage.setItem(LS_PRESET, curPresetId); localStorage.setItem(LS_RATE, curRate); localStorage.setItem(LS_PITCH, curPitch); } catch (_) {}
        previewVoice(chosenVoice, curRate, curPitch);
      });

      // 语速 / 音调 微调（拖动松手即试听）
      if (rateInput) rateInput.addEventListener('change', () => {
        curRate = parseFloat(rateInput.value) || 1; if (rateOut) rateOut.textContent = curRate.toFixed(2);
        try { localStorage.setItem(LS_RATE, curRate); } catch (_) {}
        previewVoice(chosenVoice, curRate, curPitch);
      });
      if (pitchInput) pitchInput.addEventListener('change', () => {
        curPitch = parseFloat(pitchInput.value) || 1; if (pitchOut) pitchOut.textContent = curPitch.toFixed(2);
        try { localStorage.setItem(LS_PITCH, curPitch); } catch (_) {}
        previewVoice(chosenVoice, curRate, curPitch);
      });

      // 保存 / 更新自定义音色（命名收藏，持久化）
      if (saveBtn) saveBtn.addEventListener('click', () => {
        const name = (presetName && presetName.value.trim()) || ('我的音色 ' + (presets.length + 1));
        const data = { voice: chosenVoice, rate: curRate, pitch: curPitch };
        if (curPresetId) {
          const p = presets.find((x) => x.id === curPresetId);
          if (p) { p.name = name; p.voice = data.voice; p.rate = data.rate; p.pitch = data.pitch; }
        } else {
          const id = 'p' + Date.now();
          presets.push(Object.assign({ id, name }, data));
          curPresetId = id;
        }
        try { localStorage.setItem(LS_PRESETS, JSON.stringify(presets)); localStorage.setItem(LS_PRESET, curPresetId); } catch (_) {}
        if (presetName) presetName.value = '';
        fillVoiceOptions(); renderPresetList();
        previewVoice(chosenVoice, curRate, curPitch);
      });
    }
    const renderLog = () => {
      logEl.innerHTML = history.map(m => {
        const wide = /bp-card|bp-done|sr-card/.test(m.html);
        return '<div class="msg ' + m.role + (wide ? ' msg-wide' : '') + '"><div class="avatar">' + (m.role === 'ai' ? '<img class="brand-avatar" src="assets/smartpig-mark-128.png" alt="" aria-hidden="true" />' : '🙂') + '</div><div class="bubble' + (wide ? ' bubble-wide' : '') + '">' + m.html + '</div></div>';
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;
      if (logEl.__bpRefresh) logEl.__bpRefresh();
      if (logEl.__srRefresh) logEl.__srRefresh();
      if (panel) panel.classList.toggle('sr-tall', !!logEl.querySelector('.sr-card'));
    };
    // 方案卡片里的按钮（执行 / 微调 / 跳过）——事件委托，重渲染后依然有效
    const bpState = BP_STATE.fab || (BP_STATE.fab = { plan: null, awaitIncome: false });
    wireBudgetCard(logEl, (html) => { history.push({ role: 'ai', html }); renderLog(); speak(html); });
    wireReportCard(logEl);
    const welcome = () => {
      if (!history.length) {
        history.push({ role: 'ai', html: '你好，我是 <b>SmartPig 小助手</b>（悬浮球版）。理财、存钱、消费、预算都可以问我，随时点我聊～' });
        renderLog();
      }
    };
    fab.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      if (open) { welcome(); setTimeout(function () { input.focus(); }, 50); }
    });
    if (closeBtn) closeBtn.addEventListener('click', () => panel.classList.remove('open'));
    const ask = async (q) => {
      q = (q || '').trim(); if (!q) return;
      history.push({ role: 'user', html: esc(q) }); renderLog();
      // 要报表 → 本地数据直接出详细报表（带下载 / 看图表），不等模型
      const reportStep = srChatStep(q, true);
      if (reportStep) {
        history.push({ role: 'ai', html: reportStep }); renderLog();
        srRevealTop(logEl);
        speak('报表做好了，可以下载，也可以去看图表。');
        return;
      }
      // 预算规划走「代码算金额 + 卡片确认」，不让模型自由发挥
      const budgetStep = budgetChatStep(q, bpState);
      if (budgetStep) {
        history.push({ role: 'ai', html: budgetStep }); renderLog();
        speak(/bp-card/.test(budgetStep) ? '方案算好了，你确认就帮你设上。' : budgetStep);
        return;
      }
      let reply;
      try {
        if (CONFIG.AI_BACKEND && !BACKEND.llmDegraded) reply = await callBackendChat(q, history);
        else reply = agentReply(q, getTx());
      } catch (e) { reply = agentReply(q, getTx()); }
      history.push({ role: 'ai', html: reply }); renderLog();
      speak(reply);
    };
    sendBtn.addEventListener('click', () => { const v = input.value; input.value = ''; ask(v); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = e.target.value; e.target.value = ''; ask(v); } });
  }
  initAiFab();

  // 供验收脚本 / 调试台直接检视三维度规则（只读，不写库）
  window.__riskGuard = riskGuard;
  // 供验收脚本检视消费报表（只读）
  window.__spendReport = {
    build: buildSpendReport,
    monthOf: srPickMonth,
    isAsk: srIsAsk,
    card: srCardHTML,
    doc: srDocHTML
  };
})();
