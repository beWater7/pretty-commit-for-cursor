'use strict';
// 行号逻辑自检：直接从 media/panel.html 里抠出 lineKind/lineNumbers/gutterDigits 求值，
// 保证测的就是页面里跑的那份代码，而不是抄一遍。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { parseCommitDiff } = require(path.join(ROOT, 'src/parse.js'));

const html = fs.readFileSync(path.join(ROOT, 'media/panel.html'), 'utf8');
const start = html.indexOf('function lineKind(');
const endMark = 'return String(max).length;';
const end = html.indexOf(endMark, start);
if (start < 0 || end < 0) throw new Error('抠不出函数，panel.html 结构变了？');
const src = html.slice(start, end + endMark.length) + '\n}';
// eslint-disable-next-line no-new-func
const { lineKind, lineNumbers, gutterDigits } = new Function(
  src + '\nreturn { lineKind, lineNumbers, gutterDigits };'
)();

let fails = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) fails++;
}
// 页面渲染时会跳过的空串尾巴
const eff = (h) => h.lines.filter((l) => l !== '');

// ---------------------------------------------------------------- 合成仓库
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pcline-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');

const w = (name, text) => fs.writeFileSync(path.join(repo, name), text);
const manyLines = Array.from({ length: 60 }, (_, i) => `L${i + 1}`);

w('keep.txt', 'l1\nl2\nl3\n');
w('gone.txt', 'g1\ng2\ng3\n');
w('nonl.txt', 'a\nb');                                   // 末尾无换行
w('many.txt', manyLines.join('\n') + '\n');              // 先存在，最后再改
git('add', '-A');
git('commit', '-q', '-m', 'base');

// A: 纯新增文件
w('fresh.txt', Array.from({ length: 10 }, (_, i) => `n${i + 1}`).join('\n') + '\n');
git('add', '-A');
git('commit', '-q', '-m', 'add fresh');

// B: 纯删除文件
git('rm', '-q', 'gone.txt');
git('commit', '-q', '-m', 'del gone');

// C: 无换行结尾
w('nonl.txt', 'a\nB');
git('add', '-A');
git('commit', '-q', '-m', 'nonl');

// D: 多 hunk（第 2 行与第 55 行各改一处）
const many2 = manyLines.slice();
many2[1] = 'L2-changed';
many2[54] = 'L55-changed';
w('many.txt', many2.join('\n') + '\n');
git('add', '-A');
git('commit', '-q', '-m', 'multi hunk');

const filesOf = (rev) => {
  const out = new Map();
  for (const f of parseCommitDiff(git('show', '--format=', rev))) out.set(f.path, f);
  return out;
};

// ---------------------------------------------------------- 0 幽灵行已消失
console.log('\n[0] parse.js 不再产出空串尾巴');
{
  const f = filesOf('HEAD').get('many.txt');
  ok(
    f.hunks.every((h) => h.lines.every((l) => l !== '')),
    '所有 hunk 的 lines 都没有空串'
  );
}

// ---------------------------------------------------------- A 纯新增
console.log('\n[A] 纯新增文件 fresh.txt');
{
  const f = filesOf('HEAD~3').get('fresh.txt');
  const { has, rows } = lineNumbers(f.hunks[0]);
  ok(has, 'has=true');
  ok(f.hunks[0].header === '@@ -0,0 +1,10 @@', `hunk 头是 -0,0 +1,10（实际 ${f.hunks[0].header}）`);
  ok(
    rows.length === 10,
    `渲染 10 行，没有幽灵行（实际 ${rows.length}）`
  );
  ok(
    rows.every((r) => r.kind === 'add'),
    '所有行都是 add（整文件新增）'
  );
  ok(
    rows.every((r) => r.old === ''),
    '旧行号列全空'
  );
  ok(
    rows.map((r) => Number(r.new)).join(',') === '1,2,3,4,5,6,7,8,9,10',
    '新行号 1..10 连续'
  );
  ok(gutterDigits(f.hunks) === 2, '列宽位数=2（最大行号 10+10）');
}

// ---------------------------------------------------------- B 纯删除
console.log('\n[B] 纯删除文件 gone.txt');
{
  const f = filesOf('HEAD~2').get('gone.txt');
  const { has, rows } = lineNumbers(f.hunks[0]);
  ok(has, 'has=true');
  ok(rows.length === 3, `渲染 3 行（实际 ${rows.length}）`);
  ok(
    rows.every((r) => r.kind === 'del'),
    '所有行都是 del'
  );
  ok(
    rows.every((r) => r.new === ''),
    '新行号列全空'
  );
  ok(
    rows.map((r) => Number(r.old)).join(',') === '1,2,3',
    '旧行号 1..3 连续'
  );
}

// ---------------------------------------------------------- C 无换行结尾
console.log('\n[C] 无换行结尾 nonl.txt');
{
  const f = filesOf('HEAD~1').get('nonl.txt');
  ok(eff(f.hunks[0]).some((l) => l.startsWith('\\')), 'diff 里确实出现 \\ No newline 行');
  const { rows } = lineNumbers(f.hunks[0]);
  for (const r of rows) {
    console.log(`      raw=${JSON.stringify(r.raw)} kind=${r.kind} old=${r.old} new=${r.new}`);
  }
  const nonl = rows.filter((r) => r.kind === 'nonl');
  ok(nonl.length >= 1, `\\ No newline 行被单独识别（${nonl.length} 行）`);
  ok(
    nonl.every((r) => r.old === '' && r.new === ''),
    '\\ No newline 行不占号'
  );
  ok(rows[0].old === '1' && rows[0].new === '1', '上下文行 a 为 1/1');
  const delB = rows.find((r) => r.kind === 'del');
  const addB = rows.find((r) => r.kind === 'add');
  ok(delB && delB.old === '2' && delB.new === '', '删除行 b 只有旧行号 2');
  ok(addB && addB.new === '2' && addB.old === '', '新增行 B 只有新行号 2（未被 nonl 行顶掉）');
}

// ---------------------------------------------------------- D 多 hunk
console.log('\n[D] 多 hunk many.txt');
{
  const f = filesOf('HEAD').get('many.txt');
  ok(f.hunks.length === 2, `确实是 2 个 hunk（实际 ${f.hunks.length}）`);
  const hunks = f.hunks.map((h) => lineNumbers(h));
  ok(
    hunks.every((h) => h.has),
    '两个 hunk 的 @@ 头都解析成功'
  );
  const h0del = hunks[0].rows.find((r) => r.kind === 'del');
  const h1del = hunks[1].rows.find((r) => r.kind === 'del');
  ok(h0del && h0del.old === '2', `hunk0 删除行旧行号=2（实际 ${h0del && h0del.old}）`);
  ok(h1del && h1del.old === '55', `hunk1 删除行旧行号=55，从自己的 @@ 重新起算（实际 ${h1del && h1del.old}）`);
  // 旧行号应沿 hunk 连续推进：非新增行（上下文+删除）依次 +1
  const oldSeq = hunks[1].rows.filter((r) => r.kind !== 'add' && r.kind !== 'nonl').map((r) => Number(r.old));
  ok(
    oldSeq.every((n, i) => i === 0 || n === oldSeq[i - 1] + 1),
    `hunk1 非新增行的旧行号连续（${oldSeq[0]}..${oldSeq[oldSeq.length - 1]}）`
  );
  ok(oldSeq.includes(55), 'hunk1 的 55 出现在序列里（被删除行占用）');
  ok(gutterDigits(f.hunks) === 2, '列宽位数=2（最大行号 60+4）');
}

// ---------------------------------------------------------- 兜底：异常 @@ 头
console.log('\n[E] 异常 @@ 头（不猜行号）');
{
  const { has, rows } = lineNumbers({ header: '@@ junk @@', lines: ['+x', '-y', ' z'] });
  ok(has === false, 'has=false');
  ok(
    rows.every((r) => r.old === '' && r.new === ''),
    '不显示任何行号'
  );
  ok(
    rows.map((r) => r.kind).join(',') === 'add,del,ctx',
    '仍然按前缀上色（正文保留原始前缀）'
  );
}

// ---------------------------------------------------------- 回归：送 Chat 的文本
console.log('\n[F] 回归：送 Chat 的仍是合法 diff');
{
  const f = filesOf('HEAD~1').get('nonl.txt');
  const h = f.hunks[0];
  const { rows } = lineNumbers(h);
  // 模拟 renderDiff：data-raw = 原始行，正文也照旧带前缀
  const sent = rows.map((r) => r.raw);
  ok(
    sent.join('\n') === eff(h).join('\n'),
    'data-raw 拼起来与原始 hunk 文本完全一致（带 +/-/空格前缀）'
  );
  ok(
    sent.every((l) => l === '' || /^[ +\-\\]/.test(l)),
    '每行都以合法 diff 前缀开头'
  );
  // 旧的取法等价物：textContent = 旧行号 + 新行号 + 正文，行号会混进去
  const viaTextContent = rows.map((r) => (r.old || '') + (r.new || '') + r.raw);
  ok(
    viaTextContent.join('\n') !== eff(h).join('\n'),
    '对照：按 textContent 取会把两列行号混进 diff（说明 data-raw 这个修复是必要的）'
  );
  ok(
    viaTextContent.some((l) => /^\d/.test(l)),
    '对照：textContent 版本确实以行号开头（"7 8 +..."）'
  );
  // 行号列不进选区：它不在 data-raw 里，天然不会混进来
  ok(
    !sent.some((l) => /^\s*\d+\s+\d+\s/.test(l)),
    '没有把 "旧号 新号" 混进送出的文本'
  );
}

