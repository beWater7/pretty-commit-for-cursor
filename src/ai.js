'use strict';
// 构造送 Chat 的文本：
//  - buildWholeText：整笔分析（截断，Δ 越大截得越狠），上限约 1500 行
//  - buildSelectionText：框选/当前 hunk 片段，上限约 200 行
//  - estimateTokens / fmtToken：给 Δ>1000 确认框用的粗算
// 纯 Node，不依赖 vscode。

const MAX_WHOLE_LINES = 1500; // 整笔 diff 上限（行）
const MAX_FILE_LINES = 1000; // 单文件分析 diff 上限（行）
const MAX_SEL_LINES = 200; // 选区上限（行）

const STATUS_NAME = { A: '新增', M: '修改', D: '删除', R: '重命名', T: '类型变更' };

function hunksToLines(hunks) {
  const out = [];
  for (const h of hunks) {
    out.push(h.header);
    for (const l of h.lines) out.push(l);
  }
  return out;
}

// 提问与 diff 分开：diff 进「上下文芯片」，提问进输入框（见 extension.js 的 sendAnalysisToChat）。
const WHOLE_QUESTION = [
  '请只依据附上的 diff 判断，不要逐行复述，用中文简短回答两个问题：',
  '1) for what：这次 commit 的主要目的。能看成单一功能/修复就一句话说清；',
  '   若杂糅就写“没有单一目的”并按主题点列，不要硬编一个故事。',
  '2) why：为什么用这种改法？有没有更小/更稳的替代？（没有就说没有，不要为反对而反对。）',
].join('\n');

// 整笔分析文本。返回 { text, question, diffText, lines }：
//   diffText = 纯 diff（做芯片用）；question = 短提问（填输入框用）；
//   text = 两者拼接（芯片链路失败时退回「整段塞输入框」的兜底）；lines 供确认框说“约 M 行”。
function buildWholeText(commit) {
  const files = commit.files || [];
  const out = [];
  out.push(`提交 ${commit.shortSha}  ${commit.subject}`);
  out.push(`作者：${commit.author.name} <${commit.author.email}>  ${commit.author.date}`);
  out.push(`文件：${files.length} 个，改动 Δ=${commit.delta}（+${commit.adds} / −${commit.dels}）`);
  out.push('='.repeat(64));

  let used = 0;
  let truncated = false;
  for (const f of files) {
    if (used >= MAX_WHOLE_LINES) {
      truncated = true;
      break;
    }
    const head = `### ${f.path}  (${STATUS_NAME[f.status] || f.status}  +${f.added} −${f.deleted})`;
    if (f.binary) {
      out.push(`${head}  [二进制文件，diff 省略]`);
      continue;
    }
    const hunkLines = hunksToLines(f.hunks);
    if (!hunkLines.length) {
      out.push(`${head}  [无行级改动${f.modeOnly ? '，仅模式变更' : ''}]`);
      continue;
    }
    const remain = MAX_WHOLE_LINES - used;
    const take = hunkLines.length <= remain ? hunkLines : hunkLines.slice(0, remain);
    if (take.length < hunkLines.length) truncated = true;
    out.push(head);
    for (const l of take) out.push(l);
    used += take.length + 1;
  }
  if (truncated) {
    out.push('');
    out.push(`（diff 过大：以上仅截取前约 ${used} 行，剩余 hunk 未附上。）`);
  }

  const diffText = out.join('\n');
  const text = `${diffText}\n\n${WHOLE_QUESTION}`;
  return { text, question: WHOLE_QUESTION, diffText, lines: text.split('\n').length };
}

// 单文件分析文本。返回 { text, question, diffText, lines, diffLines }：
//   lines = 总行数（含提问，给提示用）；diffLines = 该文件 diff 本身的原始行数（判断“代码量大”）。
function fileDiffLines(file) {
  let n = 0;
  for (const h of file.hunks || []) n += h.lines.length + 1;
  return n;
}

const FILE_QUESTION = [
  '请只依据附上的 diff，用中文简短回答，不要逐行复述：',
  '1) 这个文件这次改了什么？',
  '2) 它在整笔提交里起什么作用？',
  '3) 有没有风险或遗漏？没有就说没有。',
].join('\n');

function buildFileText(commit, file) {
  const files = commit.files || [];
  const out = [];
  out.push(`提交 ${commit.shortSha}  ${commit.subject}`);
  out.push(
    `整笔改动：${commit.totalFiles || files.length} 个文件，Δ=${commit.delta}（+${commit.adds} / −${commit.dels}）`
  );
  out.push(`本文件：${file.path}  (${STATUS_NAME[file.status] || file.status}  +${file.added} −${file.deleted})`);
  out.push('='.repeat(64));

  const diffLines = fileDiffLines(file);
  if (file.binary) {
    out.push('[二进制文件，diff 省略]');
  } else if (!file.hunks || !file.hunks.length) {
    out.push(`[无行级改动${file.modeOnly ? '，仅模式/权限变更' : ''}]`);
  } else {
    const all = hunksToLines(file.hunks);
    const take = all.length > MAX_FILE_LINES ? all.slice(0, MAX_FILE_LINES) : all;
    for (const l of take) out.push(l);
    if (take.length < all.length) {
      out.push(`（本文件 diff 过长，已截取前约 ${MAX_FILE_LINES} 行）`);
    }
  }

  const diffText = out.join('\n');
  const text = `${diffText}\n\n${FILE_QUESTION}`;
  return { text, question: FILE_QUESTION, diffText, lines: text.split('\n').length, diffLines };
}

function buildSelectionText(commit, filePath, raw) {
  const rawLines = String(raw || '').split('\n');
  const shown =
    rawLines.length > MAX_SEL_LINES
      ? rawLines.slice(0, MAX_SEL_LINES).concat([`…（选区过长已截断，原 ${rawLines.length} 行）`])
      : rawLines;
  return [
    `提交 ${commit.shortSha}  ${commit.subject}`,
    `文件：${filePath}`,
    `--- 选中片段（unified diff，${shown.length} 行） ---`,
    ...shown,
    '---',
    '这段改动在整笔改动里起什么作用？有没有风险？（简短回答）',
  ].join('\n');
}

// 字符数 → Token 粗算（1 Token ≈ 4 字符，按截断后文本算，非账单精确值）
function estimateTokens(text) {
  const mid = Math.max(200, Math.round(text.length / 4));
  const lo = Math.max(100, Math.round((mid * 0.6) / 100) * 100);
  const hi = Math.max(200, Math.round((mid * 2) / 100) * 100);
  return { lo, hi };
}

function fmtToken(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

module.exports = { buildWholeText, buildFileText, buildSelectionText, estimateTokens, fmtToken, MAX_SEL_LINES };
