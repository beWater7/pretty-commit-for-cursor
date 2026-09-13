# Pretty Commit

SCM 提交历史右键 → 大窗口看 diff；AI 分析**按需点击**（整笔 / 单文件），打开窗口零 Token；框选随时送 Chat。第一版实现照 `pretty_commit_ui_093cb708.plan.md`，纯 JavaScript、无构建、不进任何现有仓库。

## 触发方式

| 入口 | 说明 |
| --- | --- |
| `Alt+Q` | 快捷键，直接弹「打开提交…」列表（默认最近 25 条，条数可配、可加载更多）。不带 `when`，全窗口生效；**终端聚焦时要先执行一次「让快捷键在终端里也生效」**（见下「改快捷键」） |
| `Alt+Shift+Q` | 把面板叫回前台（被 Chat 或别的标签页盖住时用） |
| Source Control → 提交历史（SCM Graph）条目右键 `Pretty Commit: 查看此提交` | 主入口，需新版核心的 proposed 菜单（见下「限制」） |
| 命令面板 `Pretty Commit: Open HEAD（最近提交）` | 兜底，一键看 HEAD |
| 命令面板 `Pretty Commit: 打开提交…` | 兜底，列表里挑一个（底部可「加载更多」，见 `prettyCommit.recentCommitCount`） |
| `Ctrl+L` / 命令面板 `Pretty Commit: 把选中的 diff 加进 Chat` | 面板聚焦时把选区加进 Chat，见下节 |

打开后**嵌在当前编辑器窗口**里，并**展开占满整个编辑区**（`prettyCommit.fillEditorArea`，默认开），和 Chat 同处一个窗口。想把 diff 丢到独立 OS 窗口就设 `prettyCommit.moveToNewWindow=true`（见下「弹窗模式」）。

## 改快捷键 / 让它到处都能用

扩展的键位是 `package.json` 里**静态声明**的，运行时改不了；官方支持的改法是「用户键位覆盖扩展默认值」。所以本扩展只提供两个入口，把该点的点点掉：

```markdown
| 入口 | 作用 |
|------|------|
| 命令面板 `Pretty Commit: 修改快捷键…` | 打开「键盘快捷方式」界面并预筛 `prettyCommit`（`openGlobalKeybindings` 带搜索词，和 Cursor 自己跳转的方式一样） |
| `Alt+Q` 列表里的第一项 `修改快捷键…` | 同上，顺手 |
| 命令面板 `Pretty Commit: 让快捷键在终端里也生效` | 把 `prettyCommit.pickCommit` / `prettyCommit.raisePanel` 写进 `terminal.integrated.commandsToSkipShell`（见下） |
```

### 为什么原来「只有光标在编辑器里才生效」

两个原因叠在一起，都查到了证据：

**一、`when` 限制。** 原来两个键位带 `when: "!terminalFocus"`，终端聚焦时键位直接不匹配。现在两条都不带 `when`，全窗口生效。注意 `Ctrl+L`（送 Chat）是**故意**限定在面板里的（`activePanelId == prettyCommit`），别顺手把它的 `when` 删了。

**二、终端会把按键吃掉，跟 `when` 无关。** Cursor 里终端对按键的处理（`TerminalInstance` 的 keydown）：

```javascript
r.kind === 2 && r.commandId && this._skipTerminalCommands.includes(r.commandId)
  && !config.sendKeybindingsToShell
    ? (preventDefault, false)   // 交给 workbench 处理
    : …                         // 继续往下 → 把按键原样发给 shell
```

而 `_skipTerminalCommands = 内置表 ∪ terminal.integrated.commandsToSkipShell` —— **扩展自己的命令默认不在表里**，所以终端聚焦时按 `Alt+Q` 只会把字符喂给 shell，去掉 `when` 也救不了。这就是「只有光标在编辑器里才生效」的真正原因。执行一次上面那条「让快捷键在终端里也生效」即可（幂等，会保留你已有的条目，想还原就在设置里删掉那两项）。

### 想换成别的键

在「键盘快捷方式」界面里搜到 `prettyCommit.pickCommit`，双击那一行录入新键即可（会写进 `keybindings.json`）。也可以直接手写：

```json
[
  { "key": "ctrl+q", "command": "prettyCommit.pickCommit" }
]
```

用户键位优先级高于扩展默认值，所以这样就能覆盖，也可以像上面那样**追加**一个新键（旧键仍然生效；不想要了就在界面上右键 → 移除键位，会写成 `{"key":"alt+q","command":"-prettyCommit.pickCommit"}` 这样的负向覆盖）。

默认只绑了 `Alt+Q`（`Ctrl+Q` 没绑 —— 它在终端里是 XON 流控，容易打架；想用就按上面 JSON 自己加）。注意 `Ctrl+L`（送 Chat）的 `when` 是**故意**限定在面板里的，别顺手删掉。

