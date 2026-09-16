'use strict';
// 预览渲染：把真实的 media/panel.html 拿起来，喂真实 git 数据，用无头 Chrome 截图。
// 页面代码一行都不改（只是前置一个 acquireVsCodeApi 桩 + 末尾派发 commit 消息）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { parseCommitDiff } = require(path.join(ROOT, 'src/parse.js'));

// ---------------- 造一个内容丰富的仓库 ----------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pcview-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
const w = (n, t) => {
  fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true });
  fs.writeFileSync(path.join(repo, n), t);
};

const src = (v2) => [
  v2 ? '// widget 渲染器（v2：拆出 layout）' : '// widget 渲染器',
  'function render(ctx, items) {',
  '  const out = [];',
  '  for (const it of items) {',
    '    if (!it.visible) continue; // skip hidden items',
  '    out.push({ id: it.id, label: it.label, box: layout(ctx, it) });',
  '  }',
  '  return out.sort((a, b) => a.box.y - b.box.y);',
  '}',
  '',
  'function layout(ctx, it) {',
  '  return { x: ctx.x + it.dx, y: ctx.y + it.dy, w: it.w, h: it.h };',
  '}',
  '',
  'const REALLY_LONG_LINE = "这一行故意做得很长，用来确认横向滚动时两列行号是钉住不动的，并且正文不会从行号下面穿过去";',
  '',
  'function unusedHelper(a, b) {',
  '  return a + b;',
  '}',
  ...Array.from({ length: 34 }, (_, i) => `function filler${i + 1}() { return ${i + 1}; }`),
  v2 ? 'module.exports = { render };' : 'module.exports = { render, layout };',
  '',
].join('\n');

w('src/widget.js', src(false));
w('src/legacy.js', 'module.exports = 1;\n');
w('README.md', 'hi\n\nmore\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');

// 这一笔里塞进：修改(多 hunk) + 新增 + 删除 + 无换行结尾
w('src/widget.js', src(true));
w('src/fresh.js', 'const a = 1;\nconst b = 2;\n');
w('src/noeol.js', 'first\nsecond');   // 无换行结尾
git('rm', '-q', 'src/legacy.js');
git('add', '-A');
git('commit', '-q', '-m', 'refactor: 拆出 layout，新增 fresh，删掉 legacy');

// ---------------- 生成 toViewModel 形状的数据 ----------------
const diffText = git('show', '--format=', 'HEAD');
const parsed = parseCommitDiff(diffText);
const files = parsed.map((f) => ({ ...f, hunks: f.hunks, viewTrunc: false, unchanged: false }));
const adds = parsed.reduce((n, f) => n + f.added, 0);
const dels = parsed.reduce((n, f) => n + f.deleted, 0);
const commit = {
  sha: 'a'.repeat(40),
  shortSha: 'abc1234',
  subject: 'refactor: 拆出 layout，新增 fresh，删掉 legacy',
  note: '',
  delta: adds + dels,
  adds,
  dels,
  totalFiles: files.length,
  hiddenUnchanged: 0,
  author: 't',
  files,
};

// ---------------- 组页面 ----------------
const panel = fs.readFileSync(path.join(ROOT, 'media/panel.html'), 'utf8');
const STUB = `<script>
  window.__sent = [];
  window.acquireVsCodeApi = function () {
    return { postMessage: function (m) { window.__sent.push(m); } };
  };
</script>
`;

// 浅色主题变量（模拟 VS Code Light+），用来确认深色壳/浅色壳两种情况下白色 diff 区都成立
const LIGHT_VARS = `<style>
  :root {
    --vscode-editor-background: #ffffff;
    --vscode-editor-foreground: #333333;
    --vscode-descriptionForeground: #717171;
    --vscode-panel-border: #e5e5e5;
    --vscode-editorWidget-background: #f3f3f3;
    --vscode-list-activeSelectionBackground: #0060c0;
    --vscode-button-background: #007acc;
    --vscode-button-secondaryBackground: #e5e5e5;
    --vscode-button-secondaryForeground: #3b3b3b;
    --vscode-charts-green: #388a34;
    --vscode-charts-red: #e51400;
    --vscode-notifications-background: #f3f3f3;
    --vscode-notifications-foreground: #333333;
    --vscode-errorForeground: #a1260d;
  }
</style>
`;

function page(light) {
  let html = panel;
  html = html.replace('</head>', (light ? LIGHT_VARS : '') + '</head>');
  html = html.replace(/<script>/, STUB + '<script>');
  // 末尾（IIFE 之后）派发消息
  const tail = `<script>
  (function () {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'hostBuild', hostVersion: 'preview' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'commit', commit: ${JSON.stringify(commit)}, hostVersion: 'preview' } }));
  })();
  </script>
</body>`;
  html = html.replace('</body>', tail);
  return html;
}

const outDir = path.join(os.tmpdir(), 'pcview-out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'dark.html'), page(false));
fs.writeFileSync(path.join(outDir, 'light.html'), page(true));
console.log('页面已生成:', outDir);
console.log('files:', files.map((f) => `${f.path}(${f.status} +${f.added}/-${f.deleted}, hunks=${f.hunks.length})`).join('\n        '));
