# dsh-think-fold

Automatically expands the row that is currently running — the official Think row and the official tool cards — and folds it back when it settles. When a turn finishes, that whole turn's process rows merge into the built-in "processed" header, narration included, so only the final answer stays on screen.

Client-only and zero custom rendering: no self-made container, no stylesheet, no Markdown re-implementation. Layout, font sizes, code blocks, diffs and images are all the official ones. The plugin makes exactly one kind of write to the page — dispatching a single `click` on the official `[data-disclosure-row]` — and decides what is running purely from the state the official UI already publishes (`data-state`), never from timers or heuristics. Rows you opened or closed by hand are recorded and never touched again, and uninstalling restores the official settings it changed.

---

**当前正在执行的那一条自动展开，执行完自动收起。** 覆盖两类行：

- 官方的「思考」行
- 官方的**工具卡**：命令（bash）、文件修改（edit / write）、读取、搜索、网页、子代理、工作流…

纯客户端、零渲染：没有自研容器、没有样式、没有 Markdown 复刻 —— **排版、字号、代码块、diff、图片全部是官方的**。

## 它做什么

| 时刻 | 行为 |
|---|---|
| 模型开始思考 | 自动点开那条官方的「思考」行，正文按官方原样铺开 |
| 开始调工具 | 思考那条收起；正在执行的那张工具卡展开（命令、文件 diff…按官方原样） |
| 工具执行完 | 那张工具卡收回官方的一行摘要 |
| 下一个思考 / 下一步开始 | 上一条继续按同一规则轮换 |
| 你手动开合过某条 | **记下来，永不自动动它**（包括你手动收起正在跑的那条，也不抢回去） |
| **一轮跑完** | 这一整轮的思考/命令**并成一条**「已完成 · 用时 3分50秒」，点它随时展开；过程中的旁白一起收进去，只留最终回复 |
| 卸载插件 | 把它撑开过的行收回官方状态 |

判定"谁在跑"**完全读官方自己发布的状态**，没有任何计时器或启发式猜测。

## 一轮跑完并成一条

长会话里「逐行收起」还不够：35 条一行也照样占满屏。所以一轮结束（`turn.status === 'closed'`）后，
这一轮的所有过程行收进官方首行那条 **`[data-turn-process]`「已完成 · 用时 3分50秒」**，屏幕上只留这一条。

这不是自己画的摘要行，是官方内建的整轮编组（`ui-chat` 的 `transcriptView` 档位 + `TurnProcessNodeView`）。
插件的做法分两层，缺一不可：

1. **让官方处于"会折、而且只留最终回复"的状态。** 这其实是两个独立开关，得一起看：

   - `ui-chat.transcriptView` 决定**折不折**。四档语义（`dsh-client-ui-chat/lib/client.js` 的 `POLICIES`）：

   | 档位 | foldCompletedTurns | stepGrouping | 效果 |
   |---|---|---|---|
   | `compact` / `standard` | true | `collapsed` | **轮内**就编组，会跟逐行开合抢 |
   | `detailed` | true | `history` | 只折**已结束的轮** ← 我们要的 |
   | `verbose` | false | `none` | 一行不折：首行和几十行一起摊着，且首行按钮 `disabled` |

   插件面板里打开「完成后合并整轮」时，如果官方是 `verbose` 就拨到 `detailed`，并记住原档位；关掉时还原
   （只还原自己动过的，没动过一个字节也不写）。

   - `ui-chat.foldedReplies` 决定**折起来以后哪些助手回复留在外面**（`FOLDED_REPLIES = ["all", "final"]`）：

     | 值 | 含义 | 收起一轮后 |
     |---|---|---|
     | `all`（**官方默认**） | 每段回复都保留 | 过程旁白（"我来确认一下…"、"已拿到完整指南…"）**全留在外面**，白收 |
     | `final` | 只留最终回复 | 旁白变过程成员，跟思考/命令一起收进去，只剩最后那段正文 |

     源码支点：`dsh-client-ui-chat/lib/client.js` 的 `const keepReplies = usePresentation((policy) => policy.foldedReplies === "all");`
     与 `const replyRow = keepReplies && routedNode?.kind === "assistant-step" && groupPart !== "reasoning" && hasAssistantReplyContent(...)` ——
     `replyRow` 不进 `processMember`，所以 `all` 下收起来也收不掉。插件把这一项兜到 `final`，同样记住原值可还原。

     两个值都只在**已经结束**的轮上生效：跑着的轮 `alwaysOpen = liveProcess` 恒展开，最终回复本身走
     `processAnswer`（`routedNode.data.step === processSpec.answerStep`）始终留在折叠体外面。

