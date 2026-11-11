/**
 * dsh-think-fold 契约自检 —— 本插件不渲染任何东西，全部依赖官方发布的 DOM 语义属性。
 * 这个脚本对着**已安装的 DSH 包源码**核对那几条契约还在不在：
 * 通过 = 插件的假设成立；失败 = 官方改了契约，插件会（安静地）失效，需要跟着改选择器。
 *
 * 用法： node test/contract.mjs [@deepseek-ai 包根目录]
 *   DSH_APP_DIR 也可指定，默认按常见安装位置探测。
 */
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  process.argv[2],
  process.env.DSH_APP_DIR && path.join(process.env.DSH_APP_DIR, 'node_modules', '@deepseek-ai'),
  'F:/DSH Desktop/resources/app/node_modules/@deepseek-ai',
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH NEXT', 'resources', 'app', 'node_modules', '@deepseek-ai'),
  '/Applications/DeepSeek Harness.app/Contents/Resources/app/node_modules/@deepseek-ai',
  path.join(process.env.DSH_HOME ?? '', '..', 'resources', 'app', 'node_modules', '@deepseek-ai'),
  // 本地便利：从 app.asar 抽出来的解包副本（temp/extract-asar.js 生成），可能没有 lib/ 这一层
  path.join(process.cwd(), '..', 'temp', 'dsh-asar'),
].filter(Boolean);

