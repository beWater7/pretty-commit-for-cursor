'use strict';
// 所有 git 调用 + commit 数据装配。纯 Node（execFile），不 import vscode，可单测。

const { execFile } = require('child_process');
const { promisify } = require('util');
const { parseCommitDiff } = require('./parse');

const execFileAsync = promisify(execFile);
const MAX_BUF = 512 * 1024 * 1024; // 超大 diff 也装得下

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-pager', '-c', 'core.quotepath=false', ...args],
    { cwd, encoding: 'utf8', maxBuffer: MAX_BUF, windowsHide: true }
  );
  return stdout;
}

// ---------- 「只差不可见符号」的差异：默认忽略 ----------
// 为什么默认忽略：CRLF↔LF 转换、行尾多/少空格、文件末尾少一个换行 —— 这类差异会把整个文件
// 刷成一大片红绿，但它们不携带任何代码语义（基本都是编辑器 / 工具链 / git 配置自动产生的），
// review 的时候纯属噪声。真实案例：一份 3000 行的文件只因为换行符从 CRLF 变成 LF，
// 就能让 diff 看起来「改了几百行」。
//
// 只用这两个 flag（覆盖范围见 assets/pc-host-test.js 的 [J] 段，是实测出来的）：
//   --ignore-cr-at-eol    行尾 CR —— CRLF ↔ LF；顺带也吃掉「文件末尾没有换行」这种行尾差异
//   --ignore-space-at-eol 行尾空白 —— 行尾多/少空格、tab
// 刻意**不用**这几个：
//   -w / -b / --ignore-all-space  会把**缩进**变化一起吃掉。缩进在 Python / Makefile / YAML
//                                 里是语法不是排版，静默忽略会真的漏掉 bug。
//   --ignore-blank-lines          空行的增删是真实的（虽然琐碎）排版意图，不该静默隐藏。
// 一个要留意的例外：Markdown 里「行尾两个空格」是硬换行，属于语义。真遇到就去面板上按 ¶
// 临时改成显示（或 prettyCommit.ignoreSymbolDiffs=false）。
const SYMBOL_IGNORE_FLAGS = ['--ignore-cr-at-eol', '--ignore-space-at-eol'];

function symbolFlags(ignore) {
  return ignore ? SYMBOL_IGNORE_FLAGS : [];
}

// 哪些文件「只差符号/空白」、因此被 ignore flag 从 diff 里抹掉了？
//   all  = 这个范围里 git 认为变过的所有文件。用 --name-only 拿：它只比 OID、不做内容 diff，
//          很快；而且它**不吃** ignore flag（实测），正好当全集用。
//   kept = 真 diff 里仍然出现的文件
//   all − kept = 被忽略的那些
// 必须把这件事告诉用户：他把一整份文件从 CRLF 换成 LF 之后，面板会显示「没有改动」——
// 不说清楚的话，第一反应是这工具坏了。
async function symbolOnlyFiles(repoRoot, base, keptPaths, ignore) {
  if (!ignore) return [];
  let out;
  try {
    out = await runGit(repoRoot, ['-c', 'diff.renames=true', ...base, '--name-only']);
  } catch {
    return []; // 数不出来也不该拖垮主流程
  }
  const kept = new Set(keptPaths);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !kept.has(p)); // --name-only 对重命名打印的是**新名**，和解析出的 path 对得上
}

async function findRepoRoot(startDir) {
  try {
    const out = await runGit(startDir, ['rev-parse', '--show-toplevel']);
    const root = out.trim();
    return root || null;
  } catch {
    return null;
  }
}

async function resolveSha(repoRoot, rev) {
  const out = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const sha = out.trim();
  if (!sha) throw new Error(`无法解析 git 提交：${rev}`);
  return sha;
}

function firstLine(s) {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

// meta：sha / parents / author / committer / subject / message
async function getCommitMeta(repoRoot, sha) {
  const raw = await runGit(repoRoot, [
    'show', '-s',
    '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B',
    sha,
  ]);
  const p = raw.split('\0');
  const [full, short, parents, an, ae, aI, cn, ce, cI, message = ''] = p;
  const cleanMsg = message.replace(/\s+$/, '');
  return {
    sha: full,
    shortSha: short,
    parents: (parents || '').split(' ').filter(Boolean),
    author: { name: an, email: ae, date: aI },
    committer: { name: cn, email: ce, date: cI },
    subject: firstLine(cleanMsg) || full.slice(0, 7),
    message: cleanMsg,
  };
}

async function listRecent(repoRoot, n = 25) {
  const out = await runGit(repoRoot, ['log', `-n${n}`, '--format=%H%x00%h%x00%s']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, short, subject] = line.split('\0');
      return { sha, short, subject: subject || '' };
    });
}

