#!/usr/bin/env node
/**
 * 「完成后合并整轮」第二层（点首行收起来）的行为测试。
 *
 * contract.mjs 证明的是「官方源码里确实有这些属性/条件」；
 * 这个文件把 lib/client.js 的真身放进一套极简 DOM 替身里跑，证明
 * 「插件自己的判断逻辑」对：
 *   一轮结束却还摊着 → 点一次首行 → 之后再也不点；disabled / 已合并 /
 *   被 hidden 藏起 / 你亲手点过 / 开关关掉 —— 都不许点。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/* --------------------------------------------------------- 极简 DOM 替身 -- */
// 只实现插件真正用到的表面：[attr] 选择器、closest、querySelector(All)、
// dispatchEvent、disabled、isConnected。复杂选择器（class*= 等）一律不匹配，
// 插件对这些都有兜底分支，不影响本文件要验证的逻辑。

function matchesOne(el, selector) {
  const found = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (found === null) return false;
  const name = found[1];
  const value = found[2];
  if (!el.attrs.has(name)) return false;
  return value === undefined ? true : el.attrs.get(name) === value;
}
function matches(el, selector) {
  return String(selector).split(',').some((part) => matchesOne(el, part.trim()));
}

class El {
  constructor(tag, attrs = {}, parent = null) {
    this.tagName = String(tag).toUpperCase();
    this.parentElement = parent;
    this.children = [];
    this.attrs = new Map(Object.entries(attrs));
    this.disabled = false;
    this.isConnected = true;
    this.textContent = '';
    this.clicks = 0;
    this.style = {};
    this.dataset = {};
    // 滚动窗口的替身：插件会读 scrollHeight/clientHeight、写 scrollTop
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    if (parent !== null) parent.children.push(this);
  }

  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }

  matches(selector) { return matches(this, selector); }
  closest(selector) {
    let node = this;
    while (node !== null) {
      if (matches(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  descendants(out) {
    for (const child of this.children) { out.push(child); child.descendants(out); }
    return out;
  }
  querySelectorAll(selector) { return this.descendants([]).filter((el) => matches(el, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  dispatchEvent(event) {
    this.clicks += 1;
    this.lastEvent = event;
    // 模拟官方：点「已完成 · 用时」那行 = setTurnProcessOpen(!open)，data-open 跟着翻
    if (event.type === 'click' && this.attrs.has('data-turn-process')) {
      if (this.attrs.has('data-open')) this.attrs.delete('data-open');
      else this.attrs.set('data-open', '');
    }
    if (event.type === 'click') fireDocument('click', this);
    return true;
  }
}

let docListeners = new Map();
function fireDocument(type, target) {
  for (const fn of docListeners.get(type) ?? []) fn({ type, target });
}

/* --------------------------------------------------------------- 环境 -- */

function makeEnv(options = {}) {
  let clock = 0;
  let rafSeq = 0;
  let timerSeq = 0;
  const frames = new Map();
  const timers = new Map();

  const flow = new El('div', { 'data-chat-flow': '' });
  const body = new El('body');
  body.appendChild(flow);

  let turnSeq = 0;
  for (const spec of options.turns ?? []) {
    const parent = spec.hiddenWrapper === true ? new El('div', { hidden: '' }, flow) : flow;
    const header = new El('button', { 'data-turn-process': spec.turn ?? ('t' + (++turnSeq)) }, parent);
    if (spec.open === true) header.setAttribute('data-open', '');
    header.disabled = spec.disabled === true;
    header.textContent = spec.label ?? '已完成 · 用时 3分50秒';
  }

  /* --- 过程组（跑着的一轮 = data-group-expanded-mode + 不限高的正文） --- */
  const processBodies = [];
  for (const spec of options.groups ?? []) {
    const group = new El('div', { 'data-step-process': '', 'data-chat-turn': spec.turn ?? 'g' + processBodies.length }, flow);
    if (spec.live !== false) group.setAttribute('data-group-expanded-mode', '');
    const groupBody = new El('div', { 'data-step-process-body': '' }, group);
    groupBody.scrollHeight = spec.scrollHeight ?? 0;
    groupBody.clientHeight = spec.clientHeight ?? 0;
    new El('div', { 'data-step-process-content': '', 'data-chat-flow': '' }, groupBody);
    processBodies.push(groupBody);
  }

  docListeners = new Map();
  const document = {
    body,
    head: new El('head'),
    documentElement: body,
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener: () => {},
    createElement: (tag) => new El(tag),
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };

  const storage = new Map();
  for (const [key, value] of Object.entries(options.storage ?? {})) storage.set(key, String(value));
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
  };

  /* --- 官方 ui-chat 设置的替身（第一层写这里：transcriptView / foldedReplies） --- */
  const writes = [];
  const formSubs = new Set();
  const officialValue = { ...(options.official ?? {}) };
  const form = {
    getSnapshot: () => ({ value: { ...officialValue } }),
    subscribe: (fn) => { formSubs.add(fn); return () => { formSubs.delete(fn); }; },
    set: (field, value) => {
      writes.push([field, value]);
      officialValue[field] = value;
      for (const fn of [...formSubs]) fn();
      return Promise.resolve(true);
    },
    mutate: (ops) => {
      for (const op of ops) {
        writes.push([op.path[0], op.value]);
        officialValue[op.path[0]] = op.value;
      }
      for (const fn of [...formSubs]) fn();
      return Promise.resolve(true);
    },
  };
  /** 只给 configForms；slots 故意不给（面板/按钮与本文件无关） */
  const cleanups = [];
  const ctx = options.services === true ? {
    effect: (fn) => { const off = fn(); cleanups.push(off); return off; },
    inject: (deps, cb) => {
      if (!deps.every((dep) => dep === 'configForms')) return;
      cb({ configForms: { get: (ns) => { if (ns !== 'ui-chat') throw new Error('未知命名空间 ' + ns); return form; } }, effect: ctx.effect });
    },
  } : {};

  const performance = { now: () => clock };
  // Node 里没有 MouseEvent（浏览器才有），自己给一个够插件用的
  class MouseEventStub {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
      this.defaultPrevented = false;
    }
    preventDefault() { this.defaultPrevented = true; }
  }
  const MouseEvent = MouseEventStub;
  // 记录回调：测试要手动喂一批 MutationRecord，验证「字符变化只唤醒跟随、不重扫结构」
  const observers = [];
  class MutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  const requestAnimationFrame = (cb) => { const id = ++rafSeq; frames.set(id, cb); return id; };
  const cancelAnimationFrame = (id) => { frames.delete(id); };
  const setTimeoutStub = (cb, ms) => { const id = ++timerSeq; timers.set(id, { cb, ms }); return id; };
  const clearTimeoutStub = (id) => { timers.delete(id); };

  let api = null;
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load: ({ factory }) => {
        api = factory((name) => {
          if (name === 'react') {
            // 只要够模块初始化用（图标元素是模块级 h(...)）。UI 注册走不到：本测试不传 ctx.inject
            return {
              createElement: (type, props, ...children) => ({ type, props, children }),
              Fragment: 'Fragment',
              useEffect: () => {},
              useSyncExternalStore: () => null,
            };
          }
          throw new Error('模块表里没有 ' + name);
        });
      },
    },
  };

  const run = new Function(
    'window', 'document', 'performance', 'localStorage', 'MouseEvent', 'MutationObserver',
    'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    'Element', 'HTMLElement', 'console', 'globalThis',
    SOURCE,
  );
  const errors = [];
  const quiet = {
    log() {},
    warn() {},
    error: (...args) => { errors.push(args); console.error('[plugin]', ...args); },
  };
  // 「浏览器模块表里没有 react」→ React 为 null，插件只剩行为层（正是本测试要的）
  run(window, document, performance, localStorage, MouseEvent, MutationObserver,
    requestAnimationFrame, cancelAnimationFrame, setTimeoutStub, clearTimeoutStub,
    El, El, quiet, globalThis);

  api.apply(ctx);   // 不给 services 时是个空 ctx：没有 ctx.effect，start() 直接跑

  /** 推进时钟 + 跑完所有挂起的 rAF / 定时器，然后主动扫一次。 */
  function flush(advanceMs = 1000) {
    clock += advanceMs;
    for (const entry of [...timers.values()]) { timers.clear(); entry.cb(); }
    for (const [id, cb] of [...frames]) { frames.delete(id); cb(); }
  }
  /** 让 await 链跑完（写官方设置是异步的）。 */
  async function settle() {
    for (let i = 0; i < 24; i += 1) await Promise.resolve();
  }
  function scan(advanceMs = 1000) {
    flush(advanceMs);
    if (window.__dshThinkFold !== undefined) window.__dshThinkFold.scan();
  }
  /** 模拟你亲手点了某个元素（走 document 捕获监听器，不计入插件派发次数）。 */
  function userClick(el) { fireDocument('click', el); }

  /** 手动喂一批 MutationRecord（浏览器里由真实 DOM 变化产生）。 */
  function mutate(records) {
    for (const ob of observers) if (typeof ob.cb === 'function') ob.cb(records);
  }

  function headers() { return flow.querySelectorAll('[data-turn-process]'); }

  flush(0);   // start() 里那次 schedule()
  return {
    window, document, flow, headers, processBodies, scan, flush, settle, userClick, mutate, errors, writes, form,
    official: () => ({ ...officialValue }), api: () => window.__dshThinkFold,
  };
}

/* --------------------------------------------------------------- 断言 -- */

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('  ok    ' + name + (detail ? '\n          ↳ ' + detail : ''));
  } else {
    failed += 1;
    console.log('  FAIL  ' + name + (detail ? '\n          ↳ ' + detail : ''));
  }
}