### 按下没反应怎么查

命令面板 `Developer: Toggle Keyboard Shortcuts Troubleshooting`（`workbench.action.toggleKeybindingsLog`）会开始记录按键解析过程，每次按键都会打印「命中了哪条键位 / 被什么拦住」。另外本扩展在命令真正触发时会往 `输出 → Pretty Commit` 写一行 `快捷键触发：打开提交选择器` —— 有这行就说明键位通了，没这行就是被键位这一层拦住了（`when` 不匹配或终端吃掉）。

## 窗口内操作

标题栏：短 SHA + subject + `Δ=N`；右侧 `本文件分析`、`整笔分析`、`关闭`。**没有开关、也不自动发送** —— 点按钮或按快捷键才分析。

| 按键 | 作用 |
| --- | --- |
| `j` / `k` | 上一个 / 下一个文件 |
| `Enter` / `h` | 展开 / 折叠当前文件 diff |
| `n` / `p` | 下一个 / 上一个 hunk |
| `Ctrl+L`（或 `c`、或右下角「＋ 添加到 Chat」按钮） | 把框选的行加进 Chat；**无选区则送当前 hunk** |
| `Shift+A` | 整笔 commit 分析（for what / why） |
| `Shift+F` | 单文件分析（当前选中的那个文件） |
| `Alt+Shift+Q` | **把面板叫回前台**（被 Chat 或别的标签页盖住时用） |
| `Esc` | 关闭 |

每次按 `Alt+Q` 打开提交都会重新把面板展开到占满编辑区（见下面「占满编辑区」一节）；送 Chat 时会自动恢复等宽分屏，好让 diff 和 AI 回答同屏。

## 选区怎么进 Chat

鼠标在 diff 区拖选若干行 → 按 `Ctrl+L`（对齐 Cursor 自带的 Add to Chat）。有选区时右下角会浮出「＋ 添加到 Chat（N 行选区）」按钮，效果相同。

`Ctrl+L` 有**两条通路**，哪条先到用哪条（8 秒内同一段去重，不会重复添加）：

1. 面板内 `keydown`（`media/panel.html`）直接发 `sendSel` 消息 —— 面板自己就处理完了。
2. 清单快捷键 `prettyCommit.addSelection`（`when: activeWebviewPanelId == prettyCommit`）→ 宿主反过来向 webview 发 `wantSelection` 要当前选区 → 面板回报 `selection` → 再送 Chat。

之所以两条都留：按键可能被工作台先截走（那条通路由工作台派发给扩展），也可能直达 webview（那条通路由页面自己处理）。

实现方式取决于 `prettyCommit.addToChat` 设置（默认 `input`）：

```markdown
| 模式 | 行为 | 可靠性 |
|------|------|--------|
| `input`（默认） | 把「提交+文件+diff 片段+提问」作为 `{ query }` 传给 `workbench.action.chat.open`，填进 Chat 输入框（回车即发），同时写剪贴板 | 内容一定出现 |
| `context` | 先确保 chat 就绪，再用 `composer.addsymbolstocomposer` 把选区作为**代码上下文**附加（输入框保持干净） | 依赖 Cursor 内部命令 |
| `both` | 两者都做：附加上下文 + 提示词填进输入框 | —— |
```

`context` 模式的两个关键点：

- **必须先有一个已加载的 chat**。`composer.addsymbolstocomposer` 内部是 `resolveComposerIdToSelected(selectedComposerId)` → `handleOpenComposer()` → `addCodeSelectionsWithInlineMentionsBatch()`，而后者第一件事是 `getHandleIfLoaded(composerId)`，取不到就直接 `return`。chat 面板没打开时，这个命令会「静默成功但什么都没加」——表现就是**弹出了一个新对话框、里面却是空的**。所以代码先调 `workbench.action.chat.open`（Cursor 的实现是 `createComposer({openInNewTab:true})` + `showAndFocus`，调用后 composer 必然已加载并被选中），等一下再附加。
- 附加时把选区登记成**虚拟只读文档** `pretty-commit:/<短SHA>/<原路径>`（`TextDocumentContentProvider`），以 `codeSelections: [{ uri, range, text, rawText }]` 传进去 —— AI 拿到的是**带文件名和行号的代码块**，而不是一坨裸文本。
- 降级链（每级成败都写进 输出 → Pretty Commit）：`composer.addsymbolstocomposer` → `chat.addToChat`（整体加该虚拟文档）→ `composer.addsymbolstonewcomposer`（新 Chat）；全失败则自动退到 `input`。
- 无论走哪条路，都会把「带提问的提示词」（`buildSelectionText`）放进剪贴板，Ctrl+V 就能追问。选区/当前 hunk 送 Chat 上限约 200 行（与下面的整笔/单文件分析互不影响）。