2. **一轮结束却还摊着时，替你把首行点一下。** 官方把所有轮的开合存在自己的 store 里，
   某一轮一旦被点开过就会一直摊着。插件扫到「没 `data-open` 就已经是合并态」的什么都不做；
   扫到「摊着且按钮可用」的，等 `mergeDelayMs`（默认 800ms，让你看清最后一行）就点一次，**每轮只点一次**。
   `disabled`（还在跑 / 被中断 / 出错 / 没内容）的跳过；**你亲手点过的首行永不再自动合并**。

为什么不自己隐藏行 + 插一条摘要行：官方列表是 React 渲染的，往里塞非它自己的节点很脆；
而被折掉的行拿到的是 `hidden` 属性，`collectRows()` 里 `closest('[hidden]')` 本来就会跳过它们，两层天然不打架。
跑着的轮永远是展开的（`turnProcessAlwaysOpen` + `liveProcess`），所以**轮内**的逐行自动开合完全不受影响。

## 为什么这么做

官方这些卡片的正文都是**条件挂载**的：

```jsx
open && children
```

收起时正文节点根本不在 DOM 里，所以 CSS 撑不开、克隆也只会得到一份"像但不是"的排版。
唯一既保真又轻的办法就是驱动它自己的开合状态 —— 点它自己的 `onClick`。
本插件对页面**只做这一个写操作**：给 `[data-disclosure-row]` 派发一次 `click`。

## 依赖的官方 DOM 契约（dsh 0.2.0-rc.2 实测）

| 用途 | 选择器 / 取值 |
|---|---|
| 流容器（限定作用范围） | `[data-chat-flow]` |
| 思考行 | `[data-variant="think"]`，`data-state = running \| ok` |
| 工具卡 | `[data-tool="<name>"]` 或 `[data-sample="bash"]`，`data-state = preparing \| running \| stopped \| error \| ok` |
| 开合控件 | `[data-disclosure-row]` + `aria-expanded`（`role=button`，官方 `onClick=onToggle`） |
| 思考展开体 | `[class*="_thinkBody"]` |

判定规则：`data-state ∈ {running, preparing}` = 正在跑 → 展开；刚离开这个集合 = 跑完了 → 收起。

两个细节：

- **`preparing` 阶段官方 `expandable=false`**（参数还在流式、还没有正文），此时没有可点的开关，插件会跳过展开，等它变成 `running` 再展开。
- **思考行的 `running` 只发给当前步骤里正在流式的那一条**（官方 `running = streaming && i === last`），所以思考与工具卡天然按顺序轮换，不需要额外排序。

## 安装 / 卸载

列进插件市场后可以直接在 **Plugins → Discover** 里搜到。不经市场时用 Release 上的预构建包：

```
dsh plugin --profile web add https://github.com/Citrusrr/dsh-think-fold/releases/latest/download/dsh-think-fold.tgz
```

这个链接永远指向最新一版（文件名故意不带版本号）。

**本地开发**：把自己的克隆以 `link:` 方式装进去 ——

```
plugin_manager(install_bundle, "<你的克隆路径>/dsh-think-fold")
```

以 `link:` 方式安装时，**改本目录的文件后刷新页面即生效**，不用重装。

```
plugin_manager(remove_bundle, "dsh-think-fold")
```

卸载后会把插件撑开过的行收回官方状态，并还原它改过的两个官方设置
（`ui-chat.transcriptView` 档位与 `ui-chat.foldedReplies`）。

## 在哪里调

**输入框左侧、「＋」添加按钮右边紧挨着的那个圆形按钮**（28×28，与添加按钮同一套尺寸/圆角/取色）。点它弹出参数面板，**改完即时生效**，存浏览器 localStorage：