console.log('\n[G] 语法着色 tokenize（Gerrit/CodeMirror default 配色）');
{
  const c0 = html.indexOf('function langStyle(');
  const c1 = html.indexOf('function fillCode(');
  if (c0 < 0 || c1 < 0) throw new Error('抠不出 langStyle/tokenize');
  const { langStyle, tokenize } = new Function(
    html.slice(c0, c1) + '\nreturn { langStyle, tokenize };'
  )();
  const clsOf = (s, style) => tokenize(s, style || 'c').map((t) => [t.t, t.cls]);
  const textOf = (s, style) => tokenize(s, style || 'c').map((t) => t.t);
  const cls = (s, word, style) => {
    const hit = tokenize(s, style || 'c').find((t) => t.t === word);
    return hit ? hit.cls : '<没找到>';
  };

  ok(langStyle('a.js') === 'c' && langStyle('x.py') === 'hash' && langStyle('a.html') === 'xml', '按扩展名选风格');
  ok(langStyle('Makefile') === 'hash' && langStyle('src/CMakeLists.txt') === 'hash', '无扩展名/特殊文件名按文件名认（Makefile、CMakeLists.txt）');
  ok(langStyle('.env') === 'hash' && langStyle('.bashrc') === 'hash', '点开头的配置文件也认（.env、.bashrc）');
  ok(langStyle('a.c') === 'c' && langStyle('a.md') === 'c', 'C 系与 markdown 仍走 // 风格（md 的 # 是标题，不染成注释）');

  // 不变式：切分不能丢字符、不能改字符（着色只是插 span，正文必须一字不差）
  for (const [s, st] of [
    ['extern int foo(int a) { return a + 1; } // tail', 'c'],
    ['const u = "http://x.com/a//b"; /* c */ p->len = ctx.x;', 'c'],
    ['#include <stdio.h>  /* hdr */', 'c'],
    ['x = 1  # n', 'hash'],
    ['s = "# not cmt"', 'hash'],
    ["c = 'a' + '\\n';", 'c'],
    ['printf("%d\\n", n);', 'c'],
  ]) {
    ok(textOf(s, st).join('') === s, `切分可无损还原：${s.slice(0, 34)}${s.length > 34 ? '…' : ''}`);
  }

  ok(cls('extern int foo(int a) { return a + 1; }', 'extern') === 'kw', 'extern → 关键字色');
  ok(cls('extern int foo(int a) { return a + 1; }', 'int') === 'type', 'int → 类型色');
  ok(cls('extern int foo(int a) { return a + 1; }', 'foo') === 'fn', '函数名（后跟括号）→ 函数色');
  ok(cls('extern int foo(int a) { return a + 1; }', '1') === 'num', '数字常量 → 数字色');
  ok(cls('if (a) for (b) while (c)', 'if') === 'kw', '控制流关键字不被当成函数');
  ok(cls('p->len = ctx.x;', 'len') === 'mem', '-> 之后 → 成员色');
  ok(cls('p->len = ctx.x;', 'x') === 'mem', '. 之后 → 成员色');
  ok(cls('const u = "http://x.com"; // t', '// t') === 'cmt', '行尾 // 是注释');
  ok(cls('const u = "http://x.com";', '"http://x.com"') === 'str', '字符串里的 // 不是注释');
  ok(cls('x = 1  # n', '# n', 'hash') === 'cmt', 'python 的 # 注释');
  ok(cls('s = "# not cmt"', '"# not cmt"', 'hash') === 'str', '字符串里的 # 不是注释');
  ok(cls('a = 1; /* z */ b = 2;', '/* z */') === 'cmt', '同行 /* */ 块注释');

  const pre = tokenize('#include <stdio.h>', 'c');
  ok(pre[0].cls === 'pre' && pre[0].t === '#include', '#include → 预处理色');
  const esc = tokenize('printf("%d\\n", n);', 'c');
  ok(esc.some((t) => t.cls === 'esc' && t.t === '\\n'), '字符串里的转义序列单独成色');
  ok(esc.filter((t) => t.cls === 'str').map((t) => t.t).join('') === '"%d"', '字符串片段只覆盖字面量本身（转义被拆出去）');
}

console.log('\n[H] 双页对比配对 sbsRows');
{
  const c0 = html.indexOf('function sbsRows(');
  const c1 = html.indexOf('function makeSbsCell(');
  if (c0 < 0 || c1 < 0) throw new Error('抠不出 sbsRows');
  const { lineNumbers } = (() => {
    const a = html.indexOf('function lineKind(');
    const b = html.indexOf('function lineNumbers(');
    const c = html.indexOf('return String(max).length;');
    if (a < 0 || b < 0 || c < 0) throw new Error('抠不出 lineNumbers');
    return new Function(html.slice(a, c + 'return String(max).length;'.length) + '\n}return { lineNumbers };')();
  })();
  const { sbsRows } = new Function(html.slice(c0, c1) + '\nreturn { sbsRows };')();

  const rows = lineNumbers({
    header: '@@ -1,4 +1,5 @@',
    lines: [' ctx', '-old1', '-old2', '+new1', '+new2', '+new3', ' ctx2'],
  }).rows;
  const pairs = sbsRows(rows);
  ok(pairs.length === 5, `7 行折成 5 对（实际 ${pairs.length}）`);
  ok(pairs[0].left === pairs[0].right && pairs[0].left.kind === 'ctx', '上下文行左右同一行');
  ok(pairs[1].left.raw === '-old1' && pairs[1].right.raw === '+new1', '第 2 行：-old1 配 +new1');
  ok(pairs[2].left.raw === '-old2' && pairs[2].right.raw === '+new2', '第 3 行：-old2 配 +new2');
  ok(pairs[3].left === null && pairs[3].right.raw === '+new3', '多出来的新增行右侧单独成行（左侧留空）');
  ok(pairs[4].left.kind === 'ctx' && pairs[4].right.kind === 'ctx', '收尾上下文行左右同一行');

  // 纯新增：左侧必须全空
  const addOnly = sbsRows(lineNumbers({ header: '@@ -0,0 +1,3 @@', lines: ['+a', '+b', '+c'] }).rows);
  ok(addOnly.length === 3 && addOnly.every((p) => p.left === null), '纯新增文件：左侧全空');

  // 纯删除：右侧必须全空
  const delOnly = sbsRows(lineNumbers({ header: '@@ -1,3 +0,0 @@', lines: ['-a', '-b', '-c'] }).rows);
  ok(delOnly.length === 3 && delOnly.every((p) => p.right === null), '纯删除文件：右侧全空');

  // 错位配对（删 5 增 2）：左边多出来的 3 行不该被丢掉
  const uneven = sbsRows(lineNumbers({ header: '@@ -1,5 +1,2 @@', lines: ['-a', '-b', '-c', '-d', '-e', '+A', '+B'] }).rows);
  ok(uneven.length === 5, `删 5 增 2 → 5 对（实际 ${uneven.length}）`);
  ok(uneven.filter((p) => p.left).length === 5 && uneven.filter((p) => p.right).length === 2, '左 5 行 / 右 2 行，都没有丢');

  // \ No newline 行挂在它所属的那一侧
  const nonl = sbsRows(lineNumbers({
    header: '@@ -1,2 +1,2 @@',
    lines: [' a', '-b', '\\ No newline at end of file', '+B', '\\ No newline at end of file'],
  }).rows);
  const leftNonl = nonl.filter((p) => p.left && p.left.kind === 'nonl').length;
  const rightNonl = nonl.filter((p) => p.right && p.right.kind === 'nonl').length;
  ok(leftNonl === 1 && rightNonl === 1, '\\ No newline 左右各落一份，不丢也不重复');

  // 双页不丢行：左列 = 全部非 add 行，右列 = 全部非 del 行（各自按顺序）
  const raw2 = lineNumbers({
    header: '@@ -10,6 +10,7 @@',
    lines: [' a', '-x', '+y', ' z', '-p', '-q', '+r', ' end'],
  }).rows;
  const p2 = sbsRows(raw2);
  const leftRaw = p2.map((p) => p.left && p.left.raw).filter(Boolean);
  const rightRaw = p2.map((p) => p.right && p.right.raw).filter(Boolean);
  const expL = raw2.filter((r) => r.kind !== 'add').map((r) => r.raw);
  const expR = raw2.filter((r) => r.kind !== 'del').map((r) => r.raw);
  ok(leftRaw.join('|') === expL.join('|'), '左列顺序与内容 = 原序列去掉 add 行');
  ok(rightRaw.join('|') === expR.join('|'), '右列顺序与内容 = 原序列去掉 del 行');
  const ctxPairs = p2.filter((p) => p.left && p.right && p.left.kind === 'ctx');
  ok(ctxPairs.every((p) => p.left === p.right), '上下文行左右引用同一行（行号不会错位）');
}