/* --------------------------------------------------------------- 用例 -- */

console.log('完成后合并整轮（第二层）行为：');

{
  const env = makeEnv({ turns: [{ open: true }] });
  env.scan();
  const [header] = env.headers();
  check('轮结束却还摊着 → 点一次首行，把它收起来', header.clicks === 1, '派发 ' + header.clicks + ' 次点击');
  check('收起后首行回到合并态（data-open 消失）', header.hasAttribute('data-open') === false, 'data-open = ' + header.getAttribute('data-open'));
  env.scan();
  env.scan();
  check('之后再也不点（一轮只处理一次）', header.clicks === 1, '累计 ' + header.clicks + ' 次');
}

{
  const env = makeEnv({ turns: [{ open: true, disabled: true }] });
  env.scan();
  const [header] = env.headers();
  check('官方 disabled（还在跑 / 被中断 / 出错 / 没内容）→ 不点', header.clicks === 0, '派发 ' + header.clicks + ' 次点击');
}

{
  const env = makeEnv({ turns: [{ open: false }] });
  env.scan();
  const [header] = env.headers();
  check('本来就已经合并成一条 → 什么都不做', header.clicks === 0, '派发 ' + header.clicks + ' 次点击');
}

{
  const env = makeEnv({ turns: [{ open: true, hiddenWrapper: true }] });
  env.scan();
  const [header] = env.headers();
  check('被 hidden 藏起来的整轮（收起动画中 / 搜索折叠态）→ 不点', header.clicks === 0, '派发 ' + header.clicks + ' 次点击');
}

