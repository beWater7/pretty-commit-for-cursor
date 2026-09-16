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

console.log('\n[G] 注释切分');
{
  const c0 = html.indexOf('function langStyle(');
  const c1 = html.indexOf('function fillCode(');
  if (c0 < 0 || c1 < 0) throw new Error('抠不出 langStyle/splitComments');
  const { langStyle, splitComments } = new Function(
    html.slice(c0, c1) + '\nreturn { langStyle, splitComments };'
  )();
  ok(langStyle('a.js') === 'c' && langStyle('x.py') === 'hash' && langStyle('a.html') === 'xml', '按扩展名选风格');
  const js = splitComments('const a = 1; // tail', 'c');
  ok(js.length === 2 && !js[0].cmt && js[1].cmt && js[1].t === '// tail', '行尾 // 注释');
  const url = splitComments('const u = "http://x.com"; // u', 'c');
  ok(url.length === 2 && url[0].t.includes('http://') && !url[0].cmt && url[1].cmt, '字符串里的 http:// 不当注释');
  const py = splitComments('x = 1  # n', 'hash');
  ok(py.length === 2 && py[1].t === '# n' && py[1].cmt, 'python # 注释');
  const blk = splitComments('a = 1; /* z */ b = 2;', 'c');
  ok(blk.length === 3 && blk[1].cmt && blk[1].t === '/* z */' && !blk[2].cmt, '同行 /* */ 块注释');
  const hashInStr = splitComments('s = "# not cmt"', 'hash');
  ok(hashInStr.length === 1 && !hashInStr[0].cmt, '字符串里的 # 不当注释');
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