| 设置项 | 作用 |
|---|---|
| 启用 | 总开关；关掉即回到官方行为，已撑开的会收回 |
| 收起过渡 | 0 = 官方那样瞬间消失；200~300 最自然（默认 260） |
| 收起延迟 | 跑完后先停这么久再开始收 |
| 淡出程度 | 过渡期间正文淡到多透明；100% = 只收高度不淡出 |
| 最短展开时长 | read / grep 这类秒回的工具不展开，免得闪一下 |
| 思考窗口高度 | 长思考压成内滚窗口，页面不再一直往下滚；0 = 不限高 |
| 工具卡也自动开合 | 命令、文件修改、网页、子代理… |
| 提问卡也自动展开 | LLM 用 `ask_user_question` 问你的时候 |
| 保留最近几条已跑完的 | 0 = 只留正在跑的那条 |
| 滚动补偿 | 收起时下方内容跳动了再打开 |
| 恢复默认 | 一键回到出厂值 |

按钮图标是自绘的「折角箭头压向一条横线」（折起来，16px、1.5 描边，跟「＋」同一套线条风格）；插件停用时图标变半透明，鼠标悬停有提示当前状态。关闭面板：点面板外、按 `Esc`、或点右上角 `✕`。

**两个座位，别放错**：

- 按钮 → `conversation.input.left`（官方 composer 工具行左侧）。官方把这个槽排在 `.modes`（权限 / 计划）**之后**，所以插件用一条 `order` 规则把它视觉上挪到「＋」右侧：`.dshtf-trigger{order:1}` + `div:has(> .dshtf-trigger) > div:not(:has(.dshtf-trigger)){order:2}`（不写死官方 hash 类名，官方改类名也不影响；`:has()` 不被支持时只是回到官方默认位置）。
- 面板 → `shell.overlay`（官方帧级浮层）。**面板不能放在 composer 里**：聊天区带 `container-type: inline-size`（含 `contain: layout`），会把 `position: fixed` 的包含块从视口改成那个祖先并裁掉。另外 `shell.overlay` 本身是**点击穿透**的，占用者必须自己写 `pointer-events: auto`。

界面是手写的（只用 React 原生元素 + 主题 token），不依赖任何客户端 UI 包 —— 依赖越少，越不容易被 DSH 升级打断。

## 调参（控制台）

设置存浏览器 `localStorage`（key `dsh-think-fold`）。控制台：

```js
__dshThinkFold.rows()    // 每一行的 kind / state / live / liveMs / expandable / expanded / ours / userOwned
__dshThinkFold.state()   // 当前设置
__dshThinkFold.scan()    // 立刻重算一次

__dshThinkFold.set({
  enabled: true,
  mode: 'live',             // live = 只留正在跑的；keepLast = 额外保留最近 N 条跑完的
  keepLast: 0,
  lingerMs: 0,              // 跑完后延迟多久再收（毫秒）；想让它多停一会儿就调大
  collapseAnimMs: 260,      // 收起过渡时长；0 = 官方那样瞬间消失
  collapseFadeTo: 0.15,     // 过渡期间淡到多透明（1 = 不淡出，只收高度）
  scrollCompensate: false,  // 收起时手动补 scrollTop；看到跳动了再打开
  minLiveMs: 250,           // 跑满多久才值得展开：read/grep 这类几十毫秒的工具不展开，避免闪一下
  thinkWindowMax: 440,      // 长思考压成内滚窗口（px）；0 = 不限高，思考很长时页面会一直滚
  includeTools: true,       // 工具卡是否参与（关掉 = 只做思考行）
  includeQuestions: false,  // LLM 提问卡 ask_user_question 是否参与
  collapseOwnedOnly: true,  // 只收插件自己展开的（推荐保持 true）
  cooldownMs: 320,          // 点击后等官方重渲染的静默期
  mergeTurns: true,         // 一轮跑完把整轮并成一条「已完成 · 用时」
  mergeDelayMs: 800,        // 轮结束后隔多久才并，0 = 立刻
})

__dshThinkFold.merge()      // 合并相关的实时状态：官方档位 official / foldedReplies、folding / finalOnly、开关、每一轮的首行（open / disabled / queued / owned）
__dshThinkFold.setMerge(false)   // 关掉整轮合并（会把插件动过的两个官方设置都还原）

__dshThinkFold.set({ collapseAnimMs: 0 })        // 回到官方的瞬间收起
__dshThinkFold.set({ lingerMs: 1200 })           // 收之前先多停 1.2 秒
__dshThinkFold.set({ includeQuestions: true })   // 提问卡也自动展开
__dshThinkFold.set({ minLiveMs: 0 })             // 再快的工具也展开
__dshThinkFold.set({ enabled: false })           // 停用，已撑开的会收回
```

## 收起过渡是怎么做的

