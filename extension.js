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
let panel; // WebviewPanel | undefined（单例）
let current; // 最近一次成功 loadCommit 的数据（含 files/hunks）
let currentRepoRoot; // 该数据来自哪个仓库根
let loadGen = 0; // 防并发旧结果覆盖新结果
let loadingRev = null; // 正在加载中的 rev（webview 重载时用它显示进度，而不是回放上一笔旧数据）
let busy = false; // 整笔分析进行中
let picking = false; // 「打开提交…」选择框是否已弹出（键位是全局的，要挡重复触发）
// 面板是否住在独立 OS 窗口里。弹出去之后，**不能**再调 panel.reveal()：
// 主线程的实现是 $reveal → getTargetGroupFromShowOptions(showOptions)，
//   若 viewColumn 为 undefined（或不传）→ 直接返回 ViewColumn.Active，
// 而那个「Active」是在**扩展宿主所在窗口**的 editorGroupService 里解析的。
// 于是 reveal 会把面板从独立窗口拖回原窗口的活动组 —— 独立窗口随之空掉/关闭，
// 表现就是用户说的「add 到 chat 之后窗口就隐藏了」。所以弹出后只用窗口置前，
// 绝不用 reveal 去「显示」面板。
let poppedOut = false;
let popoutFailStreak = 0; // 连续失败次数（>=3 暂停重试，窗口重载后归零）
let popoutWarned = false; // 是否已就「弹不出独立窗口」提示过
let suppressPopout = false; // reopenInWindow 重建面板时，别再触发一次弹窗
let log; // OutputChannel
const virtualDocs = new Map(); // 虚拟文档 uri 字符串 -> 内容（送 Chat 的代码上下文）
let selWaiter = null; // 等待 webview 回报当前选区
let lastSelSig = null; // 去重用：面板内 Ctrl+L 与清单快捷键可能同时触发
let lastSelAt = 0;

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
      // 从任何焦点位置一键把面板叫回来（面板被 Chat / 别的标签页盖住时最有用）
      const p = panel;
      if (!panelAlive(p)) {
        vscode.window.showInformationMessage('Pretty Commit：面板还没打开，先按 Alt+Q。');
        return;
      }
      requestRaise(p, 'command', true);
      flash(p, poppedOut ? '已把面板窗口带到前台' : '已把面板切到前台');
    }),
    // 快捷键是 package.json 里静态声明的，扩展没法在运行时改写它 —— 官方支持的改法就是
    // 用户键位（keybindings.json / 快捷键 UI）覆盖扩展默认值。所以这里只负责把用户送到
    // 「键盘快捷方式」界面并预筛到本扩展的命令，剩下的点一下就能改。
    vscode.commands.registerCommand('prettyCommit.rebind', () => openKeybindingEditor()),
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
        !e.affectsConfiguration('editor.fontFamily')
      ) {
        return;
      }
      if (panelAlive(panel)) post(panel, { type: 'uiState', ui: readUiState() });
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

  const p = getPanel();
  const gen = ++loadGen;
  loadingRev = rev;
  setStatus(p, `正在读取 ${rev} 的 git 数据…`, 'loading');
  try {
    const data = await git.loadCommit(root, rev);
    if (gen !== loadGen || !panelAlive(p)) return; // 已过期/已关闭
    loadingRev = null;
    current = data;
    currentRepoRoot = root;
    // 让面板露出来。注意两条路都不能用 panel.reveal(undefined)：
    // 它的实现是 openEditor(editor, {...}, getTargetGroupFromShowOptions(...))，而
    // viewColumn 为 undefined 会解析成 ACTIVE_GROUP —— 也就是**把面板搬到当前分栏**。
    // 独立窗口时那会把面板拖回原窗口（旧 bug），嵌入时则会把面板搬到 Chat 所在分栏盖上 Chat。
    // 所以统一改成「请求页面报一下自己是不是被盖住了」，页面回报 hidden 才切标签页。
    requestRaise(p, 'open', true);
    p.title = `${data.shortSha}  ${data.subject}`;
    sendCommit(p, data, 'open');
    logTabLayout('打开提交后');
    await expandPanelGroup(p, 'open'); // 占满编辑区（fillEditorArea=false 时不做）
    // 不再自动分析：打开窗口零 Token，AI 只在用户点按钮 / 按快捷键时触发。
  } catch (err) {
    if (gen === loadGen) loadingRev = null;
    if (gen !== loadGen || !panelAlive(p)) return;
    warn(`加载失败 rev=${rev}: ${err.stack || err.message}`);
    setStatus(p, `加载失败：${err.message}`, 'error');
    vscode.window.showErrorMessage(`Pretty Commit: ${err.message}`);
  }
}