{
  const env = makeEnv({ turns: [{ open: true }] });
  const [header] = env.headers();
  env.userClick(header);
  env.scan();
  check('你亲手点开过的那一轮 → 永不再自动合并', header.clicks === 0, '派发 ' + header.clicks + ' 次点击');
}

{
  const env = makeEnv({ turns: [{ open: true }] });
  env.api().set({ mergeTurns: false });
  env.scan();
  const [header] = env.headers();
  check('面板开关关掉 → 不点', header.clicks === 0, '派发 ' + header.clicks + ' 次点击');
}

{
  const env = makeEnv({ turns: [{ open: true }] });
  env.api().set({ mergeDelayMs: 2000 });
  const [header] = env.headers();
  env.scan(500);
  check('合并延迟未到 → 先不收', header.clicks === 0, '过了 500ms，派发 ' + header.clicks + ' 次');
  env.scan(2000);
  check('合并延迟到了 → 收起来', header.clicks === 1, '过了 2500ms，派发 ' + header.clicks + ' 次');
}

{
  const env = makeEnv({ turns: [{ turn: 'a', open: true }, { turn: 'b', open: false }, { turn: 'c', open: true }] });
  env.scan();
  const list = env.headers();
  const opened = list.filter((el) => el.clicks > 0).length;
  check('多轮混在一起只收「摊着的」那些', opened === 2, '三个首行分别派发 ' + list.map((el) => el.clicks).join(' / ') + ' 次');
  const snapshot = env.api().merge();
  check('诊断接口能看到每一轮的状态', snapshot.turns.length === 3 && snapshot.turns.every((t) => typeof t.open === 'boolean'),
    JSON.stringify(snapshot.turns.map((t) => ({ turn: t.turn, open: t.open, queued: t.queued }))));
}