## 为什么有些文件「变化为 0」

git 对**100% 相似的重命名**仍会生成一个 `diff --git` 段（带 `rename from/to`，但没有任何 hunk），仅权限变更同理。这些条目解析出来 `added=0 deleted=0`，所以在列表里显示成 `+0 −0`。它们对 review 没有信息量，却能让文件数虚高——例如 `F407Proj` 的提交 `925aeaf` 有 734 个文件，其中 **536 个是纯重命名**。

默认由 `prettyCommit.hideUnchangedFiles`（默认 `true`）把这类文件从列表里去掉，顶栏显示 `198/734 个文件 · 省略 536 个无内容变化文件`。想看全部就把该设置关掉。二进制文件不属于这一类（它是真改动，只是无法给出行级 diff），始终保留并显示 `[二进制]`。

## 按需 AI 分析（不自动发送）

打开窗口**不会**调用 AI、不会自动往 Chat 里塞东西 —— 零 Token，直到你点按钮 / 按快捷键：

```markdown
| 入口 | 分析范围 | 提问 |
|------|---------|------|
| `Shift+A` / 标题栏「整笔分析」 | 整个 commit（截断上限约 1500 行） | for what / why |
| `Shift+F` / 标题栏「本文件分析」 | 当前选中的那个文件（上限约 1000 行） | 改了什么 / 在整笔里的作用 / 风险 |
```

- 点击后**先按规模判断**：整笔 `Δ > prettyCommit.wholePromptDelta`（默认 1000），或单文件 diff 行数 > `prettyCommit.filePromptLines`（默认 500）时，先弹「代码量较大」确认框（预计时长 + 按截断文本粗算的 Token 区间），**取消则什么也不送**。
- 小改动直接送，不打扰。
- 规模越大截得越狠：整笔上限约 1500 行、单文件约 1000 行，截断处注明。

### 送 Chat 的形态：diff 挂「上下文芯片」，输入框只放提问

分析**不把 diff 正文塞进输入框**，而是把 diff 挂成 Chat 的**上下文芯片**（就是 `Ctrl+L` 之后输入框上方那个带文件名的小标签），输入框里只留一句短提问：

```
┌─ Chat ──────────────────────────────┐
│ [📎 src/a.js  ▾] [✕]                │  ← 芯片：diff 收在这里
│ 这个文件这次改了什么？在整笔提交里  │  ← 正文只有提问
│ 起什么作用？有没有风险？             │
└─────────────────────────────────────┘
```

这样做的原因：输入框保持可用（能接着追问，不用先删一千行）、AI 拿到的是带文件名/行号的结构化引用而非一坨裸文本、芯片可以随时点叉撤销。

实现顺序（依据 Cursor bundle 里两个命令的真实实现）：

1. `workbench.action.chat.open` 传 `{ query: 提问 }` → `createComposer({partialState})` + `showAndFocus`：输入框拿到提问，且这个 composer 成为「当前选中」。
2. 等 400ms（composer 挂载），再 `composer.addsymbolstocomposer` → 内部是 `resolveComposerIdToSelected(selectedComposerId)` + `addCodeSelectionsWithInlineMentionsBatch`：芯片挂到**刚才那个** composer 上。

顺序反过来（先挂芯片再 `chat.open`）会新建第二个 composer，把芯片丢在旧标签页里。

**兜底**（这套链路依赖 Cursor 内部命令，且 composer 没加载好时会静默 no-op）：

- 无论成败，完整文本（diff + 提问）都会写进剪贴板 —— 芯片没出现时 `Ctrl+V` 就能补上。
- 三个挂载命令全部抛错时，自动退回老行为：把完整内容填进 Chat 输入框。
- 每一步成败都写进 输出 → Pretty Commit（`挂芯片成功：<命令名>` / `挂芯片失败 <命令名>: …`）。

- 相关设置：
  - `prettyCommit.wholePromptDelta`：默认 `1000`，整笔分析超过该 Δ 才先提示。
  - `prettyCommit.filePromptLines`：默认 `500`，单文件 diff 超过该行数才先提示。
  - `prettyCommit.recentCommitCount`：默认 `25`，「打开提交…」默认列出的最近提交条数（列表底部可「加载更多」）。
  - `prettyCommit.addToChat`：**只管选区 Ctrl+L 那条路**。`input`（默认，内容填进输入框）/ `context`（挂成上下文芯片，需已有 chat）/ `both`。整笔/单文件分析固定走「芯片优先、失败退回输入框」，不受此项影响。
  - `prettyCommit.hideUnchangedFiles`：默认 `true`，省略纯重命名/权限变更这类 Δ=0 的文件。
  - `prettyCommit.moveToNewWindow`：默认 `false`，尝试把面板弹成独立 OS 窗口（见「弹窗模式」）。