官方正文是**条件挂载**的（`open && children`），而 `DisclosureRow` 除 hover 的 100ms 颜色过渡外**没有任何过渡** —— 直接点官方收起就是瞬间消失。所以过渡只能由我们在卸载前自己接管一帧：

```
量高度 → max-height: H; overflow: hidden → 强制 reflow
      → max-height: 0; opacity: fadeTo        （duration 毫秒）
      → 过渡结束，这时正文已是 0 高 → 才点官方收起（卸载不会有跳动）
      → 若点击没生效（正文还在）→ 清掉内联样式还原
```

几个刻意的决定：

- **先卷完再点官方**，不是先点官方再补动画 —— 后者会看到一次跳动。
- **过渡期间你点了这一行** → 立即中止并还原，你的操作优先。
- **`prefers-reduced-motion: reduce`** 时整段跳过（官方自己也遵守这条）。
- **滚动补偿默认关**：Chromium 原生 scroll anchoring 与官方自己的跟随逻辑通常已经处理好，手动补有可能打架。看到跳动了再 `scrollCompensate: true`（只在"整行已在视口上方"时按高度差补 `scrollTop`）。

## 契约看门狗

插件的全部正确性压在两层契约上，升级或改动后各跑一次：

```
npm test                      # 打包层 + 行为层，只要有 node 就能跑
node test/package.mjs         # 打包层：宿主认不认这个包
node test/merge.mjs           # 行为层：整轮合并的判断逻辑（极简 DOM 替身里跑 lib/client.js 真身）

npm run test:contract         # DOM 层：官方语义属性还在不在（需要一份 DSH 源码，见下）
```

`contract.mjs` 要找到一份**未打包**的 DSH 源码（打包成 `app.asar` 的安装目录里没有
`node_modules/@deepseek-ai`）。找不到时它会把试过的路径全部打出来。这也正是它不在 `npm test`
里的原因：刚克隆下来的人手上没有 DSH 源码，不该因为一件他没做错的事看到一个红叉。
手里有源码时用参数或环境变量指过去：

```
npm run test:contract -- "D:/path/to/resources/app/node_modules/@deepseek-ai"
$env:DSH_APP_DIR = "D:/path/to/resources/app"     # 或：从 app.asar 解包后的目录
```

**打包层（`test/package.mjs`）**——踩过的坑：`exports` 里必须暴露 `./package.json`。
`client-modules` 定位包清单用的是 `resolve('<包名>/package.json')`；`exports` 一旦存在，
未列出的子路径就被封死，宿主会**直接判定「这不是客户端包」**，浏览器半区根本不会被送进页面。
症状是**完全没反应、且控制台没有任何报错** —— 最容易误判成"选择器不对"。
（对照 8 个社区同类插件：7 个都暴露了它。）

**DOM 层（`test/contract.mjs`）**——对着已安装的 DSH 包源码核对 25 条契约（思考行的
`data-variant` / `data-state` / 条件挂载、工具卡的 `data-tool` / `data-sample` / 状态取值、
`DisclosureRow` 的 `data-disclosure-row` / `aria-expanded` / `onClick` / `open && children`）。
失败 = 官方改了契约，插件会安静地失效（表现为"不再自动开合"，不会破坏页面），按失败项改选择器即可。

## 已知边界

- 靠官方语义属性工作，官方改属性名就会失效 —— 失效表现是"不再自动开合"，不会破坏页面。
- 只处理**会话流里最外层**的过程行：子代理卡展开出的嵌套正文、子调用卡不参与（避免插件去掏你看不见的内层）。
- 官方搜索（Ctrl+F）折叠起来的内容不点。
- **整轮合并的第二层（点首行）是"点一下就收"，没有高度过渡**：官方被折掉的行是直接挂 `hidden` 的，
  成员行是彼此独立的 seat，没有统一 wrapper 可以量高度做动画（官方自己也是瞬收）。
- 整轮合并依赖官方的 `foldCompletedTurns`：`verbose` 档下 `foldable` 恒 false、首行按钮 `disabled`，
  此时只能靠第一层把档位拨到 `detailed` 才有效。
- 无主机半区逻辑：`lib/index.js` 只是一个空 `apply()`，不读写文件、不发网络请求、不碰凭据
  （唯一的外部副作用是经 `configForms` 写官方设置 `ui-chat.transcriptView` 与 `ui-chat.foldedReplies`：
  只在需要时写、都记住原值，关掉面板开关就还原）。