console.log('\n[I] 配色自检：Gerrit 官方值（淡档）+ 三档深浅 × 两套主题');
{
  // 变量从两种规则里抠：主题块（body.pc-light/dark section）拿「跟主题走」的颜色；
  // 色带块（body.pc-<theme>.i-<depth> section）拿色带 4 色 + 有色行注释色。
  const blockOf = (sel) => {
    const a = html.indexOf(sel + ' {');
    if (a < 0) throw new Error('找不到 ' + sel + ' 的样式块');
    const b = html.indexOf('\n  }', a);
    return html.slice(a, b);
  };
  const varsIn = (block) => {
    const out = {};
    const re = /--([a-z-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(block))) out[m[1]] = m[2].trim();
    return out;
  };
  const THEME = { light: varsIn(blockOf('body.pc-light section')), dark: varsIn(blockOf('body.pc-dark section')) };
  const DEPTHS = ['subtle', 'standard', 'strong'];
  const BAND = {}; // BAND['light/standard'] = {...}
  for (const t of ['light', 'dark']) {
    for (const d of DEPTHS) BAND[t + '/' + d] = varsIn(blockOf('body.pc-' + t + '.i-' + d + ' section'));
  }
  ok(Object.keys(THEME.light).length > 15 && Object.keys(THEME.dark).length > 15,
    '两套主题的 palette 都抠出来了（light ' + Object.keys(THEME.light).length + ' 个变量 / dark ' + Object.keys(THEME.dark).length + ' 个）');
  ok(Object.keys(BAND).length === 6, '六个「主题 × 深浅」色带块都抠到了（' + Object.keys(BAND).length + '/6）');

  const toRgb = (v) => {
    let h = String(v).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return h.match(/../g).map((x) => parseInt(x, 16));
  };
  const lum = (v) => {
    const lin = toRgb(v).map((x) => {
      const c = x / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const cr = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // OKLab / OKLCH：判「观感等重」要靠感知亮度，不能用相对亮度。
  const oklch = (v) => {
    const f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const [lr, lg, lb] = toRgb(v).map((x) => f(x / 255));
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const n = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * n;
    const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * n;
    const b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * n;
    return [L, Math.hypot(a, b)];
  };
  const hueOf = (v) => {
    const [r, g, b] = toRgb(v).map((x) => x / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const BG = { light: '#ffffff', dark: '#202124' };

  // ---- 1) 「淡」档必须就是 Gerrit 官方那组原色 ----
  // 契约：配色不是自己发明的，是把 Gerrit 官方值搬过来的。淡档 = 原封不动，
  // 标准 / 浓才是在此基础上的加深。抄错色号比不好看严重，所以逐个对。
  // 注：Gerrit 官方那组 highlight 色（浅色 #AAF2AA / #FFCDD2）已经不用了 ——
  // 符号列不再另铺一条色带，浅色这边只保留官方的两条 background。
  const OFFICIAL = {
    light: { add: '#d8fed8', del: '#ffebee' },
    dark: { add: '#2c553a', del: '#62110f' },
  };
  for (const t of ['light', 'dark']) {
    const b = BAND[t + '/subtle'];
    for (const [k, want] of Object.entries(OFFICIAL[t])) {
      const key = { add: 'add-bg', del: 'del-bg' }[k];
      ok(String(b[key]).toLowerCase() === want, t + ' 淡档：--' + key + ' = Gerrit 官方值 ' + want + '（实际 ' + b[key] + '）');
    }
  }
  // 主题块里那些「跟主题走」的值。底色/正文仍是 Gerrit 官方；语法 token 换成了柔和配色
  // （Gerrit 那套 CodeMirror 色饱和度太高，铺在绿/红加色带上会和底色打架）。
  const THEME_OFFICIAL = {
    light: { bg: '#ffffff', fg: '#202124', cmt: '#6e7781',
      'tok-kw': '#0550ae', 'tok-type': '#953800', 'tok-num': '#0550ae',
      'tok-str': '#0a3069', 'tok-fn': '#8250df', 'tok-esc': '#0a3069' },
    dark: { bg: '#202124', fg: '#e8eaed', cmt: '#8b949e',
      'tok-kw': '#ff7b72', 'tok-type': '#ffa657', 'tok-num': '#79c0ff',
      'tok-str': '#a5d6ff', 'tok-fn': '#d2a8ff', 'tok-mem': '#c9d1d9', 'tok-esc': '#a5d6ff' },
  };
  for (const [t, table] of Object.entries(THEME_OFFICIAL)) {
    for (const [k, want] of Object.entries(table)) {
      ok(String(THEME[t][k] || '').toLowerCase() === want,
        t + ': --' + k + ' = Gerrit 官方值 ' + want + '（实际 ' + (THEME[t][k] || '(缺失)') + '）');
    }
  }

  // ---- 2) 两个来源不能打架：色带只许在 i-* 块里定义 ----
  for (const t of ['light', 'dark']) {
    const OWNED = ['add-bg', 'del-bg', 'add-mark', 'del-mark', 'cmt-on-tint'];
    const leaked = OWNED.filter((k) => k in THEME[t]);
    ok(leaked.length === 0,
      t + ' 主题块里不再重复声明这 5 个（否则深浅档切了也不生效）' + (leaked.length ? '：漏了 ' + leaked.join(',') : ''));
  }
  for (const key of Object.keys(BAND)) {
    const miss = ['add-bg', 'del-bg', 'add-mark', 'del-mark', 'cmt-on-tint']
      .filter((k) => !(k in BAND[key]));
    ok(miss.length === 0, key + ' 色带块该有的变量都在' + (miss.length ? '：缺 ' + miss.join(',') : ''));
  }
  // 「色脊」这套已经拆掉了：符号列直接用行的色带底色（background: inherit）。
  // 留着 --add-gutter / --del-gutter 只会让人以为还有第二条色带，所以必须彻底清干净。
  ok(!/--(add|del)-gutter/.test(html),
    '--add-gutter / --del-gutter 已彻底移除（符号列不再另铺一条色带）');

  // ---- 3) 六种组合逐个过约束 ----
  // 色带「能看出来」= 与底色的对比度；「能读」= 正文 / 行号 / 符号 / 注释在色带上的对比度。
  // 加深是有上限的：超过上限字就糊。所以这里既查下限，也查方向（色脊该更深还是更亮）。
  const bandScore = {};
  for (const t of ['light', 'dark']) {
    const v = THEME[t];
    const bg = BG[t];
    const deeper = t === 'light'; // 浅色：色脊比行底更深；深色：色脊比行底更亮
    for (const d of DEPTHS) {
      const b = BAND[t + '/' + d];
      const tag = t + '/' + d;
      const score = cr(b['add-bg'], bg) + cr(b['del-bg'], bg);
      bandScore[tag] = score;

      ok(cr(b['add-bg'], bg) > 1.08 && cr(b['del-bg'], bg) > 1.08,
        tag + '：色带与底色拉得开（ADD ' + cr(b['add-bg'], bg).toFixed(2) + ' / DEL ' + cr(b['del-bg'], bg).toFixed(2) + '）');
      // 正文：这是加深的硬上限
      ok(cr(v.fg, b['add-bg']) >= 4.5 && cr(v.fg, b['del-bg']) >= 4.5,
        tag + '：色带上的正文对比 ≥ 4.5（ADD ' + cr(v.fg, b['add-bg']).toFixed(2) + ' / DEL ' + cr(v.fg, b['del-bg']).toFixed(2) + '）');
      // 行号列**不染色带**：行号始终压在主题块的中性 gutter 上（--ln-fg on --gutter-bg）。
      // 这条是「色带别到行号那」的数值守卫 —— 行号列一旦又被染成绿/红，这里会当场红。
      ok(cr(v['ln-fg'], v['gutter-bg']) >= 4.5,
        tag + '：行号列中性（--ln-fg on --gutter-bg）≥ 4.5（' + cr(v['ln-fg'], v['gutter-bg']).toFixed(2) + '）');
      // +/- 符号：字号最小，最不能糊。符号列与代码区同底色，所以判据是「符号压在色带上」。
      for (const [row, mark] of [['add-bg', 'add-mark'], ['del-bg', 'del-mark']]) {
        ok(cr(b[mark], b[row]) >= 4.5,
          tag + '：' + row + ' 上的 +/- 符号 ≥ 4.5（' + cr(b[mark], b[row]).toFixed(2) + '，色 ' + b[mark] + '）');
      }
      // 语义也钉住：add/del 的**行号列**不许被染上色带色 —— 行号永远压在中性 gutter 上
      ok(!/\.ln[^{}]*\{[^}]*--(add|del)-bg/.test(html),
        tag + '：CSS 里没有把行号列染色带的规则（色带从符号列才开始）');
      // 语义钉住：add/del 的**符号列**必须跟代码区同底色（inherit 那一行的色带），
      // 不许再出现第二条更深/更亮的色带 —— 这是「+-号那里颜色和文字背景一样」的回归守卫。
      ok(/\.hl\.add \.sign, \.hl\.del \.sign \{ background: inherit/.test(html),
        tag + '：符号列底色 = 该行的色带底色（background: inherit，不另铺一条色带）');
      // 有色行上的注释：Gerrit 的注释色是中间调，色带一深就糊，所以必须随档位换色
      const cmin = t === 'light' ? 4.0 : 3.1;
      const c1 = cr(b['cmt-on-tint'], b['add-bg']);
      const c2 = cr(b['cmt-on-tint'], b['del-bg']);
      ok(c1 >= cmin && c2 >= cmin,
        tag + '：有色行上的注释 ≥ ' + cmin + '（ADD ' + c1.toFixed(2) + ' / DEL ' + c2.toFixed(2) + '，色 ' + b['cmt-on-tint'] + '）');
      // 白底行上的注释仍是 Gerrit 原色，只查它别继续变淡
      ok(cr(v.cmt, v.bg) >= 4.5,
        tag + '：白底行上的注释 ≥ 4.5（' + cr(v.cmt, v.bg).toFixed(2) + '）');
    }
  }

  // ---- 4) 三档必须真的是一个比一个深；加深的两档红绿「观感等重」；色相还是 Gerrit 的 ----
  for (const t of ['light', 'dark']) {
    // 「等重」的判据是 **感知亮度相等**（OKLab 的 L），不是相对亮度相等。
    // 按相对亮度相等来配，浅色里绿得压到 L≈73 才追上粉的亮度，那一档绿直接成了荧光色 ——
    // 因为同样的感知亮度下，绿的相对亮度天生比红高一大截。判据必须是 OKLab L。
    const offA = oklch(BAND[t + '/subtle']['add-bg']), offD = oklch(BAND[t + '/subtle']['del-bg']);
    for (const d of ['standard', 'strong']) {
      const bd = BAND[t + '/' + d];
      const pa = oklch(bd['add-bg']), pb = oklch(bd['del-bg']);
      const dL = Math.abs(pa[0] - pb[0]);
      ok(dL < 0.006, t + '/' + d + '：绿红行**感知亮度**相等（ΔL=' + dL.toFixed(4) + '）—— 观感等重');
      // 彩度不能各自放飞：官方那对本身就是绿 C 明显大于红 C（浅色 0.064 : 0.022），
      // 加深时按各自官方 C 等比放大，才保住 Gerrit 自己的红绿平衡。
      // 上一版正是绿的 C 被推到 0.201（红的 4.4 倍），于是红行看起来反而像没上色。
      const want = offA[1] / offD[1];
      const got = pa[1] / pb[1];
      ok(Math.abs(got - want) / want < 0.12,
        t + '/' + d + '：彩度比仍是官方的样子（绿:红 C = ' + got.toFixed(2) + ' : 1，官方 '
          + want.toFixed(2) + ' : 1）');
    }
    const a = bandScore[t + '/subtle'], b = bandScore[t + '/standard'], c = bandScore[t + '/strong'];
    ok(a < b && b < c,
      t + '：三档色带的「存在感」逐档上升（' + a.toFixed(2) + ' < ' + b.toFixed(2) + ' < ' + c.toFixed(2) + '）');
    // 「淡」到「标准」是主要的那一跳 —— 反馈的原话就是官方那档太淡。
    // 判据要绿红**分别**比：总分的增幅会被红行拉平，只看总分容易把「红绿等重」的变化误判成没加深。
    for (const k of ['add-bg', 'del-bg']) {
      const up = cr(BAND[t + '/standard'][k], BG[t]) - cr(BAND[t + '/subtle'][k], BG[t]);
      ok(up > 0.08, t + ' ' + k + '：标准档确实比淡档深（+' + up.toFixed(2) + '）');
    }
    // 色相不许跑偏：绿仍绿、红仍红（只动亮度 / 饱和，不换色系）
    for (const d of DEPTHS) {
      const bl = BAND[t + '/' + d];
      const ha = hueOf(bl['add-bg']), hd = hueOf(bl['del-bg']);
      ok(ha > 90 && ha < 170, t + '/' + d + '：ADD 仍是绿色相（H=' + ha.toFixed(0) + '°）');
      ok(hd > 330 || hd < 25, t + '/' + d + '：DEL 仍是红色相（H=' + hd.toFixed(0) + '°）');
    }
  }

  // ---- 5) 结构：行底色平涂、旧方案清干净 ----
  // 逐行渐变会在一行一个 div 的渲染方式下形成横纹（连续多行时像百叶窗），所以这里是硬约束。
  ok(!/--gloss/.test(html) && !/--add-edge/.test(html),
    '旧的「逐行渐变玻璃」方案已清除（--gloss / --add-edge 不该再出现）');
  ok(/\.hl\.add:where\(:not\(\.sbs\)\)\s*\{\s*background:\s*var\(--add-bg\);\s*\}/.test(html),
    '增行背景 = 平涂 var(--add-bg)，不是 linear-gradient');
  ok(/\.hl\.del:where\(:not\(\.sbs\)\)\s*\{\s*background:\s*var\(--del-bg\);\s*\}/.test(html),
    '删行背景 = 平涂 var(--del-bg)');
  ok(!/background:\s*#fff/.test(html), '行/侧边底色不再硬编码 #fff（否则深色主题下会露出白块）');
  ok(/\.hl\.add \.cmt, \.hl\.del \.cmt,/.test(html) && /var\(--cmt-on-tint\)/.test(html),
    '有色行上的注释走 --cmt-on-tint（中间调压在加深后的色带上会糊）');

  // ---- 6) 其它「跟主题走」的颜色 ----
  for (const t of ['light', 'dark']) {
    const v = THEME[t];
    ok(cr(v['ln-fg'], v['gutter-bg']) >= 4.5,
      t + '：行号 / 上下文 gutter ≥ 4.5（' + cr(v['ln-fg'], v['gutter-bg']).toFixed(2) + '）');
    ok(cr(v['hh-fg'], v['hh-bg']) >= 4.5, t + '：hunk 头 ≥ 4.5（' + cr(v['hh-fg'], v['hh-bg']).toFixed(2) + '）');
    ok(cr(v.fg, v['flash-bg']) >= 4.5, t + '：闪高行上的正文 ≥ 4.5（' + cr(v.fg, v['flash-bg']).toFixed(2) + '）');
  }

  // 语法着色与注释着色仍是两个独立开关
  ok(
    html.includes("p.cls === 'cmt' ? S.colorComments : S.syntaxHighlight"),
    'fillCode：注释只看 colorComments，不受 syntaxHighlight 牵连'
  );
}

// [L] 主题切换：auto 跟随编辑器；light/dark 强制；切主题只换 class、不重绘 diff
function sectionL() {
  console.log('\n[L] 主题切换（Gerrit Light / Dark）');
  const s0 = html.indexOf('function editorIsDark()');
  const s1 = html.indexOf('// ---------- 一键跳原文 ----------', s0);
  if (s0 < 0 || s1 < 0) throw new Error('抠不出主题相关函数，panel.html 结构变了？');
  // 亮度判断的实现在 body 开头那段「主题先行」脚本里（必须在首次绘制前挂类，防深色主题白闪），
  // applyTheme 那边只是转发。所以这里把两段一起抠出来跑 —— 顺带证明「只有一份实现」。
  const p0 = html.indexOf('function pcEditorIsDark()');
  const p1 = html.indexOf('document.body.classList.add(pcEditorIsDark()', p0);
  if (p0 < 0 || p1 < 0) throw new Error('抠不出主题先行脚本');
  const src = html.slice(p0, p1) + html.slice(s0, s1);

  ok(
    (html.match(/0\.2126 \* lin\[0\]/g) || []).length === 1,
    '亮度公式在全文件里只有一份（主题先行脚本），applyTheme 复用而不是各写一遍'
  );
  ok(
    html.indexOf('document.body.classList.add(pcEditorIsDark()') < html.indexOf('function applyTheme('),
    '「主题先行」脚本在 applyTheme 之前（首次绘制前就把 pc-light/pc-dark 挂上，深色主题不会白闪）'
  );

  const env = (editorBg, state) => {
    // 默认值要和 panel.html 里的 S 对齐（否则测不出「默认档」）
    const S = Object.assign({ diffTheme: 'auto', diffIntensity: 'standard', themeResolved: 'light' }, state);
    const body = { cls: new Set() };
    body.classList = {
      toggle(name, force) { if (force) body.cls.add(name); else body.cls.delete(name); },
    };
    const btn = { textContent: '', title: '' };
    btn.classList = { on: null, toggle(name, value) { btn.classList.on = value; } };
    const saves = [];
    const status = [];
    const doc = { body };
    const fns = new Function(
      'S', 'document', 'getComputedStyle', '$', 'saveUi', 'showStatus',
      src + '\nreturn { editorIsDark, resolvedTheme, applyTheme, cycleDiffTheme, cycleDiffDepth };'
    )(S, doc, () => ({ getPropertyValue: () => editorBg }), () => btn, () => saves.push(1), (m) => status.push(m));
    return { S, body, btn, fns, saves, status };
  };

  // auto 跟随编辑器：深色编辑器 → Gerrit Dark
  const a = env('#202124');
  a.fns.applyTheme();
  ok(a.fns.editorIsDark() === true, '能认出深色编辑器（读 --vscode-editor-background 算亮度）');
  ok(a.fns.resolvedTheme() === 'dark', 'auto + 深色编辑器 → dark');
  ok(a.body.cls.has('pc-dark') && !a.body.cls.has('pc-light'), 'body 上挂的是 pc-dark（两套 palette 靠它切换）');
  ok(a.btn.textContent === '◐' && a.btn.title.includes('Gerrit Dark'), `按钮是「跟随」并把当前实际配色写进 title（${a.btn.title.slice(0, 30)}…）`);
  ok(a.btn.classList.on === false, 'auto 模式下 ◐ 不高亮（auto 是默认态）');

  // auto + 浅色编辑器 → Gerrit Light
  const b = env('#ffffff');
  b.fns.applyTheme();
  ok(b.fns.resolvedTheme() === 'light', 'auto + 浅色编辑器 → light');
  ok(b.body.cls.has('pc-light'), 'body 上挂的是 pc-light');

  // 也认 rgb() 形式 + 读不到变量的兜底
  const c = env('rgb(32, 33, 36)');
  c.fns.applyTheme();
  ok(c.fns.resolvedTheme() === 'dark', '--vscode-editor-background 是 rgb() 形式也认');
  const d0 = env('');
  d0.fns.applyTheme();
  ok(d0.fns.resolvedTheme() === 'light', '读不到主题变量时兜底浅色（不抛错）');
  const d1 = env('#1e1e1e', { diffTheme: 'dark' });
  d1.fns.applyTheme();
  ok(d1.fns.resolvedTheme() === 'dark', '强制 dark 时忽略编辑器（编辑器是深色也一样）');
  const d2 = env('#202124', { diffTheme: 'light' });
  d2.fns.applyTheme();
  ok(d2.fns.resolvedTheme() === 'light', '强制 light 时编辑器是深色也照样浅色（这个开关存在的意义）');

  // 循环：auto → light → dark → auto，且只有非 auto 才亮
  const e = env('#202124');
  const seq = [];
  for (let i = 0; i < 4; i++) { seq.push(e.S.diffTheme); e.fns.cycleDiffTheme(); }
  ok(seq.join('>') === 'auto>light>dark>auto', `t 键循环顺序 auto→light→dark→auto（实际 ${seq.join('>')}）`);
  ok(e.saves.length === 4, '每次切换都落盘一次（saveUi）');
  ok(e.btn.classList.on === true, '循环停在非 auto 态（第 4 次记录的是 auto、切到 light）时 ◐ 高亮');
  e.S.diffTheme = 'auto';
  e.fns.applyTheme();
  ok(e.btn.classList.on === false, '切回 auto 后 ◐ 不再高亮');
  const f = env('#202124', { diffTheme: 'light' });
  f.fns.applyTheme();
  ok(f.btn.textContent === '☀' && f.btn.classList.on === true, '强制浅色时按钮显示 ☀ 且高亮');
  const g = env('#202124', { diffTheme: 'dark' });
  g.fns.applyTheme();
  ok(g.btn.textContent === '☾' && g.btn.classList.on === true, '强制深色时按钮显示 ☾ 且高亮');

  // 接线 / 落盘 / 持久化
  ok(/id="btn-theme"/.test(html), '顶栏里有 ◐ 按钮');
  ok(/\$\('#btn-theme'\)\.addEventListener\('click'/.test(html), '◐ 按钮接了点击');
  ok(/case 't':/.test(html), 't 快捷键切主题');
  ok(/diffTheme: S\.diffTheme, diffIntensity: S\.diffIntensity \}/.test(html),
    'saveUi 的载荷里带上了 diffTheme 与 diffIntensity');
  ok(/const nextTheme = ui\.diffTheme === 'light'/.test(html), 'applyUi 认 diffTheme（宿主发回来时套用）');
  ok(/applyTheme\(\);/.test(html) && /watchEditorTheme\(\);/.test(html), '启动时应用一次主题，并开始监听编辑器换主题');
  ok(/if \(S\.diffTheme === 'auto'\) applyTheme\(\);/.test(html), '编辑器换主题时只在 auto 下跟着换（强制模式不被打断）');
  ok(/attributeFilter: \['class', 'style'\]/.test(html), '监听的是 html/body 的 class 与 style（VS Code 换主题改这两处）');

  // ---- 色带深浅：和主题是两个独立的轴 ----
  const q0 = env('#ffffff');
  q0.fns.applyTheme();
  ok(q0.body.cls.has('i-standard') && !q0.body.cls.has('i-subtle'),
    '色带深浅默认是「标准」，body 上挂 i-standard（默认挂的是加深过的那档，不是 Gerrit 原色那档）');
  ok(q0.btn.classList.on === false, '深浅在默认档、主题也是 auto 时，◐ 不亮');

  const q1 = env('#ffffff', { diffIntensity: 'strong' });
  q1.fns.applyTheme();
  ok(q1.body.cls.has('i-strong') && !q1.body.cls.has('i-standard') && !q1.body.cls.has('i-subtle'),
    '设成 strong 后只有 i-strong（三档互斥，不会同时挂两个）');
  ok(q1.btn.classList.on === true, '深浅被改过时 ◐ 也亮着（提醒这里被动过）');

  const q2 = env('#ffffff', { diffIntensity: 'nonsense' });
  q2.fns.applyTheme();
  ok(q2.S.diffIntensity === 'standard' && q2.body.cls.has('i-standard'),
    '非法档位兜底成「标准」，并写回 S（免得状态和 class 不一致）');

  // 深浅和主题互不干扰：同一个 body 上同时有主题类和档位类
  const q3 = env('#202124', { diffTheme: 'light', diffIntensity: 'strong' });
  q3.fns.applyTheme();
  ok(q3.body.cls.has('pc-light') && q3.body.cls.has('i-strong'),
    '主题与深浅是两个独立的轴（pc-light + i-strong 可以同时成立，3×2 种组合）');
  ok(q3.btn.title.includes('浓') && q3.btn.title.includes('强制浅色'),
    '◐ 的 title 把两个轴都写清楚了（' + q3.btn.title.slice(0, 26) + '…）');

  // d 键循环：标准 → 浓 → 淡 → 标准
  const q4 = env('#ffffff');
  const qseq = [];
  for (let i = 0; i < 4; i++) { qseq.push(q4.S.diffIntensity); q4.fns.cycleDiffDepth(1); }
  ok(qseq.join('>') === 'standard>strong>subtle>standard',
    'd 键循环 标准→浓→淡→标准（实际 ' + qseq.join('>') + '）');
  ok(q4.saves.length === 4, '每次调深浅都落盘一次');
  // 走完 4 步停在「浓」上，状态栏跟着报当前档
  ok(q4.S.diffIntensity === 'strong' && q4.status[q4.status.length - 1].includes('浓'),
    '状态栏提示了当前档位（' + q4.status[q4.status.length - 1] + '）');
  q4.fns.cycleDiffDepth(-1);
  ok(q4.S.diffIntensity === 'standard' && q4.status[q4.status.length - 1].includes('标准'),
    'Shift+d（step=-1）往回走一档（浓 → 标准）');

  // 接线：首绘前就要挂上默认档，否则第一帧的行底色是空的
  ok(/document\.body\.classList\.add\('i-standard'\)/.test(html),
    '「主题先行」脚本里顺便挂了 i-standard（首帧不会闪出没有色带的 diff）');
  ok(/case 'd':/.test(html), 'd 快捷键调深浅');
  ok(/cycleDiffDepth\(e\.shiftKey \? -1 : 1\)/.test(html), 'd 带 Shift 时往回走');
  ok(/if \(e\.shiftKey\) cycleDiffDepth\(1\)/.test(html), '◐ 上 Shift+点击切深浅（一个按钮两个轴，不占顶栏）');
  ok(/const nextDepth = ui\.diffIntensity === 'subtle'/.test(html), 'applyUi 认 diffIntensity（宿主发回来时套用）');
  ok(/document\.body\.classList\.toggle\('i-' \+ d, d === depth\)/.test(html),
    '三个 i-* 类是「只留一个」的切换，不是叠加');
}

// （调用点统一放在文件末尾，保证输出顺序 I→J→K→L）

// [J] 原生标签模式：每个 diff 已经是 Cursor 自己的标签页，页面里不能再画一排内部页签栏
//（否则就是「标签套标签」）。这里不靠字符串匹配，而是把 renderTabs 抠出来在假 DOM 上真跑一遍。
function sectionJ() {
  console.log('\n[J] 原生标签模式：页面内部页签栏必须收起来');
  const s0 = html.indexOf('function renderTabs()');
  const endMark = "act.scrollIntoView({ block: 'nearest', inline: 'nearest' });\n  }";
  const e0 = html.indexOf(endMark, s0);
  if (s0 < 0 || e0 < 0) throw new Error('抠不出 renderTabs，panel.html 结构变了？');
  const src = html.slice(s0, e0 + endMark.length);

  // 假 DOM：$('#tabs') 返回同一个 bar 对象，我们只看它的 className / textContent
  const run = (nativeTabs, docCount) => {
    const bar = { className: '', textContent: '', appendChild() {}, querySelector: () => null };
    const S = {
      nativeTabs,
      docs: Array.from({ length: docCount }, (_, i) => ({ id: 'd' + i, view: {} })),
      activeId: 'd0',
    };
    const doc = {
      createDocumentFragment: () => ({ appendChild() {}, append() {} }),
      createElement: () => ({
        className: '',
        title: '',
        textContent: '',
        append() {},
        addEventListener() {},
      }),
    };
    const funcs = new Function('S', '$', 'document', src + '\nreturn renderTabs;')(S, () => bar, doc);
    funcs();
    return bar;
  };

  const many = run(true, 5);
  ok(many.className === 'hidden', `原生标签模式：开着 5 份文档也不画页签栏（className=${many.className || '(空)'}）`);
  ok(many.textContent === '', '原生标签模式：页签栏里不残留任何节点');

  // 宿主把 nativeTabs 一路传进来：commit 消息 → applyCommit 的第 4 个参数 → S.nativeTabs
  ok(/applyCommit\(m\.commit, m\.hostVersion, m\.docId, m\.nativeTabs\)/.test(html),
    'commit 消息里的 nativeTabs 传进了 applyCommit');
  ok(/function applyCommit\(c, hostVersion, docId, nativeTabs\)/.test(html),
    'applyCommit 接收 nativeTabs');
  ok(/S\.nativeTabs = !!nativeTabs;/.test(html), 'applyCommit 落进 S.nativeTabs');
}

sectionJ();

// [K] 「符号差异」开关（¶）：换行符 / 行尾空白这类差异默认不显示，但一切就能看见。
// 这个开关和「双页对比」不一样 —— 双页只改画法，本地重绘就够；它要改 git 的算法，
// 所以切了必须让宿主重算数据（发 refreshDiff），光重绘页面是没用的。
function sectionK() {
  console.log('\n[K] 符号差异开关（¶）');
  const a0 = html.indexOf('function applySym()');
  const a1 = html.indexOf('function toggleIgnoreSymbols()');
  const a2 = html.indexOf('// ---------- 一键跳原文 ----------', a1);
  if (a0 < 0 || a1 < 0 || a2 < 0) throw new Error('抠不出 applySym / toggleIgnoreSymbols，panel.html 结构变了？');
  const src = html.slice(a0, a2);

  const makeBtn = () => {
    const b = { title: '' };
    // 注意 toggle 里的 this 是 classList 自己，所以显式挂到 classList 上，别再写 this.on
    b.classList = { on: null, toggle(cls, v) { b.classList.on = v; } };
    return b;
  };
  const lit = (b) => b.classList.on;
  const load = (btn, S, hooks) => {
    const stubs = {
      saveUi: () => {},
      showStatus: () => {},
      vscode: { postMessage: (m) => hooks.sent.push(m) },
      ...hooks,
    };
    const fns = new Function('S', '$', 'saveUi', 'showStatus', 'vscode', src + '\nreturn { applySym, toggleIgnoreSymbols };')(
      S,
      () => btn,
      stubs.saveUi,
      stubs.showStatus,
      stubs.vscode
    );
    return fns;
  };

  // 默认（忽略）：按钮亮起，title 说清忽略了什么
  const btn1 = makeBtn();
  const S1 = { ignoreSymbols: true };
  load(btn1, S1, { sent: [] }).applySym();
  ok(lit(btn1) === true, '默认状态：¶ 按钮是「亮」的（表示正在忽略）');
  ok(/已忽略/.test(btn1.title) && /CRLF/.test(btn1.title), `title 说明了忽略的是什么（${btn1.title.slice(0, 24)}…）`);

  // 显示模式：按钮灭掉
  const btn2 = makeBtn();
  const S2 = { ignoreSymbols: false };
  load(btn2, S2, { sent: [] }).applySym();
  ok(lit(btn2) === false, '显示模式：¶ 按钮不亮');
  ok(/正在显示符号差异/.test(btn2.title), 'title 换成「正在显示符号差异」');

  // 点一下：翻转 + 落盘 + 让宿主重算（带新值，避免和防抖的 saveUi 抢先后）
  const btn3 = makeBtn();
  const S3 = { ignoreSymbols: true };
  const sent = [];
  let saved = 0;
  const fns3 = load(btn3, S3, { sent, saveUi: () => { saved++; } });
  fns3.applySym();
  fns3.toggleIgnoreSymbols();
  ok(S3.ignoreSymbols === false, '点一下 → 切到「显示符号差异」');
  ok(lit(btn3) === false, '按钮状态跟着变');
  ok(saved === 1, '顺手把偏好落盘（下次开面板还是这个选择）');
  const ref = sent.find((m) => m.type === 'refreshDiff');
  ok(!!ref, '发了 refreshDiff：数据要回 git 重算，不能只重绘页面');
  ok(ref && ref.ignoreSymbols === false, '带上新值 —— 否则会和 400ms 防抖的 saveUi 抢先后');

  // 别的标签按了 ¶ 会通过 uiState 广播过来：那边要自己请求重算（不带值，宿主已经存了）
  ok(
    /const nextSym = ui\.ignoreSymbols !== false;/.test(html) &&
      /if \(symChanged\) \{\s*try \{ vscode\.postMessage\(\{ type: 'refreshDiff' \}\); \}/.test(html),
    'uiState 广播回来时：别的标签也会请求重算一次'
  );

  // 接线 / 落盘 / 快捷键
  ok(/id="btn-sym"/.test(html), '顶栏里有 ¶ 按钮');
  ok(/\$\('#btn-sym'\)\.addEventListener\('click'/.test(html), '¶ 按钮接了点击');
  ok(/case 'i':/.test(html), 'i 快捷键切开关（invisibles）');
  ok(/ignoreSymbols: S\.ignoreSymbols \}/.test(html), 'saveUi 的载荷里带上了这个开关');

  // 数据落地 + 提示文案：忽略掉的必须点名，否则用户以为工具漏文件
  ok(/S\.symbolOnly = Array\.isArray\(c\.symbolOnly\)/.test(html), 'applyDoc 收下 symbolOnly');
  ok(/S\.symbolsIgnored = c\.symbolsIgnored !== false;/.test(html), 'applyDoc 收下 symbolsIgnored');
  ok(/忽略 \$\{S\.symbolOnly\.length\} 个只差符号\/空白的文件/.test(html), '副标题里报了「忽略 N 个」');
  ok(/只差「符号」/.test(html), '一个文件都没有时，占位文案点名是哪些文件');
  ok(/prettyCommit\.ignoreSymbolDiffs/.test(html), '占位文案里给了「怎么才能看到」的开关名');
}

// [M] 精确跳行 + 重读（refresh）
// 两件事都属于「内容会变」这一类：跳行要求行号能精确映射到工作区文件，重读要求
// 面板在数据被重算之后**不丢位置**（丢掉就表现为「一刷新回到第一个文件、滚回顶部」）。
function sectionM() {
  console.log('\n[M] 精确跳行（点行号）+ 重读 diff（r）');

  // ---- M1 删除行的跳转目标 ----
  const j0 = html.indexOf('function fillJumpTargets(');
  const j1 = html.indexOf('// 行号列宽度按「本文件出现过的最大行号位数」自适应', j0);
  if (j0 < 0 || j1 < 0) throw new Error('抠不出 fillJumpTargets，panel.html 结构变了？');
  const fillJumpTargets = new Function(
    html.slice(j0, j1) + '\nreturn fillJumpTargets;'
  )();

  // ctx(10) / del(11) / del(12) / add(11) / ctx(13)：两个删除行在新文件里没有行号，
  // 必须落到「这段改动消失的位置」（后面的 11），而不是拿旧行号 11/12 去跳新文件。
  {
    const rows = [
      { raw: ' ctx10', kind: 'ctx', old: '10', new: '10' },
      { raw: '-del11', kind: 'del', old: '11', new: '' },
      { raw: '-del12', kind: 'del', old: '12', new: '' },
      { raw: '+add11', kind: 'add', old: '', new: '11' },
      { raw: ' ctx13', kind: 'ctx', old: '13', new: '13' },
    ];
    fillJumpTargets(rows);
    ok(rows[0].jump === 10, `上下文行用自己的新行号（实际 ${rows[0].jump}）`);
    ok(rows[1].jump === 11 && rows[2].jump === 11, `删除行取「后面最近的新行号」（11，实际 ${rows[1].jump}/${rows[2].jump}）`);
    ok(rows[3].jump === 11, `新增行用自己的新行号（实际 ${rows[3].jump}）`);
    ok(rows[4].jump === 13, `后面的上下文行不受影响（实际 ${rows[4].jump}）`);
  }
  // 删到文件尾：后面没有新行号了，退回前面最近的（否则这一行点不动）
  {
    const rows = [
      { raw: ' ctx5', kind: 'ctx', old: '5', new: '5' },
      { raw: '-del6', kind: 'del', old: '6', new: '' },
      { raw: '-del7', kind: 'del', old: '7', new: '' },
    ];
    fillJumpTargets(rows);
    ok(rows[1].jump === 5 && rows[2].jump === 5, `删到文件尾 → 退回前面最近的新行号（5，实际 ${rows[1].jump}/${rows[2].jump}）`);
  }
  // 异常 @@ 头（没有行号）：宁可不给跳转，也不能跳到错地方
  {
    const rows = [{ raw: '+x', kind: 'add', old: '', new: '' }];
    fillJumpTargets(rows);
    ok(rows[0].jump == null, '没有可对齐的行号时不给跳转目标（而不是拿 0/旧行号去跳）');
  }

  // ---- M2 点行号 → openSource（精确到行） ----
  const o0 = html.indexOf('function topVisibleLine(');
  const o1 = html.indexOf('// ---------- 重读 diff（refresh）----------', o0);
  const o2 = html.indexOf('function requestRefresh(', o1);
  const o3 = html.indexOf('\n  }', o2) + 4;
  if (o0 < 0 || o1 < 0 || o2 < 0) throw new Error('抠不出 openSourceFile / requestRefresh，panel.html 结构变了？');
  const srcM = html.slice(o0, o1) + html.slice(o2, o3);

  const loadM = (S, hooks) => {
    const toast = (t) => hooks.toasts.push(t);
    const vscodeStub = { postMessage: (m) => hooks.sent.push(m) };
    const bodyFn = () => hooks.body;      // $('#diffbody')
    const curFileFn = () => hooks.curFile;
    return new Function(
      'S', '$', 'vscode', 'toast', 'curFile', 'showStatus',
      srcM + '\nreturn { topVisibleLine, scrollToLine, openSourceFile, requestRefresh };'
    )(S, bodyFn, vscodeStub, toast, curFileFn, () => {});
  };

  // 工作区 diff：点第 37 行的行号 → 精确跳第 37 行，且不做 historical（宿主会开可编辑的真实文件）
  {
    const hooks = { sent: [], toasts: [], curFile: { path: 'src/x.c' }, body: null };
    const fns = loadM({ isWorking: true }, hooks);
    fns.openSourceFile({ line: 37 });
    const m = hooks.sent[0];
    ok(!!m && m.type === 'openSource', '点行号发的是 openSource');
    ok(m && m.path === 'src/x.c' && m.line === 37, `带上文件与**精确行号**（${m && m.path}:${m && m.line}）`);
    ok(m && m.historical === false, '工作区 diff：historical=false → 宿主打开可编辑的真实文件');
  }
  // 历史 diff：默认开快照（只读）；Alt+点（worktree）则去开工作区文件
  {
    const h1 = { sent: [], toasts: [], curFile: { path: 'a.c' }, body: null };
    loadM({ isWorking: false }, h1).openSourceFile({ line: 8 });
    ok(h1.sent[0].historical === true, '历史 diff：默认开该提交的快照（行号才严格对得上）');
    ok(h1.sent[0].worktree === false, '历史 diff 默认不带 worktree');
    const h2 = { sent: [], toasts: [], curFile: { path: 'a.c' }, body: null };
    loadM({ isWorking: false }, h2).openSourceFile({ line: 8, worktree: true });
    ok(h2.sent[0].historical === false && h2.sent[0].worktree === true, 'Alt+点 → worktree=true（放弃快照，去工作区改代码）');
  }
  // 不带行号（快捷键 o）时退回「视口顶部那一行」
  {
    const mkEl = (nw, top, h) => ({
      classList: { contains: (c) => c === 'hl' },
      dataset: { lnNew: nw },
      offsetTop: top,
      offsetHeight: h,
    });
    const body = { scrollTop: 0, children: [mkEl('', -100, 20), mkEl('12', 100, 20), mkEl('13', 120, 20)] };
    const hooks = { sent: [], toasts: [], curFile: { path: 'a.c' }, body };
    loadM({ isWorking: true }, hooks).openSourceFile();
    ok(hooks.sent[0].line === 12, `o 键不带行号 → 用视口顶部那一行（实际 ${hooks.sent[0].line}）`);
  }
  // 没选中文件时别发消息（发出去宿主也不知道开哪个）
  {
    const hooks = { sent: [], toasts: [], curFile: null, body: null };
    loadM({ isWorking: true }, hooks).openSourceFile({ line: 3 });
    ok(hooks.sent.length === 0 && hooks.toasts.length === 1, '没选中文件 → 只提示，不发消息');
  }

  // ---- M3 重读：消息形状 + 入口接线 ----
  {
    const hooks = { sent: [], toasts: [], curFile: { path: 'a.c' }, body: null };
    const fns = loadM({ isWorking: true }, hooks);
    fns.requestRefresh(false);
    ok(hooks.sent[0] && hooks.sent[0].type === 'refresh' && hooks.sent[0].all === false, 'r → {type:refresh, all:false}');
    fns.requestRefresh(true);
    ok(hooks.sent[1].all === true, 'Shift+R → all:true（所有 diff 标签一起重读）');
  }
  ok(/case 'r': case 'R':/.test(html), 'r / R 快捷键接了重读');
  ok(/requestRefresh\(e\.shiftKey\)/.test(html), 'Shift 决定「只重读当前」还是「全部重读」');
  ok(/id="btn-refresh"/.test(html) && /\$\('#btn-refresh'\)\.addEventListener\('click'/.test(html), '顶栏 ↻ 按钮存在且接了点击');
  ok(/'r','R','e','E'\]\.includes\(e\.key\)/.test(html), '按住不放不会连发一堆 git 重算 / 展开');
  ok(/点行号 跳到该行/.test(html) && /<kbd>r<\/kbd> 重读 diff/.test(html), '底栏写了这两个新交互');

  // ---- M4 重读后必须保住「你在看哪个文件、滚到哪儿」 ----
  // 这是本次一并修掉的老 bug：以前只在**切换文档**时 captureView，所以同一份 diff
  // 被重算（按 r / 切 ¶ / 宿主自动重读）时 d.view 里没有 idx，applyDoc 就把人拉回
  // 第一个文件、滚回顶部。
  ok(
    /captureView\(\);\s*\n\s*clearBlobsFor\(id\);/.test(html) && /let d = docOf\(id\);/.test(html),
    'applyCommit：收到新数据前**无条件**先 captureView（同一文档重算也保住位置），再清原文缓存'
  );
  ok(
    !/if \(S\.activeId && S\.activeId !== id\) captureView\(\);/.test(html),
    '老的「只在换文档时才记位置」写法已经不在了'
  );
  ok(/path: \(curFile\(\) \|\| \{\}\)\.path \|\| ''/.test(html), 'captureView 连文件**路径**一起记（文件顺序会变，只记下标不牢靠）');
  ok(
    /if \(v\.path\) idx = S\.files\.findIndex\(\(x\) => x\.path === v\.path\);/.test(html),
    'applyDoc：优先按路径找回原来那个文件'
  );
  ok(
    /if \(idx < 0\) idx = Math\.max\(0, Math\.min\(Number\(v\.idx\)/.test(html),
    '路径找不到（文件被删/改名）时才退回旧下标，并夹在合法范围内'
  );

  // 滚动位置同理按「行」锚定：重算后上面多了/少了几行，同一个像素位置会落到别的行上
  {
    const mk = (j, top) => ({
      classList: { contains: (c) => c === 'hl' },
      dataset: j == null ? {} : { lnJump: String(j) },
      offsetTop: top,
      offsetHeight: 20,
    });
    const body = { scrollTop: 0, children: [mk(10, 0), mk(20, 400), mk(30, 800)] };
    const hooks = { sent: [], toasts: [], curFile: { path: 'a.c' }, body };
    const fns = loadM({ isWorking: true }, hooks);
    ok(fns.scrollToLine(20) === true && body.scrollTop === 400, '滚动按行锚定：正好命中那一行');
    ok(fns.scrollToLine(25) === true && body.scrollTop === 800, `要第 25 行 → 滚到头一个 ≥25 的行（实际 ${body.scrollTop}）`);
    body.scrollTop = 0;
    ok(fns.scrollToLine(999) === true && body.scrollTop === 800, '目标行在文件末尾之后（内容变短了）→ 滚到最后一行，而不是跳回顶部');
    ok(fns.scrollToLine(0) === false && fns.scrollToLine(NaN) === false, '没有行号时返回 false，交给像素兜底');
  }
  ok(/topLine: topVisibleLine\(\)/.test(html), 'captureView 连「停在第几行」一起记');
  ok(
    /if \(!scrollToLine\(Number\(v\.topLine\)\) && Number\(v\.scroll\) > 0\)/.test(html),
    'applyDoc 优先按行还原滚动，行锚定不成才退回像素'
  );
  ok(
    /line\.dataset\.lnJump = String\(r\.jump\)/.test(html) && /line\.dataset\.lnJump = String\(jump\)/.test(html),
    '单页/双页的行元素上也挂了行号（按行还原要靠它取 offsetTop）'
  );

  // ---- M5 行号可点这件事本身 ----
  ok(/\.ln\[data-ln-jump\] \{ cursor: pointer; \}/.test(html), '可跳的行号有 pointer 光标');  ok(/el\.dataset\.lnJump = String\(r\.jump\)/.test(html), '单页每行挂上跳转目标');
  ok(/ln\.dataset\.lnJump = String\(r\.jump\)/.test(html), '双页每侧也挂上（两侧都跳同一处，不拿旧行号跳新文件）');
  ok(/const ln = e\.target\.closest\('\.ln'\);/.test(html), '点行号的点击处理接在 diffbody 上');
  ok(
    /ln && ln\.dataset\.lnJump && !e\.ctrlKey && !e\.metaKey/.test(html),
    'Ctrl/⌘+点行号不抢（交给跳定义那条路），Alt+点才走 worktree'
  );

  // ---- M6 真把行 DOM 建一遍 ----
  // 上面全是「源码里有没有这句话」的结构断言，看不出 makeLine / makeSbsCell 真的把
  // dataset.lnJump 落到 DOM 上（写错一个作用域就是整页白屏）。这里配一个迷你 DOM
  // 把这三个函数真跑一遍 —— 相当于把「点行号能不能用」这条链路的最后一环也钉住。
  const r0 = html.indexOf('function makeLine(');
  const r1 = html.indexOf('function renderDiff(', r0);
  if (r0 < 0 || r1 < 0) throw new Error('抠不出 makeLine / makeSbsRow，panel.html 结构变了？');
  const renderSrc = html.slice(r0, r1);

  const makeEl = (tag) => {
    const el = {
      tagName: tag,
      children: [],
      _cls: [],
      dataset: {},
      attrs: {},
      textContent: '',
      title: '',
      classList: {
        add(...cs) { el._cls.push(...cs); },
        contains: (c) => el._cls.includes(c),
      },
      appendChild(k) { el.children.push(k); return k; },
      set className(v) { el._cls = String(v).split(/\s+/).filter(Boolean); },
      get className() { return el._cls.join(' '); },
      closest() { return null; },
      querySelector() { return null; },
    };
    return el;
  };
  const doc = { createElement: makeEl, createTextNode: (t) => ({ textContent: t }) };
  const buildLine = new Function(
    'document', 'S', 'fillCode', 'Number',
    renderSrc + '\nreturn { makeSbsCell, makeSbsRow, makeLine };'
  )(
    doc,
    { isWorking: true },
    (el, raw) => { el.textContent = String(raw || '').replace(/^[+\- ]/, ''); },
    Number
  );

  const jumpRow = { raw: ' ctx', kind: 'ctx', old: '7', new: '7', jump: 7 };
  const delRow = { raw: '-gone', kind: 'del', old: '8', new: '', jump: 9 };
  {
    const line = buildLine.makeLine(delRow, 'a.c', 0);
    const lns = line.children.filter((k) => k._cls.includes('ln'));
    ok(lns.length === 2, `一行两个行号格（实际 ${lns.length}）`);
    ok(
      lns.every((k) => k.dataset.lnJump === '9'),
      `删除行：两侧行号都带上「消失位置」9（实际 ${lns.map((k) => k.dataset.lnJump).join('/')}）`
    );
    ok(lns.every((k) => /打开第 9 行/.test(k.title)), '行号带上了「打开第 N 行」的 title 提示');
    ok(line.dataset.lnJump === '9', '行元素自己也挂了行号（scrollToLine 按行还原要用）');
  }
  {
    // 没有跳转目标的行走另一条分支：不给 dataset、不给 title（光看结构断言看不出这点）
    const noJump = buildLine.makeLine({ raw: '+x', kind: 'add', old: '', new: '', jump: null }, 'a.c', 0);
    const lns = noJump.children.filter((k) => k._cls.includes('ln'));
    ok(lns.every((k) => k.dataset.lnJump === undefined), '没算出目标行的行号不可点（不发 dataset）');
    ok(lns.every((k) => k.title === ''), '也没有 title —— 鼠标移上去不该骗人说能跳');
  }
  {
    // 双页：左侧的**旧行号**（8）和右侧的新行号（9）都跳同一处，绝不能拿旧行号 8 去跳
    const row = buildLine.makeSbsRow({ left: delRow, right: { raw: '+new', kind: 'add', old: '', new: '9', jump: 9 } }, 'a.c', 0);
    const cells = row.children;
    ok(cells.length === 2, '双页一行两格');
    ok(cells[0].children[0].dataset.lnJump === '9' && cells[1].children[0].dataset.lnJump === '9',
      `两侧都跳 9（左格实际 ${cells[0].children[0].dataset.lnJump}，右格 ${cells[1].children[0].dataset.lnJump}）`);
    ok(row.dataset.lnJump === '9', '双页行元素上也挂了行号');
    const empty = buildLine.makeSbsCell(null, 'left', 'a.c');
    ok(empty.children[0].dataset.lnJump === undefined, '空占位那侧不可点');
  }
  {
    // 历史 diff：title 要说清是只读快照，并提示 Alt+点这条出路
    const fns = new Function(
      'document', 'S', 'fillCode', 'Number',
      renderSrc + '\nreturn { makeLine };'
    )(doc, { isWorking: false }, () => {}, Number);
    const line = fns.makeLine(jumpRow, 'a.c', 0);
    const ln = line.children.find((k) => k._cls.includes('ln'));
    ok(/只读/.test(ln.title) && /Alt\+点击/.test(ln.title), `历史 diff 的 title 讲清「只读」与 Alt+点（${ln.title.slice(0, 20)}…）`);
  }
}

sectionK();
sectionL();   // [L] 定义在前、这里才跑，保证 [I]→[J]→[K]→[L] 的输出顺序
sectionM();

console.log('\n[O] hunk 缝展开：行号切片 + 上下文行（不改动左侧文件折叠）');
{
  const o0 = html.indexOf('function fillJumpTargets(rows)');
  const o1 = html.indexOf('function langStyle(', o0);
  if (o0 < 0 || o1 < 0) throw new Error('抠不出展开用的函数，panel.html 结构变了？');
  const expandSrc = html.slice(o0, o1);
  const {
    parseHunkSpan,
    hunkGaps,
    gapLineCount,
    ctxRowsForGap,
    splitSourceLines,
  } = new Function(expandSrc + '\nreturn { parseHunkSpan, hunkGaps, gapLineCount, ctxRowsForGap, splitSourceLines };')();

  const many = filesOf('HEAD').get('many.txt');
  ok(!!many && many.hunks.length === 2, `many.txt 是两段改动岛（实际 ${many && many.hunks.length}）`);
  const s0 = parseHunkSpan(many.hunks[0].header);
  const s1 = parseHunkSpan(many.hunks[1].header);
  ok(s0 && s0.newStart === 1, `第一段从新文件第 1 行起（unified=3 会带上文件头，实际 ${s0 && s0.newStart}）`);
  ok(s1 && s1.newStart >= 50, `第二段在文件后部（实际起点 ${s1 && s1.newStart}）`);

  const oldLines = manyLines;
  const newLines = many2;
  const gaps = hunkGaps(many.hunks, oldLines.length, newLines.length);
  const mid = gaps.find((g) => g.id === '0-1');
  ok(!!mid, `两段之间有一条缝（缝 id：${gaps.map((g) => g.id).join(',')}）`);
  ok(!gaps.some((g) => g.id === 'head'), '第一段贴着文件头 → 没有文件头缝');
  const tail = gaps.find((g) => g.id === 'tail');
  ok(!!tail && tail.newTo === 60, `文件末尾还有缝，接到第 60 行（实际 ${tail && tail.newTo}）`);

  const nMid = gapLineCount(mid);
  ok(nMid > 10, `中间缝超过 unified=3 的 3 行上下文（实际 ${nMid}）`);
  const rows = ctxRowsForGap(mid, oldLines, newLines);
  ok(rows.length === nMid, `切片行数 = 缝的行数（${rows.length}）`);
  ok(rows.every((r) => r.kind === 'ctx' && r.raw[0] === ' '), '缝里全是上下文（行首空格，送 Chat 才合法）');
  ok(rows[0].old === String(mid.oldFrom) && rows[0].new === String(mid.newFrom), '第一行两侧行号对齐缝的起点');
  ok(rows[0].jump === mid.newFrom, '展开行也能点行号跳（jump = 新行号）');
  const text0 = rows[0].raw.slice(1);
  ok(text0 === newLines[mid.newFrom - 1], `正文来自新侧原文第 ${mid.newFrom} 行（${JSON.stringify(text0)}）`);

  const noLen = hunkGaps(many.hunks, 0, 0);
  ok(!noLen.some((g) => g.id === 'tail'), '还没拿到全文长度时不猜文件末尾（避免假缝）');

  const fresh = filesOf('HEAD~3').get('fresh.txt') || filesOf('HEAD~2').get('fresh.txt');
  // fresh 是纯新增：一个从 +1 起的 hunk，没有缝
  const addFiles = parseCommitDiff(git('show', '--format=', 'HEAD~3'));
  const freshF = addFiles.find((x) => x.path === 'fresh.txt') || parseCommitDiff(git('show', '--format=', 'HEAD~2')).find((x) => x.path === 'fresh.txt');
  if (freshF) {
    ok(hunkGaps(freshF.hunks, 0, 10).length === 0, '纯新增文件没有可展开的缝（全文已经在 diff 里）');
  }

  ok(splitSourceLines('a\nb\n').length === 2 && splitSourceLines('a\nb').length === 2, '原文按行切开：末尾换行不另算一行');
  ok(splitSourceLines('').length === 0, '空文件 0 行');

  ok(/class="hx"/.test(html) || /\.hx \{/.test(html), '展开条用 .hx，不是 .hh（不进 hunk 导航）');
  ok(/hx-open/.test(html), '展开后条还在（hx-open），才能点回去');
  ok(/function closeGap\(/.test(html), '单条缝能单独收起');
  ok(/anyGapOpen\(f\)/.test(html), '头上的「收起」认单条缝，不只认全文');
  ok(/renderDiff\(\{ keepScroll: true \}\)/.test(html), '展开/收起不把滚动甩回文件头');
  ok(/case 'e':/.test(html) && /toggleExpandAll/.test(html), 'e = 展开/收起切换');
  ok(/case 'E':/.test(html), 'E = 收起上下文（左侧再点文件的折叠不绑这件事）');
  ok(/btn-expand-all/.test(html) && /收起上下文/.test(html), 'diff 头上有展开/收起按钮');
  ok(/if \(i === S\.idx\) \{ S\.open = !S\.open/.test(html), '左侧再点当前文件仍然是收起整份 diff，没被改成展开源码');
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
