# dsh-think-fold

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
| **跑着的时候** | 这一轮的所有过程（思考/命令/编辑…）都在**一个限高窗口**里，窗口内自己滚到最新，页面不再被越堆越长的过程拽着走 |
| **一轮跑完** | 这一整轮的思考/命令**并成一条**「已完成 · 用时 3分50秒」，点它随时展开；过程中的旁白一起收进去，只留最终回复 |
| 卸载插件 | 把它撑开过的行收回官方状态 |

判定"谁在跑"**完全读官方自己发布的状态**，没有任何计时器或启发式猜测。

## 跑着的时候：过程也在一个窗口里

官方其实**有**这个窗口 —— 但只在「这一轮已经结束、过程被编成组」时给：
`dsh-client-ui-chat/lib/client.js` 的组样式 `.…_body{…max-height:min(400px,50vh);overflow-y:auto}`，
跑着的时候挂的是 `.…_expandedBody{max-height:none;overflow:visible}`（不限高），因为那一轮还没"编成组"。

判据就在 DOM 上：组元素带 **`data-group-expanded-mode`** ⇔ 官方没把它当已结束的组 ⇔ **正在跑**
（`"data-group-expanded-mode": !grouped || void 0`）。官方这时连跟随和边缘淡出都不做
（`useProcessScroll` 第一行 `body.closest("[hidden], [data-group-expanded-mode]") === null` 才工作）。

所以这一块空间是官方留给我们的，插件接手做三件事：

1. **接过限高**：给 `[data-step-process-body]` 写 `max-height: min(<过程窗口高度>px, 60vh)`、`overflow-y:auto`、
   `overflow-anchor:none`（不禁用原生锚定的话，边滚边被浏览器拽回去，就是"卡一下再下去"）。
   首次挂上直接把 `scrollTop` 钉到底，不从开头慢慢滚。
2. **窗口内逐帧跟随**：复用思考窗口那套 `followLoop`（每帧自持、直接读最新 `scrollHeight`、`followEase` 比例 + 最小 1.2px，
   差 2px 以内直接贴底）。你手动往上滚就暂停，滚回底部自动恢复。上下边缘按官方同款 24px 渐变淡出。
3. **不套第二层**：已经在过程窗口里的思考行不再单独开思考窗口（`insideCappedProcess()`），一个窗口就够。

轮一旦结束，`data-group-expanded-mode` 消失 → 滚动、淡出、跟随**当场交还官方**
（它自己的 class 会给 `overflow-y:auto` 和 `fadeTop/fadeBottom`，也有自己的跟随），
我们只把「你调的高度」继续挂着，上限换成官方的 `50vh`；然后才是「一轮跑完并成一条」那层接管。

面板里「过程窗口高度」默认 **400**（跟官方同款），0 = 不限高；控制台 `__dshThinkFold.windows()`
能看到每一组的 `expandedMode / expanded / capped / height / offset / floor`（`offset === floor` 就是已贴底）。

### 一轮里有好几段过程的时候

模型中途说一句话，官方就把过程**切成新的一段**：`TurnGroups.rebuild` 在每条回复节点上就 `flush(true)` 当前组
（`if (reply(node)) { flush(true); emit(key, { kind: "node", key, groupPart: "response" }); }`），
于是「旁白 → 又继续跑」在 DOM 里是**两个并排的过程组**，各自一个 `[data-step-process-body]`。
这套结构改不了（每个组都是 React 自己的节点，本插件不做 DOM 手术），所以这里按**高度预算**来合并：

- **多个过程段：合并（默认）** —— 同一轮（同一个 `data-chat-turn`）的各段**共享**「过程窗口高度」这一份预算：
  前面的段只留 **56px** 一条尾巴（仍然可滚，停在它自己的最后几行），最下面那段拿走剩下的全部（不少于 140px）。
  整轮总高 ≈ 你调的那个高度，段数再多也不会一直往下长。
- **关掉 = 每段独立** —— 回到以前的行为：每段各开一个完整窗口，段数一多页面就明显变长。

想细看前面的某一段：点它自己的组标题（`[data-process-activity]` 那个按钮，`aria-expanded` 会变 true），
这一段就不再压成尾巴、按完整窗口显示；再点一下收回。预算小到不值得合并（< 196px）时自动按每段独立来。

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

插件市场收录后可以在 **Plugins → Discover** 里直接搜到。不经市场时，用 Release 上的预构建包：

