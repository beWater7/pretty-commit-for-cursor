'use strict';
// Pretty Commit 主扩展：
//  - 命令：openHistoryItem（scm/historyItem/context 右键）/ openHead / pickCommit
//  - Webview 大窗口（尽量 moveEditorToNewWindow 弹独立 OS 窗口；失败自动回落到原窗口重建）
//  - webview-ready 握手：页面未就绪时消息排队，避免首帧丢消息导致白屏/永远“正在读取”
//  - AI 门控：开关(globalState, 默认关)；Δ≥50 才整笔；Δ>1000 先确认时长+Token
//  - 送 Chat = 剪贴板 + 尝试打开 Chat（不在扩展内调模型）

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const git = require('./src/git');
const ai = require('./src/ai');

const VIEW_TYPE = 'prettyCommit';
// 本份扩展宿主机代码的构建标识。窗口启动时宿主只 require 一次 extension.js，
// 而 webview 的 panel.html 是每次建面板时从磁盘现读的 —— 两者可能一新一旧。
// 把它随 commit 消息下发，页面就能自己判断「宿主是旧版，需要 Reload Window」。
const HOST_BUILD = (() => {
  try {
    const v = require('./package.json').version;
    const m = fs.statSync(__filename).mtime.toISOString().slice(0, 16).replace('T', ' ');
    return `${v} (${m})`;
  } catch {
    return 'unknown';
  }
})();
// 虚拟文档 scheme：把选中的 diff 片段做成一个「只读文件」，
// 这样送 Chat 时可以带 uri + 行范围，AI 看到的是带文件名/行号的代码块，而不是一坨裸文本。
const SCHEME = 'pretty-commit';
const CHAT_OPEN_CMDS = [
  // 已在 Cursor 3.18.9 的 bundle 里核对过实现：
  // registerCommand("workbench.action.chat.open", (…,t)=>{ const s = typeof t=="string"?t:t?.query;
  //   createComposer({ partialState: s ? {text:s, richText:s} : undefined, openInNewTab:true });
  //   … showAndFocus(composerId) })
  // 即：传 { query } 会新开一个 chat 标签页并把文本填进输入框 —— 这是最可靠的「内容一定进框」路径。
  'workbench.action.chat.open',
  'cursor.chat.open',
];
const VIEW_FILE_LINE_CAP = 6000; // 每文件渲染进 Webview 的行上限

let context; // ExtensionContext
// 一份「文档」= 一个 diff = **一个编辑器标签** = 一个 webview 面板。
// 这里不再有「全局唯一的面板」：docs 里每一项带着自己的 panel，多开就是多个 Cursor 标签，
// 用户能像普通编辑器标签一样拖到别的分栏、Ctrl+Tab 切换、点 × 关掉。
// entry = {
//   id, rev, data, repoRoot,        // 内容与来源仓库
//   panel,                          // 这一份自己的 WebviewPanel（被关掉后为 null）
//   poppedOut, expanded, winId,     // 这一份面板自己的窗口状态
//   loadGen,                        // 这一份自己的加载代次（多份并发加载互不干扰）
//   expectingDispose,               // 弹窗过程会先 dispose 面板，别当成「用户关了标签」
// }
let docs = [];
let activeDocId = null; // 当前**聚焦**的那个 diff：AI 分析 / 送 Chat / 跳定义以它为准
let current; // activeDocId 对应的 commit 数据（沿用旧名字，AI 那套代码不用改）
let currentRepoRoot; // 该数据来自哪个仓库根
const MAX_DOCS = 12; // 标签上限，超过就关掉最早的（不动当前）
let reqSeq = 0; // 还在加载中的文档用它占位（正式 id 要等 git 返回才知道）
let picking = false; // 「打开提交…」选择框是否已弹出（键位是全局的，要挡重复触发）
let busy = false; // 整笔分析进行中
// 「弹出独立窗口」这件事本身是 opt-in，失败计数/抑制标志仍然是全局的；
// 每份面板自己的 poppedOut 记在 docs 里。
let popoutFailStreak = 0; // 连续失败次数（>=3 暂停重试，窗口重载后归零）
let popoutWarned = false; // 是否已就「弹不出独立窗口」提示过
let suppressPopout = false; // 重建面板时，别再触发一次弹窗
let log; // OutputChannel
const virtualDocs = new Map(); // 虚拟文档 uri 字符串 -> 内容（送 Chat 的代码上下文）
let selWaiter = null; // 等待 webview 回报当前选区（带 panel，防止串台）
let lastSelSig = null; // 去重用：面板内 Ctrl+L 与清单快捷键可能同时触发
let lastSelAt = 0;

// ---------- 文档 / 面板 的查找 ----------

// 逐个访问 docs 里的面板；panelAlive 要 try 住（disposed 后访问 .webview 会抛）
function liveDocs() {
  return docs.filter((d) => panelAlive(d.panel));
}

function docById(id) {
  return docs.find((d) => d.id === id) || null;
}

// 一条消息 / 一次操作属于哪个 diff：靠发出它的面板反查
function docOfPanel(p) {
  if (!p) return null;
  return docs.find((d) => d.panel === p) || null;
}

function activeDoc() {
  return docById(activeDocId);
}

// 当前聚焦的那个面板；没有聚焦信息时退回第一个还活着的
function activePanel() {
  const d = activeDoc();
  if (d && panelAlive(d.panel)) return d.panel;
  const first = liveDocs()[0];
  return first ? first.panel : undefined;
}

function docTitle(d) {
  if (!d || !d.data) return 'Pretty Commit';
  return `${d.data.shortSha}  ${d.data.subject}`;
}

// 把某个文档设为「当前」：标题、送 Chat 的上下文、跳定义的仓库根都以它为准。
// 触发时机有两个：用户切换标签（Cursor 标签系统 → onDidChangeViewState）、
// 以及某个标签发来消息（消息里带着面板身份）。
function setActiveDoc(id) {
  const d = docById(id);
  activeDocId = d ? d.id : null;
  current = d ? d.data : null;
  currentRepoRoot = d ? d.repoRoot : null;
  if (d && panelAlive(d.panel) && d.data) d.panel.title = docTitle(d);
  return d;
}

function activate(ctx) {
  context = ctx;
  log = vscode.window.createOutputChannel('Pretty Commit');
  log.appendLine(`Pretty Commit 已激活 · host=${HOST_BUILD}`);
  log.appendLine('（改了 extension.js 必须 Developer: Reload Window 才会生效；panel.html 是每次开面板现读）');
  context.subscriptions.push(
    vscode.commands.registerCommand('prettyCommit.openHistoryItem', openFromArgs),
    vscode.commands.registerCommand('prettyCommit.openHead', () => openCommit('HEAD')),
    vscode.commands.registerCommand('prettyCommit.openWorking', () => openWorking('all')),
    vscode.commands.registerCommand('prettyCommit.pickCommit', pickCommit),
    vscode.commands.registerCommand('prettyCommit.addSelection', addSelectionFromPanel),
    vscode.commands.registerCommand('prettyCommit.raisePanel', async () => {
      // 从任何焦点位置一键把 diff 标签叫回来（被 Chat / 别的标签页盖住时最有用）。
      // 多开时会**逐个**处理：嵌在窗口里的那些各自把自己那一栏的标签翻到前面；
      // 弹成独立 OS 窗口的那些各自把窗口抬到前台。
      const list = liveDocs();
      if (!list.length) {
        vscode.window.showInformationMessage('Pretty Commit：还没有打开的 diff，先按 Alt+Q。');
        return;
      }
      for (const d of list) requestRaise(d.panel, 'command', true);
      const active = activeDoc();
      const p = active && panelAlive(active.panel) ? active.panel : list[0].panel;
      const many = list.length > 1 ? `（共 ${list.length} 个 diff 标签）` : '';
      flash(p, active && active.poppedOut ? `已把面板窗口带到前台${many}` : `已把面板切到前台${many}`);
    }),
    // 快捷键是 package.json 里静态声明的，扩展没法在运行时改写它 —— 官方支持的改法就是
    // 用户键位（keybindings.json / 快捷键 UI）覆盖扩展默认值。所以这里只负责把用户送到
    // 「键盘快捷方式」界面并预筛到本扩展的命令，剩下的点一下就能改。
    vscode.commands.registerCommand('prettyCommit.rebind', () => openKeybindingEditor()),
    // 重读当前 diff（页面里也有 r / ↻；这条是给「焦点不在面板上」和自定义键位用的）
    vscode.commands.registerCommand('prettyCommit.refresh', async () => {
      const d = activeDoc();
      if (!d || !panelAlive(d.panel)) {
        vscode.window.showInformationMessage('Pretty Commit：还没有打开的 diff（先按 Alt+Q）。');
        return;
      }
      await reloadDoc(d, '正在重读 diff…', '命令');
      flash(d.panel, '已重读 diff');
    }),
    // 自动重读：文件保存 / .git 元数据变化。见 onDidSaveFile / onGitMetaChanged 的注释。
    vscode.workspace.onDidSaveTextDocument((doc) => onDidSaveFile(doc)),
    // git 状态变化 → 工作区 diff 过期。两条路都挂上：内置 git 扩展的 API 最可靠
    // （任何 index/HEAD/refs 变化都会通知，不受 files.watcherExclude 影响），
    // 拿不到 API 时（或它没激活）还有文件监听兜底；两个都触发也没关系，防抖会合成一次。
    ...gitStateHooks(),
    // 终端聚焦时按键会被送去 shell，只有「命令表」里的命令才轮得到 workbench 处理。
    // 这条命令就是把这个表补上（见 enableShortcutInTerminal 的注释）。
    vscode.commands.registerCommand('prettyCommit.enableInTerminal', () => enableShortcutInTerminal()),
    // 虚拟文档：送 Chat 的 diff 片段靠它变成「有名字、有行号」的代码上下文
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => virtualDocs.get(uri.toString()) || '',
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('prettyCommit.diffFontFamily') &&
        !e.affectsConfiguration('prettyCommit.diffFontWeight') &&
        !e.affectsConfiguration('prettyCommit.diffFontSize') &&
        !e.affectsConfiguration('prettyCommit.diffForeground') &&
        !e.affectsConfiguration('prettyCommit.diffBackground') &&
        !e.affectsConfiguration('prettyCommit.colorComments') &&
        !e.affectsConfiguration('prettyCommit.syntaxHighlight') &&
        !e.affectsConfiguration('editor.fontFamily')
      ) {
        return;
      }
      broadcastUiState(); // 配置改了 → 所有 diff 标签一起换样式
    }),
    log
  );
}

function deactivate() {}