async function openWorking(kind) {
  const root = await pickRepoRoot('查看工作区');
  if (!root) return;
  const p = getPanel();
  const gen = ++loadGen;
  const label = kind === 'staged' ? '暂存区' : kind === 'unstaged' ? '未暂存' : '工作区';
  loadingRev = `:working:${kind}`;
  setStatus(p, `正在读取${label} diff…`, 'loading');
  try {
    const data = await git.loadWorkingDiff(root, kind);
    if (gen !== loadGen || !panelAlive(p)) return;
    loadingRev = null;
    current = data;
    currentRepoRoot = root;
    requestRaise(p, 'open', true);
    p.title = `${data.shortSha}  ${data.subject}`;
    sendCommit(p, data, 'open');
    logTabLayout('打开工作区 diff 后');
    await expandPanelGroup(p, 'open');
  } catch (err) {
    if (gen === loadGen) loadingRev = null;
    if (gen !== loadGen || !panelAlive(p)) return;
    warn(`加载工作区失败: ${err.stack || err.message}`);
    setStatus(p, `加载失败：${err.message}`, 'error');
    vscode.window.showErrorMessage(`Pretty Commit: ${err.message}`);
  }
}

// 统一的 commit 下发口：所有 commit 消息都必须带上 hostVersion，
// 页面据此判断「宿主 JS 是旧版（改了代码没 Reload Window）」。
function sendCommit(p, data, why) {
  post(p, {
    type: 'commit',
    commit: toViewModel(data),
    hostVersion: HOST_BUILD,
  });
  if (why === 'resync') info(`重新下发当前提交（${why}）: ${data.shortSha}`);
}

// ---------- 界面偏好（缩放档位 / 左侧列表开关） ----------
// 放 globalState，跨窗口、跨次打开都还在。页面用 getUiState / saveUiState 两条消息读写；
// 旧宿主不认这两条消息，页面退回默认值，不会报错。
const UI_KEY = 'prettyCommit.uiState';
const UI_DEFAULT = { zoom: 0, listOpen: true, listWidth: 260 };

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
  }
  const persist = { zoom: next.zoom, listOpen: next.listOpen, listWidth: next.listWidth };
  try {
    await context.globalState.update(UI_KEY, persist);
  } catch {
    /* 存不下就算了，下次用默认值 */
  }
  return next;
}

// 把「当前应该在页面上的东西」重新下发一次。
// 关键场景：把编辑器组弹成独立 OS 窗口（moveEditorToNewWindow）后，VS Code 会在新窗口里
// 重新造一个 webview —— 它从零开始（S.files 为空），而宿主这边 panel.ready 早已是 true、
// 队列也早冲空了，于是那笔 commit 永远不会再发下去，页面就停在「没有可显示的文件改动」。
// 所以每次收到 webview-ready 都要按当前状态重发，而不是只冲队列。
function resyncState(p, why) {
  if (!panelAlive(p)) return;
  if (loadingRev) {
    setStatus(p, `正在读取 ${loadingRev} 的 git 数据…`, 'loading');
    return;
  }
  if (!current) return; // 还没有任何数据，页面自己显示初始态即可
  p.title = `${current.shortSha}  ${current.subject}`;
  sendCommit(p, current, 'resync');
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
    author: d.author,
    files,
  };
}