## 开发 / 安装

```bash
# 调试：F5（.vscode/launch.json 已配好），或
code --extensionDevelopmentPath=/home/liudayi/gitProj/vscode-tools/git-commit-analysis

# 打包（本机 npm registry 不通，vsce 装不上 → 用仓库内的脚本手工打 VSIX）
python3 scripts/build-vsix.py

# 安装
cursor --install-extension pretty-commit.vsix --force

# 装完必须让正在运行的窗口重新加载扩展宿主代码：
#   Ctrl+Shift+P → Developer: Reload Window
# （panel.html 是每次开面板现读的，所以只改页面不用重载；见上一节）
```

## 图标

`images/icon.png`（512×512，`package.json` 的 `icon` 字段）由 `assets/gen_icon.py` 生成 —— 高分辨率渲染后 LANCZOS 降采样，所以 128px 下依旧清晰：

```bash
python3 assets/gen_icon.py          # 重新生成 icon.png / icon128.png / icon256.png
```

设计：深色编辑器卡片里，左侧是提交图（竖线 + 两个提交节点，蓝点是当前打开的那个），右侧是 diff 行（灰=上下文、红=删除、绿=新增，条上挖出 `−`/`+`），右上角一个星芒代表按需 AI 分析。卡片风格与 `word-cycle-highlight` 一致，两个扩展看起来是一套。

想看它在深/浅主题、各尺寸下的效果：`assets/_preview.png`（脚本每次都会重新生成，不进 VSIX）。

## 改了 extension.js 为什么不生效：宿主只在窗口启动时加载一次

这是本扩展最容易浪费时间的坑，先看这里：

- **宿主机代码**（`extension.js`、`src/*.js`、`package.json` 的命令/快捷键/配置）只在**窗口启动**时 `require` 一次。装完新 VSIX 后，正在运行的窗口仍然执行**旧代码**，`Alt+Q` 打开的还是老行为。
- **页面**（`media/panel.html`）是**每次开面板时从磁盘现读**的。所以会出现「页面是新版、宿主是旧版」这种半新半旧的状态：新键位（页面里监听的 `Ctrl+L`）能触发，但它发出的消息宿主不认识，于是表现为「弹出了 Chat 但里面没内容」。
- 判定方法：面板底部会显示 `宿主 <版本 (时间)>`；如果显示 **宿主 旧版(未重载)**，并且顶部出现黄色诊断条，就说明宿主是旧版 —— 点诊断条上的「重载窗口」，或 `Ctrl+Shift+P` → `Developer: Reload Window`。
- 诊断条依赖页面主动向宿主追问版本（`hostBuild` 消息）：旧宿主不认识这条消息、不会回，页面 800ms 后自己判定并提示。

一句话规则：**改了 `package.json` / `extension.js` / `src/*.js` → 装完必须 Reload Window；只改 `media/panel.html` → 重开面板即可。**

## 为什么默认嵌在编辑器里（而不是弹独立窗口）

上一版把面板弹成独立 OS 窗口（`workbench.action.moveEditorToNewWindow`），绕不开一个结构性死结：

**结构**：该命令会**新建一个窗口**来显示面板，而 `extension.js` 所在的**扩展宿主仍留在原窗口**。于是所有 `vscode.commands.executeCommand`（包括打开 Chat）都作用在**原窗口**上 —— Chat 一出现就把原窗口带到前台，面板那个窗口被压到后面。两个 OS 窗口，同时只能有一个在最前面。

**补救过，但只是补救**：宿主没有任何 API 能聚焦另一个 OS 窗口（`vscode.window` 里没有焦点接口；工作台内部只有主进程侧的 `nativeHostService.focusWindow`，扩展拿不到）。webview 里调 `window.focus()` 实测无效（`visibility=visible focused=no`：窗口在、键盘焦点不在 —— iframe 没有 user activation，浏览器不允许它给自己的 OS 窗口抢焦点）。最后只能直接对 X server 发 `_NET_ACTIVE_WINDOW`（见下面「弹窗模式」）—— 能用，但每送一次 Chat 就要在两个窗口之间抢一次焦点，始终别扭。

**所以改成不分成两个窗口**：面板默认嵌在编辑器里（`prettyCommit.moveToNewWindow` 默认 `false`），和 Chat 共处同一个 OS 窗口，用**分栏**让 diff 与 AI 回答同屏。