```
dsh plugin --profile web add https://github.com/Citrusrr/dsh-think-fold/releases/latest/download/dsh-think-fold.tgz
```

这个链接永远指向最新一版（文件名故意不带版本号）。

本地开发时把自己的克隆以 `link:` 方式装进去，改完刷新页面即生效，不用重装：

```
plugin_manager(install_bundle, "<你的克隆路径>/dsh-think-fold")
```

卸载：

```
plugin_manager(remove_bundle, "dsh-think-fold")
```

卸载会把插件撑开过的行收回官方状态，清掉它写过的内联样式，并还原它改过的两个官方设置
（`ui-chat.transcriptView` 档位、`ui-chat.foldedReplies`）。

## 在哪里调

**输入框左侧、「＋」添加按钮右边紧挨着的那个圆形按钮**（28×28，与添加按钮同一套尺寸/圆角/取色）。点它弹出参数面板，**改完即时生效**，存浏览器 localStorage：

| 设置项 | 作用 |
|---|---|
| 启用 | 总开关；关掉即回到官方行为，已撑开的会收回 |
| 完成后合并整轮 | 一轮跑完把整轮过程并成一条「已完成 · 用时」 |
| 合并延迟 | 一轮结束后先停这么久再并成一条 |
| 收起过渡 | 0 = 官方那样瞬间消失；160~240 最自然（默认 200） |
| 收起延迟 | 跑完后先停这么久再开始收 |
| 淡出程度 | 过渡期间正文淡到多透明；100% = 只收高度不淡出 |
| 最短展开时长 | read / grep 这类秒回的工具不展开，免得闪一下 |
| 过程窗口 | 跑着的那一轮，整段过程收进一个窗口内自己滚；**关掉 = 平铺（页面会被越撑越长）** |
| 过程窗口高度 | 只在「过程窗口」启用时出现：窗口最多这么高（0 = 不限高） |
| 多个过程段 | 模型中途一说话，过程就被官方切成新的一段：**合并（默认）= 整轮共用一份高度**，前面的段只留一条尾巴；关掉 = 每段各开一个窗口 |
| 思考窗口高度 | 长思考压成内滚窗口，页面不再一直往下滚；0 = 不限高 |
| 跟随平滑度 | 窗口跟随时每 1/60 秒吃掉剩余距离的比例（默认 28%） |
| 工具卡也自动开合 | 命令、文件修改、网页、子代理… |
| 提问卡也自动展开 | LLM 用 `ask_user_question` 问你的时候 |
| 保留最近几条已跑完的 | 0 = 只留正在跑的那条 |
| 滚动补偿 | 收起时下方内容跳动了再打开 |
| 恢复默认 | 一键回到出厂值（就是下面「推荐默认值」那套） |

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
  collapseAnimMs: 200,      // 收起过渡时长；0 = 官方那样瞬间消失
  collapseFadeTo: 0.15,     // 过渡期间淡到多透明（1 = 不淡出，只收高度）
  scrollCompensate: false,  // 收起时手动补 scrollTop；看到跳动了再打开
  minLiveMs: 200,           // 跑满多久才值得展开：read/grep 这类几十毫秒的工具不展开，避免闪一下
  thinkWindowMax: 400,      // 长思考压成内滚窗口（px）；0 = 不限高，思考很长时页面会一直滚
  processWindowEnabled: true, // 跑着的那一轮收进过程窗口；false = 平铺（高度值仍记着）
  processWindowMax: 400,    // 过程窗口最多这么高（px）；0 = 不限高
  processWindowMerge: true, // 一轮被旁白切成几段时合并成一个窗口（共用这份高度）；false = 每段各一个
  followEase: 0.28,         // 跟随平滑度：每 1/60 秒吃掉剩余距离的比例（已按帧率换算，60/120Hz 手感一致）
  includeTools: true,       // 工具卡是否参与（关掉 = 只做思考行）
  includeQuestions: false,  // LLM 提问卡 ask_user_question 是否参与
  collapseOwnedOnly: true,  // 只收插件自己展开的（推荐保持 true）
  cooldownMs: 260,          // 点击后等官方重渲染的静默期
  mergeTurns: true,         // 一轮跑完把整轮并成一条「已完成 · 用时」
  mergeDelayMs: 600,        // 轮结束后隔多久才并，0 = 立刻
})