// ---------- Webview 面板 ----------

function getPanel() {
  if (panel && panelAlive(panel)) return panel;
  // 默认嵌在编辑器里（moveToNewWindow=false）：面板和 Chat 就在同一个 OS 窗口，
  // 不存在「同时只能有一个在最前面」的问题 —— 同一个窗口内用分栏就能同屏看到两边。
  // 仍然保留弹出独立窗口的能力（moveToNewWindow=true），但那是 opt-in。
  const willPopOut = popOutEnabled() && !suppressPopout;
  // 嵌入时默认「占满编辑区」：先把面板开在**当前分栏**（不额外切一道屏），随后由
  // expandPanelGroup 把它展开到占满 —— 这样不会留下一个多余的空分栏。
  // 只有关掉 fillEditorArea 时才按 openBeside 决定是否在旁边新开一栏（旧的左右分屏行为）。
  const column =
    !willPopOut && !fillEditorArea() && openBeside() ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'Pretty Commit',
    column,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaDir()],
    }
  );
  panel.ready = false;
  panel.pending = [];
  panel.webview.html = readHtml();
  poppedOut = false; // 新面板先建在「当前窗口」，是否弹出去由 schedulePopOut 决定
  const created = panel;
  panel.webview.onDidReceiveMessage(onMessage, undefined, context.subscriptions);
  panel.onDidDispose(
    () => {
      if (panel === created) {
        info('panel disposed');
        panel = undefined;
        current = null;
        currentRepoRoot = null;
        poppedOut = false;
        panelExpanded = false;
        panelWindowId = null; // 窗口没了，缓存的 id 作废
      }
    },
    undefined,
    context.subscriptions
  );
  if (willPopOut) schedulePopOut(created);
  return created;
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
let panelWindowId = null; // 面板那个 OS 窗口的 X11 id（学习到就缓存，比按标题找更稳）

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
function titleNeedle() {
  if (current && current.shortSha) return current.shortSha;
  return '';
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

async function learnPanelWindowIdAfter(before) {
  if (!before) return;
  const after = await snapshotWindowIds();
  if (!after) return;
  const fresh = [...after].filter((id) => !before.has(id));
  if (fresh.length === 1) {
    panelWindowId = fresh[0];
    info(`学到面板窗口 id: ${panelWindowId}`);
  } else if (fresh.length > 1) {
    info(`弹窗后新增了 ${fresh.length} 个窗口（${fresh.join(', ')}），不猜，改用标题定位`);
  }
}

async function raiseViaX11(why) {
  if (!x11Applicable() || x11Off || x11Busy) return false;
  const needle = titleNeedle();
  if (!panelWindowId && !needle) return false; // 还没有提交数据、也不知道窗口 id，无法定位
  x11Busy = true;
  try {
    // WM 对「刚映射出来的新窗口」的 _NET_ACTIVE_WINDOW 请求常常第一次不认（实测 GNOME/mutter
    // 就是这样：首发被拒、700ms 后重试即成功），所以被拒时按退避再试几次。
    const delays = [0, 400, 900];
    for (let i = 0; i < delays.length; i++) {
      if (i) await sleep(delays[i]);
      let r = null;
      if (panelWindowId) {
        r = await runHelper(['activate', '--id', panelWindowId], 3000);
        if (r && r.code === 5) {
          info(`面板窗口 ${panelWindowId} 已失效，改用标题重新查找`);
          panelWindowId = null;
          r = null;
        }
      }
      if (!r && titleNeedle()) r = await runHelper(['activate', '--title', titleNeedle()], 3000);
      if (!r) return false;

      const out = r.out.trim();
      if (r.code === 0) {
        const m = /MATCHED=(0x[0-9a-fA-F]+)/.exec(out);
        if (m) panelWindowId = m[1];
        const active = /ACTIVE=(0x[0-9a-fA-F]+)/.exec(out);
        const taken = active && m && active[1].toLowerCase() === m[1].toLowerCase();
        if (taken) {
          x11FailStreak = 0;
          info(`X11 置前成功（${why}${i ? `，第 ${i + 1} 次尝试` : ''}）win=${panelWindowId || '?'}`);
          return true;
        }
        if (i < delays.length - 1) continue; // 被 WM 拒绝 → 退避重试
        info(`X11 置前被 WM 拒绝（${why}，重试 ${delays.length} 次）win=${panelWindowId || '?'}`);
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
    const { TabInputWebview } = vscode.window;
    return !!TabInputWebview && t.input instanceof TabInputWebview && t.input.viewType === VIEW_TYPE;
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

// 找到面板所在的分栏。返回 { all, idx, group }；找不到返回 null。
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
  info(`分栏（${tag}）: ${desc}${f ? `  ← 面板在第 ${f.idx} 栏` : '  ← 面板不在这个窗口'}`);
}

// 在「面板自己那一栏」把它显示出来：只激活标签页，不搬动分栏。
// preserveFocus=true 时只把标签页翻到它那一栏的前面，不抢键盘焦点（送完 Chat 要用这个，
// 否则光标会从 Chat 输入框被拽走）；默认 false，把焦点也一起带过去（用户按 Alt+Q / Alt+Shift+Q 时）。
function revealPanelInPlace(p, preserveFocus = false) {
  const f = findPanelGroups();
  if (!f) return false;
  try {
    p.reveal(f.group.viewColumn, preserveFocus);
    info(`已在面板自己那一栏（第 ${f.idx} 栏）显示面板${preserveFocus ? '（不抢焦点）' : ''}`);
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
let panelExpanded = false; // 「展开」是我们自己造成的状态，API 查不到，只能自己记

function fillEditorArea() {
  return vscode.workspace.getConfiguration('prettyCommit').get('fillEditorArea', true);
}

function requestRaise(p, why, userAsked) {
  if (!panelAlive(p)) return;
  if (!poppedOut) {
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
  raiseViaX11(why).catch(() => {});
}

// 展开面板那一栏，让它占满编辑区（其它栏缩到最小，不关闭）。
// 每次 Alt+Q 打开提交都会走一次：你上一笔看完、把布局恢复成左右分屏去跟 AI 讨论，
// 再 Alt+Q 看下一笔时又会变回大视图。
async function expandPanelGroup(p, why) {
  if (!fillEditorArea() || poppedOut || !panelAlive(p)) return;
  // 走弹窗那条路时不展开宿主的布局 —— 面板马上要搬到别的 OS 窗口，展开原窗口毫无意义。
  // （schedulePopOut 是异步的、带 ping 重试，所以这里不能等 poppedOut 变成 true 再判断。）
  if (popOutEnabled()) return;
  const f = findPanelGroups();
  if (!f) {
    info(`不展开面板分栏（${why}）：拿不到分栏信息（核心没有 tabGroups API），不猜它在哪一栏`);
    return;
  }
  if (f.all.length < 2) {
    panelExpanded = false;
    return; // 只有一栏：本来就已经占满，且该命令在单栏时会直接 return
  }
  revealPanelInPlace(p); // 先让面板那一栏成为活动栏：arrangeGroups 只认 activeGroup
  try {
    await vscode.commands.executeCommand('workbench.action.minimizeOtherEditors');
    panelExpanded = true;
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
async function unexpandPanelGroup(why) {
  if (!panelExpanded) return;
  panelExpanded = false;
  try {
    await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
    info(`已恢复等宽分栏，便于 Chat 与面板同屏（${why}）`);
  } catch (e) {
    info(`恢复等宽分栏失败（忽略）: ${e.message}`);
  }
}

function notePopoutFailure() {  popoutFailStreak += 1;
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
    if (!panelAlive(p) || panel !== p) return false;
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
  if (!popOutEnabled()) {
    info(`跳过弹窗（moveToNewWindow=off 或连续失败 ${popoutFailStreak} 次），留在当前窗口`);
    return;
  }
  info('尝试 moveEditorToNewWindow…');
  await sleep(250);
  if (!panelAlive(p) || panel !== p) return;

  const snapshot = current; // dispose 会清空 current，先存
  const idsBefore = await learnPanelWindowIdBefore(); // 移动前记录窗口集合，用于事后认出新窗口
  try {
    p.reveal(vscode.ViewColumn.Active, true);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  } catch (e) {
    info(`moveEditorToNewWindow 被拒绝（留在原窗口）: ${e.message}`);
    notePopoutFailure();
    return; // 面板还在，原窗口大视图，无需重建
  }

  await sleep(900); // 等窗口切换 / dispose 尘埃落定
  if (!panelAlive(p) || panel !== p) {
    // 移动导致本面板被 dispose —— 此环境弹不了独立窗口
    info('弹窗后面板被 dispose，改回原窗口内重建');
    notePopoutFailure();
    if (snapshot) reopenInWindow(snapshot);
    return;
  }
  // 新窗口里的 webview 可能是刚新建、脚本还没跑起来，单次 ping 会误判成「白窗」，
  // 所以多试几次；期间只要有一次 pong 就说明面板是活的。
  const alive = await pingPanelWithRetry(p, 3, 1000);
  if (!alive) {
    info('弹窗后面板无响应（疑似白窗），改回原窗口内重建');
    notePopoutFailure();
    try { p.dispose(); } catch { /* 忽略 */ }
    // onDidDispose 可能还没触发，先手动清单例，确保重建拿到新面板
    if (panel === p) {
      panel = undefined;
      current = null;
      currentRepoRoot = null;
    }
    if (snapshot) reopenInWindow(snapshot);
    return;
  }
  info('moveEditorToNewWindow 成功，面板存活');
  popoutFailStreak = 0; // 这次成了，把连续失败计数清零，避免历史失败拖累后续表现
  poppedOut = true; // 从这里开始，禁止再调 reveal（会把面板拖回原窗口）
  await learnPanelWindowIdAfter(idsBefore); // 认出新窗口，之后置前优先用 id
  // 新窗口是 VS Code 刚建出来的，焦点往往还留在原窗口 —— 真正把它抬到前台
  requestRaise(p, 'popout');
  setTimeout(() => requestRaise(p, 'popout-retry'), 700);
}

// 不用弹窗，直接在当前窗口重建面板并回放当前 commit
async function reopenInWindow(data) {
  suppressPopout = true;
  poppedOut = false; // 回到「在当前窗口里」的状态，可以安全 reveal
  panelExpanded = false; // 重新造出来的面板，展开状态从零开始
  panelWindowId = null;
  let p;
  try {
    p = getPanel(); // 关掉弹窗抑制前必须先拿到面板，否则会递归触发弹窗
  } finally {
    suppressPopout = false;
  }
  const gen = ++loadGen;
  const ok = await waitReady(p, 2000);
  if (!ok || gen !== loadGen || !panelAlive(p)) return;
  sendCommit(p, data, 'reopen');
  if (panel === p) {
    p.title = `${data.shortSha}  ${data.subject}`;
    setStatus(p, '', '');
  }
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

async function onMessage(msg) {
  if (!msg || !msg.type) return;
  const p = panel;
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
        if (poppedOut) requestRaise(p, 'webview-ready');
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
      if (p) p.dispose();
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
      break;
    case 'analyze':
      await requestWhole();
      break;
    case 'analyzeFile':
      await requestFile(msg.path);
      break;
    case 'sendSel':
      await addSelectionToChat(msg);
      break;
    case 'selection': // webview 回报当前选区（回应 wantSelection）
      if (selWaiter) selWaiter.deliver({ path: msg.path, text: msg.text });
      break;
    case 'goToSymbol':
      await handleGoToSymbol(msg);
      break;
    case 'raised': // webview 已执行 window.focus()（只证明代码跑了；visibility/focused 才是证据）
      info(
        `面板已请求窗口聚焦${msg.why ? `（${msg.why}）` : ''}` +
          ` [visibility=${msg.visibility || '?'} focused=${msg.focused ? 'yes' : 'no'}]`
      );
      // visibility=hidden 说明面板被「同一个窗口」里的别的标签页盖住了（典型：Chat 标签页），
      // 这种情况 window.focus() 救不了，得把标签页切回来。只有确认面板和宿主在同一窗口
      // （!poppedOut）时才敢 reveal —— 弹出后 reveal 会把面板拖回原窗口。
      if (!poppedOut && msg.visibility === 'hidden' && panelAlive(p)) {
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

async function addSelectionFromPanel() {
  const p = panel;
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
  await addSelectionToChat(sel);
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

async function addSelectionToChat(sel) {
  const p = panel;
  const d = current;
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
  if (!poppedOut) return;
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
  if (poppedOut) return; // 独立窗口模式下 Chat 和面板本来就分属不同窗口
  if (!chatBesidePanel()) return;
  // 面板刚才可能是「展开占满编辑区」的状态：这时 Chat 是开在面板那一栏里的，而且
  // 该栏处于展开态 —— 若直接往旁边新建一栏，bundle 里 addGroup 有这么一段：
  //     const o = this.groupViews.size > 1 && this.isGroupExpanded(i);
  //     … o && this.arrangeGroups(1, r);   // 新栏也变成展开的那一栏
  // 结果是 Chat 占满、面板缩成一条缝 —— 正好搞反。所以先恢复等宽，再挪 Chat。
  await unexpandPanelGroup('place-chat');
  const before = findPanelGroups();
  if (!before) return; // 拿不到分栏信息（老版本 API）就不猜
  const activeIdx = before.all.findIndex((g) => g.isActive);
  if (activeIdx !== before.idx) {
    info('Chat 没有开在面板那一栏（分栏布局不变）');
    return;
  }
  const toLeft = before.idx > 0;
  const cmd = toLeft ? 'workbench.action.moveEditorToLeftGroup' : 'workbench.action.moveEditorToRightGroup';
  try {
    await vscode.commands.executeCommand(cmd);
    // 挪走 Chat 后，那一栏的活动标签页会回落到「上一笔活动编辑器」（可能是源文件）。
    // 用 preserveFocus=true 把面板标签页翻到该栏最前，但**不**抢键盘焦点 ——
    // 此时用户正要去 Chat 输入框里打字。
    revealPanelInPlace(panel, true);
    info(`已把 Chat 挪到面板${toLeft ? '左' : '右'}侧的分栏（同屏可见）`);
    logTabLayout('送 Chat 后');
  } catch (e) {
    info(`移动 Chat 分栏失败（忽略；Chat 会盖住面板，可 Alt+Shift+Q 切回）: ${e.message}`);
    revealPanelInPlace(panel, true); // 挪不动也至少把面板标签页翻出来
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
async function sendAnalysisToChat({ question, diffText, docPath, docHeader, fullText, label }) {
  const p = panel;
  const d = current;

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
async function requestWhole() {
  const p = panel;
  if (!p || !current || busy) return;
  const d = current;
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
    await sendAnalysisToChat({
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
async function requestFile(filePath) {
  const p = panel;
  if (!p || !current || busy) return;
  const d = current;
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
    await sendAnalysisToChat({
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

module.exports = { activate, deactivate };
