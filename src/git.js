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
function firstParentDiffText(repoRoot, sha, parents) {
  if (parents.length > 1) {
    return runGit(repoRoot, [
      '-c', 'diff.renames=true',
      'diff', '--no-color', '--unified=3', parents[0], sha,
    ]);
  }
  return runGit(repoRoot, [
    '-c', 'diff.renames=true',
    'show', '--no-color', '--format=', '--unified=3', sha,
  ]);
}

// 主要入口：resolve + meta + files(hunks) + Δ 汇总
async function loadCommit(repoRoot, rev) {
  const sha = await resolveSha(repoRoot, rev);
  const meta = await getCommitMeta(repoRoot, sha);

  let note = '';
  if (meta.parents.length > 1) {
    note = `merge 提交：显示相对第一父提交 ${meta.parents[0].slice(0, 7)} 的差异`;
  }

  const diffText = await firstParentDiffText(repoRoot, sha, meta.parents);
  const files = parseCommitDiff(diffText);

  let adds = 0;
  let dels = 0;
  for (const f of files) {
    adds += f.added;
    dels += f.deleted;
  }
  return { ...meta, files, note, adds, dels, delta: adds + dels };
}

function tally(files) {
  let adds = 0;
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
async function loadWorkingDiff(repoRoot, kind) {
  let hasHead = true;
  try {
    await resolveSha(repoRoot, 'HEAD');
  } catch {
    hasHead = false;
  }

  let useKind = kind === 'staged' || kind === 'unstaged' ? kind : 'all';
  if (!hasHead) useKind = 'staged';

  const args =
    useKind === 'staged'
      ? ['diff', '--cached', '--no-color', '--unified=3']
      : useKind === 'unstaged'
        ? ['diff', '--no-color', '--unified=3']
        : ['diff', 'HEAD', '--no-color', '--unified=3'];

  const diffText = await runGit(repoRoot, ['-c', 'diff.renames=true', ...args]);
  const files = parseCommitDiff(diffText);
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
  };
}

module.exports = { findRepoRoot, resolveSha, loadCommit, loadWorkingDiff, listRecent };