/* ---------------- 第一层：把官方两个设置兜到「会折整轮 + 只留最终回复」 ---------------- */

{
  const env = makeEnv({ services: true, official: { transcriptView: 'verbose', foldedReplies: 'all' } });
  await env.settle();
  const written = env.writes.map(([field, value]) => field + '=' + value).join(', ');
  check('官方「不合并 + 旁白全留」→ 两个字段都拨过来',
    env.official().transcriptView === 'detailed' && env.official().foldedReplies === 'final', written || '一个都没写');
  const snapshot = env.api().merge();
  check('诊断接口反映官方状态', snapshot.folding === true && snapshot.finalOnly === true && snapshot.official === 'detailed',
    JSON.stringify({ official: snapshot.official, foldedReplies: snapshot.foldedReplies, finalOnly: snapshot.finalOnly }));
}

{
  // 就是截图那种情况：工作详情档位本来就是 detailed，但过程旁白默认「全留」
  const env = makeEnv({ services: true, official: { transcriptView: 'detailed', foldedReplies: 'all' } });
  await env.settle();
  check('只差「旁白全留」→ 只拨 foldedReplies，不碰工作详情档位',
    env.writes.length === 1 && env.writes[0][0] === 'foldedReplies' && env.writes[0][1] === 'final',
    env.writes.map(([field, value]) => field + '=' + value).join(', ') || '一个都没写');
}

{
  const env = makeEnv({ services: true, official: { transcriptView: 'detailed', foldedReplies: 'final' } });
  await env.settle();
  check('官方本来就是对的状态 → 一个字节也不写', env.writes.length === 0, '写了 ' + env.writes.length + ' 次');
}

{
  const env = makeEnv({
    services: true,
    storage: { 'dsh-think-fold': JSON.stringify({ mergeTurns: false }) },
    official: { transcriptView: 'verbose', foldedReplies: 'all' },
  });
  await env.settle();
  check('开关关着 → 只反映官方状态，不动它', env.writes.length === 0, '写了 ' + env.writes.length + ' 次');
}

{
  const env = makeEnv({ services: true, official: { transcriptView: 'verbose', foldedReplies: 'all' } });
  await env.settle();
  env.api().setMerge(false);
  await env.settle();
  check('关掉面板开关 → 还原成我们动手之前的样子',
    env.official().transcriptView === 'verbose' && env.official().foldedReplies === 'all',
    JSON.stringify(env.official()));
  const again = env.writes.length;
  env.api().setMerge(false);
  await env.settle();
  check('重复关 → 没有可还原的东西就不动', env.writes.length === again, '又多写 ' + (env.writes.length - again) + ' 次');
}

{
  const env = makeEnv({ services: true, official: { transcriptView: 'detailed', foldedReplies: 'all' } });
  await env.settle();
  env.flush(5000);                       // 跳过 4 秒的兜底冷却
  env.form.set('foldedReplies', 'all');  // 你在官方设置页里手动改回「过程旁白全留」
  await env.settle();
  const ours = env.writes.filter(([, value]) => value === 'final').length;  // 只数插件自己写的
  check('你手动改回「旁白全留」→ 冷却过后再兜一次',
    env.official().foldedReplies === 'final' && ours === 2,
    env.writes.map(([field, value]) => field + '=' + value).join(', '));
}

/* ---------------- 跑着的那一轮：整段过程收进限高窗口 ---------------- */

{
  const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 1200, clientHeight: 400 }] });
  env.scan();
  const [body] = env.processBodies;
  check('跑着的一轮 → 过程正文挂上限高窗口',
    body.style.maxHeight === 'min(400px, 60vh)' && body.style.overflowY === 'auto' && body.style.overflowAnchor === 'none',
    JSON.stringify({ maxHeight: body.style.maxHeight, overflowY: body.style.overflowY }));
  check('首次挂上直接钉到最新（不从开头慢慢滚）', body.scrollTop === 800, 'scrollTop = ' + body.scrollTop);
  const snapshot = env.api().windows();
  check('诊断接口能看到这个窗口', snapshot.max === 400 && snapshot.groups[0].capped === true, JSON.stringify(snapshot.groups[0]));
}