```markdown
| 时机 | 动作 | 实现 |
|------|------|------|
| `Alt+Q` 打开面板 | 单独占一栏：左代码 / 右 diff | `createWebviewPanel(..., ViewColumn.Beside)`（`prettyCommit.openBeside` 默认开） |
| `Ctrl+L` 送 Chat | Chat 开在**与面板不同**的分栏，两边同屏可见 | 若 Chat 开在了面板那一栏，用 `moveEditorToLeftGroup` / `moveEditorToRightGroup` 把它挪到面板另一侧 |
| 送完 Chat | **什么都不做**（不抢焦点） | 同一个窗口里不存在「被压到后面」，抢焦点只会妨碍你往输入框打字 |
| `Alt+Shift+Q` | 面板被别的标签页盖住时切回它 | 只在自己那一栏里激活标签页，不搬动分栏 |
```

### 分栏定位：为什么不能随便调 `reveal(undefined)`

`WebviewPanel.reveal()` 传 `undefined`（或 `ViewColumn.Active`）时，主线程的实现是：

```
$reveal(handle, { viewColumn, preserveFocus })
  → getTargetGroupFromShowOptions: typeof viewColumn === 'undefined' → 返回 ACTIVE_GROUP
  → revealWebview: editorService.openEditor(editor, {...}, 目标栏)
```

也就是说它是「**打开到当前活动分栏**」—— 是**搬家**，不是「把标签页翻到前面」。危害有两个：弹窗模式下会把面板从新窗口拖回原窗口（旧 bug「送完 Chat 窗口就消失」）；嵌入模式下会把面板搬到 Chat 那一栏、盖住 Chat。

所以现在先用 `vscode.window.tabGroups` 查出面板自己在哪一栏（`TabInputWebview.viewType === 'prettyCommit'` 能唯一认出我们的标签页），再 `reveal(它自己那一栏)` 只激活标签页；送 Chat 前也先判断「Chat 是不是真的开在面板那一栏」，是才挪 —— 不乱动你的布局。老版本没有 `tabGroups` API 时**不猜**：不搬动任何分栏，只在日志里写一行说明。


## 占满编辑区（默认开）

面板默认不是「半屏」，也不是「旁边切一栏」，而是**展开占满整个编辑区**：其它编辑器分栏缩到最小（不关闭、不隐藏侧边栏、不动 Chat 所在的辅助栏），需要时点一下它们就回来。

扩展 API 没有「展开/最大化某个分栏」的能力，所以走的是命令 + 内部布局服务。Cursor 里那几个命令的实现（bundle 里 `editorGroupsService`）是：

```javascript
arrangeGroups(e, t = this.activeGroup) {
  if (this.count < 2 || !this.gridWidget) return;   // 只有一栏 → 直接 no-op
  const n = this.assertGroupView(t);
  switch (e) {
    case 2: this.gridWidget.distributeViewSizes(); break;  // "Reset Editor Group Sizes"
    case 0: …maximizeView(n)…; break;                      // 隐藏其它栏（Toggle Maximize Editor Group）
    case 1: this.gridWidget.expandView(n); break;          // "Expand Editor Group"
  }
}
```

由此定下三条：

- **用 `minimizeOtherEditors`（"Expand Editor Group"，`arrangeGroups(1)`）**，不用 maximize：maximize 那条路（`maximizeEditorHideSidebar`）会把侧边栏和 Chat 所在的辅助栏一起隐藏，而我们要的就是和 Chat 并排看。
- **它只作用于活动分栏**（命令没法传目标栏），所以先 `reveal(面板自己那一栏, preserveFocus=false)` 把面板那栏设为活动栏，再展开。日志里 `分栏（展开后）` 那一行前面带 `*` 的就是活动栏，可以直接核对。
- **单栏时不调用**：命令的 precondition 就是 `multipleEditorGroups`，而单栏本来就已经占满（`arrangeGroups` 自己也会 return）。

送 Chat 时有个必须做对的动作：**先恢复等宽，再挪 Chat**。因为 `addGroup` 里有这么一段（展开状态下新建的分栏会「继承」展开）：

```javascript
const o = this.groupViews.size > 1 && this.isGroupExpanded(i);
… o && this.arrangeGroups(1, r);   // 新栏也变成展开的那一栏
```

如果直接挪，结果就是 **Chat 占满、面板被挤成一条缝**，正好搞反。所以顺序是：`evenEditorWidths`（"Reset Editor Group Sizes" → `distributeViewSizes`，展开状态随之解除）→ 挪 Chat → 用 `preserveFocus=true` 把面板标签页翻到它那一栏最前（**不抢键盘焦点**，此时你正要去 Chat 输入框里打字）。

```markdown
| 设置 | 默认 | 说明 |
|------|------|------|
| `prettyCommit.fillEditorArea` | `true` | 打开提交时展开面板分栏占满编辑区 |
| `prettyCommit.chatBesidePanel` | `true` | 送 Chat 时先恢复等宽、再把 Chat 挪到面板另一侧 |
| `prettyCommit.openBeside` | `true` | 只在 `fillEditorArea=false` 时有意义：面板开在旁边分栏而不是占用当前分栏 |
```