function info(...a) {
  if (log) log.appendLine(`[info] ${a.join(' ')}`);
}
function warn(...a) {
  if (log) log.appendLine(`[warn] ${a.join(' ')}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 入口 ----------

function openFromArgs(...args) {
  let item = null;
  for (const a of args) {
    if (a == null) continue;
    if (Array.isArray(a)) {
      if (a.length) item = a[0];
    } else {
      item = a;
    }
    break;
  }
  const rev = item == null ? null : typeof item === 'string' ? item : item.id || item.sha || null;
  if (!rev) {
    vscode.window.showInformationMessage('Pretty Commit：请选中一个提交（或在命令面板用 Open HEAD）。');
    return;
  }
  return openCommit(rev);
}

// 打开「键盘快捷方式」界面，并预筛到本扩展的命令（executeCommand 的第二个参数就是搜索词，
// 这也是 Cursor 自己跳转过去时用的方式）。用户在里面双击任意一行即可改键。
async function openKeybindingEditor() {
  try {
    await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'prettyCommit');
    info('已打开「键盘快捷方式」并筛选 prettyCommit');
  } catch (e) {
    warn(`打开键盘快捷方式失败: ${e.message}`);
    vscode.window.showInformationMessage(
      'Pretty Commit：请手动打开 键盘快捷方式（Ctrl+K Ctrl+S）后搜索 prettyCommit 改键。'
    );
  }
}

// 让快捷键在「终端聚焦」时也能用。
// 为什么单独需要这个：终端对按键的处理是（bundle 里 TerminalInstance 的 keydown）：
//   r.kind === 2 && r.commandId && this._skipTerminalCommands.includes(r.commandId)
//     && !config.sendKeybindingsToShell
//       ? 交给 workbench（preventDefault，不再往下）
//       : 继续往下 → 把按键原样发给 shell
// 而 _skipTerminalCommands = 内置表 ∪ terminal.integrated.commandsToSkipShell。
// 也就是说：**扩展自己的命令不在那个表里时，终端聚焦下按快捷键只会把字符喂给 shell**，
// 去掉 when 限制也救不了它 —— 这就是「只有光标在编辑器里才生效」的真正原因。
// 这条命令把本扩展的两个键位命令补进那个表；用户随时可以在设置里删掉还原。
async function enableShortcutInTerminal() {
  const CMDS = ['prettyCommit.pickCommit', 'prettyCommit.raisePanel'];
  const termCfg = vscode.workspace.getConfiguration('terminal.integrated');
  if (termCfg.get('sendKeybindingsToShell', false)) {
    vscode.window.showErrorMessage(
      'Pretty Commit：terminal.integrated.sendKeybindingsToShell 为 true，终端会把所有快捷键都发给 shell。' +
        '请先把它改成 false，再执行本命令。'
    );
    return;
  }
  const cur = termCfg.get('commandsToSkipShell', []) || [];
  const missing = CMDS.filter((c) => !cur.includes(c));
  if (!missing.length) {
    vscode.window.showInformationMessage('Pretty Commit：快捷键在终端里已经可以用了（命令表里已有）。');
    info('commandsToSkipShell 已包含本扩展命令，无需改动');
    return;
  }
  try {
    await termCfg.update('commandsToSkipShell', [...cur, ...missing], vscode.ConfigurationTarget.Global);
    info(`已把 ${missing.join(', ')} 加入 terminal.integrated.commandsToSkipShell`);
    vscode.window
      .showInformationMessage(
        `Pretty Commit：已加入 terminal.integrated.commandsToSkipShell（${missing.join('、')}），` +
          '终端聚焦时按快捷键也会打开提交列表了。想还原就从设置里删掉这两项。',
        '打开设置'
      )
      .then((pick) => {
        if (pick === '打开设置') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            '@id:terminal.integrated.commandsToSkipShell'
          );
        }
      });
  } catch (e) {
    warn(`写入 commandsToSkipShell 失败: ${e.message}`);
    vscode.window.showErrorMessage(
      `Pretty Commit：写入设置失败（${e.message}）。请手动在 settings.json 里加：\n` +
        `"terminal.integrated.commandsToSkipShell": [${CMDS.map((c) => `"${c}"`).join(', ')}]`
    );
  }
}

async function pickCommit() {
  // 键位是全局的（不带 when），所以有可能连按两次叠出两层选择框；用一个标志挡掉。
  if (picking) {
    info('忽略重复的「打开提交」请求（选择框已开）');
    return;
  }
  picking = true;
  info('快捷键触发：打开提交选择器');
  try {
    await pickCommitInner();
  } finally {
    picking = false;
  }
}

async function pickCommitInner() {
  const root = await pickRepoRoot('列出最近提交');
  if (!root) return;
  const base = Math.max(1, Math.floor(cfgNum('recentCommitCount', 25)));
  let limit = base;
  const REBIND = '$(keyboard) 修改快捷键…';
  const MORE = '$(ellipsis) 加载更多提交…';
  const MORE_ID = '__prettyCommit_more__';

  // 循环：每次点「加载更多」把窗口翻倍后重新列一次，想翻多深都行
  while (true) {
    let list;
    try {
      list = await git.listRecent(root, limit);
    } catch (err) {
      vscode.window.showErrorMessage(`Pretty Commit: ${err.message}`);
      return;
    }
    if (!list.length) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(diff) 工作区改动', description: ':working:all', detail: '仓库还没有 commit，将尝试 git diff --cached' },
          { label: REBIND, description: '打开键盘快捷方式（已筛选 prettyCommit）' },
        ],
        { placeHolder: '这个仓库还没有提交，可以先看工作区 diff' }
      );
      if (!picked) return;
      if (picked.label === REBIND) {
        await openKeybindingEditor();
        return;
      }
      await openWorking('all');
      return;
    }
    const WORK = [
      {
        label: '$(diff) 工作区改动',
        description: ':working:all',
        detail: 'git diff HEAD · 已暂存 + 未暂存，相对最后一次提交',
      },
      {
        label: '$(diff) 仅暂存',
        description: ':working:staged',
        detail: 'git diff --cached',
      },
      {
        label: '$(diff) 仅未暂存',
        description: ':working:unstaged',
        detail: 'git diff（不含已暂存）',
      },
    ];
    const picks = [
      ...WORK,
      ...list.map((c) => ({ label: `${c.short}  ${c.subject}`, description: c.sha })),
    ];
    if (list.length >= limit) {
      picks.push({
        label: MORE,
        description: MORE_ID,
        detail: `当前列出最近 ${list.length} 条（可在设置里改 prettyCommit.recentCommitCount，当前 ${base}）`,
      });
    }
    // 「改键」入口固定放最后：让人不用去记 Ctrl+K Ctrl+S 或用命令面板找
    picks.push({ label: REBIND, description: '打开键盘快捷方式（已筛选 prettyCommit）' });

    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: `工作区 diff 或最近 ${list.length} 条提交`,
    });
    if (!picked) return;
    if (picked.label === REBIND) {
      await openKeybindingEditor();
      return;
    }
    if (picked.description === MORE_ID) {
      limit = limit * 2;
      continue;
    }
    if (typeof picked.description === 'string' && picked.description.startsWith(':working:')) {
      await openWorking(picked.description.slice(':working:'.length));
      return;
    }
    const sel = list.find((c) => c.sha === picked.description);
    if (sel) await openCommit(sel.sha);
    return;
  }
}

// 找出应该操作的 git 仓库根目录：
//  - 没有打开任何文件夹 / 都不是 git 仓库 → 提示并返回 null
//  - 只有一个 → 用它
//  - 多个 → 优先：包含当前活动编辑器文件的仓库；否则尝试用 rev 能否解析提交来筛选；再退回第一个
async function pickRepoRoot(what) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    vscode.window.showErrorMessage('Pretty Commit：请先打开一个文件夹（git 工作区）。');
    return null;
  }
  const roots = [];
  for (const f of folders) {
    try {
      const r = await git.findRepoRoot(f.uri.fsPath);
      if (r && !roots.includes(r)) roots.push(r);
    } catch { /* 忽略 */ }
  }
  if (!roots.length) {
    const names = folders.map((f) => f.name).join('、');
    vscode.window.showErrorMessage(
      `Pretty Commit：当前打开的文件夹都不是 git 仓库（${names}）。\n请在 git 仓库上打开文件夹后再试。`
    );
    return null;
  }
  if (roots.length === 1) return roots[0];

  // 多仓库：优先包含活动编辑器文件的仓库
  const activeUri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (activeUri) {
    for (const r of roots) {
      if (activeUri.fsPath.startsWith(r + path.sep)) return r;
    }
  }
  info(`多个 git 仓库：${roots.join(', ')}，取第一个`);
  return roots[0];
}

// 解析 rev 具体属于哪个仓库（用于多仓库下右键菜单带来的 sha）
async function repoForRev(rev) {
  const folders = vscode.workspace.workspaceFolders || [];
  const roots = [];
  for (const f of folders) {
    try {
      const r = await git.findRepoRoot(f.uri.fsPath);
      if (r && !roots.includes(r)) roots.push(r);
    } catch { /* 忽略 */ }
  }
  if (roots.length <= 1) return roots[0] || null;
  for (const r of roots) {
    try {
      await git.resolveSha(r, rev);
      return r;
    } catch { /* 下一个 */ }
  }
  return roots[0];
}

// ---------- 打开 & 加载 ----------

async function openCommit(rev) {
  let root;
  try {
    root = await repoForRev(rev);
  } catch { root = null; }
  if (!root) {
    const ok = await pickRepoRoot('打开提交');
    if (!ok) return;
    root = ok;
  }
  info(`openCommit rev=${rev} root=${root}`);

  // 同一个 rev 已经开着 → 只把它那个标签翻回来，不新开一个
  const dup = docs.find((d) => d.rev === rev);
  if (dup && panelAlive(dup.panel)) {
    info(`这个 rev 已经开着了，切回它的标签: ${rev}`);
    setActiveDoc(dup.id);
    requestRaise(dup.panel, 'open', true);
    sendCommit(dup.panel, dup, 'resync');
    return;
  }
  // 新开一个编辑器标签（一个 diff 一个标签，不再挤在同一个面板的页签里）
  const d = dup || newDoc(rev, root);
  if (dup) {
    // 上一轮加载失败留下的空壳，或面板被关掉了 —— 复用这个文档槽，重新建标签
    d.repoRoot = root;
  }
  const p = panelAlive(d.panel) ? d.panel : createPanelFor(d, columnForNewPanel());
  setActiveDoc(d.id);
  evictOverflow();
  setStatus(p, `正在读取 ${rev} 的 git 数据…`, 'loading');
  const myGen = (d.loadGen = (d.loadGen || 0) + 1);
  try {
    const data = await git.loadCommit(root, rev, { ignoreSymbols: readUiState().ignoreSymbols });
    // 这个标签被关了、或者又发起了新的加载 → 丢弃这次结果
    if (d.loadGen !== myGen || d.panel !== p || !panelAlive(p)) return;
    fillDoc(d, data, rev, root);
    // 让面板露出来。注意两条路都不能用 panel.reveal(undefined)：
    // 它的实现是 openEditor(editor, {...}, getTargetGroupFromShowOptions(...))，而
    // viewColumn 为 undefined 会解析成 ACTIVE_GROUP —— 也就是**把面板搬到当前分栏**。
    // 独立窗口时那会把面板拖回原窗口（旧 bug），嵌入时则会把面板搬到 Chat 所在分栏盖上 Chat。
    // 所以统一改成「请求页面报一下自己是不是被盖住了」，页面回报 hidden 才切标签页。
    requestRaise(p, 'open', true);
    sendCommit(p, d, 'open');
    logTabLayout('打开提交后');
    await expandPanelGroup(p, 'open'); // 占满编辑区（fillEditorArea=false 时不做）
    // 不再自动分析：打开窗口零 Token，AI 只在用户点按钮 / 按快捷键时触发。
  } catch (err) {
    if (d.loadGen !== myGen || !panelAlive(p)) return;
    warn(`加载失败 rev=${rev}: ${err.stack || err.message}`);
    setStatus(p, `加载失败：${err.message}`, 'error');
    vscode.window.showErrorMessage(`Pretty Commit: ${err.message}`);
  }
}

async function openWorking(kind) {
  const root = await pickRepoRoot('查看工作区');
  if (!root) return;
  const label = kind === 'staged' ? '暂存区' : kind === 'unstaged' ? '未暂存' : '工作区';
  const rev = `:working:${kind}`;
  const dup = docs.find((d) => d.rev === rev);
  const d = dup && panelAlive(dup.panel) ? dup : newDoc(rev, root);
  if (dup) d.repoRoot = root;
  const p = panelAlive(d.panel) ? d.panel : createPanelFor(d, columnForNewPanel());
  setActiveDoc(d.id);
  evictOverflow();
  setStatus(p, `正在读取${label} diff…`, 'loading');
  const myGen = (d.loadGen = (d.loadGen || 0) + 1);
  try {
    const data = await git.loadWorkingDiff(root, kind, { ignoreSymbols: readUiState().ignoreSymbols });
    if (d.loadGen !== myGen || d.panel !== p || !panelAlive(p)) return;
    fillDoc(d, data, rev, root);
    requestRaise(p, 'open', true);
    sendCommit(p, d, 'open');
    logTabLayout('打开工作区 diff 后');
    await expandPanelGroup(p, 'open');
  } catch (err) {
    if (d.loadGen !== myGen || !panelAlive(p)) return;
    warn(`加载工作区失败: ${err.stack || err.message}`);
    setStatus(p, `加载失败：${err.message}`, 'error');
    vscode.window.showErrorMessage(`Pretty Commit: ${err.message}`);
  }
}

// 重新读一份 diff 的数据（不是重绘页面）。
// 触发点有三个：
//   1) 用户按了顶栏 ¶ 切换「符号差异」—— 这个开关决定 git 用哪组 flag 去算 diff，
//      所以光让页面重绘没用，必须回 git 重算一遍。工作区 diff 也要重算（可能刚存过盘）。
//   2) 用户按了 r / ↻（手动重读）。
//   3) 宿主自己发现内容过期了（文件保存、.git/index 或 HEAD 变了，见 schedule* 那几个函数）。
// reason：状态栏上显示的原因文案；不给就用 ¶ 那套默认文案。
// why：日志里的一句话原因（给自己排查用）。
async function reloadDoc(d, reason, why) {
  if (!d || !d.repoRoot || !panelAlive(d.panel)) return;
  const p = d.panel;
  const ignore = readUiState().ignoreSymbols;
  setStatus(p, reason || (ignore ? '正在忽略符号差异、重算 diff…' : '正在按符号差异重算 diff…'), 'loading');
  const myGen = (d.loadGen = (d.loadGen || 0) + 1);
  try {
    const data =
      d.data && d.data.working
        ? await git.loadWorkingDiff(d.repoRoot, workingKindOf(d), { ignoreSymbols: ignore })
        : await git.loadCommit(d.repoRoot, d.rev, { ignoreSymbols: ignore });
    if (d.loadGen !== myGen || d.panel !== p || !panelAlive(p)) return;
    fillDoc(d, data, d.rev, d.repoRoot);
    sendCommit(p, d, 'reload');
    info(
      why
        ? `已重读 diff（${why}）: ${d.data.shortSha}`
        : `已${ignore ? '忽略' : '显示'}符号差异并重算 diff: ${d.data.shortSha}`
    );
  } catch (e) {
    if (d.loadGen !== myGen || !panelAlive(p)) return;
    warn(`重算 diff 失败: ${e.stack || e.message}`);
    setStatus(p, `重算失败：${e.message}`, 'error');
  }
}

// 所有还开着的 diff 标签一起重读（页面上的 Shift+R / Shift+点 ↻）。
// 逐个 await：每个标签有自己的 loadGen，互不干扰；串行是为了别同时开一堆 git 进程。
async function reloadAllDocs(reason, why) {
  const list = liveDocs();
  info(`重读全部 diff 标签（${why}）：${list.length} 个`);
  for (const d of list) await reloadDoc(d, reason, why);
}

// ---------- 内容过期就自动重读 ----------
// diff 是「某一刻」从 git 算出来的快照，下面这些事之后它会过期：
//   · 文件被保存 —— 必须挂 onDidSaveTextDocument 而不是 onDidChangeTextDocument：
//     git diff 读的是**磁盘**内容（src/git.js 全是 execFile 起进程），敲键盘时它不会变，
//     只有存盘才会。挂 change 事件只会白跑一堆没用的 git。
//   · .git/index 变了 —— 在终端 / SCM 面板里 git add / reset，工作区 diff 的
//     「已暂存 / 未暂存」分档会变。
//   · .git/HEAD 变了 —— 切分支 / commit / checkout。
// 只作用于**工作区 diff**：历史提交的内容不会变，重算它没有意义（`d.data.working` 判定）。
// 一律防抖 400ms：一次 git checkout 会连着触发很多个文件事件，不防抖就会开一堆 git 进程
// （而 git diff 是全量重算，代价不小）。
const AUTO_REFRESH_DEBOUNCE = 400;
let autoRefreshTimer = null;

function refreshOnSaveEnabled() {
  return vscode.workspace.getConfiguration('prettyCommit').get('refreshOnSave', true) !== false;
}
function watchGitStateEnabled() {
  return vscode.workspace.getConfiguration('prettyCommit').get('watchGitState', true) !== false;
}

// 某个路径是否在仓库根下面（按目录边界比，避免 /repo 匹配到 /repo2）
function isInsideRepo(file, dir) {
  if (!file || !dir) return false;
  const f = path.resolve(file);
  const d = path.resolve(dir);
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

// 防抖后统一重读「受影响仓库」的工作区 diff
function scheduleWorkingRefresh(repoRoot, why) {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(() => {
    autoRefreshTimer = null;
    const targets = liveDocs().filter(
      (d) => d.data && d.data.working && (!repoRoot || d.repoRoot === repoRoot)
    );
    if (!targets.length) return;
    for (const d of targets) reloadDoc(d, `检测到变化（${why}），正在重读 diff…`, why);
  }, AUTO_REFRESH_DEBOUNCE);
}

// 文件保存：只认「磁盘上真实的文件」，且必须落在某个开着工作区 diff 的仓库里
function onDidSaveFile(doc) {
  if (!refreshOnSaveEnabled()) return;
  const uri = doc && doc.uri;
  if (!uri || uri.scheme !== 'file' || !uri.fsPath) return;
  const hit = liveDocs().find(
    (d) => d.data && d.data.working && isInsideRepo(uri.fsPath, d.repoRoot)
  );
  if (!hit) return;
  scheduleWorkingRefresh(hit.repoRoot, '文件已保存');
}

// .git/index 或 .git/HEAD 变了：把路径反推回仓库根，交给同一个防抖口
function onGitMetaChanged(uri) {
  if (!watchGitStateEnabled()) return;
  const p = uri && uri.fsPath;
  const m = p ? /^(.*)[/\\]\.git[/\\](index|HEAD)$/.exec(p) : null;
  if (!m) return;
  const repoRoot = m[1];
  if (!liveDocs().some((d) => d.data && d.data.working && d.repoRoot === repoRoot)) return;
  scheduleWorkingRefresh(repoRoot, `.git/${m[2]} 变化`);
}

// 盯一个 .git 元数据文件（变化或新建都算）
function watchGitMetaFile(rel) {
  const w = vscode.workspace.createFileSystemWatcher(`**/${rel}`);
  const fire = (uri) => onGitMetaChanged(uri);
  return [w, w.onDidChange(fire), w.onDidCreate(fire)];
}

// git 状态变化的两个来源，一起返回给 subscriptions
function gitStateHooks() {
  const hooks = [...watchGitMetaFile('.git/index'), ...watchGitMetaFile('.git/HEAD')];
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return hooks;
    const bind = (api) => {
      const git = api && typeof api.getAPI === 'function' ? api.getAPI(1) : null;
      if (!git || typeof git.onDidOpenRepository !== 'function') return;
      const bindRepo = (r) => {
        if (!r || !r.state || typeof r.state.onDidChange !== 'function') return;
        hooks.push(
          r.state.onDidChange(() => {
            if (!watchGitStateEnabled()) return;
            const root = (r.rootUri && r.rootUri.fsPath) || '';
            if (!liveDocs().some((d) => d.data && d.data.working && d.repoRoot === root)) return;
            scheduleWorkingRefresh(root, 'git 状态变化');
          })
        );
      };
      for (const r of git.repositories || []) bindRepo(r);
      if (typeof git.onDidOpenRepository === 'function') hooks.push(git.onDidOpenRepository(bindRepo));
    };
    if (ext.isActive) bind(ext.exports);
    else Promise.resolve(ext.activate()).then(bind).catch((e) => warn(`git 扩展激活失败: ${e.message}`));
  } catch (e) {
    warn(`挂接内置 git 扩展失败（退回只盯 .git/index、.git/HEAD）: ${e.message}`);
  }
  return hooks;
}

// 工作区 diff 的三个档位存在 rev 里（`:working:staged` 等）
function workingKindOf(d) {
  const m = /^:working:(staged|unstaged|all)$/.exec((d && d.rev) || '');
  return m ? m[1] : 'all';
}

// 统一的 commit 下发口：所有 commit 消息都必须带上 hostVersion，
// 页面据此判断「宿主 JS 是旧版（改了代码没 Reload Window）」。
// 每个面板只拿自己那一份数据；页面里的页签栏已经不再使用（nativeTabs=true），
// 但 tabs/activeDocId 仍然照发，老页面/兜底逻辑不至于抓空。
function tabsPayload(d) {
  return {
    activeDocId: d ? d.id : activeDocId,
    tabs: (d ? [d] : liveDocs()).map((x) => ({
      id: x.id,
      shortSha: x.data ? x.data.shortSha : '',
      subject: x.data ? x.data.subject : '加载中…',
      working: !!(x.data && x.data.working),
    })),
  };
}

function sendCommit(p, doc, why) {
  if (!doc.data) return; // 还在加载中：数据不到就什么都不发（页面显示 loading 状态）
  post(p, {
    type: 'commit',
    docId: doc.id,
    commit: toViewModel(doc.data),
    hostVersion: HOST_BUILD,
    // 面板内部不再画页签栏（每个 diff 已经是独立的 Cursor 标签了）
    nativeTabs: true,
    ...tabsPayload(doc),
  });
  if (why === 'resync') info(`重新下发当前提交（${why}）: ${doc.data.shortSha}`);
}

// ---------- 文档（= 标签）的增删 ----------

// 开一个文档槽。id 先用 `:pending:N` 占位，等 git 数据回来再定成 sha
// （工作区 diff 的 sha 就是 `:working:xxx`，一开始就知道）。
function newDoc(rev, root) {
  const d = {
    id: `:pending:${++reqSeq}`,
    rev,
    data: null,
    repoRoot: root,
    panel: null,
    poppedOut: false,
    expanded: false,
    winId: null,
    loadGen: 0,
    expectingDispose: false,
  };
  docs.push(d);
  return d;
}

// 数据到位：把 id / 标题 / current 一起对齐
function fillDoc(d, data, rev, root) {
  const wasActive = activeDocId === d.id;
  d.data = data;
  d.rev = rev;
  d.repoRoot = root;
  d.id = data.sha || d.id;
  if (panelAlive(d.panel)) d.panel.title = docTitle(d);
  if (wasActive) setActiveDoc(d.id);
  return d;
}

// 标签不是无限开的：超上限时关掉最早的、非当前的那个（它会连同那个 Cursor 标签一起消失）
function evictOverflow() {
  while (docs.length > MAX_DOCS) {
    const i = docs.findIndex((x) => x.id !== activeDocId);
    if (i < 0) break;
    const d = docs[i];
    info(`标签超过 ${MAX_DOCS} 个，关掉最早的 ${d.data ? d.data.shortSha : d.rev}`);
    const p = d.panel;
    // 先摘掉引用再 dispose：dispose 回调看到 d.panel !== p 就直接返回，不会重复处理
    d.panel = null;
    docs.splice(i, 1);
    if (panelAlive(p)) {
      try { p.dispose(); } catch { /* 忽略 */ }
    }
  }
}

// 面板被关掉（用户点了标签上的 ×）= 关掉这份 diff。
// 只有一种例外：弹独立窗口的过程中面板会先被 dispose，那属于「搬家」，见 expectingDispose。
function onPanelDisposed(d, p) {
  if (d.panel !== p) return;
  info(`diff 标签关闭: ${d.data ? d.data.shortSha : d.rev}`);
  d.panel = null;
  if (d.expectingDispose) return;
  const i = docs.indexOf(d);
  if (i >= 0) docs.splice(i, 1);
  if (activeDocId === d.id) {
    // 关掉的是当前标签：把「当前」移给相邻的一个（没有就用剩下的第一个）
    const next = docs[Math.min(i, docs.length - 1)] || docs[0];
    setActiveDoc(next ? next.id : null);
  }
  if (!docs.length) {
    activeDocId = null;
    current = null;
    currentRepoRoot = null;
  }
}

// ---------- 界面偏好（缩放档位 / 左侧列表开关） ----------
// 放 globalState，跨窗口、跨次打开都还在。页面用 getUiState / saveUiState 两条消息读写；
// 旧宿主不认这两条消息，页面退回默认值，不会报错。
const UI_KEY = 'prettyCommit.uiState';
const UI_DEFAULT = { zoom: 0, listOpen: true, listWidth: 260, sideBySide: false, ignoreSymbols: true, diffTheme: 'auto', diffIntensity: 'standard' };

const FONT_STACKS = {
  popular: '"JetBrains Mono", "Cascadia Code", "Fira Code", "Source Code Pro", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
  jetbrains: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", ui-monospace, Consolas, monospace',
  fira: '"Fira Code", ui-monospace, Menlo, Consolas, monospace',
  ibm: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
  source: '"Source Code Pro", ui-monospace, Menlo, Consolas, monospace',
};

function resolvedDiffFont() {
  const preset = String(vscode.workspace.getConfiguration('prettyCommit').get('diffFontFamily', 'popular') || 'popular');
  if (preset === 'editor') {
    const ed = vscode.workspace.getConfiguration('editor').get('fontFamily', '');
    return ed && String(ed).trim() ? String(ed) : FONT_STACKS.popular;
  }
  return FONT_STACKS[preset] || preset;
}

function readUiState() {
  let saved = null;
  try {
    saved = context ? context.globalState.get(UI_KEY) : null;
  } catch {
    saved = null;
  }
  const ui = { ...UI_DEFAULT, ...(saved && typeof saved === 'object' ? saved : {}) };
  const cfg = vscode.workspace.getConfiguration('prettyCommit');
  ui.fontFamily = resolvedDiffFont();
  const w = Number(cfg.get('diffFontWeight', 500));
  ui.fontWeight = w === 400 || w === 500 || w === 550 || w === 600 ? w : 500;
  const fs = Number(cfg.get('diffFontSize', 13));
  ui.baseFontSize = Number.isFinite(fs) ? Math.max(8, Math.min(28, Math.round(fs))) : 12;
  const fg = String(cfg.get('diffForeground', '') || '').trim();
  const bg = String(cfg.get('diffBackground', '') || '').trim();
  ui.diffForeground = fg || null;
  ui.diffBackground = bg || null;
  ui.colorComments = cfg.get('colorComments', true) !== false;
  ui.syntaxHighlight = cfg.get('syntaxHighlight', true) !== false;
  ui.sideBySide = ui.sideBySide === true;
  // 「忽略只差符号的改动」和缩放/列表开关不同：它还有对应的 VS Code 设置项。globalState 里存的
  // 是面板上按 ¶ 之后的**临时**选择；没按过（globalState 里压根没这个键）就听设置的。
  // 注意不能拿 ui.ignoreSymbols 判断「用户存过没有」—— UI_DEFAULT 里就有这个键，永远是 boolean。
  const savedSym = saved && typeof saved.ignoreSymbols === 'boolean' ? saved.ignoreSymbols : null;
  ui.ignoreSymbols = savedSym === null ? cfg.get('ignoreSymbolDiffs', true) !== false : savedSym;
  // diff 区配色（Gerrit Light / Dark）：面板上按 t 切过就以那个为准，否则听设置。
  // 纯前端的事（只换 CSS class），宿主只负责存/发，不参与解析。
  const savedTheme = saved && typeof saved.diffTheme === 'string' ? saved.diffTheme : null;
  const theme = savedTheme || String(cfg.get('diffTheme', 'auto') || 'auto');
  ui.diffTheme = theme === 'light' || theme === 'dark' ? theme : 'auto';
  // 色带深浅（Gerrit 原色那档铺满整行太淡，默认 standard）。优先级同上：面板上按过 d 就听面板。
  const savedDepth = saved && typeof saved.diffIntensity === 'string' ? saved.diffIntensity : null;
  const depth = savedDepth || String(cfg.get('diffIntensity', 'standard') || 'standard');
  ui.diffIntensity = depth === 'subtle' || depth === 'strong' ? depth : 'standard';
  return ui;
}

async function saveUiState(patch) {
  const next = readUiState();
  if (patch && typeof patch === 'object') {
    if (Number.isFinite(Number(patch.zoom))) {
      next.zoom = Math.max(-3, Math.min(10, Math.round(Number(patch.zoom))));
    }
    if (typeof patch.listOpen === 'boolean') next.listOpen = patch.listOpen;
    if (Number.isFinite(Number(patch.listWidth))) {
      next.listWidth = Math.max(140, Math.min(800, Math.round(Number(patch.listWidth))));
    }
    if (typeof patch.sideBySide === 'boolean') next.sideBySide = patch.sideBySide;
    if (typeof patch.ignoreSymbols === 'boolean') next.ignoreSymbols = patch.ignoreSymbols;
    if (patch.diffTheme === 'light' || patch.diffTheme === 'dark' || patch.diffTheme === 'auto') {
      next.diffTheme = patch.diffTheme;
    }
    if (patch.diffIntensity === 'subtle' || patch.diffIntensity === 'standard' || patch.diffIntensity === 'strong') {
      next.diffIntensity = patch.diffIntensity;
    }
  }
  const persist = {
    zoom: next.zoom,
    listOpen: next.listOpen,
    listWidth: next.listWidth,
    sideBySide: next.sideBySide,
    ignoreSymbols: next.ignoreSymbols,
    diffTheme: next.diffTheme,
    diffIntensity: next.diffIntensity,
  };
  try {
    await context.globalState.update(UI_KEY, persist);
  } catch {
    /* 存不下就算了，下次用默认值 */
  }
  return next;
}

// 界面偏好（缩放 / 左侧列表 / 双页开关）是全局的：任何一个 diff 标签改了，
// 别的标签也要跟着变，否则两个标签会显示成两套样式。
function broadcastUiState() {
  const ui = readUiState();
  for (const d of liveDocs()) post(d.panel, { type: 'uiState', ui });
}

// 把「当前应该在页面上的东西」重新下发一次。
// 关键场景：把编辑器组弹成独立 OS 窗口（moveEditorToNewWindow）后，VS Code 会在新窗口里
// 重新造一个 webview —— 它从零开始（S.files 为空），而宿主这边 panel.ready 早已是 true、
// 队列也早冲空了，于是那笔 commit 永远不会再发下去，页面就停在「没有可显示的文件改动」。
// 所以每次收到 webview-ready 都要按当前状态重发，而不是只冲队列。
function resyncState(p, why) {
  if (!panelAlive(p)) return;
  const d = docOfPanel(p); // 只重发这个面板自己那一份
  if (!d) return;
  if (!d.data) {
    setStatus(p, `正在读取 ${d.rev} 的 git 数据…`, 'loading');
    return;
  }
  p.title = docTitle(d);
  sendCommit(p, d, 'resync');
}

// 这个文件在 diff 里是否“没有内容变化”：纯重命名（相似度 100%）、仅权限变更、
// 或者任何不含 +/- 行的条目。git 对 100% 相似的重命名仍会生成一个 `diff --git` 段
// （带 rename from/to，但没有 hunk），所以解析出来是一个 Δ=0 的文件条目。
function isContentUnchanged(f) {
  return !f.binary && f.added === 0 && f.deleted === 0;
}

function hideUnchanged() {
  return !!vscode.workspace.getConfiguration('prettyCommit').get('hideUnchangedFiles', true);
}

function toViewModel(d) {
  const mapped = d.files.map((f) => {
    let hunks = f.hunks;
    let viewTrunc = false;
    if (f.hunks.length) {
      const out = [];
      let used = 0;
      for (const h of f.hunks) {
        const n = h.lines.length + 1;
        if (used + n > VIEW_FILE_LINE_CAP) {
          if (out.length) viewTrunc = true;
          break;
        }
        out.push(h);
        used += n;
      }
      hunks = out;
    }
    return { ...f, hunks, viewTrunc, unchanged: isContentUnchanged(f) };
  });

  // 默认把「无内容变化」的文件从列表里去掉：它们对 review 毫无信息量，
  // 却能让文件数虚高（例如 F407Proj 某个提交 734 个文件里 536 个是纯重命名）。
  const skip = hideUnchanged();
  const files = skip ? mapped.filter((f) => !f.unchanged) : mapped;
  const hiddenUnchanged = skip ? mapped.length - files.length : 0;
  return {
    sha: d.sha,
    shortSha: d.shortSha,
    subject: d.subject,
    working: !!d.working,
    note: d.note || '',
    delta: d.delta,
    adds: d.adds,
    dels: d.dels,
    totalFiles: mapped.length,
    hiddenUnchanged,
    // 「只差换行符/行尾空白、已被忽略」的文件（git.js 算出来的）。页面据此提醒用户
    // 「你这几个文件确实改了，只是只有符号差异」—— 否则他会以为面板漏了文件。
    symbolOnly: Array.isArray(d.symbolOnly) ? d.symbolOnly.slice(0, 50) : [],
    symbolsIgnored: d.symbolsIgnored !== false,
    author: d.author,
    files,
  };
}

// ---------- Webview 面板 ----------
// 一个文档一个面板（= 一个 Cursor 编辑器标签）。同名/同 id 的文档只会有一个面板。

// 新标签开在哪儿？
// 已经有 diff 标签的话，就开在**它所在的那一栏** —— 效果是「同一栏里多一个标签」，
// 也就是用户要的「在 Cursor 里新建标签」，而不是新切一道分屏出来。
// 一个都没有时，才按老规矩决定：默认占满编辑区（开在当前分栏后展开），
// 关掉 fillEditorArea 时才按 openBeside 决定要不要在旁边新开一栏。
function columnForNewPanel() {
  for (const d of liveDocs()) {
    const g = groupOfPanel(d.panel);
    if (g) return g.viewColumn;
  }
  if (shouldPopOut()) return vscode.ViewColumn.Active;
  if (!fillEditorArea() && openBeside()) return vscode.ViewColumn.Beside;
  return vscode.ViewColumn.Active;
}

// 「弹成独立 OS 窗口」只对**第一个** diff 标签生效。
// 多开时如果每个标签都往新窗口弹，你会被一堆 OS 窗口糊住（而且它们互相抢焦点），
// 后来打开的 diff 就老老实实开在已有标签旁边。
function shouldPopOut(exclude) {
  if (!popOutEnabled() || suppressPopout) return false;
  return !liveDocs().some((x) => x !== exclude);
}

function createPanelFor(d, column) {
  const p = vscode.window.createWebviewPanel(VIEW_TYPE, docTitle(d), column, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaDir()],
  });
  p.ready = false;
  p.pending = [];
  p.webview.html = readHtml();
  d.panel = p;
  d.poppedOut = false; // 新面板先建在「当前窗口」，是否弹出去由 schedulePopOut 决定
  d.expanded = false;
  // 消息必须带上面板身份：同一扩展的多个 diff 标签共用一套消息协议，
  // 不带 p 就分不清是哪个标签在说话（AI 分析 / 送 Chat 会张冠李戴）。
  p.webview.onDidReceiveMessage((m) => onMessage(p, m), undefined, context.subscriptions);
  // 焦点换到哪个标签，就把「当前 diff」换成哪个 —— 标题、送 Chat 的上下文、
  // 跳定义的仓库根全都跟着焦点走（这就是以前页签栏点击做的事，现在交给 Cursor 的标签系统）。
  p.onDidChangeViewState(
    (e) => {
      if (e.webviewPanel && e.webviewPanel.active) setActiveDoc(d.id);
    },
    undefined,
    context.subscriptions
  );
  p.onDidDispose(() => onPanelDisposed(d, p), undefined, context.subscriptions);
  if (shouldPopOut(d)) schedulePopOut(p);
  return p;
}

// 注意：webview 已 dispose 时，访问 p.webview 这个 getter 会 **抛错**
// （"Error: Webview is disposed"），不是返回 undefined。这一步曾经把
// requestWhole 的 finally 直接炸掉，所以必须 try 住。
function panelAlive(p) {
  try {
    return !!p && !!p.webview;
  } catch {
    return false;
  }
}

// ---------- 把面板所在的 OS 窗口真正抬到前台（X11） ----------
// 背景：面板弹到独立窗口后，扩展宿主仍在原窗口；vscode 扩展 API 没有任何聚焦窗口的能力，
// webview 里的 window.focus() 也抬不动自己的窗口（实测 focused 一直是 no）。
// 所以只能调用 scripts/x11-raise.py 直接向 X server 发 EWMH 的 _NET_ACTIVE_WINDOW。
// 该脚本只用 python3 标准库 ctypes + 系统 libX11（有 xprop 的机器必然有），不需要 xdotool。
let x11FailStreak = 0; // 连续失败次数
let x11Off = false; // 失败太多次后放弃，不再每次弹进程
let x11Warned = false; // 是否已提示过「置前不可用」
let x11Busy = false; // 同时只跑一个帮助进程
let pythonBin; // 'python3' / 'python'，探测一次后缓存
// 面板那个 OS 窗口的 X11 id 缓存在文档上（d.winId）：多开时每个窗口各记一份。

function focusMode() {
  return vscode.workspace.getConfiguration('prettyCommit').get('focusWindow', 'auto');
}

function x11Helper() {
  return path.join(context.extensionPath, 'scripts', 'x11-raise.py');
}

// 只在 Linux + X11 下有意义；Wayland 下 X 窗口 id 拿不到（除非跑 XWayland 且窗口在其中）
function x11Applicable() {
  return x11SkipReason() === '';
}

// 返回「为什么不能置前」；空串表示可用。用于日志诊断，避免用户以为功能坏了却没线索。
function x11SkipReason() {
  if (focusMode() !== 'auto') return 'focusWindow 设置为 off';
  if (process.platform !== 'linux') return `平台是 ${process.platform}（只实现了 X11）`;
  if (!process.env.DISPLAY) return '扩展宿主环境里没有 DISPLAY（远程 SSH / 纯 Wayland？）';
  return '';
}

let x11SkipLogged = false;

function logX11Skip() {
  if (x11SkipLogged) return;
  x11SkipLogged = true;
  info(`不做窗口置前：${x11SkipReason() || '未知原因'}`);
}

function runHelper(args, timeout) {
  return new Promise((resolve) => {
    const tryBin = (bins) => {
      if (!bins.length) return resolve(null);
      const bin = bins[0];
      execFile(bin, [x11Helper(), ...args], { timeout, windowsHide: true }, (err, stdout, stderr) => {
        // 解释器不存在：换下一个候选（python3 → python）
        if (err && err.code === 'ENOENT') return tryBin(bins.slice(1));
        pythonBin = bin; // 这个解释器可用，之后直接复用，省掉探测
        resolve({ err, code: err ? err.code : 0, out: String(stdout || ''), errOut: String(stderr || '') });
      });
    };
    tryBin(pythonBin ? [pythonBin] : ['python3', 'python']);
  });
}

// 面板窗口的「标题线索」：VS Code 的窗口标题里含 activeEditorShort，也就是我们设的 p.title。
// 提交加载完成后 p.title = "<shortSha>  <subject>"，用 shortSha 匹配最稳（不受空格数量影响）。
function titleNeedle(d) {
  const data = d ? d.data : current;
  return data && data.shortSha ? data.shortSha : '';
}

// 弹出前/后各取一次窗口 id 集合，差集就是「面板那个新窗口」。
// 比按标题匹配更稳：弹出瞬间 current 可能还没加载完（没有 shortSha 可用）。
async function snapshotWindowIds() {
  if (!x11Applicable()) return null;
  const r = await runHelper(['ids'], 2500);
  if (!r || r.code !== 0) return null;
  const ids = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  return new Set(ids);
}

async function learnPanelWindowIdBefore() {
  return snapshotWindowIds();
}

// 每份面板各自记自己的窗口 id（弹出多个面板时互不干扰）
async function learnPanelWindowIdAfter(d, before) {
  if (!before || !d) return;
  const after = await snapshotWindowIds();
  if (!after) return;
  const fresh = [...after].filter((id) => !before.has(id));
  if (fresh.length === 1) {
    d.winId = fresh[0];
    info(`学到面板窗口 id: ${d.winId}`);
  } else if (fresh.length > 1) {
    info(`弹窗后新增了 ${fresh.length} 个窗口（${fresh.join(', ')}），不猜，改用标题定位`);
  }
}

async function raiseViaX11(why, d) {
  if (!x11Applicable() || x11Off || x11Busy) return false;
  const needle = titleNeedle(d);
  if (!d || (!d.winId && !needle)) return false; // 还没有提交数据、也不知道窗口 id，无法定位
  x11Busy = true;
  try {
    // WM 对「刚映射出来的新窗口」的 _NET_ACTIVE_WINDOW 请求常常第一次不认（实测 GNOME/mutter
    // 就是这样：首发被拒、700ms 后重试即成功），所以被拒时按退避再试几次。
    const delays = [0, 400, 900];
    for (let i = 0; i < delays.length; i++) {
      if (i) await sleep(delays[i]);
      let r = null;
      if (d.winId) {
        r = await runHelper(['activate', '--id', d.winId], 3000);
        if (r && r.code === 5) {
          info(`面板窗口 ${d.winId} 已失效，改用标题重新查找`);
          d.winId = null;
          r = null;
        }
      }
      if (!r && needle) r = await runHelper(['activate', '--title', needle], 3000);
      if (!r) return false;

      const out = r.out.trim();
      if (r.code === 0) {
        const m = /MATCHED=(0x[0-9a-fA-F]+)/.exec(out);
        if (m) d.winId = m[1];
        const active = /ACTIVE=(0x[0-9a-fA-F]+)/.exec(out);
        const taken = active && m && active[1].toLowerCase() === m[1].toLowerCase();
        if (taken) {
          x11FailStreak = 0;
          info(`X11 置前成功（${why}${i ? `，第 ${i + 1} 次尝试` : ''}）win=${d.winId || '?'}`);
          return true;
        }
        if (i < delays.length - 1) continue; // 被 WM 拒绝 → 退避重试
        info(`X11 置前被 WM 拒绝（${why}，重试 ${delays.length} 次）win=${d.winId || '?'}`);
        x11FailStreak += 1;
        return false;
      }
      throw new Error(out.split('\n')[0] || `exit ${r.code}`);
    }
    return false;
  } catch (e) {
    x11FailStreak += 1;
    if (x11FailStreak <= 2) info(`X11 置前失败（${why}）: ${e.message}`);
    if (x11FailStreak >= 3) {
      x11Off = true;
      warn(`X11 置前连续失败 ${x11FailStreak} 次，本次窗口内不再尝试：${e.message}`);
      if (!x11Warned) {
        x11Warned = true;
        vscode.window
          .showWarningMessage(
            'Pretty Commit：无法把这个窗口抬到前台（X11 置前不可用）。可用 Alt+Shift+Q 手动叫回面板；或在设置里把 prettyCommit.focusWindow 设为 off 关掉相关尝试。',
            '打开输出日志'
          )
          .then((pick) => {
            if (pick === '打开输出日志') log.show(true);
          });
      }
    }
    return false;
  } finally {
    x11Busy = false;
  }
}

// ---------- 分栏（editor group）定位 ----------
// vscode.window.tabGroups 能回答两件关键的事：
//   1) 面板的 webview 标签页在哪个分栏 → 显示面板时用 reveal(它自己那一列)，只激活标签页、不搬家；
//   2) 送 Chat 时 Chat 是不是正好开在面板那一栏（会盖住 diff）→ 只有确认盖住了才挪 Chat。
// 为什么这么计较「搬家」：reveal 的 viewColumn 为 undefined（或 Active）时会解析成 ACTIVE_GROUP，
// 等于把面板打开到当前活动分栏 —— 独立窗口时会把面板拖回原窗口，嵌入时会把面板搬到 Chat 上面。
function isOurPanelTab(t) {
  try {
    // ⚠️ TabInputWebview 在 **vscode 根命名空间**（vscode.TabInputWebview），
    // 不在 vscode.window 上。这里以前写的是 vscode.window.TabInputWebview —— 那是 undefined，
    // 于是本函数永远返回 false，所有「定位我们的标签在哪一栏」的逻辑全部静默失效：
    //   展开占满编辑区（fillEditorArea 默认开着却从没生效）、
    //   激活自己被盖住的标签页、送 Chat 后把 Chat 挪到旁边，全是空转。
    // 用 mock 环境跑自检才把它照出来，两个位置都兜一下以防版本差异。
    const Ctor =
      vscode.TabInputWebview || (vscode.window && vscode.window.TabInputWebview) || null;
    return !!Ctor && t.input instanceof Ctor && t.input.viewType === VIEW_TYPE;
  } catch {
    return false;
  }
}

function tabGroupsApi() {
  try {
    const tg = vscode.window.tabGroups;
    return tg && Array.isArray(tg.all) ? tg : null;
  } catch {
    return null; // 老版本 VS Code 没有这个 API
  }
}

// 找到**指定面板**所在的分栏。
// 麻烦点：TabInputWebview 只暴露 viewType，同一个扩展的所有 diff 标签看起来一模一样，
// 没法直接问「这个 panel 对应哪个 tab」。能区分它们的只有标签文字 —— 而 webview 面板的
// 标签文字正是我们设的 p.title（`<shortSha>  <subject>`），所以按标题认。
// 认不出来时不敢瞎猜：只有一个 diff 标签时才敢用「唯一含 PrettyCommit 的那一栏」兜底，
// 否则宁可返回 null（调用方会放弃 reveal，而不是把标签搬到别的分栏去）。
function groupOfPanel(p) {
  const tg = tabGroupsApi();
  if (!tg || !panelAlive(p)) return null;
  const label = p.title;
  for (const g of tg.all) {
    if ((g.tabs || []).some((t) => isOurPanelTab(t) && t.label === label)) return g;
  }
  const ours = tg.all.filter((g) => (g.tabs || []).some(isOurPanelTab));
  if (ours.length === 1 && liveDocs().length === 1) return ours[0];
  return null;
}

// 兼容旧调用（日志诊断 / 送 Chat 时找「我们的面板在不在 Chat 那一栏」）
function findPanelGroups() {
  const tg = tabGroupsApi();
  if (!tg) return null;
  const all = tg.all;
  const idx = all.findIndex((g) => (g.tabs || []).some(isOurPanelTab));
  return idx < 0 ? null : { all, idx, group: all[idx] };
}

function describeTab(t) {
  try {
    return isOurPanelTab(t) ? '★PrettyCommit' : t.label || '?';
  } catch {
    return '?';
  }
}

function logTabLayout(tag) {
  const tg = tabGroupsApi();
  if (!tg) return;
  const desc = tg.all
    .map((g, i) => `#${i}${g.isActive ? '*' : ''}[${(g.tabs || []).map(describeTab).join('|')}]`)
    .join('  ');
  const f = findPanelGroups();
  info(
    `分栏（${tag}）: ${desc}` +
      (f ? `  ← 有 ${liveDocs().length} 个 diff 标签，最早的在第 ${f.idx} 栏` : '  ← 没有 diff 标签在这个窗口')
  );
}

// 在「这个面板自己那一栏」把它显示出来：只激活标签页，不搬动分栏。
// preserveFocus=true 时只把标签页翻到它那一栏的前面，不抢键盘焦点（送完 Chat 要用这个，
// 否则光标会从 Chat 输入框被拽走）；默认 false，把焦点也一起带过去（用户按 Alt+Q / Alt+Shift+Q 时）。
function revealPanelInPlace(p, preserveFocus = false) {
  const g = groupOfPanel(p);
  if (!g) return false;
  try {
    p.reveal(g.viewColumn, preserveFocus);
    info(`已在面板自己那一栏显示面板${preserveFocus ? '（不抢焦点）' : ''}`);
    return true;
  } catch (e) {
    info(`按所在分栏 reveal 失败（忽略）: ${e.message}`);
    return false;
  }
}

// ---------- 让面板占满整个编辑区 ----------
// vscode 扩展 API 没有「展开/最大化某个分栏」的能力，Cursor 里对应的是这组命令，实现如下
// （bundle 里 editorGroupsService）：
//   arrangeGroups(e, t = this.activeGroup) {
//     if (this.count < 2 || !this.gridWidget) return;   // 只有一栏 → 直接 no-op（本来就已经占满）
//     const n = this.assertGroupView(t);
//     switch (e) {
//       case 2: this.gridWidget.distributeViewSizes(); break;  // "Reset Editor Group Sizes"
//       case 0: …maximizeView(n)…; break;                      // 隐藏其它栏（未暴露为命令）
//       case 1: this.gridWidget.expandView(n); break;          // "Expand Editor Group"
//     }
//   }
// 两个关键点：
//   1) 它只作用于 **activeGroup** —— 命令本身没法指定目标栏，所以必须先让面板那一栏成为活动栏
//      （revealPanelInPlace 传 preserveFocus=false 正好做到）；
//   2) 该命令的 precondition 是 `multipleEditorGroups`，只有一栏时不能调用（也无需调用）。
// 「展开」是把其它分栏缩到最小（保留、不关闭、也不动侧边栏），比 maximize 类的
// maximizeEditorHideSidebar 温和 —— 后者会连侧边栏和 Chat 所在的辅助栏一起隐藏。
// 「展开」是我们自己造成的状态，API 查不到，只能自己记 —— 现在记在每个文档上（d.expanded）。

function fillEditorArea() {
  return vscode.workspace.getConfiguration('prettyCommit').get('fillEditorArea', true);
}

function requestRaise(p, why, userAsked) {
  if (!panelAlive(p)) return;
  const d = docOfPanel(p);
  if (!d || !d.poppedOut) {
    // 嵌入模式：面板和 Chat 在同一个 OS 窗口里，没有「窗口被压到后面」这回事，
    // 因此**不**做任何抢窗口/抢焦点的动作（送完 Chat 更不该抢：用户正要往输入框打字）。
    // 只有用户显式要求（Alt+Q / Alt+Shift+Q）时才探测一次可见性：
    // 页面回报 visibility=hidden 表示被同窗口的别的标签页盖住了，那时才切回面板标签页。
    if (!userAsked) return;
    info(`请求把面板切到前台（${why}）`);
    post(p, { type: 'raise', why });
    return;
  }
  info(`请求把面板窗口带到前台（${why}）`);
  post(p, { type: 'raise', why }); // 补充手段：页面里 window.focus()（实测抬不动窗口，但无害）
  if (!x11Applicable()) {
    logX11Skip();
    return;
  }
  raiseViaX11(why, d).catch(() => {});
}

// 展开面板那一栏，让它占满编辑区（其它栏缩到最小，不关闭）。
// 每次 Alt+Q 打开提交都会走一次：你上一笔看完、把布局恢复成左右分屏去跟 AI 讨论，
// 再 Alt+Q 看下一笔时又会变回大视图。
// 注意「展开的只是分栏」：同一个分栏里其它的 diff 标签仍然是标签，不会被关掉 ——
// 所以多开几笔 diff 之后，展开不会把兄弟标签藏起来，只是把别的分栏压扁。
async function expandPanelGroup(p, why) {
  const d = docOfPanel(p);
  if (!fillEditorArea() || (d && d.poppedOut) || !panelAlive(p)) return;
  // 走弹窗那条路时不展开宿主的布局 —— 面板马上要搬到别的 OS 窗口，展开原窗口毫无意义。
  // （schedulePopOut 是异步的、带 ping 重试，所以这里不能等 poppedOut 变成 true 再判断。）
  if (shouldPopOut(d)) return;
  const g = groupOfPanel(p);
  const all = tabGroupsApi();
  if (!g || !all) {
    info(`不展开面板分栏（${why}）：认不出这个面板在哪一栏，不猜`);
    return;
  }
  if (all.all.length < 2) {
    if (d) d.expanded = false;
    return; // 只有一栏：本来就已经占满，且该命令在单栏时会直接 return
  }
  revealPanelInPlace(p); // 先让面板那一栏成为活动栏：arrangeGroups 只认 activeGroup
  try {
    await vscode.commands.executeCommand('workbench.action.minimizeOtherEditors');
    if (d) d.expanded = true;
    info(`已展开面板分栏、占满编辑区（${why}）`);
    logTabLayout('展开后');
  } catch (e) {
    info(`展开面板分栏失败（忽略；面板仍是普通分栏）: ${e.message}`);
  }
}

// 反向操作：恢复各栏等宽，好让 Chat 和面板同屏。
// 用 "Reset Editor Group Sizes"（arrangeGroups(2) → distributeViewSizes）而不是 toggleEditorWidths，
// 因为「当前是否处于展开状态」这个信息 API 查不到，toggle 会依赖猜测。distributeViewSizes 会
// 重算等宽尺寸并 relayout，展开状态随之解除。
async function unexpandPanelGroup(p, why) {
  const d = docOfPanel(p);
  if (!d || !d.expanded) return;
  d.expanded = false;
  try {
    await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
    info(`已恢复等宽分栏，便于 Chat 与面板同屏（${why}）`);
  } catch (e) {
    info(`恢复等宽分栏失败（忽略）: ${e.message}`);
  }
}

function notePopoutFailure() {
  popoutFailStreak += 1;
  if (!popoutWarned) {
    popoutWarned = true;
    vscode.window
      .showWarningMessage(
        'Pretty Commit：这个窗口环境弹不出独立 OS 窗口（workbench.action.moveEditorToNewWindow 不可用），已改为嵌在编辑器里。将连续尝试 3 次后暂停；可在设置里关掉 prettyCommit.moveToNewWindow 去掉提示。',
        '打开输出日志'
      )
      .then((pick) => {
        if (pick === '打开输出日志') log.show(true);
      });
  }
}

// 就绪前排队，就绪后直发 —— 修复“首帧消息丢失导致白屏/一直正在读取”
function post(p, msg) {
  if (!p || !panelAlive(p)) return;
  if (!p.ready) {
    p.pending.push(msg);
    return;
  }
  try {
    p.webview.postMessage(msg);
  } catch (e) {
    warn(`postMessage 失败: ${e.message}`);
  }
}

function flushPending(p) {
  if (!p.ready) return;
  const q = p.pending;
  p.pending = [];
  for (const m of q) {
    try {
      p.webview.postMessage(m);
    } catch (e) {
      warn(`flush postMessage 失败: ${e.message}`);
    }
  }
}

// 心跳：问 webview 是否还活着
const pingWaiters = new Map();
function pingPanel(p, timeout) {
  return new Promise((resolve) => {
    if (!panelAlive(p)) return resolve(false);
    const id = `ping-${Date.now()}-${Math.random()}`;
    const t = setTimeout(() => {
      pingWaiters.delete(id);
      resolve(false);
    }, timeout);
    pingWaiters.set(id, () => {
      clearTimeout(t);
      resolve(true);
    });
    try {
      p.webview.postMessage({ type: 'ping', id });
    } catch {
      pingWaiters.delete(id);
      clearTimeout(t);
      resolve(false);
    }
  });
}

// 多次探活：新窗口里的 webview 冷启动可能错过第一发 ping，别据此就判死
async function pingPanelWithRetry(p, tries, timeout) {
  for (let i = 0; i < tries; i++) {
    if (!panelAlive(p)) return false;
    if (await pingPanel(p, timeout)) return true;
    if (i < tries - 1) {
      info(`第 ${i + 1} 次 ping 未响应，稍后重试…`);
      await sleep(350);
    }
  }
  return false;
}

// 弹独立 OS 窗口；成功后探活，若面板被 dispose / 无响应，就在当前窗口重建。
// 关于「有时弹出、有时嵌在编辑器」：之前一旦某次判定失败就把 popOutBroken 永久置位，
// 于是本会话里后续所有 Alt+Q 都变成嵌在编辑器 —— 看起来就是“时好时坏”。
// 现在改成：每次都尝试；只在连续失败 3 次后暂停重试（避免刷屏），并在窗口重载后恢复。
function popOutEnabled() {
  if (!vscode.workspace.getConfiguration('prettyCommit').get('moveToNewWindow', false)) return false;
  return popoutFailStreak < 3;
}

// 嵌入模式（默认）下，面板开在「旁边分栏」而不是占用当前分栏。
function openBeside() {
  return vscode.workspace.getConfiguration('prettyCommit').get('openBeside', true);
}

// 送 Chat 之后把 Chat 标签页挪到相邻分栏，让 diff 与 AI 回答同屏可见。
function chatBesidePanel() {
  return vscode.workspace.getConfiguration('prettyCommit').get('chatBesidePanel', true);
}

async function schedulePopOut(p) {
  const d = docOfPanel(p);
  if (!popOutEnabled()) {
    info(`跳过弹窗（moveToNewWindow=off 或连续失败 ${popoutFailStreak} 次），留在当前窗口`);
    return;
  }
  info('尝试 moveEditorToNewWindow…');
  await sleep(250);
  if (!panelAlive(p) || !d || d.panel !== p) return;

  const idsBefore = await learnPanelWindowIdBefore(); // 移动前记录窗口集合，用于事后认出新窗口
  // 弹窗过程中这个面板一定会被 dispose（成功＝搬到新窗口重建，失败＝本环境不支持）。
  // 打上标记，免得 onDidDispose 把这份 diff 当成「用户关掉了标签」直接删掉。
  d.expectingDispose = true;
  try {
    p.reveal(vscode.ViewColumn.Active, true);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  } catch (e) {
    info(`moveEditorToNewWindow 被拒绝（留在原窗口）: ${e.message}`);
    notePopoutFailure();
    d.expectingDispose = false;
    return; // 面板还在，原窗口大视图，无需重建
  }

  await sleep(900); // 等窗口切换 / dispose 尘埃落定
  if (!panelAlive(p) || d.panel !== p) {
    // 移动导致本面板被 dispose —— 此环境弹不了独立窗口
    info('弹窗后面板被 dispose，改回原窗口内重建');
    notePopoutFailure();
    await rebuildPanel(d);
    return;
  }
  // 面板还活着 = 它已经住进新窗口了。新窗口里的 webview 可能是刚新建、脚本还没跑起来，
  // 单次 ping 会误判成「白窗」，所以多试几次；期间只要有一次 pong 就说明面板是活的。
  const ok = await pingPanelWithRetry(p, 3, 1000);
  if (!ok) {
    info('弹窗后面板无响应（疑似白窗），改回原窗口内重建');
    notePopoutFailure();
    try { p.dispose(); } catch { /* 忽略 */ }
    // onDidDispose 可能还没触发，先手动摘掉，确保重建拿到的是新面板
    if (d.panel === p) d.panel = null;
    await rebuildPanel(d);
    return;
  }
  info('moveEditorToNewWindow 成功，面板存活');
  popoutFailStreak = 0; // 这次成了，把连续失败计数清零，避免历史失败拖累后续表现
  d.expectingDispose = false;
  d.poppedOut = true; // 从这里开始，禁止再调 reveal（会把面板拖回原窗口）
  await learnPanelWindowIdAfter(d, idsBefore); // 认出新窗口，之后置前优先用 id
  // 新窗口是 VS Code 刚建出来的，焦点往往还留在原窗口 —— 真正把它抬到前台
  requestRaise(p, 'popout');
  setTimeout(() => requestRaise(p, 'popout-retry'), 700);
}

// 面板被换掉之后，在当前窗口里把这份 diff 重新做成一个标签并回放数据。
async function rebuildPanel(d) {
  d.expectingDispose = false;
  d.poppedOut = false; // 回到「在当前窗口里」的状态，可以安全 reveal
  d.expanded = false; // 重新造出来的面板，展开状态从零开始
  d.winId = null;
  d.panel = null;
  suppressPopout = true;
  let p;
  try {
    p = createPanelFor(d, columnForNewPanel()); // 关掉弹窗抑制前必须先拿到面板，否则会递归触发弹窗
  } finally {
    suppressPopout = false;
  }
  const ok = await waitReady(p, 2000);
  if (!ok || d.panel !== p || !panelAlive(p)) return;
  sendCommit(p, d, 'reopen');
  p.title = docTitle(d);
  setStatus(p, '', '');
  await expandPanelGroup(p, 'reopen'); // 回落到嵌入模式时同样占满编辑区
}

function waitReady(p, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (p.ready) {
        clearInterval(timer);
        return resolve(true);
      }
      if (!panelAlive(p)) {
        clearInterval(timer);
        return resolve(false);
      }
      if (Date.now() - t0 > timeout) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

// ---------- Webview 消息 ----------

async function onMessage(p, msg) {
  if (!msg || !msg.type) return;
  // 消息来自哪个 diff 标签，就以哪个 diff 为「当前」——
  // 多开时 AI 分析 / 送 Chat / 跳定义必须落到用户正在看的那个标签上。
  const mine = docOfPanel(p);
  switch (msg.type) {
    case 'webview-ready':
      if (p) {
        p.ready = true;
        flushPending(p);
        // webview 可能是弹窗后新建的、也可能是重载过的：按当前状态补发一次
        resyncState(p, 'webview-ready');
        // 弹窗场景：这份文档就活在新窗口里，趁机让它把窗口抬到前台。
        // 嵌入模式不这么做：那是同一个窗口内的 DOM 焦点问题，页面自己 window.focus()
        // 只会显得像在「抢焦点」，而我们希望焦点留在 Chat 输入框里。
        if (mine && mine.poppedOut) requestRaise(p, 'webview-ready');
      }
      break;
    case 'pong': {
      const fn = pingWaiters.get(msg.id);
      if (fn) {
        pingWaiters.delete(msg.id);
        fn();
      }
      break;
    }
    case 'ext-error':
      warn(`webview 内部错误: ${msg.text}`);
      vscode.window.showErrorMessage(`Pretty Commit 界面错误：${msg.text}`);
      break;
    case 'close':
      if (panelAlive(p)) p.dispose();
      break;
    case 'reloadWindow': // 诊断条上的「重载窗口」按钮
      info('用户从诊断条触发 Reload Window');
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      break;
    case 'hostBuild': // 页面问宿主版本
      post(p, { type: 'hostBuild', hostVersion: HOST_BUILD });
      break;
    case 'getUiState': // 页面要上次的缩放/列表开关
      post(p, { type: 'uiState', ui: readUiState() });
      break;
    case 'saveUiState': // 页面存缩放/列表开关（已防抖）
      await saveUiState(msg.ui);
      broadcastUiState(); // 同一个人开的其它 diff 标签也同步过去
      break;
    case 'refreshDiff': // 页面切了「符号差异」开关：diff 得回 git 用另一组 flag 重算
      if (typeof msg.ignoreSymbols === 'boolean') await saveUiState({ ignoreSymbols: msg.ignoreSymbols });
      broadcastUiState(); // 别的标签也要跟着换（它们会各自请求重算）
      await reloadDoc(mine);
      break;
    case 'refresh': // 页面按了 r / ↻：内容可能在别处被改过（存盘、git add、切分支）
      if (msg.all) await reloadAllDocs('正在重读 diff…', '手动·全部');
      else await reloadDoc(mine || activeDoc(), '正在重读 diff…', '手动');
      break;
    case 'analyze':
      if (mine) setActiveDoc(mine.id);
      await requestWhole(p);
      break;
    case 'analyzeFile':
      if (mine) setActiveDoc(mine.id);
      await requestFile(p, msg.path);
      break;
    case 'sendSel':
      if (mine) setActiveDoc(mine.id);
      await addSelectionToChat(p, msg);
      break;
    case 'selection': // webview 回报当前选区（回应 wantSelection）
      // 带着 panel 校验：多个标签同时开着时，别把别的标签的选区当成本次的回答
      if (selWaiter && selWaiter.panel === p) selWaiter.deliver({ path: msg.path, text: msg.text });
      break;
    case 'goToSymbol':
      if (mine) setActiveDoc(mine.id);
      await handleGoToSymbol(msg);
      break;
    case 'openSource':
      if (mine) setActiveDoc(mine.id);
      await handleOpenSource(p, msg);
      break;
    case 'activateDoc': {
      // 老页面（还画着内部页签栏）才会发这条；原生标签模式下页面自己就不会有页签栏
      const d = setActiveDoc(msg.docId);
      if (d && panelAlive(p)) post(p, { type: 'tabs', ...tabsPayload(d) });
      break;
    }
    case 'closeDoc': {
      // 页面里的「关闭这个页签」（x 键）：原生标签模式下就是关掉对应的那个 Cursor 标签
      const d = docById(msg.docId) || mine;
      if (d && panelAlive(d.panel)) {
        info(`关闭标签 ${d.data ? d.data.shortSha : d.rev}`);
        d.panel.dispose();
      }
      break;
    }
    case 'raised': // webview 已执行 window.focus()（只证明代码跑了；visibility/focused 才是证据）
      info(
        `面板已请求窗口聚焦${msg.why ? `（${msg.why}）` : ''}` +
          ` [visibility=${msg.visibility || '?'} focused=${msg.focused ? 'yes' : 'no'}]`
      );
      // visibility=hidden 说明面板被「同一个窗口」里的别的标签页盖住了（典型：Chat 标签页），
      // 这种情况 window.focus() 救不了，得把标签页切回来。只有确认面板和宿主在同一窗口
      // （!poppedOut）时才敢 reveal —— 弹出后 reveal 会把面板拖回原窗口。
      if (mine && !mine.poppedOut && msg.visibility === 'hidden' && panelAlive(p)) {
        info('面板被同窗口的其它标签页盖住，切回面板标签页');
        // 优先在它自己那一栏里激活（不搬家）；拿不到分栏信息时才退到旧的 reveal(Active)
        if (!revealPanelInPlace(p)) p.reveal(undefined, false);
      }
      break;
  }
}

// ---------- 选区送 Chat ----------

// 清单快捷键 prettyCommit.addSelection（Ctrl+L，作用域 activeWebviewPanelId == prettyCommit）
// 落到这里：宿主不知道 webview 里的选区，所以反过来问一次。
function requestSelection(p, timeout) {
  return new Promise((resolve) => {
    if (!panelAlive(p)) return resolve(null);
    const finish = (v) => {
      if (selWaiter && selWaiter.finish === finish) selWaiter = null;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeout);
    selWaiter = {
      panel: p, // 只认这个面板回报的选区（多开时别串台）
      finish,
      deliver: (v) => {
        clearTimeout(timer);
        finish(v);
      },
    };
    try {
      p.webview.postMessage({ type: 'wantSelection' });
    } catch (e) {
      warn(`请求选区失败: ${e.message}`);
      clearTimeout(timer);
      finish(null);
    }
  });
}

// diff 面板里 Ctrl/Alt+点击符号：走工作区真实文件 + 语言服务的定义/引用（clangd、TS 等）。
// 限制：行号按 diff 的新/旧侧映射到**当前磁盘文件**，看历史 commit 时可能与当时版本不一致。
async function handleGoToSymbol(msg) {
  if (!currentRepoRoot) {
    vscode.window.showWarningMessage('Pretty Commit：未记录仓库根目录，无法跳转。');
    return;
  }
  const rel = String(msg.path || '').replace(/\\/g, '/');
  if (!rel) return;
  const full = path.join(currentRepoRoot, rel);
  if (!fs.existsSync(full)) {
    vscode.window.showWarningMessage(`Pretty Commit：工作区里没有 ${rel}`);
    return;
  }
  const uri = vscode.Uri.file(full);
  const line = Math.max(1, Number(msg.line) || 1);
  const character = Math.max(0, Number(msg.character) || 0);
  const pos = new vscode.Position(line - 1, character);
  const isRef = msg.kind === 'reference';
  const cmd = isRef ? 'vscode.executeReferenceProvider' : 'vscode.executeDefinitionProvider';
  let locs;
  try {
    locs = await vscode.commands.executeCommand(cmd, uri, pos);
  } catch (e) {
    vscode.window.showWarningMessage(
      `Pretty Commit：${isRef ? '查找引用' : '跳转定义'}失败（${e.message}）`
    );
    return;
  }
  if (!locs || (Array.isArray(locs) && !locs.length)) {
    vscode.window.showInformationMessage(
      `Pretty Commit：没有${isRef ? '引用' : '定义'}结果（请确认已安装并启用对应语言扩展 / clangd）。`
    );
    return;
  }
  const list = Array.isArray(locs) ? locs : [locs];
  if (msg.historical) {
    info(`goToSymbol ${isRef ? 'ref' : 'def'} ${rel}:${line}:${character}（diff 行号对应当前工作区，未必与 commit 一致）`);
  }
  if (isRef) {
    await vscode.commands.executeCommand('editor.action.showReferences', uri, pos, list);
    return;
  }
  const loc = list[0];
  try {
    await vscode.window.showTextDocument(loc.uri, {
      preview: false,
      selection: new vscode.Range(loc.range.start, loc.range.start),
    });
  } catch (e) {
    vscode.window.showWarningMessage(`Pretty Commit：打开定义位置失败（${e.message}）`);
  }
}

// ---------- 一键跳原文 ----------
// 面板里看到的只是 diff 片段；要改代码 / 看上下文得回编辑器。分两种情况：
//   · 工作区 diff：diff 的「新侧」就是磁盘文件本身 → 打开真实文件，光标落到对应行（可编辑）；
//   · 历史 commit：磁盘上的文件很可能已经改过，行号对不上 → 打开「该提交那一刻」的快照
//     （git show <sha>:<path> 的只读虚拟文档），这样行号一定对得上。
function revealLineIn(ed, line) {
  const n = Math.max(1, Math.min(ed.document.lineCount, line || 1));
  const pos = new vscode.Position(n - 1, 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

// 「这个文档不与扩展同步」时，唯一还能把文件开到屏幕上的路。
//
// 为什么 workspace.openTextDocument 会被挡住、而这条不会：前者要求主线程把文档**同步**
// 给扩展宿主（MainThreadDocuments 只在模型新增时登记，且有个开关
// `!isTooLargeForSyncing() && !isForSimpleWidget && !skipLSPSync`），登记不上就抛
// 「Documents above the size limit cannot be synchronized with extensions.」。
// 那句话有误导性：真实阈值是 50MB，而常见触发者其实是后两个条件 —— Cursor 内部读文件
// 内容（Chat / Composer 附上下文、checkpoint、Bugbot 定位）时用 createModelReference(uri, data, true)
// 建模型，那个 true 一路传到 skipLSPSync，于是这个文件永远不再同步给任何扩展。
// vscode.open 走的是主线程的 OpenerService.open，不经过同步，所以照样能开。
async function openViaWorkbench(uri, line) {
  const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
  const range = new vscode.Range(pos, pos);
  // 选项（selection / preview）按官方签名是支持的，但这个构建里 vscode.open 的注册只声明了
  // Uri 参数、实现是 executeCommand(kfe, n)，多给的参数不保证被转发 —— 所以传了也只是顺手，
  // 真正的定位由下面的 revealInActiveEditor 兜住。
  await vscode.commands.executeCommand('vscode.open', uri, { preview: false, selection: range });
  return revealInActiveEditor(uri, line);
}

// 文件已经开出来了，再把目标行带进视野。三层退让，每层都可能因为「文档不同步」而不可用：
//   1) 拿得到 activeTextEditor 且是同一个文件 → 精确落光标 + 居中（和正常路径一样），返回 'cursor'；
//   2) 落光标成功但读不了行数（不同步的文档读 document.lineCount 会抛）→ 按原行号再试；
//   3) 连编辑器对象都拿不到 → 用内置 revealLine 命令滚动，返回 'scroll'。
// 返回 'scroll' 要如实告诉用户「光标没落」：平时点行号光标是跟着走的，不说清就会在错的位置打字。
async function revealInActiveEditor(uri, line) {
  const want = uri.toString();
  let ed = null;
  try {
    ed = vscode.window.activeTextEditor;
  } catch (e) {
    warn(`读 activeTextEditor 失败（${e.message}）`);
  }
  const mine = !!(ed && ed.document && ed.document.uri && ed.document.uri.toString() === want);
  if (mine) {
    for (const clamp of [true, false]) {
      try {
        const n = clamp ? Math.max(1, Math.min(ed.document.lineCount, line || 1)) : Math.max(1, line || 1);
        const pos = new vscode.Position(n - 1, 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        return 'cursor';
      } catch (e) {
        if (!clamp) warn(`定位到第 ${line} 行失败（${e.message}）`);
      }
    }
  }
  // 没认准是哪个编辑器就别去动 revealLine：它作用在「当前聚焦的编辑器」上，
  // 认错人就会把别的文件滚走（比不定位更烦人）。
  if (ed && !mine) return false;
  try {
    await vscode.commands.executeCommand('revealLine', { lineNumber: Math.max(1, line || 1), at: 'center' });
    return 'scroll';
  } catch (e) {
    warn(`revealLine 失败（${e.message}）`);
    return false;
  }
}

async function handleOpenSource(p, msg) {
  // 「跳原文」跳的是这个标签里显示的那份 diff 对应的文件
  const d = docOfPanel(p) || activeDoc();
  const repoRoot = d ? d.repoRoot : currentRepoRoot;
  const rel = String(msg.path || '').replace(/\\/g, '/');
  if (!repoRoot || !rel) {
    vscode.window.showWarningMessage('Pretty Commit：不知道该打开哪个仓库里的文件。');
    return;
  }
  const line = Math.max(1, Number(msg.line) || 1);
  // 历史 diff 默认开「那一提交的快照」（行号才严格对得上，且只读）。
  // msg.worktree（页面里 Alt+点行号）会显式要求：别给快照，去开当前工作区的同名文件 ——
  // 想直接改代码就走这条，代价是行号按 diff 推算、可能已经偏移，所以下面会提示一句。
  const fromHistory = !!d && !d.data.working && !!msg.worktree;
  const historical = !!msg.historical && !!d && !d.data.working && !msg.worktree;

  if (historical) {
    let text;
    try {
      text = await git.readBlob(repoRoot, d.data.sha, rel);
    } catch (e) {
      vscode.window.showWarningMessage(
        `Pretty Commit：这个提交里取不到 ${rel} 的内容（新增 / 删除 / 重命名？）。`
      );
      return;
    }
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${d.data.shortSha}/${rel}` });
    virtualDocs.set(uri.toString(), text);
    while (virtualDocs.size > 20) virtualDocs.delete(virtualDocs.keys().next().value);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      revealLineIn(ed, line);
      info(`跳原文（历史）: ${rel}@${d.data.shortSha}:${line}`);
      flash(p, `${rel} —— ${d.data.shortSha} 时的快照（只读）`);
    } catch (e) {
      vscode.window.showWarningMessage(`Pretty Commit：打开快照失败（${e.message}）`);
    }
    return;
  }

  const full = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  if (!fs.existsSync(full)) {
    vscode.window.showWarningMessage(
      `Pretty Commit：工作区里没有 ${rel}（删除的文件只能看 diff）。`
    );
    return;
  }
  const uri = vscode.Uri.file(full);
  const note = fromHistory
    ? `${rel}:${line} —— 打开的是当前工作区文件（行号按历史 diff 推算，可能已偏移）`
    : '';

  // 主路：扩展宿主先拿到文档再显示 —— 这条定位最准（能夹行号、能精确落光标）。
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    revealLineIn(ed, line);
    info(`跳原文（工作区）: ${rel}:${line}`);
    if (note) flash(p, note);
    return;
  } catch (e) {
    // 这是预期内的情形（文档不与扩展同步），不是故障：换一条不需要同步的路继续。
    warn(`openTextDocument 拿不到 ${rel}（${e.message}）→ 改用 vscode.open（主线程直接开）`);
  }

  // 退路：请主线程直接把文件开进编辑器，再尽力把目标行带进视野。
  try {
    const how = await openViaWorkbench(uri, line);
    info(`跳原文（工作区·主线程开）: ${rel}:${line}（${how || '未定位'}）`);
    if (!how) {
      flash(
        p,
        `${rel} 已打开，但没能定位到第 ${line} 行 —— 这个文件不与扩展同步（常见于大文件，或 Chat 正在引用它），只能自己滚过去了`
      );
    } else if (how === 'scroll') {
      // 只滚了没落光标：不说清的话，用户会以为光标就在那一行，直接在别处开始打字。
      flash(p, `${note || `${rel}:${line}`}（已滚动到该行；本文件不与扩展同步，光标未落）`);
    } else if (note) {
      flash(p, note);
    }
    return;
  } catch (e) {
    warn(`vscode.open 也失败: ${e.message}`);
  }

  vscode.window.showWarningMessage(
    `Pretty Commit：打不开 ${rel} —— Cursor 把这个文档标成了「不与扩展同步」（大文件，或 Chat / Composer 正在引用它）。` +
      (fromHistory
        ? '直接点行号（不按 Alt）可以看该提交的只读快照。'
        : '可以先在编辑器里手动打开它，或 Developer: Reload Window 之后再试。')
  );
}

async function addSelectionFromPanel() {
  const p = activePanel(); // 快捷键作用在「当前聚焦的那个 diff 标签」上
  if (!p || !panelAlive(p) || !current) {
    vscode.window.showInformationMessage('Pretty Commit：先打开一个提交窗口（Alt+Q），再按 Ctrl+L。');
    return;
  }
  info('快捷键触发：向 webview 询问当前选区');
  const sel = await requestSelection(p, 1500);
  if (!sel) {
    flash(p, '没拿到选区（面板未就绪，或这个文件没有可发送的内容）');
    return;
  }
  await addSelectionToChat(p, sel);
}

// 把选中的 diff 片段登记成虚拟文档，返回可直接作为 Chat 上下文的 codeSelection。
// 为什么要虚拟文档而不是直接把文本塞进去：Chat 的「Add to Chat」接收的是
// { uri, range, text }，有 uri 才会显示成「文件名 + 行号」的代码块；而且这个 uri
// 指向的是本 commit 的历史内容，不是工作区里现在的文件，用真实文件路径会张冠李戴。
function makeContextDoc(d, filePath, snippet, opts) {
  const o = opts || {};
  const lines = [
    `# 提交 ${d.shortSha}  ${d.subject}`,
    o.header || `# 文件 ${filePath}（unified diff 片段，非工作区当前内容）`,
    ...snippet.split('\n'),
  ];
  const text = lines.join('\n');
  const uri = vscode.Uri.from({
    scheme: SCHEME,
    path: `/${d.shortSha}/${filePath}`,
    ...(o.uriQuery ? { query: o.uriQuery } : {}),
  });
  virtualDocs.set(uri.toString(), text);
  while (virtualDocs.size > 20) virtualDocs.delete(virtualDocs.keys().next().value); // 只留最近 20 份
  const last = lines[lines.length - 1];
  return {
    uri,
    codeSelection: {
      uri,
      range: {
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: lines.length,
        positionColumn: last.length + 1,
      },
      text,
      rawText: text,
    },
  };
}

// 把一段 diff 挂成 Chat 的「上下文芯片」（就是 Ctrl+L 之后输入框上方那个带文件名的小标签）。
// 返回真正生效的命令名，全失败返回 null。
// allowNewComposer=false 时不尝试 `...stonewcomposer` —— 那条会新建一个 chat，
// 会把调用方已经填好的输入框（短提问）留在旧标签页里，反而更乱。
async function attachDocToChat(doc, label, allowNewComposer) {
  try {
    // 让虚拟文档真实存在，Chat 侧按 uri 取内容时才拿得到
    await vscode.workspace.openTextDocument(doc.uri);
  } catch (e) {
    warn(`虚拟文档打开失败: ${e.message}`);
  }

  // 依次尝试「把代码加进 Chat 上下文」。这些是 Cursor 内部命令，不同版本可能缺，
  // 所以逐个 try、把成败写进输出通道，失败就往下退一代。
  const attempts = [
    ['composer.addsymbolstocomposer', { codeSelections: [doc.codeSelection] }],
    ['chat.addToChat', doc.uri],
  ];
  if (allowNewComposer) {
    attempts.push(['composer.addsymbolstonewcomposer', { codeSelections: [doc.codeSelection] }]);
  }
  for (const [cmd, arg] of attempts) {
    try {
      await vscode.commands.executeCommand(cmd, arg);
      info(`挂芯片成功：${cmd}  ${label}`);
      return cmd;
    } catch (e) {
      warn(`挂芯片失败 ${cmd}: ${e.message}`);
    }
  }
  return null;
}

async function addSelectionToChat(p, sel) {
  // 送 Chat 用的上下文必须是「发出这个动作的那个标签」的 diff，
  // 而不是碰巧最后获得焦点的那个（onMessage 里已经先把 active 切过来了）。
  const d = (docOfPanel(p) || activeDoc());
  if (!d || !sel || !sel.text || !sel.text.trim()) return;

  // 去重：面板内 Ctrl+L 与清单快捷键可能同时命中，8 秒内同一段只处理一次
  const sig = `${sel.path || ''}\u0000${sel.text}`;
  const now = Date.now();
  if (sig === lastSelSig && now - lastSelAt < 8000) {
    info('忽略重复的送 Chat 请求（面板与快捷键同时触发）');
    return true;
  }
  lastSelSig = sig;
  lastSelAt = now;

  const promptText = ai.buildSelectionText(d, sel.path || '', sel.text);
  await vscode.env.clipboard.writeText(promptText); // 兜底：无论走哪条路，剪贴板里都有一份

  const mode = getAddMode();
  let ctxOk = false;
  if (mode === 'context' || mode === 'both') {
    ctxOk = await attachSelectionContext(d, sel);
  }
  if (mode === 'input' || mode === 'both' || !ctxOk) {
    const r = await openChatWithText(promptText);
    // 打开 Chat 会把扩展宿主所在的窗口（原窗口）带到前台，弹出的面板窗口就被压到后面了。
    // 面板自己要能回到前台（见 panel.html 的 raiseWindow）。
    refocusPanelAfterChat(p);
    if (mode === 'context' && !ctxOk) {
      // 上下文芯片没加成（多半是当前没有已加载的 chat），退到输入框，保证内容不丢
      flash(p, r.prefilled ? '附加代码上下文失败，已改为把提示词填进 Chat 输入框' : '无法附加代码上下文；提示词已复制到剪贴板');
    } else if (mode === 'both') {
      flash(p, '已附加代码上下文，并把提示词填进输入框（回车发送）');
    } else {
      flash(p, r.prefilled ? 'diff 与提问已填进 Chat 输入框（回车发送），也复制到了剪贴板' : '提示词已复制到剪贴板；未能自动打开 Chat，请手动粘贴');
    }
    return !!r.cmd;
  }
  flash(p, '已加入 Chat 上下文；提问用的提示词已复制（Ctrl+V 可直接发送）');
  return true;
}

// 送完 Chat 把面板窗口抬回前台。**仅在面板弹成独立 OS 窗口时有意义**：
// 那种情况下 Chat 会把宿主所在的原窗口带到前台、把面板窗口压下去。
// 嵌入模式（默认）下不做任何事 —— 面板和 Chat 在同一个窗口里，用分栏并排显示，
// 抢焦点反而会妨碍用户往 Chat 输入框里打字。
function refocusPanelAfterChat(p) {
  const dp = docOfPanel(p);
  if (!dp || !dp.poppedOut) return;
  if (!vscode.workspace.getConfiguration('prettyCommit').get('refocusPanelAfterChat', true)) return;
  setTimeout(() => requestRaise(p, 'after-chat'), 350);
  setTimeout(() => requestRaise(p, 'after-chat-retry'), 1100);
}

function getAddMode() {
  const m = vscode.workspace.getConfiguration('prettyCommit').get('addToChat', 'input');
  return ['input', 'context', 'both'].includes(m) ? m : 'input';
}

// 把选区作为「代码上下文芯片」附加进当前 Cursor Chat。
// 关键前提（踩过的坑）：composer.addsymbolstocomposer 内部是
//   const c = composerDataService.resolveComposerIdToSelected(selectedComposerId);
//   handleOpenComposer(c); addCodeSelectionsWithInlineMentionsBatch(c, selections, 'editor')
// 而 addCodeSelections* 里第一件事就是 getHandleIfLoaded(composerId)，取不到就直接 return。
// 也就是说：**chat 面板没打开 / composer 还没加载完**时，这个命令会“静默成功但什么都没加”
// —— 表现为「弹出了一个新对话框，但里面是空的」。所以先确保有一个已加载、被选中的 composer。
async function ensureChatReady() {
  // Cursor 的 workbench.action.chat.open 实现是 createComposer({openInNewTab:true}) + showAndFocus，
  // 调用后 composer 必然处于“已加载且被选中”状态（代价是会新开一个 chat 标签页）。
  for (const cmd of CHAT_OPEN_CMDS) {
    try {
      await vscode.commands.executeCommand(cmd);
      info(`已确保 Chat 就绪：${cmd}`);
      await sleep(400);
      return cmd;
    } catch (e) {
      warn(`准备 Chat 失败 ${cmd}: ${e.message}`);
    }
  }
  try {
    await vscode.commands.executeCommand('composer.focusComposer');
    info('已确保 Chat 就绪：composer.focusComposer');
    await sleep(300);
    return 'composer.focusComposer';
  } catch (e) {
    warn(`准备 Chat 失败 composer.focusComposer: ${e.message}`);
  }
  return null;
}

// 返回是否成功把选区加进了 Chat 上下文（命令抛错才算失败；静默 no-op 无法从外部探测）
async function attachSelectionContext(d, sel) {
  await ensureChatReady();
  const doc = makeContextDoc(d, sel.path || '', sel.text);
  const cmd = await attachDocToChat(doc, `file=${sel.path}`, true);
  return !!cmd;
}

// 送 Chat 后，如果 Chat 正好开在面板那一栏（会把 diff 盖住），就把它挪到相邻分栏，
// 让 diff 与 AI 回答同屏可见。先用 tabGroups 确认「确实盖住了」才动手，避免乱动用户的布局。
// 用方向命令而不是 next/previous：bundle 里这两个命令的实现是
//     case"left":  g = u.findGroup({direction:2}, a), g || (g = u.addGroup(a, 2)); break;
//     case"right": g = u.findGroup({direction:3}, a), g || (g = u.addGroup(a, 3)); break;
// 也就是说方向命令「没有相邻栏就新建一栏」，**目标栏一定存在**；
// 而 previous/next 用的是 findGroup({location:3/2})，找不到时 g 为 undefined → 静默什么都不做。
// 方向选择：面板不在最左就往左挪，否则往右 —— 总之把 Chat 放到面板的另一侧。
async function placeChatBesidePanel() {
  const p = activePanel();
  const dp = p ? docOfPanel(p) : null;
  if (!p || !dp || dp.poppedOut) return; // 独立窗口模式下 Chat 和面板本来就分属不同窗口
  if (!chatBesidePanel()) return;
  // 面板刚才可能是「展开占满编辑区」的状态：这时 Chat 是开在面板那一栏里的，而且
  // 该栏处于展开态 —— 若直接往旁边新建一栏，bundle 里 addGroup 有这么一段：
  //     const o = this.groupViews.size > 1 && this.isGroupExpanded(i);
  //     … o && this.arrangeGroups(1, r);   // 新栏也变成展开的那一栏
  // 结果是 Chat 占满、面板缩成一条缝 —— 正好搞反。所以先恢复等宽，再挪 Chat。
  await unexpandPanelGroup(p, 'place-chat');
  // 以「这个 diff 标签自己所在的分栏」为基准，而不是「第一个含 diff 的分栏」
  const g = groupOfPanel(p);
  const all = tabGroupsApi();
  if (!g || !all) return; // 拿不到分栏信息（老版本 API）就不猜
  const idx = all.all.indexOf(g);
  if (idx < 0) return;
  if (!g.isActive) {
    info('Chat 没有开在面板那一栏（分栏布局不变）');
    return;
  }
  const toLeft = idx > 0;
  const cmd = toLeft ? 'workbench.action.moveEditorToLeftGroup' : 'workbench.action.moveEditorToRightGroup';
  try {
    await vscode.commands.executeCommand(cmd);
    // 挪走 Chat 后，那一栏的活动标签页会回落到「上一笔活动编辑器」（可能是源文件）。
    // 用 preserveFocus=true 把面板标签页翻到该栏最前，但**不**抢键盘焦点 ——
    // 此时用户正要去 Chat 输入框里打字。
    revealPanelInPlace(p, true);
    info(`已把 Chat 挪到面板${toLeft ? '左' : '右'}侧的分栏（同屏可见）`);
    logTabLayout('送 Chat 后');
  } catch (e) {
    info(`移动 Chat 分栏失败（忽略；Chat 会盖住面板，可 Alt+Shift+Q 切回）: ${e.message}`);
    revealPanelInPlace(p, true); // 挪不动也至少把面板标签页翻出来
  }
}

// 打开 Chat 并把 text 填进输入框。
// Cursor 的 workbench.action.chat.open 实现（bundle 里可见）：
//   const s = typeof t == "string" ? t : t?.query;
//   createComposer({ partialState: s ? {text: s, richText: s} : undefined, openInNewTab: true })
//   await composerViewService.showAndFocus(composerId)
// 所以传 { query } 会把文本作为 composer 的初始内容（新标签页），这是**内容一定会出现**的那条路。
// 返回 { cmd, prefilled }：prefilled 表示文本确实被填进去了。
async function openChatWithText(text) {
  const tries = [];
  for (const cmd of CHAT_OPEN_CMDS) {
    if (text) tries.push([cmd, { query: text }]);
    tries.push([cmd, undefined]);
  }
  tries.push(['aichat.newfollowupaction', undefined]);
  for (const [cmd, arg] of tries) {
    try {
      if (arg === undefined) await vscode.commands.executeCommand(cmd);
      else await vscode.commands.executeCommand(cmd, arg);
      const prefilled = !!arg && !!arg.query;
      info(`打开 Chat：${cmd}${prefilled ? '（带 query，文本已填入）' : '（无 query）'}`);
      await placeChatBesidePanel();
      return { cmd, prefilled };
    } catch (e) {
      warn(`打开 Chat 失败 ${cmd}: ${e.message}`);
    }
  }
  return { cmd: null, prefilled: false };
}

// ---------- 送 Chat（整笔/单文件分析：挂芯片） ----------

// 把一次「AI 分析」送进 Chat：**输入框只放短提问，diff 作为上下文芯片挂上去**。
//
// 顺序很关键（顺序错了芯片会丢），依据是 Cursor bundle 里这两个命令的实现：
//   1) workbench.action.chat.open {query} → createComposer({partialState:{text,richText}})
//      + showAndFocus → 输入框拿到提问，且这个 composer 成为「selected」；
//   2) composer.addsymbolstocomposer → resolveComposerIdToSelected(selectedComposerId)
//      → addCodeSelectionsWithInlineMentionsBatch → 挂到**当前选中的**那个 composer 上。
// 所以先开 composer 再挂芯片，两者落在同一个标签页；反过来先挂芯片再 chat.open，
// 会新建第二个 composer，把刚挂上的芯片丢在旧标签页里。
//
// 这套链路依赖 Cursor 内部命令，且 addCodeSelections* 在 composer 没加载好时是**静默 no-op**
// （不抛错）。所以：无论成败都把完整文本写进剪贴板兜底，用户 Ctrl+V 就能补救。
async function sendAnalysisToChat(p, { question, diffText, docPath, docHeader, fullText, label }) {
  const d = (docOfPanel(p) || activeDoc());
  if (!d) return;

  // 1) 开 chat，把短提问填进输入框（同时保证 composer 已加载、被选中）
  const opened = await openChatWithText(question);
  if (!opened.cmd) {
    await vscode.env.clipboard.writeText(fullText);
    flash(p, '未能自动打开 Chat；完整分析内容已复制到剪贴板');
    return;
  }

  // 等 composer 真正挂载。理由同 ensureChatReady：addCodeSelections* 在 handle 还没加载时
  // 会静默 no-op（不抛错），所以创建后必须留一点时间，否则芯片会「看起来成功但没出现」。
  await sleep(400);

  // 2) 把 diff 挂成语境芯片（挂到刚打开的那个 composer 上；不新建 composer）
  const doc = makeContextDoc(d, docPath, diffText, { header: docHeader, uriQuery: 'analysis' });
  const cmd = await attachDocToChat(doc, label, false);

  if (cmd) {
    await vscode.env.clipboard.writeText(fullText); // 芯片没出现时的兜底
    refocusPanelAfterChat(p);
    flash(p, 'diff 已挂成语境芯片，输入框里是提问（回车发送）；若没看到芯片，Ctrl+V 可粘贴完整内容');
    return;
  }

  // 3) 芯片链路全失败 → 退回老行为：完整内容填进输入框
  info('芯片链路失败，退回「完整内容填进输入框」');
  const fallback = await openChatWithText(fullText);
  await vscode.env.clipboard.writeText(fullText);
  refocusPanelAfterChat(p);
  flash(
    p,
    fallback.prefilled
      ? '未能挂上芯片，已改为把完整分析内容填进 Chat 输入框（回车发送）'
      : '未能挂上芯片，也未能填入 Chat；完整内容已复制到剪贴板'
  );
}

// ---------- 按需 AI 分析（点击才跑，绝不自动） ----------
// 门控只做一件事：代码量大时先提示，用户确认后才把内容送进 Chat；小改动直接送。

function cfgNum(key, def) {
  const v = vscode.workspace.getConfiguration('prettyCommit').get(key, def);
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// 弹出「代码量大」确认框；返回是否继续。
// 注意用 showWarningMessage 的 modal：它会显示在扩展宿主所在窗口；嵌入模式下就是面板同窗口，没问题。
async function confirmLargeCode(headline, detail) {
  const picked = await vscode.window.showWarningMessage(
    `${headline}\n\n${detail}\n\n确认后才会把上面的内容送进 Chat。`,
    { modal: true },
    '继续分析',
    '取消'
  );
  return picked === '继续分析';
}

// 整笔 commit 分析（for what / why）
async function requestWhole(p) {
  // 分析的是「这个标签里显示的 diff」，不是碰巧最后聚焦的那一个
  const d = docOfPanel(p) || activeDoc();
  if (!p || !d || busy) return;
  if (!d.files.length && !d.totalFiles) {
    flash(p, '这个提交没有可分析的改动');
    return;
  }

  busy = true;
  post(p, { type: 'busy', value: true });
  try {
    const { text, question, diffText, lines } = ai.buildWholeText(d);
    const threshold = cfgNum('wholePromptDelta', 1000);
    if (d.delta > threshold) {
      const { lo, hi } = ai.estimateTokens(text);
      const ok = await confirmLargeCode(
        `代码量较大：整笔改动 Δ=${d.delta} 行、${d.totalFiles || d.files.length} 个文件。`,
        `会把截断后的约 ${lines} 行作为「上下文芯片」挂上（不是塞进输入框）。预计分析数十秒到数分钟，` +
          `大约消耗 ${ai.fmtToken(lo)}–${ai.fmtToken(hi)} Token（按截断后文本粗算，非账单精确值）。`
      );
      if (!ok) {
        flash(p, '已取消整笔分析');
        return;
      }
    }
    await sendAnalysisToChat(p, {
      question,
      diffText,
      docPath: `commit-${d.shortSha}.diff`,
      docHeader: `# 提交 ${d.shortSha}  ${d.subject}（整笔 unified diff，非工作区当前内容）`,
      fullText: text,
      label: `whole ${d.shortSha}`,
    });
  } finally {
    busy = false;
    if (panelAlive(p)) post(p, { type: 'busy', value: false });
  }
}

// 单文件分析：只针对当前选中的那个文件
async function requestFile(p, filePath) {
  const d = docOfPanel(p) || activeDoc();
  if (!p || !d || busy) return;
  const file = (d.files || []).find((f) => f.path === filePath);
  if (!file) {
    flash(p, '没找到这个文件（列表可能已变化）');
    return;
  }

  busy = true;
  post(p, { type: 'busy', value: true });
  try {
    const { text, question, diffText, lines, diffLines } = ai.buildFileText(d, file);
    const threshold = cfgNum('filePromptLines', 500);
    if (diffLines > threshold) {
      const { lo, hi } = ai.estimateTokens(text);
      const ok = await confirmLargeCode(
        `代码量较大：${file.path} 这个文件本身就有 ${diffLines} 行 diff（+${file.added} / −${file.deleted}）。`,
        `会把截断后的约 ${lines} 行作为「上下文芯片」挂上（不是塞进输入框）。预计分析数十秒到数分钟，` +
          `大约消耗 ${ai.fmtToken(lo)}–${ai.fmtToken(hi)} Token（按截断后文本粗算，非账单精确值）。`
      );
      if (!ok) {
        flash(p, '已取消单文件分析');
        return;
      }
    }
    await sendAnalysisToChat(p, {
      question,
      diffText,
      docPath: file.path,
      docHeader: `# 文件 ${file.path}（unified diff，非工作区当前内容）`,
      fullText: text,
      label: `file ${file.path}`,
    });
  } finally {
    busy = false;
    if (panelAlive(p)) post(p, { type: 'busy', value: false });
  }
}

// ---------- 小工具 ----------

function mediaDir() {
  return vscode.Uri.joinPath(context.extensionUri, 'media');
}

function readHtml() {
  return fs.readFileSync(path.join(context.extensionPath, 'media', 'panel.html'), 'utf8');
}

function setStatus(p, text, kind) {
  post(p, { type: 'status', text, kind });
}

function flash(p, text) {
  post(p, { type: 'toast', text });
}

// 自检钩子（assets/pc-host-test.js 在 mock 的 vscode 环境里驱动这套状态机）。
// 只是把内部状态露出来，运行时行为不受影响。
module.exports = {
  activate,
  deactivate,
  __test: {
    openCommit,
    openWorking,
    docs: () => docs, // 活引用：测试可以直接往里塞文档来验证上限裁剪
    docOfPanel,
    activeDoc,
    activeId: () => activeDocId,
    setActiveDoc,
    selWaiter: () => selWaiter,
    addSelectionFromPanel,
    columnForNewPanel,
    groupOfPanel,
    evictOverflow,
    reloadDoc,
    reloadAllDocs,
    onDidSaveFile,
    onGitMetaChanged,
    scheduleWorkingRefresh,
    isInsideRepo,
    refreshOnSaveEnabled,
    watchGitStateEnabled,
    handleOpenSource, // 「跳原文」三层兜底（见 openViaWorkbench 注释）
    readUiState,
    saveUiState,
    resetDocs: () => {
      docs = [];
      activeDocId = null;
      current = null;
      currentRepoRoot = null;
    },
  },
};