{
  const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 1200, clientHeight: 400 }] });
  env.scan();
  const [body] = env.processBodies;
  body.scrollHeight = 1600;          // 又跑了几步，内容变长
  env.flush(16);                     // 一帧
  check('窗口内自己往底部追', body.scrollTop > 800 && body.scrollTop <= 1200, 'scrollTop = ' + body.scrollTop);
  for (let i = 0; i < 40; i += 1) env.flush(16);
  check('追平后停在底部', body.scrollTop === 1200, 'scrollTop = ' + body.scrollTop);
}

{
  const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 1200, clientHeight: 400 }] });
  env.scan();
  const [body] = env.processBodies;
  env.api().set({ processWindowMax: 0 });
  env.scan();
  check('把「过程窗口高度」调成 0 → 样式全还回去（官方原样）',
    body.style.maxHeight === '' && body.style.overflowY === '' && body.style.overflowAnchor === '',
    JSON.stringify(body.style));
}

{
  const env = makeEnv({ groups: [{ turn: 'done', live: false }] });
  env.scan();
  const [body] = env.processBodies;
  check('这一轮已经结束 → 只接高度（上限按官方 50vh），滚动和淡出留给官方',
    body.style.maxHeight === 'min(400px, 50vh)' && (body.style.overflowY ?? '') === '' && (body.style.overflowAnchor ?? '') === '',
    JSON.stringify(body.style));
}

{
  const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 900, clientHeight: 400 }] });
  env.scan();
  const [group] = env.document.querySelectorAll('[data-step-process]');
  const [body] = env.processBodies;
  check('跑着时上限是 60vh（比官方那档多留一点）', body.style.maxHeight === 'min(400px, 60vh)', 'maxHeight = ' + body.style.maxHeight);
  group.removeAttribute('data-group-expanded-mode');   // 这一轮跑完了，官方把组编起来了
  body.style.maskImage = 'linear-gradient(to bottom, transparent 0, #000 24px 100%)';
  env.scan();
  check('轮结束时把内滚和淡出交还官方，高度仍是你调的值',
    body.style.maxHeight === 'min(400px, 50vh)' && body.style.overflowAnchor === '' && body.style.maskImage === '',
    JSON.stringify(body.style));
}

/* ---------------------- 性能：一帧只做一件事 ---------------------- */

console.log('\n性能与流畅度：');

{
  // 流式正文每敲一个字都会来一条 characterData：它只该唤醒跟随，不该触发结构性扫描
  const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 1200, clientHeight: 400 }] });
  env.scan();
  const before = env.api().stats().ticks;
  for (let i = 0; i < 5; i += 1) env.mutate([{ type: 'characterData' }]);
  env.flush(16);
  const stats = env.api().stats();
  check('流式字符变化 → 不重扫结构（ticks 不涨）', stats.ticks === before, 'ticks ' + before + ' → ' + stats.ticks);
  check('流式字符变化 → 只叫醒跟随循环', stats.followWakes > 0, 'followWakes = ' + stats.followWakes);
  check('跟随队列在结构扫描时重建好（每帧不再查 DOM）', stats.followBodies === 1, 'followBodies = ' + stats.followBodies);
}

{
  // 结构性变化（增删节点 / data-state / aria-expanded）该扫还是要扫
  const env = makeEnv({ turns: [{ open: false }] });
  env.scan();
  const before = env.api().stats().ticks;
  env.mutate([{ type: 'childList' }]);
  env.flush(16);
  check('增删节点 → 下一帧重扫一次', env.api().stats().ticks === before + 1, 'ticks ' + before + ' → ' + env.api().stats().ticks);
}