补充两点：

- 想**真正全屏**（把其它分栏整个藏起来，而不是缩到最小），用编辑器标题栏上的「最大化编辑器组」图标，或命令面板的 `View: Toggle Maximize Editor Group`（`workbench.action.toggleMaximizeEditorGroup`）。面板不影响这个开关，两者可以叠着用。
- 展开是我们自己记的状态（`panelExpanded`），因为扩展侧查不到「某栏是否展开」。你手动拖分隔条或用命令面板改了布局也不会出错：展开是**幂等**的（对已展开的栏再展开等于没做），恢复等宽同样是确定性操作。


## 弹窗模式（`prettyCommit.moveToNewWindow=true`，非默认）

仍然保留弹独立窗口的能力（比如你想把 diff 丢到第二块屏幕）。这时才需要「抢前台」这套机制 —— 它是扩展在跨窗口场景下唯一能动的手。这条路上不会去展开宿主窗口的分栏（面板马上要搬到别的窗口，展开没意义）。

```
[info] 面板已请求窗口聚焦（popout-retry） [visibility=visible focused=no]
[info] 面板已请求窗口聚焦（after-chat）  [visibility=visible focused=no]
```

`visibility=visible focused=no` 说明「窗口在、键盘焦点不在」，而 `window.focus()` 抬不动它：webview 是 iframe，没有 user activation，浏览器不允许它给自己的 OS 窗口抢焦点。

**现在改成直接对 X server 发 EWMH 请求**：随包附带的 `scripts/x11-raise.py` 用 python3 标准库 `ctypes` 调系统 `libX11`（有 `xprop` 的机器必然有），对根窗口发 `_NET_ACTIVE_WINDOW`（`data[0]=2` 表示来源是 pager，绕过焦点窃取保护），再补 `XRaiseWindow` + `XSetInputFocus`。不需要 `xdotool` / `wmctrl`。

定位「哪个窗口是面板」用两种办法，优先前者：

- **弹窗前后取窗口 id 差集**：`x11-raise.py ids` 在 `moveEditorToNewWindow` 前后各取一次，差集就是新窗口的 id，之后一直用这个 id（此时页面可能还没加载完、拿不到提交标题，差集法不依赖标题）。
- **按标题匹配**：面板窗口标题里含 `activeEditorShort`，也就是我们设的 `p.title`，用提交的 `shortSha` 去匹配最稳。

```markdown
| 时机 | 谁触发 | 说明 |
|------|--------|------|
| 弹窗成功后 | 宿主 `requestRaise` | 新窗口是刚建出来的，焦点常还在原窗口；实测 GNOME/mutter 会拒绝第一次请求，第 2 次（退避 400ms）才接受，所以内置重试 |
| 每次 Alt+Q | 宿主 `requestRaise` | 复用的面板可能正被盖着 |
| 送完 Chat | `refocusPanelAfterChat`（默认开） | Chat 会把原窗口带到前台，这里再把面板抬回来 |
| `Alt+Shift+Q` | 手动 | 一键把面板叫回前台 |
```

`prettyCommit.focusWindow`（默认 `auto`）控制置前手段；设成 `off` 则完全不尝试，只用 `Alt+Shift+Q` 手动叫。宿主环境没有 `DISPLAY`（远程 SSH、纯 Wayland）时会自动跳过并在日志里写一行原因。
**「送完 Chat 窗口就消失了」是旧版的一个独立 bug，已修**：对**已经弹到独立窗口**的面板调 `reveal(undefined)`，会把面板**拖回原窗口的活动组**（原因见上面「分栏定位」一节）：独立窗口随之空掉/关闭、面板对象被 dispose、webview 重建（日志里就是 `panel disposed` + `重新下发当前提交（resync）`）。所以用 `poppedOut` 标记区分：弹出后**绝不**调 `reveal`，只发 `raise`。

页面在每次 `raise` 后回报 `{ visibility, focused }`，宿主写进输出通道，用来区分两种失败场景：

```markdown
| 日志样子 | 含义 | 对应处理 |
|---------|------|---------|
| `visibility=visible focused=no` | 面板在另一个窗口里，那个窗口被压在后面 | X11 置前（`scripts/x11-raise.py`） |
| `visibility=hidden` | 面板被**同一个窗口**里的别的标签页盖住 | 在它自己那一栏激活标签页（`revealPanelInPlace`） |
| `X11 置前成功（…）win=0x…` | `_NET_ACTIVE_WINDOW` 被 WM 接受，窗口确实到前台了 | 正常 |
| `X11 置前被 WM 拒绝` | 重试若干次后 WM 仍不接受 | 降到用 `Alt+Shift+Q` 手动叫 |
| `不做窗口置前：…` | 环境不支持（无 DISPLAY / 非 Linux / 设置成 off） | 按提示处理 |
| `Chat 没有开在面板那一栏（分栏布局不变）` | 嵌入模式下 Chat 本来就没盖住面板 | 不动布局 |
```
## 限制（第一版）