__dshThinkFold.merge()      // 合并相关的实时状态：官方档位 official / foldedReplies、folding / finalOnly、开关、每一轮的首行（open / disabled / queued / owned）
__dshThinkFold.windows()    // 过程窗口 / 思考窗口：enabled、max、merge、每组 {expandedMode, expanded, capped, height, offset, floor}
__dshThinkFold.stats()      // 性能计数：ticks（结构性扫描次数）/ followFrames / followWakes / avgTickMs / avgFollowMs
__dshThinkFold.setMerge(false)   // 关掉整轮合并（会把插件动过的两个官方设置都还原）

__dshThinkFold.set({ collapseAnimMs: 0 })        // 回到官方的瞬间收起
__dshThinkFold.set({ lingerMs: 1200 })           // 收之前先多停 1.2 秒
__dshThinkFold.set({ includeQuestions: true })   // 提问卡也自动展开
__dshThinkFold.set({ minLiveMs: 0 })             // 再快的工具也展开
__dshThinkFold.set({ enabled: false })           // 停用，已撑开的会收回
```

## 性能：一帧只做一件事

DSH 的正文是**流式**的：一句话还在写的时候，DOM 里是在同一个文本节点上不停改字符
（`characterData`），一秒能来几十上百条 MutationRecord。所以性能的关键不在"算得快"，
而在"哪些事不必算"：

| 以前 | 现在 |
|---|---|
| `MutationObserver`（含 `characterData`）的回调直接 `schedule()` → 每来一个字就整帧全量 `collectRows()` + `applyProcessWindows()` + 合并检查 | 回调分流：`characterData` **只叫醒跟随循环**；`childList` / `attributes`（只订阅 `data-state` / `data-expanded` / `aria-expanded` / `data-open`）才置脏标记，下一帧重扫一次 |
| 跟随循环每帧自己 `collectRows()` + `querySelectorAll('[data-step-process]')` | 结构扫描时顺手算好 `followBodies`（要跟的窗口清单），跟随循环只读这个数组，不再查 DOM |
| 跟随循环里"读 `scrollTop` → 写 `scrollTop` → 再读下一个"交替，反复强制重排 | 两遍走：先全部读完（`scrollTop` / `scrollHeight` / `clientHeight`）算好计划，再一次性写 |
| 追平后仍然 60fps 空转 | 追平后空转 18 帧就停，等下一次 DOM 变化再被叫醒 |

另外两个观感细节：

- **缓动是帧率无关的**。`followEase` 的含义是「每 16.7ms 吃掉剩余距离的比例」，120Hz 屏上一帧
  只有 8ms，就按 `dt / 16.7` 换算成等价比例（`k = 1 - (1 - ease) ** (dt / 16.7)`），
  所以两种屏上是同一条曲线、同样的手感，不会出现"高刷屏反而更黏"。
- **快到底就直接贴**（剩余 ≤ 3px）。渐近逼近永远差零点几像素，「跟到底」就会永远差一口气。

想自己看数据：`__dshThinkFold.stats()`。健康的样子是 —— 流式输出时 `followFrames` 一直在涨、
`followWakes` 跟着涨，而 **`ticks`（结构性扫描次数）基本不动**（只在真的增删行时 +1）。

## 推荐默认值

「恢复默认」就是下面这套。它不是随手定的，是"每一条都能说出理由"的那一组：

| 参数 | 值 | 为什么 |
|---|---|---|
| `collapseAnimMs` | **200** | 折起来要"动一下"，但超过 ~240ms 就开始等它；官方 hover 过渡是 100ms，200ms 大约是最长可接受的两倍 |
| `minLiveMs` | **200** | 低于 200ms 的工具（read / grep 秒回）展开再收就是闪一下；200 刚好过滤掉"闪"，又不会漏掉真正跑起来的命令 |
| `followEase` | **0.28** | 约 150ms 走完 95% 的距离：足够跟上流式输出，又看得出是"滑"不是"跳" |
| `thinkWindowMax` | **400** | 和官方过程组正文的 `min(400px, 50vh)` 对齐 —— 视觉上两类窗口高度一致 |
| `processWindowMax` | **400** | 同上；跑着时上限 `min(400px, 60vh)`，比官方多留一点余量 |
| `cooldownMs` | **260** | React 提交一帧通常 < 16ms，260ms 足够覆盖一次重渲染 + 一次动画帧，又短到不会让你觉得"点不动" |
| `mergeDelayMs` | **600** | 轮结束后留半秒看清最后一行，再并成一条 |

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
node test/merge.mjs           # 行为层：整轮合并 / 过程窗口 / 性能分流（极简 DOM 替身里跑 lib/client.js 真身）

npm run test:contract         # DOM 层：官方语义属性还在不在（需要一份 DSH 源码，见下）
```