{
  // 缓动按 dt 换算：16.7ms 一帧吃掉 28% 剩余距离；8ms 一帧只吃掉约 14%（同一条曲线，不是同一比例）
  function drop(dt) {
    const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 1200, clientHeight: 400 }] });
    env.scan();                    // 首帧钉底：scrollTop = 800
    const [body] = env.processBodies;
    env.flush(16);                 // 跑掉首帧，建立 lastFollowTs 基准
    body.scrollHeight = 2800;      // 目标 2400 → 剩余距离 1600
    env.flush(dt);
    return body.scrollTop - 800;
  }
  const at60 = drop(16.7);
  const at120 = drop(8);
  check('60Hz 一帧走约 28% 的剩余距离', at60 > 400 && at60 < 500, '一帧走了 ' + Math.round(at60) + 'px');
  check('120Hz（8ms 一帧）同一套缓动 → 一帧只走约一半', at120 > 150 && at120 < 250, '一帧走了 ' + Math.round(at120) + 'px');
}

{
  // 追平后别再空烧 rAF：空转十几帧就停，等 DOM 变化再醒
  const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 1200, clientHeight: 400 }] });
  env.scan();
  const [body] = env.processBodies;
  for (let i = 0; i < 30; i += 1) env.flush(16);       // 追上 + 空转
  const idle = env.api().stats().followFrames;
  for (let i = 0; i < 5; i += 1) env.flush(16);
  check('追平后停止空转（不再白跑帧）', env.api().stats().followFrames === idle, 'followFrames ' + idle + ' → ' + env.api().stats().followFrames);
  body.scrollHeight = 2000;                            // 内容又长了
  env.mutate([{ type: 'characterData' }]);             // 流式继续写
  env.flush(16);
  check('内容一长、字符一来 → 立刻恢复跟随', body.scrollTop > 800, 'scrollTop = ' + body.scrollTop);
}

{
  const env = makeEnv({});
  env.scan();
  const state = env.api().state();
  check('推荐默认值（面板「恢复默认」用的就是这套）',
    state.followEase === 0.28 && state.collapseAnimMs === 200 && state.minLiveMs === 200
      && state.cooldownMs === 260 && state.mergeDelayMs === 600
      && state.thinkWindowMax === 400 && state.processWindowMax === 400,
    JSON.stringify({
      followEase: state.followEase, collapseAnimMs: state.collapseAnimMs, minLiveMs: state.minLiveMs,
      cooldownMs: state.cooldownMs, mergeDelayMs: state.mergeDelayMs,
    }));
}

{
  const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 1200, clientHeight: 400 }] });
  env.scan();
  const [body] = env.processBodies;
  env.api().set({ processWindowEnabled: false });
  env.scan();
  check('关掉「过程窗口」→ 不挂限高（跑着的一轮平铺）',
    body.style.maxHeight === '' && body.style.overflowY === '' && body.style.overflowAnchor === '',
    JSON.stringify(body.style));
  check('诊断接口反映开关状态', env.api().windows().enabled === false && env.api().windows().max === 0,
    JSON.stringify({ enabled: env.api().windows().enabled, max: env.api().windows().max }));
  env.api().set({ processWindowEnabled: true });
  env.scan();
  check('再打开 → 记着的高度立刻回来', body.style.maxHeight === 'min(400px, 60vh)', 'maxHeight = ' + body.style.maxHeight);
}

{
  // 「关掉时高度进度条不展示」—— 面板那一行是可选的，高度值要留着不能丢
  const env = makeEnv({ groups: [{ turn: 'live', scrollHeight: 1200, clientHeight: 400 }] });
  env.scan();
  env.api().set({ processWindowMax: 600 });
  env.scan();
  const [body] = env.processBodies;
  check('调高度到 600 → 立刻生效', body.style.maxHeight === 'min(600px, 60vh)', 'maxHeight = ' + body.style.maxHeight);
  env.api().set({ processWindowEnabled: false });
  check('关掉开关后高度值仍然记着（不归零）', env.api().state().processWindowMax === 600,
    'processWindowMax = ' + env.api().state().processWindowMax);
  env.api().set({ processWindowEnabled: true });
  env.scan();
  check('打开后用的还是 600，而不是回到 400', body.style.maxHeight === 'min(600px, 60vh)', 'maxHeight = ' + body.style.maxHeight);
}

if (failed === 0) {
  console.log('\n全部 ' + (passed) + ' 条通过：合并整轮的判断逻辑符合预期。');
  process.exit(0);
} else {
  console.log('\n' + failed + ' 条失败。');
  process.exit(1);
}