- `scm/historyItem/context` 是 **proposed API**（需 `enabledApiProposals` 声明，且要新版核心支持 SCM Graph 历史条目）。不可用时右键菜单不出现——不影响命令面板三个入口。
- 弹独立窗口（`prettyCommit.moveToNewWindow=true`）依赖 `workbench.action.moveEditorToNewWindow` 在面板聚焦时执行一次；失败自动留在原窗口，不报错（第一次失败会提示一条警告）。默认不弹窗，所以正常使用遇不到这条。
- 弹成独立窗口后 VS Code 会在新窗口**重建 webview**：宿主收到 `webview-ready` 时会把当前提交**补发**一次（`resyncState`），所以新窗口不会停在空页面；探活 ping 也改为多次重试，避免把冷启动中的新 webview 误判成白窗。（仅弹窗模式）
- `webview.dispose()` 之后再读 `panel.webview` 这个 getter 会**抛异常**（"Webview is disposed"）而不是返回 `undefined`，`panelAlive()` 已用 try/catch 兜住；否则「整笔分析」在面板已关闭时会把异常抛到 Output 之外的日志里。
- 页面在**没有收到任何数据**时显示「还没有收到提交数据」，与「这个提交确实没有文件改动」区分开：前者是通信问题，后者顶栏会显示 sha/subject 和 `Δ=0`。
- merge 提交显示**相对第一父提交**的差异（界面有注明）；二进制只列名不展开。
- 「无内容变化」的文件（纯重命名 / 仅权限变更）默认不列，`prettyCommit.hideUnchangedFiles` 可关。**旧宿主不会过滤**，所以页面侧还做了一层兜底过滤（判据：新宿主一定会带 `hiddenUnchanged` 字段），保证「省略 N 个无内容变化文件」在任何宿主版本下都对得上。
- `composer.addsymbolstocomposer` / `chat.addToChat` 是 Cursor 内部命令，未见于公开 API，且**成功与否无法从外部探测**（它是静默 no-op 而不是抛错）。所以：**选区**那条路默认走 `input`（内容一定进输入框），想用芯片就把 `prettyCommit.addToChat` 设成 `context`；**整笔/单文件分析**那条路固定「芯片优先、失败退回输入框」，并始终把完整文本放剪贴板兜底 —— 用 `Ctrl+Shift+P` → `Developer: Reload Window` 触发一次，然后在 输出 → Pretty Commit 里看 `挂芯片成功/失败` 判断走了哪条路。
- 窗口置前（仅弹窗模式用）只能走 X11（`scripts/x11-raise.py`）：Wayland 原生窗口拿不到 X 窗口 id（除非在 XWayland 里），macOS/Windows 没实现；这些环境下退回「`Alt+Shift+Q` 手动叫」。另外置前依赖 `python3` + `libX11`，缺任一则自动跳过（日志会写原因），连续失败 3 次后本次窗口内不再尝试并提示一次。
- 宿主的每条命令都作用在**它所在的窗口**，所以弹窗模式下「打开 Chat」必定把原窗口带到前台 —— 这是 VS Code 的窗口模型决定的，面板能回来靠的是上面那套 X11 置前。嵌入模式（默认）没有这个问题。
- 嵌入模式下「Chat 与面板分屏」依赖 `vscode.window.tabGroups` + `moveEditorToLeft/RightGroup`：前者用来确认面板在哪一栏（还用来避免 `reveal(undefined)` 乱搬家），后者在缺少相邻分栏时会新建一栏。两者都不可用/不适用时（老版本核心、或 `chatBesidePanel=false`）退化为「Chat 与面板同一栏，用标签页切换 + `Alt+Shift+Q`」。
- 「占满编辑区」依赖 `workbench.action.minimizeOtherEditors`（"Expand Editor Group"）：它只作用于活动分栏，且 precondition 是 `multipleEditorGroups`（单栏时本来就已经占满，跳过）。它把其它分栏缩到**最小而不是隐藏**——想彻底藏起来请用编辑器标题栏的「最大化编辑器组」图标（`workbench.action.toggleMaximizeEditorGroup`），本扩展不碰这个开关。
- 快捷键本身是 `package.json` 静态声明的，扩展无法在运行时改写：想换键用命令面板 `Pretty Commit: 修改快捷键…` 打开界面双击改（写入用户 `keybindings.json`），或手写覆盖。另外终端聚焦时按键默认会发给 shell，需要 `terminal.integrated.commandsToSkipShell` 里有本扩展的命令（有现成命令一键补上，见「改快捷键」一节）。
- 不做 split diff / blame / 提交图节点 / 每 hunk 自动 AI。

