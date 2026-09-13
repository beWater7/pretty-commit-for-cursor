'use strict';
// 把 `git show --format=` 的输出（多个文件的 unified diff 拼在一起）拆成
// 每个文件一段，再逐段解析出：状态 / 路径 / 是否二进制 / hunks / ±行数。
// 纯 Node，不依赖 vscode，可单测。

function splitSections(text) {
  const sections = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { header: line, body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(line.replace(/\r$/, ''));
    }
  }
  return sections;
}

// hunk 头固定以列 0 的 `@@` 开头；hunk 内容行一定以 空格/+/-\ 开头，
// 所以这里不会误切。
function parseHunks(bodyLines) {
  const hunks = [];
  let cur = null;
  for (const line of bodyLines) {
    if (line.startsWith('@@')) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return hunks;
}

function stripPref(p) {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseFileSection(sec) {
  const bodyText = sec.body.join('\n');
  const f = {
    path: null,
    oldPath: null,
    status: 'M',
    binary: false,
    modeOnly: false,
    hunks: [],
    added: 0,
    deleted: 0,
  };

  const newFile = /^new file mode /m.test(bodyText);
  const delFile = /^deleted file mode /m.test(bodyText);
  const rnFrom = /^rename from (.*)$/m.exec(bodyText);
  const rnTo = /^rename to (.*)$/m.exec(bodyText);

  if (rnFrom && rnTo) {
    f.status = 'R';
    f.oldPath = rnFrom[1];
    f.path = rnTo[1];
  } else if (newFile) {
    f.status = 'A';
  } else if (delFile) {
    f.status = 'D';
  }

  f.binary = /^Binary files /m.test(bodyText) || /^GIT binary patch/m.test(bodyText);
  f.modeOnly = /^old mode /m.test(bodyText) && /^new mode /m.test(bodyText);

  if (!f.path) {
    // `+++ b/x`（新增/修改），或 `+++ /dev/null`（删除）
    const plus = /^\+\+\+ (.*)$/m.exec(bodyText);
    const minus = /^--- (.*)$/m.exec(bodyText);
    if (plus && plus[1] !== '/dev/null') f.path = stripPref(plus[1]);
    else if (minus && minus[1] !== '/dev/null') f.path = stripPref(minus[1]);
  }
  if (!f.path) {
    // 兜底：从 `diff --git a/.. b/..` 头取 b 侧（git 极少折叠长路径）
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(sec.header);
    if (m) f.path = m[2].replace(/^\{.*\}$/, '');
  }

  if (!f.binary) {
    f.hunks = parseHunks(sec.body);
    let added = 0;
    let deleted = 0;
    for (const h of f.hunks) {
      for (const line of h.lines) {
        const c = line[0];
        if (c === '+') added++;
        else if (c === '-') deleted++;
      }
    }
    f.added = added;
    f.deleted = deleted;
  }
  return f;
}

function parseCommitDiff(diffText) {
  return splitSections(diffText).map(parseFileSection);
}

module.exports = { splitSections, parseHunks, parseCommitDiff };