`contract.mjs` 要找到一份**未打包**的 DSH 源码（打包成 `app.asar` 的安装目录里没有
`node_modules/@deepseek-ai`），找不到时它会把试过的路径全部打出来。这也正是它不在 `npm test`
里的原因：刚克隆下来的人手上没有 DSH 源码，不该因为一件他没做错的事看到红叉。手里有源码时用参数
或环境变量指过去：

```
npm run test:contract -- "D:/path/to/resources/app/node_modules/@deepseek-ai"
$env:DSH_APP_DIR = "D:/path/to/resources/app"     # 或：从 app.asar 解包后的目录
```

**打包层（`test/package.mjs`）**——踩过的坑：`exports` 里必须暴露 `./package.json`。
`client-modules` 定位包清单用的是 `resolve('<包名>/package.json')`；`exports` 一旦存在，
未列出的子路径就被封死，宿主会**直接判定「这不是客户端包」**，浏览器半区根本不会被送进页面。
症状是**完全没反应、且控制台没有任何报错** —— 最容易误判成"选择器不对"。
（对照 8 个社区同类插件：7 个都暴露了它。）

**DOM 层（`test/contract.mjs`）**——对着已安装的 DSH 包源码核对 31 条契约（思考行的
`data-variant` / `data-state` / 条件挂载、工具卡的 `data-tool` / `data-sample` / 状态取值、
`DisclosureRow` 的 `data-disclosure-row` / `aria-expanded` / `onClick` / `open && children`、
整轮折叠首行的 `data-turn-process` / `data-open` / `disabled` / `setOpen`、
`foldedReplies` 的 `keepReplies` / `replyRow` / `answerStep`、过程组的 `data-step-process-body` /
`data-group-expanded-mode` / `max-height:min(400px,50vh)`、
「每条回复都 flush 过程组」与组标题的 `aria-expanded` / `aria-controls`）。
失败 = 官方改了契约，插件会安静地失效（表现为"不再自动开合"，不会破坏页面），按失败项改选择器即可。

## 已知边界

- 靠官方语义属性工作，官方改属性名就会失效 —— 失效表现是"不再自动开合"，不会破坏页面。
- 只处理**会话流里最外层**的过程行：子代理卡展开出的嵌套正文、子调用卡不参与（避免插件去掏你看不见的内层）。
- **过程窗口的高度对"正在跑"和"已结束"都生效**（判据分别是 `data-group-expanded-mode` 有 / 无）；
  区别只是跑着时滚动、淡出、跟随由插件做（上限 `60vh`），结束后全部交还官方（上限 `50vh`）。
- 窗口高度写的是 `min(<你的值>px, 60vh)`：屏幕矮的时候按 60vh 走，不会超过半屏多一点。
- **模型中途说话会把过程切成多段**（官方 `TurnGroups.rebuild` 在每条回复节点上就 `flush` 当前组），
  各段是 flow 里彼此独立的 React 节点、不能真的塞进同一个滚动条；「多个过程段：合并」用的是
  **共享高度预算**（前面的段压成 56px 尾巴），不是字面意义上的一整个滚动容器。
- 官方搜索（Ctrl+F）折叠起来的内容不点。
- **整轮合并的第二层（点首行）是"点一下就收"，没有高度过渡**：官方被折掉的行是直接挂 `hidden` 的，
  成员行是彼此独立的 seat，没有统一 wrapper 可以量高度做动画（官方自己也是瞬收）。
- 整轮合并依赖官方的 `foldCompletedTurns`：`verbose` 档下 `foldable` 恒 false、首行按钮 `disabled`，
  此时只能靠第一层把档位拨到 `detailed` 才有效。
- 无主机半区逻辑：`lib/index.js` 只是一个空 `apply()`，不读写文件、不发网络请求、不碰凭据
  （唯一的外部副作用是经 `configForms` 写官方设置 `ui-chat.transcriptView` 与 `ui-chat.foldedReplies`：
  只在需要时写、都记住原值，关掉面板开关就还原）。