## 验收清单

1. SCM 历史右键（或命令面板）能打开大窗口并显示文件列表 + diff。
2. 默认**不弹独立窗口**：面板嵌在同一个窗口里、单独占一栏（左代码 / 右 diff），原编辑器仍在。
3. `j/k/Enter` 切文件、折叠；拖选若干行按 `Ctrl+L`（或右下角按钮）能把代码加进 Chat 上下文。
4. 有选区时右下角按钮显示「（N 行选区）」并高亮；无选区时按 `Ctrl+L` 送当前 hunk。
5. 标题栏有「整笔分析」「本文件分析」两个按钮，**没有开关**；打开窗口不自动分析、不自动发送。
6. 按 `Shift+A` 整笔分析：Δ 小时直接在 Chat 里生成「短提问 + diff 芯片」（输入框是提问，芯片在输入框上方）；Δ 超过 `wholePromptDelta` 时先弹「代码量较大」确认，取消则不送。
7. 按 `Shift+F` 单文件分析：只针对当前文件，形态同上；单文件 diff 超过 `filePromptLines` 时先弹确认。
8. 分析时输入框**不应**被 diff 正文占满；输出 → Pretty Commit 里有 `挂芯片成功：composer.addsymbolstocomposer`。
9. 把 `prettyCommit.addToChat` 设成 `context` 后按 `Ctrl+L`，选区同样挂成芯片（说明芯片链路在你机器上可用）。
9. 输出 → Pretty Commit 里能看到「送 Chat 成功：<命令名>」，能判断走了哪一级降级。
10. 顶栏文件数是 `显示数/总数`，并有「省略 N 个无内容变化文件」；关掉 `prettyCommit.hideUnchangedFiles` 后两数相等。
11. `prettyCommit.addToChat=input`（默认）时，`Ctrl+L` 后 Chat 输入框里能看到 diff 与提问（而非空对话框）。
12. 弹出独立窗口时，日志里出现 `X11 置前成功（…）win=0x…`，且那个窗口真的跳到前台（`_NET_ACTIVE_WINDOW` 变成它）。
13. 弹窗窗口被别的窗口盖住时，`Alt+Shift+Q` 能把它叫回前台；`prettyCommit.focusWindow=off` 时日志写 `不做窗口置前：focusWindow 设置为 off`，且不再尝试。
14. 嵌入模式下 `Ctrl+L` 后 Chat 出现在**面板旁边**的那一栏（两栏同屏），且**面板没有被搬到 Chat 那一栏**；日志里有 `已把 Chat 挪到面板左/右侧的分栏`。
15. `Ctrl+L` 之后焦点在 Chat 输入框里（可以直接打字），面板不会抢焦点；再按 `Alt+Shift+Q` 面板在自己那一栏被切到最前。
16. 把 `prettyCommit.chatBesidePanel` 设为 `false` 后，`Ctrl+L` 不再挪动任何分栏（Chat 与面板同栏，标签页切换）。
17. 打开提交后面板**占满编辑区**（其它分栏缩到最小）；日志里 `已展开面板分栏、占满编辑区（open）`，紧接着的 `分栏（展开后）` 行中带 `*` 的那一栏就是面板所在栏。
18. 只有一个编辑器分栏时打开面板：不报错、日志也不出现展开动作（单栏本来就是占满）。
19. 展开状态下按 `Ctrl+L`：日志先出现 `已恢复等宽分栏，便于 Chat 与面板同屏（place-chat）`，再出现挪 Chat —— 结果是面板与 Chat 各占一栏，**不是** Chat 占满、面板缩成一条缝。
20. 把 `prettyCommit.fillEditorArea` 设为 `false` 后，打开面板不再展开（面板只是普通分栏，宽度自己拖分隔条）。
21. `Alt+Q` 在**编辑器、侧边栏、Chat、终端**里都能弹出提交列表（终端需先执行一次「让快捷键在终端里也生效」）；`输出 → Pretty Commit` 里有 `快捷键触发：打开提交选择器`。
22. 连按两次 `Alt+Q` 只出现一个选择框（不会叠两层）。
23. 选择框最后一项是 `修改快捷键…`，选中后打开「键盘快捷方式」并已筛选 `prettyCommit`。
24. 执行「让快捷键在终端里也生效」后，设置里出现 `terminal.integrated.commandsToSkipShell` 含 `prettyCommit.pickCommit`；再执行一次不重复添加。
25. `prettyCommit.recentCommitCount` 改成 50 后，`Alt+Q` 列表变长；列表底部出现「加载更多提交…」，点它条数翻倍继续往后列（提交很多的仓库能一直翻）。
26. 点「加载更多提交…」只是翻页，不会误打开某个提交。
