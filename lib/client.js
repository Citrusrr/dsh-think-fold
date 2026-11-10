window.__ModuleLoader__.load({
  id: 'dsh-think-fold',
  factory(require) {
    'use strict';

    // 设置界面需要 React；拿不到就只保留行为，不影响自动开合
    let React = null;
    try { React = require('react'); } catch { /* 浏览器模块表里没有 react 时降级 */ }

    /**
     * dsh-think-fold —— 「当前正在执行的那一条」自动展开，执行完自动收起。
     * 覆盖两类行：官方的「思考」行，和官方的工具卡（命令 / 文件修改 / 网页 / 子代理…）。
     *
     * 设计红线：**不渲染任何东西**。没有自研容器、没有样式、没有 Markdown 复刻。
     * 官方这条正文是条件挂载的（`open && children`），所以「展开」只能由它自己的 state
     * 驱动 —— 本插件对页面只做一件事：按需点一下那条官方折叠行。
     * 排版、字号、代码块、diff、图片全部来自官方，插件只决定「何时点」。
     *
     * 依赖的官方 DOM 契约（dsh 0.2.0-rc.2 实测）：
     *   流容器   [data-chat-flow]
     *   思考行   [data-variant="think"]，data-state = running | ok
     *   工具卡   [data-tool="<name>"] 或 [data-sample="bash"]，
     *            data-state = preparing | running | stopped | error | ok
     *            （官方 toolRowModel：preparing 阶段 expandable=false，点不动也没内容）
     *   开合控件 [data-disclosure-row]（role=button、onClick=onToggle、带 aria-expanded）
     *   展开体   [class*="_thinkBody"]（思考）—— 工具的正文由官方各自的卡片负责
     *
     * 「谁在跑」完全读官方自己发布的状态，不用计时器猜：
     *   思考行只在「当前步骤里正在流式的那条」上发 running（running = streaming && i === last）；
     *   工具卡在执行期间发 running、参数还在流式时发 preparing。
     * 于是「该展开谁」= 状态正在跑的那些行，「该收谁」= 刚刚不在跑的那些行。
     */

    const NS = 'dsh-think-fold';

    const DEFAULTS = {
      enabled: true,
      // live     = 只有正在跑的那些行保持展开，跑完即收（默认）
      // keepLast = 额外保留最近 keepLast 条已跑完的行
      mode: 'live',
      keepLast: 0,
      // 跑完后延迟多久再收（毫秒）。0 = 立刻。
      lingerMs: 0,
      // 跑满多久才值得展开（毫秒）。read / grep / glob 这类几十毫秒就返回的工具
      // 展开再收起只会闪一下，所以不到这个时长就不展开。0 = 一律展开。
      minLiveMs: 250,
      // 收起过渡时长（毫秒）。官方正文是条件挂载且没有任何过渡，直接点 = 瞬间消失；
      // 非 0 时我们自己先把正文卷起来，卷完再点官方收起。0 = 保留官方的瞬间收起。
      collapseAnimMs: 260,
      // 过渡期间正文淡到多透明（0~1）。留一点不透明度可避免"灰块"感；1 = 不淡出只收高度。
      collapseFadeTo: 0.15,
      // 收起时手动做滚动锚定补偿（整行已在视口上方时，按高度差补 scrollTop）。
      // 默认关：Chromium 原生 scroll anchoring 与官方自己的跟随逻辑通常已经处理好，
      // 手动补有可能和它们打架。看到跳动了再打开。
      scrollCompensate: false,
      // 正在流式的思考正文限高（px）：思考很长时把它压进一个限高内滚窗口，窗口内部
      // 自动滚到最新，页面不再被它拽着往下滚。0 = 不限高（回到官方行为）。
      // 官方自己就是这么干的：过程组正文是 max-height:min(400px,50vh)。
      thinkWindowMax: 440,
      // 跟随的平滑度（0.05~1）：越大贴底越紧（跟得快、略硬），越小越绵长（跟得慢、易滞后）。
      followEase: 0.55,
      // 工具卡是否参与（命令、文件修改、网页、子代理…）
      includeTools: true,
      // LLM 提问卡（ask_user_question）是否参与。默认不参与：那不是「在执行」，
      // 而且官方输入框会把它顶到眼前。想连它一起自动展开就设 true。
      includeQuestions: false,
      // true = 只收我们自己展开过的；你手动点开的行永不被自动收起
      collapseOwnedOnly: true,
      // 点完之后等 React 落地的静默期：避免同一行被连点两次又翻回去
      cooldownMs: 320,
      // 一次跑完（一轮结束）后，把这一整轮的思考/命令收进首行那条「已完成 · 用时」。
      // 主开关在官方档位（见下面的「完成后合并整轮」段），这里是第二层兜底：
      // 某轮结束时还摊着就替你把首行点一下。
      mergeTurns: true,
      // 轮结束后隔多久才收（毫秒）：留点时间看清最后一行，0 = 立刻
      mergeDelayMs: 800,
    };

    const FLOW = '[data-chat-flow]';
    const THINK = '[data-variant="think"]';
    const TOOL = '[data-tool], [data-sample="bash"]';
    const CONTROL = '[data-disclosure-row]';
    const ANY_ROW = THINK + ', ' + TOOL;
    const LIVE_STATES = new Set(['running', 'preparing']);

    /* ------------------------------------------------------------ 设置存储 -- */

    let state = { ...DEFAULTS };
    try {
      const cached = JSON.parse(localStorage.getItem(NS) || 'null');
      if (cached !== null && typeof cached === 'object') state = { ...state, ...cached };
    } catch { /* 坏值就当没存过 */ }

    // 设置页要订阅它：snapshot 只在真的变化时换引用（useSyncExternalStore 的要求）
    let snapshot = { ...state };
    const listeners = new Set();
    function notify() {
      snapshot = { ...state };
      for (const listener of [...listeners]) { try { listener(); } catch { /* ignore */ } }
    }
    function subscribeSettings(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
    const readSettings = () => snapshot;

    /* ------------------------------------------------------------ 运行状态 -- */

    let synthetic = false;            // 我方派发的事件（捕获器要放行，否则拦到自己）
    let lastLive = new Set();         // 上一次「正在跑」的那些行
    let stopController = null;        // 控制器的停止函数；非 null = 正在跑
    let observer = null;
    let frame = 0;
    let followFrame = 0;              // 平滑跟随的 rAF 句柄（0 = 没在跑）
    let announced = false;            // 首次成功接管时的单行日志
    let errorCount = 0;               // 出错日志最多打几条，避免刷屏
    const ours = new WeakSet();       // 我们展开过的行
    const userOwned = new WeakSet();  // 你手动开合过的行：永不自动动它
    const cooldown = new WeakMap();   // 行 -> { want, until }
    const liveSince = new WeakMap();  // 行 -> 第一次被看到「在跑」的时间戳（minLiveMs 门槛用）
    const animating = new Map();      // 行 -> { abort, timer }：收起过渡正在飞的
    const thinkWindow = new WeakMap(); // 思考行 -> { cap, following }：限高内滚窗口
    const timers = new Set();
    let minLiveTimer = 0;

    /* -------------------------------------------------------------- 选取器 -- */

    /**
     * 会话流里的「过程行」：思考行 + 工具卡，DOM 顺序 = 会话顺序。
     * 只在 [data-chat-flow] 容器内取：轨迹视图 / 右栏文档 / 子代理正文都有自己的
     * 折叠行，不能被误当成会话里的行。
     */
    function collectRows() {
      const out = [];
      for (const flow of document.querySelectorAll(FLOW)) {
        for (const row of flow.querySelectorAll(ANY_ROW)) {
          if (row.closest('[hidden]') !== null) continue;   // 官方搜索折叠等隐藏态：不点

          if (row.matches(THINK)) {
            // 子代理卡展开出的嵌套正文里也可能有思考行：只管会话这一层
            if (row.closest(TOOL) !== null) continue;
          } else {
            // 子调用卡（data-subcalls 里的那些）：只管最外层那张卡
            const parent = row.parentElement;
            if (parent !== null && parent.closest(TOOL) !== null) continue;
            if (state.includeQuestions === false && row.getAttribute('data-tool') === 'ask_user_question') continue;
            if (state.includeTools === false) continue;
          }

          out.push(row);
        }
      }
      return out;
    }

    /** 行里真正可点的那颗开关；不可展开时返回 null。 */
    function controlOf(row) {
      const control = row.querySelector(CONTROL);
      if (control === null) return null;
      if (control.getAttribute('aria-expanded') !== null) return control;
      // 少数卡片把开关放在 leading button 上（expandOnRowClick=false）
      const button = control.querySelector('button[aria-expanded]');
      return button !== null ? button : null;
    }

    /** 这条行是否已展开。三个判据任一成立即可（官方换实现时不至于全瞎）。 */
    function expandedOf(row) {
      if (row.hasAttribute('data-expanded')) return true;
      const control = controlOf(row);
      if (control !== null && control.getAttribute('aria-expanded') === 'true') return true;
      return row.querySelector('[class*="_thinkBody"]') !== null;
    }

    /** 官方发布的运行态。思考行只有 running|ok；工具卡还有 preparing|stopped|error。 */
    function isLive(row) {
      const value = row.getAttribute('data-state');
      return value !== null && LIVE_STATES.has(value);
    }

    /* -------------------------------------------------------------- 开合 -- */

    /** 点官方那条折叠行 —— 本插件唯一的写操作。 */
    function requestToggle(row, desired) {
      if (!row.isConnected) return false;
      if (expandedOf(row) === desired) return false;

      const cool = cooldown.get(row);
      if (cool !== undefined && cool.want === desired && performance.now() < cool.until) return false;

      const control = controlOf(row);
      if (control === null) return false;

      synthetic = true;
      try {
        control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch {
        return false;
      } finally {
        synthetic = false;
      }

      cooldown.set(row, { want: desired, until: performance.now() + state.cooldownMs });
      if (desired) ours.add(row); else ours.delete(row);
      if (state.debug === true) {
        console.log('[dsh-think-fold] ' + (desired ? '展开' : '收起'),
          row.matches(THINK) ? 'think' : (row.getAttribute('data-tool') || row.getAttribute('data-sample')));
      }
      return true;
    }

    /* ---------------------------------------------------------- 收起过渡 -- */

    /** 官方 DisclosureRow 里那个「被卸载」的正文（open && children）。 */
    const BODY_HINT = '[class*="_thinkBody"], [class*="_bodyScroll"], [class*="_bodyWrap"], [data-context-injection-body]';
    function bodyOf(row) {
      const hinted = row.querySelector(BODY_HINT);
      if (hinted !== null) return hinted;
      // 兜底：disclosure 根下、除折叠行以外的那个子元素就是正文
      const control = controlOf(row);
      const parent = control === null ? null : control.parentElement;
      if (parent === null) return null;
      for (const child of parent.children) if (child !== control) return child;
      return null;
    }

    /** 系统级「减少动态效果」。官方自己就遵守这条（DisclosureRow.module.css 里有），我们照做。 */
    function reduceMotion() {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
    }

    function clearInline(el) {
      if (el === null) return;
      try {
        el.style.maxHeight = '';
        el.style.overflow = '';
        el.style.overflowAnchor = '';
        el.style.transition = '';
        el.style.opacity = '';
      } catch { /* ignore */ }
    }

    /**
     * 先把正文卷起来，卷完再点官方收起。
     * 顺序是关键：官方正文是条件挂载的，必须等它已经是 0 高再卸载，否则会看到一次跳动。
     * 过渡期间用户自己点了这一行 → 立即中止并还原（用户意图优先）。
     */
    function animateClose(row, done) {
      const duration = Math.max(0, Number(state.collapseAnimMs) || 0);
      const body = duration === 0 || reduceMotion() ? null : bodyOf(row);
      if (body === null) { done(); return; }

      const height = body.getBoundingClientRect().height;
      if (!(height > 1)) { done(); return; }   // 没有可卷的高度：别浪费一帧

      const scroller = state.scrollCompensate === true ? row.closest('[data-conversation-scroll]') : null;
      const anchorScroll = scroller === null ? 0 : scroller.scrollTop;
      const viewTop = scroller === null ? 0 : scroller.getBoundingClientRect().top;
      const rowRect = row.getBoundingClientRect();
      const wholeRowAbove = scroller !== null && rowRect.bottom < viewTop;
      const fadeTo = Math.min(1, Math.max(0, Number(state.collapseFadeTo ?? 0.15)));

      const finish = (aborted) => {
        const entry = animating.get(row);
        if (entry === undefined) return;          // 已经收过尾了
        animating.delete(row);
        clearTimeout(entry.timer);
        timers.delete(entry.timer);

        if (aborted) { clearInline(body); return; }   // 用户接管：原样还回去，不点官方

        done();                                        // 此刻正文还是 0 高 → 卸载不会有跳动
        // 点击成功时 React 会在同一个 click 事件里同步把正文摘掉；正文还在且官方仍是展开态
        // = 这次点击没生效，必须把内联样式还原，否则会留下一块 0 高的正文。
        if (body.isConnected && expandedOf(row)) clearInline(body);

        // 整行都在视口上方：它变矮会把你在读的内容往上推，按高度差补回滚动位置
        if (wholeRowAbove && scroller.isConnected) scroller.scrollTop = anchorScroll + height;
      };

      const entry = { abort: () => finish(true), timer: 0 };
      animating.set(row, entry);

      body.style.overflow = 'hidden';
      body.style.maxHeight = height + 'px';
      body.style.opacity = '1';
      body.style.transition = 'max-height ' + duration + 'ms cubic-bezier(0.4, 0, 0.2, 1), opacity '
        + Math.round(duration * 0.7) + 'ms ease';
      void body.offsetHeight;                          // 强制 reflow：让上面的起点真的生效
      body.style.maxHeight = '0px';
      body.style.opacity = String(fadeTo);

      entry.timer = setTimeout(() => finish(false), duration + 20);
      timers.add(entry.timer);
    }

    /** 收起一行：尊重你的手动意图与「只收自己的」策略。 */
    function collapse(row) {
      if (row === null || !row.isConnected) return;
      if (userOwned.has(row)) return;
      if (state.collapseOwnedOnly && !ours.has(row)) return;
      if (animating.has(row)) return;
      animateClose(row, () => { requestToggle(row, false); });
    }

    function scheduleCollapse(row) {
      const delay = Number(state.lingerMs) || 0;
      if (delay <= 0) { collapse(row); return; }
      const timer = setTimeout(() => { timers.delete(timer); collapse(row); }, delay);
      timers.add(timer);
    }

    /* ---------------------------------------------- 长思考限高内滚 -- */

    /**
     * 把「正在流式」的思考正文压进一个限高内滚窗口：页面不被它拽着往下滚，
     * 窗口内部自己滚到最新。官方对过程组正文就是这么做的（max-height:min(400px,50vh)）。
     */
    function applyThinkWindow(row) {
      const cap = Math.max(0, Number(state.thinkWindowMax) || 0);
      const body = bodyOf(row);
      if (body === null) return;
      const win = thinkWindow.get(row);

      if (cap === 0) { clearThinkWindow(row); return; }

      // 上限尽早挂上（内容还短时也挂，避免它长高后一次性跳）；值变了才重写
      const desired = 'min(' + cap + 'px, 60vh)';
      if (win === undefined || win.cap !== desired) {
        body.style.overflow = 'auto';
        body.style.overflowAnchor = 'none';   // 关掉原生 scroll anchoring，别跟我们的跟随打架
        body.style.maxHeight = desired;
      }
      const current = win ?? { cap: desired, following: true, autoTop: 0 };
      if (win === undefined) {
        // 首次挂上：直接钉到最新，别从开头慢慢滚下去
        const bottom = Math.max(0, body.scrollHeight - body.clientHeight);
        body.scrollTop = bottom;
        current.autoTop = bottom;
      }
      if (current.following) kickFollow();
      thinkWindow.set(row, current);
    }

    function clearThinkWindow(row) {
      const body = bodyOf(row);
      if (body !== null) {
        body.style.maxHeight = '';
        body.style.overflow = '';
        body.style.overflowAnchor = '';
      }
      thinkWindow.delete(row);
    }

    /**
     * 平滑跟随：每帧往底部逼近一段，把流式内容的「跳」变成「滑」。
     * 关键点：只要还有「正在跟随」的思考窗口，循环就每帧自持 —— 每帧直接读最新的
     * scrollHeight。这样即使正文只是文本节点在变（一句话还在写、还没换行，characterData），
     * 下一帧也能跟上，而不是等整句话/整段落的结构变化才被唤醒。
     */
    function followLoop() {
      followFrame = 0;
      if (stopController === null || state.enabled === false) return;
      let anyFollowing = false;
      const ease = Math.min(1, Math.max(0.05, Number(state.followEase) || 0.55));
      for (const row of collectRows()) {
        if (!row.matches(THINK)) continue;
        const win = thinkWindow.get(row);
        if (win === undefined || !win.following) continue;
        anyFollowing = true;
        const body = bodyOf(row);
        if (body === null) continue;
        const target = Math.max(0, body.scrollHeight - body.clientHeight);
        const delta = target - body.scrollTop;
        if (delta > 0.5) {
          const step = Math.max(delta * ease, 1.2);   // 每帧吃掉 ease 比例，至少 1.2px
          body.scrollTop = Math.min(target, body.scrollTop + step);
          win.autoTop = body.scrollTop;
        } else if (delta < -0.5) {
          body.scrollTop = target;   // 内容变矮（重排/删行，少见）：直接贴回
          win.autoTop = target;
        }
      }
      if (anyFollowing) followFrame = requestAnimationFrame(followLoop);
    }

    function kickFollow() {
      if (followFrame !== 0) return;
      followFrame = requestAnimationFrame(followLoop);
    }

    /**
     * 区分「我们自己滚」和「你往上滚」：我们只会把窗口往底部推（scrollTop 递增），
     * 你往上滚会让 scrollTop 明显小于我们上次放到的位置 —— 只有那样才暂停跟随；
     * 滚回底部则恢复跟随。
     */
    function onWindowScroll(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest(THINK);
      if (row === null) return;
      const win = thinkWindow.get(row);
      if (win === undefined) return;
      if (target.scrollTop < win.autoTop - 8) {
        win.following = false;   // 用户往上滚了：松手
      } else if (target.scrollTop >= target.scrollHeight - target.clientHeight - 2) {
        win.following = true;    // 滚回底部：恢复跟随
        kickFollow();
      }
    }

    /* -------------------------------------------------------------- 主循环 -- */

    function tick() {
      if (stopController === null || state.enabled === false) return;
      try {
        runTick();
      } catch (error) {
        // 显示类插件最糟的失败方式是「安静地不工作」，所以这里必须出声
        if (errorCount < 3) { errorCount += 1; console.error('[dsh-think-fold] 扫描失败', error); }
      }
    }

    function runTick() {
      const rows = collectRows();

      const live = new Set();
      for (const row of rows) if (isLive(row)) live.add(row);

      // 首次真的看到行时留一行日志：这行出现 = 选择器与当前 DSH 对得上
      if (!announced && rows.length > 0) {
        announced = true;
        console.log('[dsh-think-fold] 已接管 ' + rows.length + ' 条过程行（正在跑 ' + live.size + ' 条）');
      }

      // 记录「从何时起在跑」：刚进入 live 的行要等满 minLiveMs 才值得展开
      const now = performance.now();
      const threshold = Math.max(0, Number(state.minLiveMs) || 0);
      let waiting = false;
      for (const row of live) {
        if (!liveSince.has(row)) {
          liveSince.set(row, now);
          if (threshold > 0) waiting = true;
        }
      }
      // 门槛期间行可能一直不产生 DOM 变化（长时间静默的命令），所以自己补一次唤醒
      if (waiting && threshold > 0 && minLiveTimer === 0) {
        minLiveTimer = setTimeout(() => { minLiveTimer = 0; schedule(); }, threshold + 30);
      }

      // ① 正在跑的：保持展开（preparing 阶段的卡官方不可展开，controlOf 会给 null，跳过）
      for (const row of live) {
        if (userOwned.has(row)) continue;
        if (threshold > 0 && now - (liveSince.get(row) ?? now) < threshold) continue;
        requestToggle(row, true);
      }

      // ①b 思考正文限高内滚：正在流式的压成内滚窗口，跑完的还原全高（动画中的行不动）
      for (const row of rows) {
        if (!row.matches(THINK) || animating.has(row)) continue;
        if (live.has(row)) applyThinkWindow(row); else clearThinkWindow(row);
      }

      // ② 刚刚跑完的：收起 —— 「执行完收起」就是这一步
      for (const row of lastLive) {
        if (live.has(row)) continue;
        liveSince.delete(row);
        scheduleCollapse(row);
      }

      // ③ keepLast：额外保留最近 N 条已跑完的
      if (state.mode === 'keepLast') {
        const settled = rows.filter((row) => !live.has(row));
        const keepCount = Math.max(0, Number(state.keepLast) || 0);
        const keep = new Set(keepCount === 0 ? [] : settled.slice(-keepCount));
        for (const row of settled) if (!keep.has(row)) scheduleCollapse(row);
      }

      // ④ 一轮结束了却还摊着 → 替你把首行的「已完成 · 用时」点一下，整轮并成一条
      mergeTick();

      lastLive = live;
    }

    function schedule() {
      if (stopController === null || frame !== 0) return;
      frame = requestAnimationFrame(() => { frame = 0; tick(); });
    }

    function setState(patch) {
      state = { ...state, ...patch };
      try { localStorage.setItem(NS, JSON.stringify(state)); } catch { /* 隐私模式等，不影响运行 */ }
      if (state.enabled === false) {
        for (const entry of [...animating.values()]) entry.abort();
        for (const row of collectRows()) if (ours.has(row) && expandedOf(row)) requestToggle(row, false);
        lastLive = new Set();
      }
      notify();
      schedule();
    }

    /* ---------------------------------------------------- 你的手动意图登记 -- */

    function markUserGesture(event) {
      if (synthetic) return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      // 首行那条「已完成 · 用时」：你点过它就是你想看，此后永不再自动合并
      const header = target.closest(TURN_HEADER);
      if (header !== null) turnOwned.add(header);

      const control = target.closest(CONTROL);
      if (control === null) return;
      const row = control.closest(ANY_ROW);
      if (row === null) return;
      userOwned.add(row);
      // 收起伏笔正飞着的时候你点了它：立刻中止并还原，别和你的操作抢
      const entry = animating.get(row);
      if (entry !== undefined) entry.abort();
    }

    function onKeydown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      markUserGesture(event);
    }

    /* -------------------------------------------------------------- 生命周期 -- */

    function start() {
      if (stopController !== null) return stopController;

      document.addEventListener('click', markUserGesture, true);
      document.addEventListener('keydown', onKeydown, true);
      document.addEventListener('scroll', onWindowScroll, true);

      observer = new MutationObserver(schedule);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,   // 流式正文在一句话内的字符变化也要唤醒 tick
        attributeFilter: ['data-state', 'data-expanded', 'aria-expanded', 'data-open'],
      });

      stopController = function stop() {
        stopController = null;
        try { observer.disconnect(); } catch { /* ignore */ }
        observer = null;
        document.removeEventListener('click', markUserGesture, true);
        document.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('scroll', onWindowScroll, true);
        if (frame !== 0) { cancelAnimationFrame(frame); frame = 0; }
        if (followFrame !== 0) { cancelAnimationFrame(followFrame); followFrame = 0; }
        if (minLiveTimer !== 0) { clearTimeout(minLiveTimer); minLiveTimer = 0; }
        if (mergeTimer !== 0) { clearTimeout(mergeTimer); mergeTimer = 0; }
        turnQueue.clear();
        for (const entry of [...animating.values()]) entry.abort();   // 过渡在飞的先还原
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        // 卸下时把我们撑开过的行收回去：不在会话里留下插件的痕迹
        synthetic = true;
        try {
          for (const row of collectRows()) {
            if (!row.isConnected || !ours.has(row) || !expandedOf(row)) continue;
            const control = controlOf(row);
            if (control !== null) control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }
        } catch { /* ignore */ } finally { synthetic = false; }
        lastLive = new Set();
        if (window.__dshThinkFold !== undefined) { try { delete window.__dshThinkFold; } catch { /* ignore */ } }
      };

      window.__dshThinkFold = {
        state: () => ({ ...state }),
        set: setState,
        rows: () => collectRows().map((row, index) => ({
          index,
          kind: row.matches(THINK) ? 'think' : (row.getAttribute('data-tool') || row.getAttribute('data-sample')),
          state: row.getAttribute('data-state'),
          live: isLive(row),
          liveMs: liveSince.has(row) ? Math.round(performance.now() - liveSince.get(row)) : null,
          expandable: controlOf(row) !== null,
          expanded: expandedOf(row),
          animating: animating.has(row),
          ours: ours.has(row),
          userOwned: userOwned.has(row),
          text: (row.textContent || '').replace(/\s+/g, ' ').slice(0, 40),
        })),
        scan: tick,
        merge: () => ({
          ...mergeSnapshot,
          official: officialMode(),
          folding: isFolding(mergeSnapshot.mode),
          switchOn: state.mergeTurns !== false,
          delayMs: Math.round(Number(state.mergeDelayMs) || 0),
          turns: collectTurnHeaders().map((header) => ({
            turn: header.getAttribute('data-turn-process'),
            open: header.hasAttribute('data-open'),
            disabled: header.disabled === true,
            queued: turnQueue.has(header),
            owned: turnOwned.has(header),
            label: (header.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          })),
        }),
        setMerge: setMergeSwitch,
        dispose: () => { const stop = stopController; if (stop !== null) stop(); },
      };

      schedule();
      return stopController;
    }

    /* ------------------------------------------------ 完成后合并整轮过程行 -- */
    /*
     * 目标：一轮跑完后，这一整轮的「思考 / 运行命令 / 读取 / …」全部收进首行那条
     *       「已完成 · 用时 3分50秒」里，屏幕上只留这一条。
     *
     * 那条首行是官方 TurnProcessNodeView（dsh-client-ui-chat/lib/client.js:8690），
     * 只在 turn.status === 'closed' 时渲染，点了就是 actions.setTurnProcessOpen()。
     * 官方自带的合并开关是设置 ui-chat.transcriptView 的四档（同文件 POLICIES）：
     *
     *   compact   foldCompletedTurns:true   stepGrouping:'collapsed'
     *   standard  foldCompletedTurns:true   stepGrouping:'collapsed'
     *   detailed  foldCompletedTurns:true   stepGrouping:'history'   ← 只折「已结束的轮」
     *   verbose   foldCompletedTurns:false  stepGrouping:'none'      ← 一行不折
     *
     * 所以要分两层，缺一不可：
     *   ① 官方档位得是会折的档。verbose 下 ChatNodeSeat 的 foldCompleted 恒 false，
     *      processHidden 永远不成立 → 首行和几十行一起摊着；而且此时首行的 button 是
     *      disabled，连合成点击都进不了它的 onClick。
     *   ② 折叠时机由官方 store 的 storedOpen 决定：某轮一旦被点开过就一直摊着。所以某轮
     *      结束了却还摊着时，我们自己再点一次首行，把它收起来。这不是 DOM 手术 —— 官方
     *      那个按钮就是原生的「整轮开合」控件，点了会落进官方 store，真实且持久。
     *
     * 为什么不自己隐藏行 + 插一条摘要行：官方列表是 React 渲染的，往里塞非它自己的节点
     * 很脆；而被折掉的行拿到的是 hidden 属性，collectRows() 里 `closest('[hidden]')`
     * 本来就会跳过它们，两层天然不打架。
     * 也不能选 standard/compact：它们的 stepGrouping:'collapsed' 在轮内就开始编组，会把
     * 「正在执行的那一条」也折进去，跟逐行自动开合抢。detailed 只折已结束的轮 —— 跑着的
     * 轮永远展开（turnProcessAlwaysOpen + liveProcess），轮内开合完全不受影响。
     */
    const CHAT_NS = 'ui-chat';
    const TRANSCRIPT_FIELD = 'transcriptView';
    const MERGE_MODE = 'detailed';
    // { seeded, prev } —— seeded = 首次兜过底；prev = 我们动手之前的官方档位
    const MERGE_STORE = NS + ':merge';
    const FOLDING_MODES = new Set(['compact', 'standard', 'detailed']);
    const TURN_HEADER = '[data-turn-process]';
    const MODE_LABEL = { compact: '精简', standard: '标准', detailed: '详细', verbose: '不合并' };

    let chatForm = null;
    let mergeState = { mode: undefined, busy: false, error: '' };
    let mergeSnapshot = { ...mergeState };
    const mergeListeners = new Set();
    function notifyMerge() {
      mergeSnapshot = { ...mergeState };
      for (const listener of [...mergeListeners]) { try { listener(); } catch { /* ignore */ } }
    }
    function subscribeMerge(listener) {
      mergeListeners.add(listener);
      return () => { mergeListeners.delete(listener); };
    }
    const readMerge = () => mergeSnapshot;

    function readMergeRecord() {
      try {
        const cached = JSON.parse(localStorage.getItem(MERGE_STORE) || 'null');
        return cached !== null && typeof cached === 'object' ? cached : {};
      } catch { return {}; }
    }
    function writeMergeRecord(patch) {
      try { localStorage.setItem(MERGE_STORE, JSON.stringify({ ...readMergeRecord(), ...patch })); } catch { /* ignore */ }
    }
    /** 还原完官方档位就把 prev 忘掉，免得下次"关掉"时又拨回一个早就过期的档。 */
    function forgetMergePrev() {
      const record = readMergeRecord();
      if (!('prev' in record)) return;
      delete record.prev;
      try { localStorage.setItem(MERGE_STORE, JSON.stringify(record)); } catch { /* ignore */ }
    }

    /** 官方实时档位；undefined = Host 设置还没送到（别当成用户选了 verbose）。 */
    function officialMode() {
      if (chatForm === null) return undefined;
      const value = chatForm.getSnapshot()?.value;
      return typeof value?.transcriptView === 'string' ? value.transcriptView : undefined;
    }

    /** 这一档会不会把「已结束的轮」并成一条。normal / expanded 是官方的旧档名。 */
    function isFolding(mode) {
      if (mode === 'normal' || mode === 'expanded') return true;
      return FOLDING_MODES.has(mode);
    }

    /** 写官方设置；Host 可能拒绝，所以返回是否被接受，调用方再用快照核对。 */
    async function writeOfficialMode(mode) {
      if (chatForm === null) return false;
      try {
        const accepted = typeof chatForm.set === 'function'
          ? await chatForm.set(TRANSCRIPT_FIELD, mode)
          : await chatForm.mutate([{ op: 'set', path: [TRANSCRIPT_FIELD], value: mode }]);
        return accepted !== false;
      } catch (error) {
        console.error('[dsh-think-fold] 写官方「工作详情」档位失败', error);
        return false;
      }
    }

    /**
     * 第一层：让官方处于「会折」的档位。
     * verbose（不合并）时拨到 detailed，并记住拨之前是哪一档，关掉时还原。
     */
    async function bundleOfficial() {
      const mode = officialMode();
      if (mode === undefined) return false;              // 设置还没送到，等 sync 兜
      if (isFolding(mode)) return true;
      writeMergeRecord({ prev: mode });
      mergeState = { ...mergeState, busy: true, error: '' };
      notifyMerge();
      const accepted = await writeOfficialMode(MERGE_MODE);
      const after = officialMode();
      mergeState = {
        ...mergeState,
        busy: false,
        mode: after,
        error: accepted && isFolding(after) ? '' : '官方设置没接受这次改动',
      };
      notifyMerge();
      schedule();
      return mergeState.error === '';
    }

    /** 关掉合并：只还原我们动过的官方档位；没动过就一个字节也不写。 */
    async function unbundleOfficial() {
      const record = readMergeRecord();
      if (typeof record.prev !== 'string') return true;
      const back = record.prev;
      mergeState = { ...mergeState, busy: true, error: '' };
      notifyMerge();
      const accepted = await writeOfficialMode(back);
      if (accepted) forgetMergePrev();
      mergeState = { ...mergeState, busy: false, mode: officialMode(), error: accepted ? '' : '官方设置没接受这次改动' };
      notifyMerge();
      schedule();
      return accepted;
    }

    /** 面板上那个开关：自己的规则立刻生效，官方档位异步跟着拨。 */
    function setMergeSwitch(on) {
      setState({ mergeTurns: on });
      (on ? bundleOfficial() : unbundleOfficial()).catch((error) => {
        console.error('[dsh-think-fold] 切换「完成后合并整轮」失败', error);
      });
    }

    /* ---- 第二层：一轮结束却还摊着，就替你把首行那条点一下 ---- */

    const turnSeen = new WeakSet();   // 处理过、或看到时本来就是合并态（一轮只处理一次）
    const turnOwned = new WeakSet();  // 你亲手开合过的首行：永不自动收
    const turnQueue = new Map();      // 首行 -> 该收的时间点（留点时间看清最后一行）
    let mergeTimer = 0;

    /** 流里所有「已完成 · 用时」首行（跳过被官方的 hidden 藏起来的）。 */
    function collectTurnHeaders() {
      const flow = document.querySelector(FLOW);
      if (flow === null) return [];
      const out = [];
      for (const node of flow.querySelectorAll(TURN_HEADER)) {
        if (node instanceof HTMLElement && node.closest('[hidden]') === null) out.push(node);
      }
      return out;
    }

    /** 派发一个合成点击 —— 和 requestToggle 同一套：只点，不模拟指针。 */
    function clickOnce(el) {
      synthetic = true;
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch {
        return false;
      } finally {
        synthetic = false;
      }
      return true;
    }

    function mergeWake(delay) {
      if (mergeTimer !== 0) clearTimeout(mergeTimer);
      mergeTimer = setTimeout(() => { mergeTimer = 0; schedule(); }, Math.max(30, delay));
    }

    function mergeTick() {
      if (state.mergeTurns === false) return;
      const now = performance.now();
      for (const header of collectTurnHeaders()) {
        if (turnSeen.has(header) || turnOwned.has(header)) continue;
        if (header.disabled === true) continue;            // 官方不收：还在跑 / 被中断 / 出错 / 没内容
        turnSeen.add(header);
        if (!header.hasAttribute('data-open')) continue;   // 本来就已合并成一条，什么都不用做
        turnQueue.set(header, now + Math.max(0, Number(state.mergeDelayMs) || 0));
      }
      if (turnQueue.size === 0) return;

      let wakeIn = Infinity;
      for (const [header, due] of [...turnQueue]) {
        if (now < due) { wakeIn = Math.min(wakeIn, due - now); continue; }
        turnQueue.delete(header);
        if (!header.isConnected || header.disabled === true) continue;
        if (!header.hasAttribute('data-open') || turnOwned.has(header)) continue;
        if (clickOnce(header) && state.debug === true) {
          console.log('[dsh-think-fold] 整轮合并', header.getAttribute('data-turn-process'));
        }
      }
      // 队列里还有没到点的：补一次唤醒（DOM 不再变化时 rAF 不会被叫醒）
      if (turnQueue.size !== 0 && wakeIn !== Infinity) mergeWake(Math.min(wakeIn + 40, 5000));
    }

    /**
     * 订阅官方档位：面板显示「官方现在哪一档、会不会折」；首次运行按开关兜一次底。
     * 之后你在官方设置页里手选任何档位，这里都只反映、不再覆盖。
     */
    function bindOfficialSetting(scope) {
      const form = scope.configForms.get(CHAT_NS);
      chatForm = form;

      const sync = () => {
        const mode = officialMode();
        if (mode !== mergeState.mode) {
          mergeState = { ...mergeState, mode };
          notifyMerge();
        }
        if (mode === undefined || mergeState.busy) return;   // Host 设置还没到 / 正在写
        const record = readMergeRecord();
        // 你在官方设置页里手选了第三个档位 → 尊重你的选择，别把老 prev 还回去覆盖它
        if (typeof record.prev === 'string' && mode !== MERGE_MODE && mode !== record.prev) forgetMergePrev();
        if (record.seeded === true) return;                  // 兜过一次了，之后只反映
        writeMergeRecord({ seeded: true });
        if (state.mergeTurns === false || isFolding(mode)) return;
        console.warn('[dsh-think-fold] 官方「工作详情」档位是 ' + mode
          + '（不合并整轮），已按插件开关切到 ' + MERGE_MODE + '；可在插件面板里关掉并还原。');
        bundleOfficial().catch((error) => console.error('[dsh-think-fold] 兜底切换失败', error));
      };
      sync();

      const off = form.subscribe(sync);
      return () => {
        try { if (typeof off === 'function') off(); } catch { /* ignore */ }
        if (chatForm === form) chatForm = null;
      };
    }

    /* ------------------------------------------------------------ 设置界面 -- */
    // 手写界面：只用 React 原生元素 + 主题 token，不依赖任何客户端 UI 包 ——
    // 依赖越少，越不容易被 DSH 升级打断。入口：设置 → 思考折叠。

    // 拿不到 React 也不许在加载期炸掉：图标是模块级元素，兜一个"什么都不生成"的 h
    const h = React === null ? () => null : React.createElement;

    const SETTINGS_CSS = [
      // 输入框里的那个按钮：尺寸/圆角/取色全部对齐官方添加按钮（.uWtHQG_add）
      '.dshtf-trigger{corner-shape:round;background:var(--dsw-specific-selector);width:28px;height:28px;',
      'color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;flex:none;',
      'place-items:center;display:grid;padding:0;transition:background 120ms ease}',
      '.dshtf-trigger:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dshtf-trigger[data-open]{background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dshtf-trigger[data-off]{opacity:.5}',
      // 位置：官方把「输入框左槽」(conversation.input.left) 排在 .modes（权限 / 计划）之后，
      // 想紧挨着「＋」就得自己排一下 —— 工具行是 flex，用 order 把 .modes 挪到我们后面。
      // 槽本身渲染成 `div[data-slot=...]{display:contents}`（不生成盒子），所以按钮就是工具行的
      // flex 子项；这里靠「谁是那个槽的直接父级」认行，不写死官方 hash 类名。
      '.dshtf-trigger{order:1}',
      'div:has(> [data-slot="conversation.input.left"]) > div:not([data-slot]){order:2}',
      // 面板：挂在 shell.overlay（帧级浮层），不受聊天区 container 的裁剪
      // shell.overlay 本身是「点击穿透」的，占用者必须自己声明 pointer-events
      '.dshtf-backdrop{position:fixed;inset:0;z-index:39;background:transparent;pointer-events:auto}',
      '.dshtf-panel{position:fixed;z-index:40;box-sizing:border-box;width:340px;max-height:min(72vh,560px);',
      'overflow-y:auto;pointer-events:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);',
      'font-size:13px;line-height:20px;padding:12px 14px}',
      '.dshtf-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}',
      '.dshtf-title{font-weight:500}',
      '.dshtf-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'font:inherit;padding:2px 6px;border-radius:var(--dsw-radius-sm)}',
      '.dshtf-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshtf-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;margin-bottom:8px}',
      '.dshtf-row{display:flex;flex-direction:column;gap:4px;padding:9px 0;',
      'border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshtf-rowHead{display:flex;align-items:center;gap:12px}',
      '.dshtf-rowTitle{flex:1;min-width:0}',
      '.dshtf-rowControl{flex:none;display:flex;align-items:center;gap:8px}',
      '.dshtf-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}',
      '.dshtf-switch{position:relative;width:36px;height:20px;border-radius:999px;border:none;padding:0;flex:none;',
      'background:var(--dsw-alias-border-l2);cursor:pointer;transition:background 120ms ease}',
      '.dshtf-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dshtf-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:var(--dsw-alias-bg-base);transition:transform 120ms ease}',
      '.dshtf-switch[aria-checked="true"] .dshtf-knob{transform:translateX(16px)}',
      '.dshtf-slider{display:inline-flex;align-items:center;gap:8px}',
      '.dshtf-slider input[type=range]{width:128px;accent-color:var(--dsw-alias-brand-primary)}',
      '.dshtf-value{min-width:52px;text-align:right;color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums}',
      '.dshtf-foot{display:flex;align-items:center;gap:12px;padding-top:10px;',
      'border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshtf-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);padding:5px 10px;cursor:pointer;font:inherit}',
      '.dshtf-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    ].join('');

    function injectSettingsStyles() {
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = NS + '/composer-ui';
      tag.textContent = SETTINGS_CSS;
      document.head.appendChild(tag);
      return tag;
    }

    function Toggle({ checked, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        className: 'dshtf-switch',
        onClick: () => onChange(!checked),
      }, h('span', { className: 'dshtf-knob' }));
    }

    function Slider({ value, min, max, step, suffix, onChange }) {
      return h('span', { className: 'dshtf-slider' },
        h('input', {
          type: 'range', min, max, step, value,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        h('span', { className: 'dshtf-value' }, String(value) + suffix));
    }

    function Row({ title, desc, children }) {
      return h('div', { className: 'dshtf-row' },
        h('div', { className: 'dshtf-rowHead' },
          h('div', { className: 'dshtf-rowTitle' }, title),
          h('div', { className: 'dshtf-rowControl' }, children)),
        desc === undefined ? null : h('div', { className: 'dshtf-rowDesc' }, desc));
    }

    /** 「完成后合并整轮」那行的说明：自己的开关 + 官方档位的实时状态。 */
    function mergeDesc(s, m) {
      if (m.error !== '') return m.error;
      const label = m.mode === undefined ? '' : (MODE_LABEL[m.mode] || m.mode);
      if (s.mergeTurns === false) {
        if (m.mode === undefined) return '关掉后每行各占一条（正在跑的那条照旧自动展开）。';
        return isFolding(m.mode)
          ? '关掉后每行各占一条。注意官方档位仍是「' + label + '」，它自己也会合并已结束的轮。'
          : '关掉后每行各占一条（正在跑的那条照旧自动展开）。';
      }
      if (m.mode === undefined) return '正在读官方「工作详情」档位…';
      return isFolding(m.mode)
        ? '一轮跑完并成一条「已完成 · 用时 3分50秒」，点它随时展开。官方档位：' + label + ' ✓'
        : '官方档位是「' + label + '」（不合并），正在切到「详细」…';
    }

    /* 按钮在 composer 槽、面板在 shell.overlay 槽，两边共享这一个 store。 */
    const PANEL_WIDTH = 340;
    let panelState = { open: false, left: 8, bottom: 8 };
    let panelSnapshot = { ...panelState };
    const panelListeners = new Set();
    function notifyPanel() {
      panelSnapshot = { ...panelState };
      for (const listener of [...panelListeners]) { try { listener(); } catch { /* ignore */ } }
    }
    function subscribePanel(listener) {
      panelListeners.add(listener);
      return () => { panelListeners.delete(listener); };
    }
    const readPanel = () => panelSnapshot;
    function openPanel(anchor) {
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth || 1200;
      panelState = {
        open: true,
        left: Math.max(8, Math.min(rect.left, viewportWidth - PANEL_WIDTH - 8)),
        bottom: Math.max(8, (window.innerHeight || 800) - rect.top + 8),
      };
      notifyPanel();
    }
    function closePanel() {
      if (!panelState.open) return;
      panelState = { ...panelState, open: false };
      notifyPanel();
    }

    /** 自设计的图标：折角箭头压向一条横线 —— 「折起来」，16px、1.5 描边，小尺寸下也干净。 */
    const COLLAPSE_ICON = h('svg', {
      viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    },
      h('path', { d: 'M4 4.4 8 7.6l4-3.2' }),
      h('path', { d: 'M3.8 11.2h8.4' }));

    /** 输入框左侧、官方「+」添加按钮旁边的那个按钮。 */
    function ComposerButton() {
      const s = React.useSyncExternalStore(subscribeSettings, readSettings);
      const panel = React.useSyncExternalStore(subscribePanel, readPanel);
      const on = s.enabled !== false;
      return h('button', {
        type: 'button',
        className: 'dshtf-trigger',
        'data-open': panel.open ? '1' : undefined,
        'data-off': on ? undefined : '1',
        'aria-label': '思考折叠设置',
        'aria-haspopup': 'dialog',
        'aria-expanded': panel.open ? 'true' : 'false',
        title: '思考折叠：' + (on ? '已启用' : '已停用') + '（点开调参数）',
        onClick: (event) => {
          if (panelState.open) { closePanel(); return; }
          openPanel(event.currentTarget);
        },
      }, COLLAPSE_ICON);
    }

    /** 参数面板：挂在 shell.overlay，不受聊天区 container 的裁剪，也不挤 composer 布局。 */
    function PanelLayer() {
      const s = React.useSyncExternalStore(subscribeSettings, readSettings);
      const panel = React.useSyncExternalStore(subscribePanel, readPanel);
      const m = React.useSyncExternalStore(subscribeMerge, readMerge);
      React.useEffect(() => {
        if (!panel.open) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') closePanel(); };
        const onResize = () => closePanel();
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onResize);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          window.removeEventListener('resize', onResize);
        };
      }, [panel.open]);
      if (!panel.open) return null;

      const set = (patch) => setState(patch);
      const keepLast = Math.max(0, Number(s.keepLast) || 0);
      return h(React.Fragment, null,
        h('div', { className: 'dshtf-backdrop', onClick: closePanel }),
        h('div', {
          className: 'dshtf-panel',
          role: 'dialog',
          'aria-label': '思考折叠设置',
          style: { left: panel.left + 'px', bottom: panel.bottom + 'px' },
        },
        h('div', { className: 'dshtf-head' },
          h('div', { className: 'dshtf-title' }, '思考折叠'),
          h('button', {
            type: 'button', className: 'dshtf-x', 'aria-label': '关闭', onClick: closePanel,
          }, '✕')),
        h('div', { className: 'dshtf-hint' },
          '正在执行的那一条自动展开，跑完自动收起（思考行与工具卡同一套规则）。改动即时生效。'),
        h(Row, { title: '启用', desc: '关掉即回到官方行为，已撑开的会收回' },
          h(Toggle, { checked: s.enabled !== false, onChange: (v) => set({ enabled: v }) })),
        h(Row, { title: '完成后合并整轮', desc: mergeDesc(s, m) },
          h(Toggle, {
            checked: s.mergeTurns !== false,
            onChange: (v) => setMergeSwitch(v),
          })),
        h(Row, { title: '合并延迟', desc: '一轮结束后先停这么久再并成一条，0 = 立刻' },
          h(Slider, {
            value: Math.max(0, Number(s.mergeDelayMs) || 0), min: 0, max: 3000, step: 100, suffix: ' ms',
            onChange: (v) => set({ mergeDelayMs: v }),
          })),
        h(Row, { title: '收起过渡', desc: '0 = 官方那样瞬间消失；200~300 最自然' },
          h(Slider, {
            value: Math.max(0, Number(s.collapseAnimMs) || 0), min: 0, max: 600, step: 20, suffix: ' ms',
            onChange: (v) => set({ collapseAnimMs: v }),
          })),
        h(Row, { title: '收起延迟', desc: '跑完后先停这么久再开始收，读的时候不容易被打断' },
          h(Slider, {
            value: Math.max(0, Number(s.lingerMs) || 0), min: 0, max: 5000, step: 100, suffix: ' ms',
            onChange: (v) => set({ lingerMs: v }),
          })),
        h(Row, { title: '淡出程度', desc: '过渡期间正文淡到多透明；100% = 只收高度、不淡出' },
          h(Slider, {
            value: Math.round(Math.min(1, Math.max(0, Number(s.collapseFadeTo ?? 0.15))) * 100),
            min: 0, max: 100, step: 5, suffix: ' %',
            onChange: (v) => set({ collapseFadeTo: v / 100 }),
          })),
        h(Row, { title: '最短展开时长', desc: 'read / grep 这类秒回的工具不展开，免得闪一下' },
          h(Slider, {
            value: Math.max(0, Number(s.minLiveMs) || 0), min: 0, max: 2000, step: 50, suffix: ' ms',
            onChange: (v) => set({ minLiveMs: v }),
          })),
        h(Row, { title: '思考窗口高度', desc: '长思考压成内滚窗口，页面不再一直往下滚；0 = 不限高' },
          h(Slider, {
            value: Math.max(0, Number(s.thinkWindowMax) || 0), min: 0, max: 2000, step: 40, suffix: ' px',
            onChange: (v) => set({ thinkWindowMax: v }),
          })),
        h(Row, { title: '跟随平滑度', desc: '越大贴底越紧、越小越绵长' },
          h(Slider, {
            value: Math.round(Math.min(1, Math.max(0.05, Number(s.followEase) || 0.55)) * 100),
            min: 5, max: 100, step: 5, suffix: ' %',
            onChange: (v) => set({ followEase: v / 100 }),
          })),
        h(Row, { title: '工具卡也自动开合', desc: '命令、文件修改、网页、子代理…' },
          h(Toggle, { checked: s.includeTools !== false, onChange: (v) => set({ includeTools: v }) })),
        h(Row, { title: '提问卡也自动展开', desc: 'LLM 用 ask_user_question 问你的时候' },
          h(Toggle, { checked: s.includeQuestions === true, onChange: (v) => set({ includeQuestions: v }) })),
        h(Row, { title: '保留最近几条已跑完的', desc: '0 = 只留正在跑的那条' },
          h(Slider, {
            value: keepLast, min: 0, max: 10, step: 1, suffix: ' 条',
            onChange: (v) => set({ keepLast: v, mode: v > 0 ? 'keepLast' : 'live' }),
          })),
        h(Row, { title: '滚动补偿', desc: '收起时下方内容跳动了再打开' },
          h(Toggle, { checked: s.scrollCompensate === true, onChange: (v) => set({ scrollCompensate: v }) })),
        h('div', { className: 'dshtf-foot' },
          h('button', {
            type: 'button', className: 'dshtf-btn',
            onClick: () => setState({ ...DEFAULTS }),
          }, '恢复默认'),
          h('span', { className: 'dshtf-hint', style: { marginBottom: 0 } }, '存 localStorage，刷新后仍在。'))));
    }

    /** 注册「输入框按钮 + 浮层面板」；返回清理函数（供 ctx.effect 托管）。 */
    function applyComposerUi(scope) {
      const styleTag = injectSettingsStyles();
      const offButton = scope.slots.inject('conversation.input.left', () => scope.slots.register({
        name: 'conversation.input.left',
        id: 'think-fold',
        order: 100,
      }, ComposerButton));
      const offPanel = scope.slots.inject('shell.overlay', () => scope.slots.register({
        name: 'shell.overlay',
        id: 'think-fold-panel',
        order: 40,
      }, PanelLayer));
      return () => {
        closePanel();
        try { offButton(); } catch { /* ignore */ }
        try { offPanel(); } catch { /* ignore */ }
        try { styleTag.remove(); } catch { /* ignore */ }
      };
    }

    function apply(ctx) {
      try {
        if (ctx !== undefined && typeof ctx.effect === 'function') {
          ctx.effect(() => start(), 'dsh-think-fold: live process row controller');
        } else {
          // 没有 effect 也能跑：宁可少一层托管，也不要静默不工作
          start();
        }
      } catch (error) {
        console.error('[dsh-think-fold] 启动失败', error);
      }

      // 输入框按钮 + 浮层面板：slots 走可选注入，拿不到也不影响自动开合
      if (React === null || ctx === undefined || typeof ctx.inject !== 'function') return;

      // 「完成后合并整轮」第一层：官方 ui-chat.transcriptView 得是会折的档；
      // 拿不到 configForms 就只是少这一层兜底，第二层（点首行）照样工作
      try {
        ctx.inject(['configForms'], (scope) => {
          scope.effect(() => bindOfficialSetting(scope), 'dsh-think-fold: official transcript view');
        });
      } catch (error) {
        console.error('[dsh-think-fold] 官方「工作详情」档位绑定失败', error);
      }

      try {
        ctx.inject(['slots'], (scope) => {
          scope.effect(() => applyComposerUi(scope), 'dsh-think-fold: composer button and panel');
        });
      } catch (error) {
        console.error('[dsh-think-fold] 按钮注册失败', error);
      }
    }

    return { apply };
  },
});
