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
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
  };

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
  class MutationObserver { observe() {} disconnect() {} takeRecords() { return []; } }
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

  api.apply({});   // 没有 ctx.effect：start() 直接跑

  /** 推进时钟 + 跑完所有挂起的 rAF / 定时器，然后主动扫一次。 */
  function flush(advanceMs = 1000) {
    clock += advanceMs;
    for (const entry of [...timers.values()]) { timers.clear(); entry.cb(); }
    for (const [id, cb] of [...frames]) { frames.delete(id); cb(); }
  }
  function scan(advanceMs = 1000) {
    flush(advanceMs);
    if (window.__dshThinkFold !== undefined) window.__dshThinkFold.scan();
  }
  /** 模拟你亲手点了某个元素（走 document 捕获监听器，不计入插件派发次数）。 */
  function userClick(el) { fireDocument('click', el); }

  function headers() { return flow.querySelectorAll('[data-turn-process]'); }

  flush(0);   // start() 里那次 schedule()
  return { window, document, flow, headers, scan, flush, userClick, errors, api: () => window.__dshThinkFold };
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

if (failed === 0) {
  console.log('\n全部 ' + (passed) + ' 条通过：合并整轮的判断逻辑符合预期。');
  process.exit(0);
} else {
  console.log('\n' + failed + ' 条失败。');
  process.exit(1);
}