/** 解包副本有的保留 lib/、有的被压平，两种都认。 */
function pkgFile(dir, pkg, file) {
  for (const sub of ['lib', '']) {
    const candidate = path.join(dir, pkg, sub, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const root = CANDIDATES.find((dir) => pkgFile(dir, 'dsh-client-ui-chat', 'client.js') !== undefined);
if (root === undefined) {
  console.error('找不到已安装的 DSH 包。用 `node test/contract.mjs <@deepseek-ai 目录>` 或设 DSH_APP_DIR。');
  console.error('试过：\n  ' + CANDIDATES.join('\n  '));
  process.exit(2);
}

const read = (pkg) => {
  const file = pkgFile(root, pkg, pkg === 'dsh-client-ui-primitives' ? 'index.js' : 'client.js');
  if (file === undefined) throw new Error('缺少 ' + pkg);
  return fs.readFileSync(file, 'utf8');
};

const CHECKS = [
  {
    what: '会话流容器带 data-chat-flow',
    file: 'dsh-client-ui-chat',
    pattern: /"data-chat-flow":\s*""/,
  },
  {
    what: '思考行根带 data-variant="think"',
    file: 'dsh-client-ui-chat',
    pattern: /"data-variant":\s*"think"/,
  },
  {
    what: '思考行状态用 running|ok 发布（决定「谁在跑」）',
    file: 'dsh-client-ui-chat',
    pattern: /"data-state":\s*running\s*\?\s*"running"\s*:\s*"ok"/,
  },
  {
    what: '思考展开体是条件挂载（所以只能点开、不能 CSS 撑开）',
    file: 'dsh-client-ui-chat',
    pattern: /expanded\s*\?[\s\S]{0,160}?thinkBody/,
  },
  {
    what: '工具卡根带 data-tool="<name>"',
    file: 'dsh-client-ui-tool',
    pattern: /"data-tool":\s*toolName/,
  },
  {
    what: 'bash 卡根带 data-sample="bash"',
    file: 'dsh-client-ui-tool',
    pattern: /"data-sample":\s*"bash"/,
  },
  {
    what: '工具卡状态含 preparing（此阶段官方不可展开）',
    file: 'dsh-client-ui-tool',
    pattern: /"preparing"/,
  },
  {
    what: '工具卡状态含 running（执行中 = 展开）',
    file: 'dsh-client-ui-tool',
    pattern: /state\s*===\s*"running"/,
  },
  {
    what: '开合控件带 data-disclosure-row',
    file: 'dsh-client-ui-primitives',
    pattern: /"data-disclosure-row":\s*true/,
  },
  {
    what: '开合控件行内自带 aria-expanded（插件靠它判断展开态）',
    file: 'dsh-client-ui-primitives',
    pattern: /"aria-expanded":\s*rowExpands\s*\?\s*open\s*:\s*void 0/,
  },
  {
    what: '行内自带 onClick（插件派发的 click 才有意义）',
    file: 'dsh-client-ui-primitives',
    pattern: /onClick:\s*rowExpands\s*\?\s*onToggle\s*:\s*void 0/,
  },
  {
    what: '正文条件挂载（open && children）',
    file: 'dsh-client-ui-primitives',
    pattern: /open\s*&&\s*children/,
  },
  // ---- 「完成后合并整轮」代理的是官方 transcriptView 档位，这四条是它的支点 ----
  {
    what: '官方「详细」档 = foldCompletedTurns:true + stepGrouping:"history"',
    file: 'dsh-client-ui-chat',
    pattern: /foldCompletedTurns:\s*true,\s*stepGrouping:\s*"history"/,
  },
  {
    what: '官方「不合并」档（verbose）= foldCompletedTurns:false',
    file: 'dsh-client-ui-chat',
    pattern: /foldCompletedTurns:\s*false,\s*stepGrouping:\s*"none"/,
  },
  {
    what: '正在跑 / 中断 / 出错的一轮永不被整轮折叠（轮内自动开合才不受影响）',
    file: 'dsh-client-ui-chat',
    pattern: /turn\.status === "open" \|\| reason === "aborted"/,
  },
  {
    what: '被折掉的成员行用 hidden 属性隐藏（collectRows 靠它跳过）',
    file: 'dsh-client-ui-chat',
    pattern: /hasAttribute\("hidden"\)/,
  },
  {
    what: '设置项字段名是 transcriptView（命名空间 ui-chat）',
    file: 'dsh-client-ui-chat',
    pattern: /TRANSCRIPT_VIEW_FIELD = "transcriptView"/,
  },
  // ---- 第二层点的是官方首行那条 TurnProcessNodeView，这四条是它的支点 ----
  {
    what: '整轮首行带 data-turn-process="<turn>"（插件按它找）',
    file: 'dsh-client-ui-chat',
    pattern: /"data-turn-process": node\.data\.turn/,
  },
  {
    what: '首行只有展开态才带 data-open（插件据此判断"还摊着"）',
    file: 'dsh-client-ui-chat',
    pattern: /"data-open": open \|\| void 0/,
  },
  {
    what: '首行在官方不收的时候是 disabled（插件跳过）',
    file: 'dsh-client-ui-chat',
    pattern: /disabled: !canCollapse/,
  },
  {
    what: '点首行 = turnProcess.setOpen(!open)（合成 click 才有效）',
    file: 'dsh-client-ui-chat',
    pattern: /turnProcess\.setOpen\(!open\)/,
  },
  // ---- 「过程旁白也一起收」靠的是 foldedReplies，这四条是它的支点 ----
  {
    what: '官方 foldedReplies 默认 all（每段过程旁白都留在外面）',
    file: 'dsh-client-ui-chat',
    pattern: /\[FOLDED_REPLIES_FIELD\]: Schema\.union\(\[\.\.\.FOLDED_REPLIES\]\)\.default\("all"\)/,
  },
  {
    what: 'keepReplies = foldedReplies === "all"（all 才把回复排除在过程之外）',
    file: 'dsh-client-ui-chat',
    pattern: /const keepReplies = usePresentation\(\(policy\) => policy\.foldedReplies === "all"\)/,
  },
  {
    what: 'replyRow = keepReplies && assistant-step 且有回复内容（这类行永不折进整轮）',
    file: 'dsh-client-ui-chat',
    pattern: /const replyRow = keepReplies && routedNode\?\.kind === "assistant-step"[\s\S]{0,160}?hasAssistantReplyContent/,
  },
  {
    what: '最终回复那一步留在外面（processAnswer = step === answerStep）',
    file: 'dsh-client-ui-chat',
    pattern: /routedNode\.data\.step === processSpec\.answerStep/,
  },
  // ---- 「跑着的一轮收进限高窗口」靠的是过程组正文，这四条是它的支点 ----
  {
    what: '官方过程组正文自带 max-height:min(400px,50vh)（已结束的组才有）',
    file: 'dsh-client-ui-chat',
    pattern: /max-height:min\(400px,50vh\);overflow-y:auto\}/,
  },
  {
    what: '过程正文元素标了 data-step-process-body（插件挂限高用）',
    file: 'dsh-client-ui-chat',
    pattern: /"data-step-process-body": true/,
  },
  {
    what: '跑着的一轮挂 data-group-expanded-mode（没编成组 = 正文不限高）',
    file: 'dsh-client-ui-chat',
    pattern: /"data-group-expanded-mode": !grouped \|\| void 0/,
  },
  {
    what: 'capped = grouped && …（没编成组就放开限高，正是跑着的时候）',
    file: 'dsh-client-ui-chat',
    pattern: /const capped = grouped && \(!deferCompletedTurns \|\| \(shownCap \?\? closingCap\)\)/,
  },
];

const sources = new Map();
let failed = 0;
console.log(`契约核对：${root}\n`);
for (const check of CHECKS) {
  if (!sources.has(check.file)) {
    try { sources.set(check.file, read(check.file)); } catch (error) { sources.set(check.file, null); }
  }
  const source = sources.get(check.file);
  if (source === null || source === undefined) {
    console.log(`  ?? 读不到 ${check.file}`);
    failed += 1;
    continue;
  }
  const hit = check.pattern.exec(source);
  if (hit === null) {
    console.log(`  FAIL  ${check.what}   [${check.file}]`);
    failed += 1;
  } else {
    const snippet = hit[0].replace(/\s+/g, ' ').slice(0, 70);
    console.log(`  ok    ${check.what}\n          ↳ ${snippet}`);
  }
}
console.log(failed === 0
  ? `\n全部 ${CHECKS.length} 条通过：插件的选择器假设与当前 DSH 一致。`
  : `\n${failed}/${CHECKS.length} 条失败：官方契约变了，插件的选择器需要跟着更新（失败时表现为「不再自动开合」，不会破坏页面）。`);
process.exit(failed === 0 ? 0 : 1);
