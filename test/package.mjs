/**
 * 打包契约自检 —— 这一层比 DOM 契约更容易踩，而且失败时完全静默：
 * 宿主不认识这个包是「客户端包」，于是浏览器半区根本不会被送进页面，
 * 插件一行代码都不会跑（症状 = 完全没反应，控制台也没有报错）。
 *
 * 用法： node test/package.mjs
 * 依赖： DSH_PROFILE_DIR（在 Harness 的 shell 里自动存在）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const fail = [];
const ok = [];

const check = (name, pass, detail = '') => (pass ? ok : fail).push(`${name}${detail === '' ? '' : `  ↳ ${detail}`}`);

/* 1. exports 必须暴露 ./package.json -------------------------------------
 * client-modules 定位包清单用的是 resolve('<包名>/package.json')：
 * 一旦 exports 存在，未列出的子路径就全被封死，宿主直接判定「不是客户端包」。
 */
check("exports['./package.json'] 已暴露（宿主靠它定位包清单）",
  pkg.exports?.['./package.json'] === './package.json',
  JSON.stringify(pkg.exports?.['./package.json'] ?? null));

/* 2. 从 profile 里真的能解析到 ------------------------------------------- */
const profiles = [process.env.DSH_PROFILE_DIR].filter(Boolean);
if (profiles.length === 0) {
  ok.push('跳过 profile 解析检查（DSH_PROFILE_DIR 未设置）');
} else {
  for (const dir of profiles) {
    let resolved = null;
    let error = null;
    try { resolved = createRequire(path.join(dir, 'index.js')).resolve(`${pkg.name}/package.json`); }
    catch (e) { error = e.code ?? e.message; }
    check(`profile 里可解析 ${pkg.name}/package.json`, resolved !== null, resolved ?? String(error));
  }
}

/* 3. dsh.client / dsh.bundle 声明 --------------------------------------- */
check("dsh.client.platform === 'web'（桌面端也走 web 客户端契约）",
  pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform));

const clientRel = typeof pkg.exports?.['./client'] === 'string'
  ? pkg.exports['./client']
  : pkg.exports?.['./client']?.default;
check("exports['./client'] 指向一个字符串", typeof clientRel === 'string', String(clientRel));

const clientPath = typeof clientRel === 'string' ? path.join(root, clientRel) : null;
check('./client 文件存在', clientPath !== null && fs.existsSync(clientPath), clientPath ?? '');
if (clientPath !== null && fs.existsSync(clientPath)) {
  const source = fs.readFileSync(clientPath, 'utf8');
  // 4. 浏览器半区必须以包名注册工厂，否则 client-modules 物化不出这个模块
  const id = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/);
  check('客户端工厂 id 等于包名', id?.[1] === pkg.name, id ? id[1] : '未找到 __ModuleLoader__.load({ id: ... })');
  check('客户端工厂导出 apply', /\bapply\b/.test(source), '');
}

const patch = pkg.dsh?.bundle?.patch;
check('dsh.bundle.patch 文件存在', typeof patch === 'string' && fs.existsSync(path.join(root, patch)), String(patch));

/* 报告 ------------------------------------------------------------------- */
console.log(`打包契约核对：${root}\n`);
for (const line of ok) console.log(`  ok    ${line}`);
for (const line of fail) console.log(`  FAIL  ${line}`);
console.log(fail.length === 0
  ? `\n全部 ${ok.length} 条通过：宿主能识别这个包并把浏览器半区送进页面。`
  : `\n${fail.length} 条失败：浏览器半区不会被加载，插件会完全没反应（且无报错）。`);
process.exit(fail.length === 0 ? 0 : 1);