// 单个 commit 相对第一父提交的 unified diff 文本
function firstParentDiffText(repoRoot, sha, parents, ignore) {
  const flags = symbolFlags(ignore);
  if (parents.length > 1) {
    return runGit(repoRoot, [
      '-c', 'diff.renames=true',
      'diff', '--no-color', '--unified=3', ...flags, parents[0], sha,
    ]);
  }
  return runGit(repoRoot, [
    '-c', 'diff.renames=true',
    'show', '--no-color', '--format=', '--unified=3', ...flags, sha,
  ]);
}

// 同一个范围的「只列文件名」形式（用于算被忽略的文件，见 symbolOnlyFiles）
function firstParentNameArgs(sha, parents) {
  return parents.length > 1
    ? ['diff', parents[0], sha]
    : ['show', '--format=', sha];
}

// 主要入口：resolve + meta + files(hunks) + Δ 汇总
// opts.ignoreSymbols（默认 true）：忽略只差换行符/行尾空白的改动，见 SYMBOL_IGNORE_FLAGS。
async function loadCommit(repoRoot, rev, opts) {
  const ignore = !opts || opts.ignoreSymbols !== false;
  const sha = await resolveSha(repoRoot, rev);
  const meta = await getCommitMeta(repoRoot, sha);

  let note = '';
  if (meta.parents.length > 1) {
    note = `merge 提交：显示相对第一父提交 ${meta.parents[0].slice(0, 7)} 的差异`;
  }

  const diffText = await firstParentDiffText(repoRoot, sha, meta.parents, ignore);
  const files = parseCommitDiff(diffText);
  const symbolOnly = await symbolOnlyFiles(
    repoRoot,
    firstParentNameArgs(sha, meta.parents),
    files.map((f) => f.path),
    ignore
  );

  let adds = 0;
  let dels = 0;
  for (const f of files) {
    adds += f.added;
    dels += f.deleted;
  }
  return { ...meta, files, note, adds, dels, delta: adds + dels, symbolOnly, symbolsIgnored: ignore };
}

// 某个提交里某个文件的完整内容（= diff 的「新侧」原文）。
// 「一键跳原文」在历史 commit 下用它：磁盘上的文件可能早就变了，只有这份快照
// 和面板里显示的行号是一一对应的。文件在该提交里不存在（新增/删除/重命名）时抛错。
async function readBlob(repoRoot, rev, filePath) {
  const text = await runGit(repoRoot, ['show', `${rev}:${filePath}`]);
  return text;
}

function tally(files) {  let adds = 0;
  let dels = 0;
  for (const f of files) {
    adds += f.added;
    dels += f.deleted;
  }
  return { adds, dels, delta: adds + dels };
}

// 工作区 diff（不是某笔 commit）：
//   all      = git diff HEAD     （已暂存 + 未暂存，相对最后一次提交）
//   staged   = git diff --cached
//   unstaged = git diff
// 未跟踪文件 git diff 本来就不包含，note 里会提一句。
// opts.ignoreSymbols（默认 true）：同 loadCommit，忽略只差换行符/行尾空白的改动。
async function loadWorkingDiff(repoRoot, kind, opts) {
  const ignore = !opts || opts.ignoreSymbols !== false;
  let hasHead = true;
  try {
    await resolveSha(repoRoot, 'HEAD');
  } catch {
    hasHead = false;
  }

  let useKind = kind === 'staged' || kind === 'unstaged' ? kind : 'all';
  if (!hasHead) useKind = 'staged';

  const base =
    useKind === 'staged'
      ? ['diff', '--cached']
      : useKind === 'unstaged'
        ? ['diff']
        : ['diff', 'HEAD'];

  const diffText = await runGit(repoRoot, [
    '-c', 'diff.renames=true',
    ...base, '--no-color', '--unified=3', ...symbolFlags(ignore),
  ]);
  const files = parseCommitDiff(diffText);
  const symbolOnly = await symbolOnlyFiles(repoRoot, base, files.map((f) => f.path), ignore);
  const { adds, dels, delta } = tally(files);

  const titles = {
    all: '未提交改动（相对 HEAD）',
    staged: '已暂存改动',
    unstaged: '未暂存改动',
  };
  return {
    sha: `:working:${useKind}`,
    shortSha: useKind === 'staged' ? 'staged' : useKind === 'unstaged' ? 'unstaged' : 'WT',
    parents: [],
    author: { name: '', email: '', date: '' },
    committer: { name: '', email: '', date: '' },
    subject: titles[useKind],
    message: titles[useKind],
    files,
    note: '',
    adds,
    dels,
    delta,
    working: true,
    symbolOnly,
    symbolsIgnored: ignore,
  };
}

module.exports = { findRepoRoot, resolveSha, loadCommit, loadWorkingDiff, listRecent, readBlob };
