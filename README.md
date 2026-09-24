# Pretty Commit

SCM 提交历史右键 → 大窗口看 diff；AI 分析**按需点击**（整笔 / 单文件），打开窗口零 Token；框选随时送 Chat。第一版实现照 `pretty_commit_ui_093cb708.plan.md`，纯 JavaScript、无构建、不进任何现有仓库。

## 触发方式

| 入口 | 说明 |
| --- | --- |
| `Alt+Q` | 快捷键，直接弹「打开提交…」列表（默认最近 25 条，条数可配、可加载更多）。不带 `when`，全窗口生效；**终端聚焦时要先执行一次「让快捷键在终端里也生效」**（见下「改快捷键」） |
| `Alt+Shift+Q` | 把 diff 标签叫回前台（被 Chat 或别的标签页盖住时用）；多开时逐个处理 |
| Source Control → 提交历史（SCM Graph）条目右键 `Pretty Commit: 查看此提交` | 主入口，需新版核心的 proposed 菜单（见下「限制」） |
| 命令面板 `Pretty Commit: Open HEAD（最近提交）` | 兜底，一键看 HEAD |
| 命令面板 `Pretty Commit: 打开提交…` | 兜底，列表里挑一个（底部可「加载更多」，见 `prettyCommit.recentCommitCount`） |
| `Ctrl+L` / 命令面板 `Pretty Commit: 把选中的 diff 加进 Chat` | 面板聚焦时把选区加进 Chat，见下节 |

打开后**嵌在当前编辑器窗口**里，并**展开占满整个编辑区**（`prettyCommit.fillEditorArea`，默认开），和 Chat 同处一个窗口。再按一次 `Alt+Q` 打开另一笔时，不会覆盖前一笔：**每个 diff 占一个 Cursor 编辑器标签**（一个 diff 一个 `WebviewPanel`），能拖到别的分栏、能左右摆两笔一起看（见下「多标签」）。想把 diff 丢到独立 OS 窗口就设 `prettyCommit.moveToNewWindow=true`（见下「弹窗模式」）。

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

标题栏：短 SHA + subject + `Δ=N`；右侧 `≡` 收起列表、`↑`/`↓` 上下改动、`P`/`N` 翻文件、`¶` 符号差异、`◐` 配色、`↻` 重读、缩放、`本文件分析`、`整笔分析`、`关闭`。**没有开关、也不自动发送** —— 点按钮或按快捷键才分析。

```markdown
| 按键 | 作用 |
| --- | --- |
| `←` / `→` 或 `P` / `N` | 上一个 / 下一个文件 |
| `↑` / `↓` 或 `[` / `]`（顶栏 **↑↓**） | 上一个 / 下一个**改动块**；本文件走完自动进相邻文件 |
| `s`（顶栏 `◫`） | 单页 / **双页对比**切换（左旧右新并排），状态会记住 |
| `i`（顶栏 `¶`） | 忽略 / 显示「只差符号」的改动（换行符、行尾空白、文件末尾换行），见下一节 |
| `t`（顶栏 `◐`） | diff 配色：跟随编辑器 → 强制 Gerrit Light → 强制 Gerrit Dark 循环，状态会记住 |
| `d`（`◐` 上 **Shift+点击**） | 色带深浅：**淡（Gerrit 原色）→ 标准 → 浓** 循环，状态会记住。只换类、不重算 diff |
| `o`（diff 头右上「打开文件 ↗」） | 一键跳到**原文**：工作区 diff 打开磁盘文件并定位到视口顶端那一行；历史 commit 打开该提交那一刻的只读快照 |
| **点行号** | 跳到**这一行**（精确到行）：工作区 diff 开可编辑的真实文件；历史 commit 开只读快照，`Alt`+点则去开工作区文件。详见「精确跳行」一节 |
| `r`（顶栏 `↻`） | **重读 diff**：文件在别处被改过 / 刚存盘 / 刚 `git add` 时用。`Shift+R` = 重读所有 diff 标签 |
| `e`（diff 头「展开全文」） | 把 git 省略的未改源码补进 **diff 区**（红绿行还在原位）。缝上的条是展开中间 / 文件头 / 文件末尾。`E` 收起。左侧再点文件仍是收起整份 diff，两套手势不绑在一起 |
| `x` | 关掉这个 diff 标签（= 关掉这个 Cursor 标签页） |
| `b`（标题栏 ≡） | 收起 / 展开左侧文件列表 |
| `+` / `-` / `0`（标题栏缩放、Ctrl+滚轮） | 放大 / 缩小 / 复位 diff 字号 |
| `Ctrl+L` / `c` / 右下角「＋ 添加到 Chat」 | 把选区加进 Chat（无选区则送当前 hunk）。底栏不再提示这条，避免占位 |
| `Shift+A` | 整笔分析 |
| `Shift+F` | 本文件分析 |
| `Esc` | 关闭 |
```

`Alt+Q` 列表**最上面**三项是工作区 diff（`git diff HEAD` / `--cached` / 未暂存），下面才是最近提交。命令面板另有 `Pretty Commit: 查看工作区改动（git diff）`。

每次按 `Alt+Q` 打开都会把面板展开到占满编辑区（见「占满编辑区」）；送 Chat 时会自动恢复等宽分屏。缩放档位、列表宽度和是否收起记在 `globalState` 里。

## diff 视图：Gerrit 配色

diff 区**两套主题**（Gerrit Light / Gerrit Dark）：底色 / 正文 / 注释基线取自 Gerrit 官方色板，语法 token 另用一套更克制的柔和配色（原因见下）。默认**跟着编辑器走**（深色主题 → Gerrit Dark，浅色 → Gerrit Light），随编辑器换主题实时切换。顶栏 `◐`（快捷键 `t`）可以强制成某一套，也可以交给设置 `prettyCommit.diffTheme`。改的只是 diff 区，顶栏 / 左侧文件列表 / 底栏始终跟 VS Code 主题。

这套配色还有一个**独立的轴：红绿色带的深浅**，三档 `淡 / 标准 / 浓`（默认 `标准`）。

为什么默认不是官方原色：Gerrit 官方给的 `ADD background` 是 Material 的 50 号色，**整行铺满时确实太淡** —— 它和白底的对比只有 **1.10 / 1.14**（`#D8FED8` / `#FFEBEE`），几乎看不出色带。所以官方那组留作 `淡` 档（喜欢原汁原味的可以选），默认走 `标准`（浅色 `#ADF5AF` / `#F9D5DB`；深色 `#25623C` / `#97211E`）。三档的**色相都钉在 Gerrit 原值上**（浅色绿 120°、红 353°；深色绿 140°、红 1°），只动亮度和彩度 —— 换档不会变成另一种绿。

**红绿必须「观感等重」，判据是 OKLab 的感知亮度，不是相对亮度**。这一点踩过两次坑，值得记下来：

- 按**相对亮度相等**去配（两行与底色的对比度一样）：浅色里绿得压到 `L≈73` 才追上粉的亮度，那一档绿直接成了荧光色 —— 因为同样的感知亮度下，绿的相对亮度天生比红高一大截。结果是绿行像荧光笔、红行正常。
- 干脆**只加深绿**（认为官方红已经够重）：出一版是绿 1.32 / 红 2.11，红行一片荧光、整体很脏。
- 现在按 **`ΔL(OKLab) < 0.006`** 解，两档加深值都是「感知亮度相等」。另外彩度**按各自官方的 `C` 等比放大**（官方浅色绿 `C=0.064`、红 `C=0.022`，本来就是 ~2.9 : 1），保住 Gerrit 自己定下的红绿平衡，不让某一方独自放飞。

深浅不是随手挑的，是被这几条硬约束解出来的（`assets/pc-lineno-test.js` 会把「三档 × 两主题」6 种组合逐个复算）：

```markdown
| 约束 | 下限 | 为什么 |
| --- | --- | --- |
| 色带上的正文对比 | ≥ 4.5 | 这是「加深」的**上限**：再深字就糊。深色主题先撞上它 |
| 色带上的 `+` `-` 符号 | ≥ 4.5 | 单独一列、字号最小，最不能糊 |
| 色带上的注释 | 浅色 ≥ 4.0 / 深色 ≥ 3.1 | 不比 Gerrit 原注释色更差 |
| 行号列上的行号 | ≥ 4.5 | 行号列中性，判据是 `--ln-fg` 压 `--gutter-bg`（浅 5.74 / 深 5.43） |
| 三档的存在感 | 逐档上升 | 调档必须真的有区别 |
| 加深两档的绿红感知亮度 | `ΔL(OKLab) < 0.006` | 观感等重，不能一行重一行轻 |
| 加深两档的彩度比 | 与官方偏差 < 12% | 保住 Gerrit 自己的红绿平衡 |
```

**加深色带不是改一个色号就完事**：色带一变深，落在它上面的东西就全得重配。同一色系里前景和背景不能同时变深 —— 试过把深红 `-` 号留在加深后的红脊上，只剩 **2.83:1**。所以 **`+`/`-` 符号、注释**都被纳入档位一起解。

```markdown
| 元素 | 含义 |
| --- | --- |
| 左列行号 | 旧文件行号；**新增行没有它** |
| 右列行号 | 新文件行号；**删除行没有它** |
| 行号列底色 | 上下文行的 gutter；比正文略暗，把 gutter 和代码分成两层 |
| 新增行 | **符号列 + 代码区是同一条均匀色带** = `ADD background` 的**加深版**（`标准` 档：浅色 `#ADF5AF` / 深色 `#25623C`；`淡` 档才是官方 `#D8FED8` / `#2C553A`）。**行号列不染** |
| 删除行 | 同上，符号列 + 代码区 = `DEL background` 的**加深版**（`标准` 档：浅色 `#F9D5DB` / 深色 `#97211E`）。**行号列不染** |
| 行号列 | **任何行都是同一个中性灰底**（`--gutter-bg`），增删行也不例外 —— 色带不铺到行号上，扫行号时不受绿/红干扰 |
| `+` / `-` 符号 | 单独一列、加粗、**不可选中**（复制代码不会带上前缀）；颜色随档位走（压在色带上必须 ≥ 4.5）。它是这一列唯一的标识 —— 底色跟代码区一样，不靠第二条色带区分 |
| 注释（白底 / 上下文行） | `Comment` 色（浅色 `#6E7781` / 深色 `#8B949E`）斜体 |
| 注释（增删行上） | 另给一色（`--cmt-on-tint`）。中性灰是**中间调**，压在加深后的色带上会糊（`淡` 档就只有 ~4.9，加深后更低），所以按档位重新解一个压得住色带的版本 |
| 代码区左边蓝条 | 当前用 ↑/↓ 定位到的那个改动块 |
| Hunk 头 `@@ … @@` | 中性灰底，左边距对齐到代码列 |
| 暗色 `\ No newline at end of file` | 不占行号 |
```

**只有一条色带，没有「色脊」了**：Gerrit 官方色板里 `background` / `highlight` 是一对，早先的实现拿 highlight 色给「行号列 + 符号列」另铺了一条更深/更亮的竖带（色脊）。现在这条拆掉了 —— **符号列和代码区是同一个底色**（符号列的底色直接 `background: inherit` 整行的色带），一行从符号列到代码末尾是一条**均匀的色带**，`+` / `-` 靠符号本身的颜色识别。符号列右侧那条 1px 分隔线也跟着透明掉，否则色带上会多出一条灰线。

**色带不铺到行号上**：行号列（`--gutter-bg` / `--ln-fg`）在任何行都是同一套中性色 —— 增删行的行号列**不跟着染绿/红**。这样左边那一竖条永远是稳定的灰，扫行号 / 看上下文的行号都不受色带干扰，色带只从符号列开始。符号列虽然 `sticky`（横向滚动时正文要从底下滑过去，底色必须不透明），但用的是 `inherit` 而不是另给一个色 —— 不透明这点天然满足，也不会出现第二种颜色。`assets/pc-lineno-test.js` 里有两条结构断言盯着这件事（行号列不许引用 `--add-bg` / `--del-bg`；符号列必须是 `background: inherit`）。

**为什么整行是平涂、不用渐变**：一行是一个 `div`，连续多行各自画一次渐变，接缝处会看出**一条条横纹**（越长的改动块越像百叶窗）。之前试过「半透明 + 顶部高光」的玻璃方案，就是这个毛病，已回退。精致感交给 `+` / `-` 符号和语法着色，不交给渐变。

深色主题下有个容易踩的坑：配色类必须在**第一次绘制之前**挂到 `body` 上，否则会先闪一下白底 diff 区。所以 `media/panel.html` 的 `<body>` 开头有一段「主题先行」小脚本（读 VS Code 注入的 `--vscode-editor-background` 算亮度），后面 `applyTheme()` 复用它 —— 亮度判断全文件只有一份实现，`assets/pc-lineno-test.js` 里有这条断言。同一段脚本里顺手挂上默认的深浅档（`i-standard`）：不挂的话第一帧的行底色是空的，会闪出一下**没有色带**的 diff。

细节：

- 正文**保留 `+` / `-` 前缀**（上下文行是一个空格，与 git 输出一致）—— 底色负责一眼看出增删，前缀负责逐行确认。
- 行号从 hunk 头的 `@@ -a,b +c,d @@` 逐行推出来，每个 hunk 各自重新起算；列宽按本文件最大行号位数自适应（`--ln-w: digits × 7px + 4px`），短文件不会白白很宽。
- 左侧文件列表默认 220px，**中间那条竖线可以拖**（宽度会记住）；`b` 可以整个收起。
- 代码默认 **Semibold（600）**、近黑 `#0b0d10`；行号保持 Regular。字体默认走主流等宽栈（JetBrains Mono → Cascadia Code → Fira Code → Source Code Pro → 系统等宽），可在设置里改：
  - `prettyCommit.diffFontFamily`：`popular`（默认）/ `editor`（跟编辑器走）/ `jetbrains` / `cascadia` / `fira` / `ibm` / `source`
  - `prettyCommit.diffFontWeight`：默认 `500`；可选 `400` / `550` / `600`
  - `prettyCommit.diffFontSize`：diff 基础字号 px（默认 `13`）；顶栏 ± 是在此基础上缩放
  - `prettyCommit.diffForeground` / `prettyCommit.diffBackground`：正文色 / 区背景（留空则按当前主题取 Gerrit 的 `Text` / `Background`）
- diff 区 **Ctrl+点击** 跳转定义、**Alt+点击** 查找引用（**F12** / **Shift+F12** 需先选中标识符）：走工作区真实文件 + 已安装的语言服务（clangd、TS 等）。**工作区 diff** 行号与磁盘一致；**历史 commit** 按 diff 行号对应当前文件，可能与当时版本不一致。
- 注释（`//` `#` `/* */` `<!-- -->` `--`）渲染成 `Comment` 灰斜体（浅色 `#6E7781` / 深色 `#8B949E`）。白底行上就用这个值；**增删行上会自动换成 `--cmt-on-tint`**（按档位解出来的、压得住色带的版本），因为中性灰压在加深后的绿/红带上会糊。字符串里的 `http://`、Python 的整除 `//` 不会被当成注释。`#` 系风格除了按扩展名（`.py` `.sh` `.yml`…），也按文件名认 `Makefile` / `CMakeLists.txt` / `.env` / `.bashrc` 这类没有可识别扩展名的文件。关掉：`prettyCommit.colorComments`（与 `prettyCommit.syntaxHighlight` 相互独立，关掉语法着色时注释仍然保留）。
- **语法着色**：一套**克制的柔和配色**，两套主题各一份。刻意**不用 Gerrit 那套 CodeMirror token 色** —— 那套饱和度太高（关键字品红、字符串纯蓝），铺在绿/红加色带上会和底色打架，整片代码看着很花。
  - 浅色：关键字 `#0550AE`、内置类型/宏 `#953800`、数字 `#0550AE`、字符串 `#0A3069`、函数名 `#8250DF`、成员访问 `#24292F`。
  - 深色：关键字 `#FF7B72`、内置类型/宏 `#FFA657`、数字 `#79C0FF`、字符串 `#A5D6FF`、函数名 `#D2A8FF`、成员访问 `#C9D1D9`。
  - 只挑「绿底、红底上都不打架」的色相（蓝 / 棕 / 紫 / 灰），避开绿和红本身；转义序列跟字符串同色，预处理指令（`#include`…）用注释灰。
  - 本扩展的 `type` 类指的就是 `int` / `char` / `void` / `size_t` 这些内建类型，以及 `RCC_CR_*` 这类全大写宏。
  - 逐行无状态扫描（diff 会跳行，跨行跟踪必然出错），切分保证**无损**（着色只插 `span`，正文一字不差，`assets/pc-lineno-test.js` 有这条不变式）。关掉：`prettyCommit.syntaxHighlight`。
- 字符较长需要横向滚动时，两列行号**钉在左侧不动**（`position: sticky`），且不会把行号拖进选区（`user-select: none`）。
- 想换配色，先看清变量归谁管（`media/panel.html`）：
  - **跟主题走**的 → `body.pc-light section { … }` / `body.pc-dark section { … }`：背景、正文、语法 token、注释（白底行）、`gutter` 底色、hunk 头、闪高色、当前改动块蓝条。其中 `--tok-*` 是那套柔和配色，`--bg` / `--fg` 才是 Gerrit 官方的 `Background` / `Text`。
  - **跟深浅走**的 → `body.pc-<主题>.i-<淡|标准|浓> section { … }`，每个档位块 **5 个变量**：色带 2（`--add-bg` / `--del-bg`，符号列继承它）+ 落在色带上的 3 个前景色（`--add-mark` / `--del-mark` 符号、`--cmt-on-tint` 注释）。**行号列不在其中** —— 它跟上下文行走同一套中性色（`--gutter-bg` / `--ln-fg`）。
  - 这两个轴**互相独立**（3 × 2 = 6 种组合），所以色带相关的东西**只在档位块里定义**，主题块里不再重复 —— 否则会出现「切了深浅却不生效」这种两个来源打架的问题（自检里有这条断言）。
  - 改这些**不用重新打包**，重开面板即可。想验证改完的样子：见下一条。
- 改配色前可以先看渲染效果，不用反复重开 VS Code：`node assets/pc-render.js` 会拿**真实的 `media/panel.html`**灌一份合成 diff（新增/删除/多 hunk/无换行结尾都有），把页面写到 `$TMPDIR/pcview-out/light.html` 与 `dark.html`（分别注入 VS Code 浅色 / 深色主题变量，所以顺带验证「auto 自动认主题」这条路），用浏览器打开或交给无头 Chrome 截图即可。`node assets/pc-lineno-test.js` 是行号/配对/配色/主题与深浅切换的自检（配色那段会把 Gerrit 官方取值逐个对一遍，并把「三档 × 两主题」的每一档都按上面那几条约束复算 —— 改错立刻红；`[M]` 段再覆盖精确跳行的行号映射与重读后的位置还原）；`node assets/pc-host-test.js` 是**宿主侧状态机**的自检 —— 把 `vscode` API 整个 mock 掉，真跑「连开两笔 diff、按焦点切当前、关标签、页签上限、新标签开在哪一栏、设置与面板选择的优先级、手动/自动重读」，不需要开 VS Code。

**注意**：`Ctrl+L` 送进 Chat 的是**带前缀、不含行号的合法 unified diff**（含行首的 `@@` 头）—— 行首多了两列行号之后，直接取 DOM 的 `textContent` 会得到 `"7 8 +const x = 1"` 这种垃圾，所以渲染时把原始行存在 `data-raw` 里，`selectedLines()` 优先取它。

缩放和「收起列表」走宿主的 `getUiState` / `saveUiState`（`globalState`）。**改了 `extension.js` 必须 Reload Window** 这两条消息才会生效；只改 `panel.html` 重开面板即可。旧宿主不认这两条消息时，缩放和列表开关仍能用，只是下次打开不记得。

## 双页对比 / 多标签 / 一键跳原文

**双页对比**（顶栏 `◫`，`N` 右边；快捷键 `s`，状态记在 `globalState`）：一行仍然是一个 `.hl`，里面左右两个 `.side`，各占 50%，hunk 头横跨两侧。这样「改动块导航 / 选区 / 送 Chat」这些按行工作的逻辑一行都不用改。

```markdown
| 情况 | 双页怎么画 |
| --- | --- |
| 上下文行 | 左右同一条，行号分别是旧号 / 新号 |
| `-old` 配 `+new` | 同一条的左半红、右半绿（按下标配对） |
| 删多增少 / 增多少删 | 多出来的一侧单独成行，另一侧是浅灰空占位（`--gutter-bg`） |
| 纯新增 / 纯删除文件 | 对侧整列空占位 |
| `\ No newline at end of file` | 跟着它所属的那一侧（`-` 之后归左，`+` 之后归右） |
```

单页下长行横向滚动；双页下两侧各占一半、长行**折行**（不裁切，信息不丢）。配对逻辑是纯函数 `sbsRows()`，`assets/pc-lineno-test.js` 的 `[H]` 段专门校验「左列 = 原序列去掉 add 行、右列 = 原序列去掉 del 行」以及纯增/纯删/错位配对不丢行。

**多标签**（不再覆盖、也不挤在一个标签里）：`Alt+Q` 再开一笔 commit / 工作区 diff 时，宿主把它登记成一份**文档**（`docs[]`，id 用 full sha 或 `:working:<kind>`），并给它开一个**独立的 Cursor 编辑器标签**（一个文档 = 一个 `WebviewPanel`）——就是 `docs[i].panel`。所以你能像普通文件标签那样拖到别的分栏、`Ctrl+Tab` 切换、左右分屏并把两笔 diff 摆在一起看。

```markdown
| 行为 | 说明 |
| --- | --- |
| 新标签开在哪一栏 | 已经有 diff 标签的那一栏（同一栏里多一个标签），不会另切一道分屏 |
| 打开同一笔两次 | 按 rev 命中已有文档，直接把它那个标签翻回来，不会多长一个 |
| 切换标签 | 每份文档各自记住「看到哪个文件 / hunk / 滚动位置 / 最近选区」（`docs[i].view`），切回来不丢 |
| 关闭标签 | 光标在 diff 里按 `x`，或直接点 Cursor 标签上的 `✕`；关掉的那份 diff 随之消失 |
| 「当前 diff」 | 跟着**焦点标签**走（`onDidChangeViewState`）—— 标题、整笔/本文件分析、`Ctrl+L` 送 Chat、语言服务用的仓库根都以它为准 |
| 每个标签的数据 | 各自 `loadGen` 独立：两笔 diff 同时加载互不打断（以前是「后开的赢」） |
| 标签上限 | 12 份，超了先关掉最早的、非当前的那份（连同它的 Cursor 标签） |
| 弹独立窗口 | 每个标签各自弹自己的（`d.poppedOut`），失败就在原窗口重建它自己 |
| 多仓库工作区 | 每份文档各自带 `repoRoot`，标签可以来自不同仓库 |
```

面板内部**不再画页签栏**：宿主在 `commit` 消息里带 `nativeTabs: true`，页面据此把 `#tabs` 那一行永远收起来。切换/关闭标签全部交给 Cursor 自己的标签系统，宿主通过 `onDidChangeViewState`（焦点）和 `onDidDispose`（关闭）感知。

> 实现上的一点交代：一个扩展没法让 VS Code 把「同一个 webview」放进多个标签，所以「多标签」只能做成**多个 `WebviewPanel`**。`TabInputWebview` 只暴露 `viewType`，宿主分辨不出哪个 tab 对应哪个面板，只能**按标签文字**（= `p.title`）认；认不出来时不瞎猜，宁可放弃 `reveal` 也不把标签搬到别的分栏去。

**一键跳原文**（diff 头右上「打开文件 ↗」，快捷键 `o`）：把「当前文件 + 视口顶端那一行」交给宿主。

```markdown
| 场景 | 打开什么 |
| --- | --- |
| 工作区 diff | 磁盘上的真实文件，光标落到对应行（可编辑） |
| 历史 commit | `git show <sha>:<path>` 的只读快照（虚拟文档，scheme `pretty-commit`），行号与面板一一对应 |
| 该提交里没有这个文件 | 弹警告（新增文件在更早的提交里取不到），不静默失败 |
```

### 精确跳行：点行号

上面那条快捷键是「打开这个文件」。要跳到**某一具体行**，直接点那一行的行号（行号列本来就是 `user-select:none`，拿它当点击热区不会和「拖选代码」打架；点代码区仍然是选文字）：

```markdown
| 操作 | 效果 |
| --- | --- |
| 点行号（工作区 diff） | 在原生编辑器里打开真实文件，光标落到该行 —— 接下来就是普通编辑，改完存盘面板会自动重读 |
| 点行号（历史 commit） | 打开该提交那一刻的只读快照，行号严格对齐 |
| `Alt`+点行号（历史 commit） | 放弃快照，去开**当前工作区**里的同名文件（想直接改代码就走这条；行号按历史 diff 推算，可能已偏移，所以会提示一句） |
| `Ctrl`/`⌘`+点行号 | 不拦，仍交给「跳到定义」那条路 |
| `o` | 不给行号，退回「视口顶端那一行」（老行为） |
```

**删除行怎么跳**：删除行在新文件里根本没有行号，不能拿旧行号去跳（那是「改动前」的坐标系，落到新文件里会错位）。删除行的跳转目标是「这段改动消失的位置」—— 后面最近的新行号，后面没有（删到文件尾）就退回前面最近的；两端都没有（异常 `@@` 头）就不给跳转，行号没有 pointer 光标也不显示下划线，点了不会有反应，而不是跳到别处。

### 在 diff 里展开完整源码

git 默认只给每个改动岛上下 3 行上下文（`--unified=3`）。两个 `@@` 之间没改的大段**根本没下发**，所以左侧「再点文件 → 已折叠」只是把右侧关掉，翻开也凑不齐全文。

展开走另一条路：点缝上的条，或 diff 头「展开全文」/ `e`。宿主按**这份 diff 的两侧**取原文（工作区 all = 磁盘 vs HEAD；staged = 暂存区 vs HEAD；历史 commit = 该提交 vs 第一父），按行号切片，当成普通上下文行插回去（行首空格，送 Chat / 点行号都还能用）。`E` 或再点「收起上下文」只收缝，不把文件从列表里藏起来。

```markdown
| 操作 | 效果 |
| --- | --- |
| 点缝上的蓝条 | 只补这一段省略的源码；**条还在**，再点就是收起这一段 |
| `e` / 「▼ 展开全文」 | 文件头 + 中间 + 文件末尾一起补上；已经展开时再按一次 = 全部收起 |
| `E` / 「▲ 收起上下文」 | 缝合上，回到 git 给的改动岛 |
| 左侧再点当前文件 | 仍是收起整份 diff（「先不看这个文件」），不是展开源码 |
```

默认仍然 `--unified=3`，只在你点展开时按**当前文件**取原文。超过约 1.5MB 或含空字节会拒绝。重读 diff 后展开开关还在，原文缓存会按新内容再取一次。纯新增 / 整文件删除通常没有缝（全文已经在 diff 里）。

**打不开的时候（`Documents above the size limit cannot be synchronized with extensions.`）**：报这句话**不是因为文件大** —— 真正的尺寸阈值是 50MB，常见触发者是 Cursor 内部读过这个文件的内容（Chat / Composer 附上下文、checkpoint、Bugbot 定位），它建模型时带上了 `skipLSPSync`，于是这个文档**再也不与任何扩展同步**；此后扩展调 `workspace.openTextDocument` 一律被拒。所以点行号改成了三层，够用就停：

```markdown
| 层 | 走的接口 | 能拿到什么 |
| --- | --- | --- |
| 1. 主路 | `workspace.openTextDocument` + `showTextDocument` | 定位最准：能夹行号（超过文件长度就贴到末行）、光标精确落行 |
| 2. 兜底 | `vscode.open`（主线程的 `OpenerService.open`） | **不需要同步**，所以文档被标记后照样能把文件开出来；再尽力量位置：认得出编辑器就落光标，认不出就用内置 `revealLine` 滚动（此时提示会明说「光标未落」，免得你在错的位置开始打字） |
| 3. 都不行 | —— | 弹一条说清原因和办法的警告（原因 + 手动打开 / `Reload Window`），不静默失败、也不说「文件太大」误导人 |
```

「不与扩展同步」是预期内的降级，不是故障，所以第 2 层成功时不弹警告刷屏，只在输出通道里记一行。`node assets/pc-host-test.js` 的 `[N]` 段把这几条路逐个 mock 出来跑（含「读不到 `lineCount` 也要能定位」「编辑器是别的文件时不许乱滚」「两条路都断了要给可行动的建议」）。

### 重读 diff（refresh）

diff 是「某一刻」从 git 算出来的**快照**。文件在别处被改之后（编辑器存盘、终端里 `git add`/`commit`、切分支、外部工具改），面板上显示的还是旧内容。

```markdown
| 触发 | 说明 |
| --- | --- |
| 顶栏 `↻` / 快捷键 `r` | 手动重读当前标签 |
| `Shift`+`r` / `Shift`+点 `↻` | 重读**所有**还开着的 diff 标签 |
| 命令 `Pretty Commit: 重读当前 diff` | 焦点不在面板上时用，也可以拿去绑自己的键 |
| 自动：文件保存 | 设置 `prettyCommit.refreshOnSave`（默认开）。挂的是「保存」而不是「输入」：`git diff` 读的是**磁盘**内容，敲键盘时它不会变，只有存盘才会 —— 挂输入事件只会白跑一堆 git |
| 自动：`.git/index` / `.git/HEAD` 变化 | 设置 `prettyCommit.watchGitState`（默认开）。在终端或 SCM 面板里 `git add` / `reset` 会改「已暂存 / 未暂存」的分档，切分支 / 提交会改基线 |
```

几条实现上的讲究：

- **只作用于工作区 diff**：历史提交的内容不会变，重算它没有意义。
- **一律防抖 400ms**：一次 `git checkout` 会连着触发很多个文件事件，不防抖就会同时开一堆 git 进程（`git diff` 是全量重算，代价不小）。
- **重读不丢位置**：重算后仍然停在你刚才看的那个文件、那一行。这里顺带修掉了一个老 bug —— 以前只在**切换文档**时才 `captureView()`，所以同一份 diff 被重算（按 `r`、切 `¶`、宿主自动重读）时页面拿不到 `v.idx`，会把人拉回第一个文件、滚回顶部。现在改成「收到新数据前无条件先记位置」，并按两条线索还原：
  - **文件**优先按路径找回（文件顺序会变：改动被提交掉、新文件加进来、重命名），路径找不到了才退回旧下标。
  - **滚动**优先按「刚才停在文件第几行」锚定（重算后上面多了/少了几行、hunk 边界变了，同一个像素位置会落到别的行上），行锚定不成立（比如目标行在文件末尾之后）才退回像素。
- 挂了两条路感知 git 状态：优先用内置 git 扩展的 API（`state.onDidChange`，任何 index/HEAD/refs 变化都会通知），拿不到时退回 `createFileSystemWatcher('**/.git/index')` / `('**/.git/HEAD')`；两个都触发也没关系，防抖会合成一次。

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

## 忽略「只差符号」的改动（换行符 / 行尾空白）

**默认忽略**。把一份文件从 CRLF 换成 LF、行尾多几个空格、或者少了文件末尾那个换行 —— 内容一个字没改，diff 却能把整份文件刷成一大片红绿。这类差异基本都是编辑器 / 工具链 / `core.autocrlf` 自动产生的，review 时纯属噪声，所以默认不算改动。

```markdown
| 差异 | 默认 | 说明 |
| --- | --- | --- |
| 行尾 CR（CRLF ↔ LF） | 忽略 | `--ignore-cr-at-eol` |
| 行尾空白（多/少空格、tab） | 忽略 | `--ignore-space-at-eol` |
| 文件末尾换行（有 ↔ 无） | 忽略 | 上面两个 flag 各自就能覆盖，git 把「`\ No newline at end of file`」也当行尾差异 |
| **缩进变化** | **不忽略** | 故意不用 `-w` / `-b` / `--ignore-all-space`：缩进在 Python / Makefile / YAML 里是语法，吃掉会真漏 bug |
| 空行的增删 | **不忽略** | 故意不用 `--ignore-blank-lines`：这是真实的（虽然琐碎）排版意图 |
```

- 顶栏 `¶`（快捷键 `i`）切换。它和 `◫` 不是一类开关：`◫` 只改画法，本地重绘就行；`¶` 改的是 **git 的算法**，切了会回 git 用另一组 flag 重算（`refreshDiff`），并记住选择（`globalState`）。没在面板上切过就听设置 `prettyCommit.ignoreSymbolDiffs`（默认 `true`）。
- 被它抹掉的文件**不会静默消失**：顶栏副标题显示 `忽略 2 个只差符号/空白的文件`；如果整个 diff 一个文件都不剩，占位区会点名是**哪几个**文件、并告诉你按 `¶` 就能看到它们。宿主额外跑一次 `git … --name-only`（只比 OID、不做内容 diff，很快）求出「git 认为变过」的全集，减去真 diff 里剩下的那份，差值就是被忽略的文件。
- 一个必须留意的例外：**Markdown 里行尾两个空格是硬换行**，属于语义。看 `.md` 的改动时如果发现少了东西，按一下 `¶`。

### 顺带：「Inline diffs have been suppressed for recent changes…」不是本扩展的消息

那句话来自 **Cursor 自己**：`cursor.inlineDiff.enablePerformanceProtection`（默认 `true`，Cursor 的 Cmd+K / Composer 内联 diff 的「性能保护」）在改动量太大时会收起编辑器里的内联 diff 装饰，并在编辑器里留这句话，旁边的按钮「Disable Protection」就是让你关掉这个保护。三条证据：

- 这个字符串在 Cursor 的 `resources/app/out/nls.messages.json` 里（第 204 条），紧挨着的兄弟字符串有 `Loading...`、`Disable Protection`、`Toggle Collapse Unchanged Regions`、`Diff Editor` —— 全是编辑器 / diff 编辑器自己的文案，而它旁边就是 `cursor.inlineDiff.enablePerformanceProtection` 这个设置的默认值。
- 本扩展的 `extension.js` / `media/panel.html` / `src/*.js` 里**没有**这个字符串（`grep -ri suppressed` 为空）：diff 是本扩展自己画在一个 webview 里的，从不往编辑器里画装饰。
- 这类提示只可能由 Cursor 本体或扩展的 API 发出，而本扩展不发任何编辑器装饰。

所以它和 `Alt+Q` 的 diff 性能无关 —— 本扩展渲染 diff 用的是「一次性解析 + 分块 DOM」那套（见「性能」一节），没有「改动太多就不显示」的阈值。真嫌 Cursor 那边烦，可以在设置里搜 `inlineDiff` 把这层保护关掉。

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
| `Alt+Q` 打开面板 | 第一个 diff 单独占一栏（左代码 / 右 diff）；后来的 diff 开在同一栏里当新标签 | `createWebviewPanel(..., ViewColumn.Beside)`（`prettyCommit.openBeside` 默认开，且只在 `fillEditorArea=false` 时生效）；已有 diff 标签时改用**它所在那一栏**的 `viewColumn` |
| `Ctrl+L` 送 Chat | Chat 开在**与面板不同**的分栏，两边同屏可见 | 若 Chat 开在了该 diff 标签那一栏，用 `moveEditorToLeftGroup` / `moveEditorToRightGroup` 把它挪到面板另一侧 |
| 送完 Chat | **什么都不做**（不抢焦点） | 同一个窗口里不存在「被压到后面」，抢焦点只会妨碍你往输入框打字 |
| `Alt+Shift+Q` | 把 diff 标签切回前台 | 逐个处理还开着的标签：嵌在窗口里的各自在**自己那一栏**激活标签页（不搬动分栏），弹成独立窗口的各自把窗口抬到前台 |
```

### 分栏定位：为什么不能随便调 `reveal(undefined)`

`WebviewPanel.reveal()` 传 `undefined`（或 `ViewColumn.Active`）时，主线程的实现是：

```
$reveal(handle, { viewColumn, preserveFocus })
  → getTargetGroupFromShowOptions: typeof viewColumn === 'undefined' → 返回 ACTIVE_GROUP
  → revealWebview: editorService.openEditor(editor, {...}, 目标栏)
```

也就是说它是「**打开到当前活动分栏**」—— 是**搬家**，不是「把标签页翻到前面」。危害有两个：弹窗模式下会把面板从新窗口拖回原窗口（旧 bug「送完 Chat 窗口就消失」）；嵌入模式下会把面板搬到 Chat 那一栏、盖住 Chat。

所以现在先用 `vscode.window.tabGroups` 查出面板自己在哪一栏（`t.input instanceof vscode.TabInputWebview && t.input.viewType === 'prettyCommit'` 能认出我们的标签页），再 `reveal(它自己那一栏)` 只激活标签页；送 Chat 前也先判断「Chat 是不是真的开在面板那一栏」，是才挪 —— 不乱动你的布局。老版本没有 `tabGroups` API 时**不猜**：不搬动任何分栏，只在日志里写一行说明。

两个坑值得写下来：

- **`TabInputWebview` 在 `vscode` 根命名空间，不在 `vscode.window` 上。** 这里以前写的是 `vscode.window.TabInputWebview`（JS 没有类型检查，所以一直没报错），值恒为 `undefined` → 认标签永远失败 → 「展开占满编辑区」「激活被盖住的标签页」「送 Chat 后把 Chat 挪到旁边」全都静默空转（`fillEditorArea` 默认开着却从没生效过）。现在两个位置都兜了一下，`assets/pc-host-test.js` 的 `[I]` 段是它的回归守卫。
- **多标签时只靠 viewType 分辨不出是哪个标签**（同一个扩展的所有 diff 标签 `viewType` 都一样），只能按标签文字（= `p.title`）认。认不出来时返回 `null`，宁可放弃 reveal，也不把标签搬到别的分栏去。


## 占满编辑区（默认开）

面板默认不是「半屏」，也不是「旁边切一栏」，而是**展开占满整个编辑区**：其它编辑器分栏缩到最小（不关闭、不隐藏侧边栏、不动 Chat 所在的辅助栏），需要时点一下它们就回来。

> **注意这一节的行为在修掉 `TabInputWebview` 那个 bug 之后才真正生效。** 以前「认不出面板在哪一栏」导致整段逻辑空转，所以 `fillEditorArea` 虽然默认 `true` 却从没动过你的分栏。现在它会动手了：只有**你本来就分了多个编辑器栏**时才有区别（单栏时命令本身就是 no-op），效果是其它栏被缩到最小。不想要就把 `prettyCommit.fillEditorArea` 设为 `false`。

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
| `prettyCommit.diffTheme` | `auto` | diff 区配色：`auto` 跟随编辑器主题（Gerrit Light / Dark），`light` / `dark` 强制固定；面板上按过 `t` 之后以面板选择为准 |
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
## 性能：这个 diff 视图在哪些地方是省着的

顺手回答一个常见疑问：「是不是改动一多、这个工具就不显示了？」**不是** —— 页面侧没有「改动太多就放弃渲染」的逻辑，只有下面这些有意的上限和缓存：

```markdown
| 机制 | 位置 | 作用 |
| --- | --- | --- |
| 每文件 6000 行上限 | `extension.js` `VIEW_FILE_LINE_CAP` | 单个文件的 hunk 超过就截断，并在 diff 头标「已截断」。防的是一个文件把整个 webview 拖死 |
| 只渲染展开的那个文件 | `renderDiff()` 里 `S.open` 为假时直接出占位 | 别的文件不建 DOM |
| `DocumentFragment` 批量插入 | `fillCode` / 行渲染 | 不逐行 `appendChild` 触发重排 |
| 改动块缓存 | `S.changeBlocksCache` | `↑`/`↓` 跳改动不反复全量扫 DOM |
| 只清「上次标过的那几个元素」 | `S.chgMarkedEls` | 不再 `querySelectorAll('.chg')` |
| 落盘防抖 | `saveUi()` 400ms / 列表宽度 resize 100ms | 拖一次分隔条只写一次 `globalState` |
| 标签上限 12 | `MAX_DOCS` | 超了先关最早的、非当前的那个（每个标签各占一份渲染内存） |
| 默认忽略符号差异 | `SYMBOL_IGNORE_FLAGS` | 直接把「整份文件只有行尾变了」这类最大号的假 diff 从渲染里去掉 |
```

真正会「不显示」的只有两种情况，而且都会在页面上写明原因：单文件超过 6000 行（标注截断），以及 `prettyCommit.hideUnchangedFiles` 省略掉的纯重命名/仅权限变更。

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
- 多标签是**多个 `WebviewPanel`**（VS Code 没法把一个 webview 放进多个标签），每个都开着 `retainContextWhenHidden`，所以「切标签不重渲染、滚动位置和选区都留着」的代价是**每个标签各占一份渲染内存**。标签数上限 12（`MAX_DOCS`，超了先关最早的、非当前的那个）；同时开十几个超大 diff 会明显吃内存，看完关掉即可。
- 每个 diff 标签靠 `vscode.window.tabGroups` 里标签的**文字**（= `p.title`，`<shortSha>  <subject>`）反查自己落在哪一栏 —— `TabInputWebview` 只暴露 `viewType`，同一个扩展的多个面板长得一模一样，没有别的办法区分。认不出来（比如标签被拖到另一个 OS 窗口、或标题被改）时**不做任何 reveal**，宁可少做一步也不把你的标签搬到别的分栏去。
- 快捷键本身是 `package.json` 静态声明的，扩展无法在运行时改写：想换键用命令面板 `Pretty Commit: 修改快捷键…` 打开界面双击改（写入用户 `keybindings.json`），或手写覆盖。另外终端聚焦时按键默认会发给 shell，需要 `terminal.integrated.commandsToSkipShell` 里有本扩展的命令（有现成命令一键补上，见「改快捷键」一节）。
- 「忽略符号差异」是**全局**的：没有「只对某个文件忽略」的粒度，也不能对单个 hunk 单独放开。要逐文件对比时按 `¶` 切一次即可（`.md` 的行尾两空格是硬换行，是最常见的例外）。
- 自动重读的感知边界：**VS Code 内部知道**的变化（编辑器存盘、`git add`/`commit`/切分支）能自动跟上；外部工具**绕过编辑器直接改磁盘**（`sed -i`、别的 checkout、容器里改文件）不会触发保存事件，那就按 `r` 手动重读。
- 「点行号跳行」在历史 commit 下打开的是只读快照（`git show <sha>:<path>`）：这是为了让行号严格对应，代价是不能直接编辑 —— 想改代码用 `Alt`+点行号去开工作区文件（行号按历史 diff 推算，可能已偏移，会提示一句）。
- 「不与扩展同步」的文档（Cursor 内部读过内容的那些）只能靠 `vscode.open` 从主线程开，那条路上扩展**拿不到文档对象**，所以定位是尽力而为：能认准编辑器就落光标，否则只滚不落。这是接口边界，不是可以再优化掉的东西。
- 展开全文是把原文塞进 webview，不是改 `--unified`。单个文件超过约 1.5MB 会拒；特别长的文件展开后滚动会沉。文件末尾那条缝要先拿到原文长度才出现（点「展开全文」会取）。
- 不做 split diff / blame / 提交图节点 / 每 hunk 自动 AI。也**不做面板内联编辑**（在 diff 视图里改源码）：当前渲染是「只读快照」的一套假设（diff 行直接来自 `git show` 的输出、行号是 diff 坐标系、改动会立刻让 diff 本身失效），要做就得上 `TextDocument` + 映射回写 + 失效重算三条链路，代价和风险都不小。要改代码就点行号回原生编辑器。

## 验收清单

1. SCM 历史右键（或命令面板）能打开大窗口并显示文件列表 + diff。
2. 默认**不弹独立窗口**：面板嵌在同一个窗口里、单独占一栏（左代码 / 右 diff），原编辑器仍在。
3. `P/N` 或 `↑/↓` 切文件；拖选若干行按 `Ctrl+L`（或右下角按钮）能把代码加进 Chat 上下文。
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
27. 连着 `Alt+Q` 开两笔不同的提交：出现**两个 Cursor 标签**（各自标题是 `<shortSha>  <subject>`），并且都开在**同一栏**里；点第二个标签里面的文件/滚动，再点回第一个，两边各看各的、互不覆盖。
28. 每个 diff 标签里都**没有**那一排内部页签栏（页面内部页签栏已收起来，切换交给 Cursor 自己的标签）。
29. 把两个 diff 标签拖到左右两栏：`Alt+Q` 再开一笔时，新标签落在**已有 diff 标签所在的那一栏**（不另切分屏）。
30. 关掉一个标签（点 `✕`，或在 diff 里按 `x`）：那一份 diff 随之消失，其余标签不受影响；关掉最后一个标签后 `Alt+Q` 重新开一个，日志里没有残留错误。
31. 在第一个标签里按 `Shift+A`（或 `Shift+F`）：Output 里 `挂芯片成功` 针对的是**第一个标签的那笔提交**；切到第二个标签再按，针对的是第二笔 —— 不会张冠李戴。
32. 连按两次 `Alt+Q` 选**同一笔**提交：不会多出一个标签，而是把已经开着的那个翻回来（日志 `这个 rev 已经开着了，切回它的标签`）。
33. 多开之后按 `Alt+Shift+Q`：每个还开着的 diff 标签各自被切到自己那一栏的最前（日志逐个 `已在面板自己那一栏显示面板`）。
34. `node assets/pc-host-test.js` 全过（不需要开 VS Code）：两个面板各自拿到自己的 `docId` / `nativeTabs` / 内容，焦点切 `current`、关标签、页签上限、新标签落在哪一栏都有断言。
35. 把某个文件整体换成 CRLF（或只在行尾加几个空格）后打开工作区 diff：**它不出现在文件列表里**，顶栏副标题写「忽略 1 个只差符号/空白的文件」；按 `¶`（或 `i`）后它出现、红绿正常，再按一次又消失。
36. 一笔提交里所有文件都只差换行符时，占位区点名是**哪几个**文件，并提示按 `¶` 查看（不是干巴巴的「没有改动」）。
37. 改 **缩进**（Python 缩进、Makefile 的 tab）不会被忽略：这类改动照常出现在列表里。
38. 在一个 diff 标签里按 `¶` 后，另一个还开着的 diff 标签也会跟着重算成同样的模式（`uiState` 广播 + 各自 `refreshDiff`）。
39. 编辑器是**深色**主题时打开 diff：diff 区就是 Gerrit Dark（`#202124` 底、`标准` 档绿 `#25623C` / 红 `#97211E`），且**不会先闪一下白底**；切换到浅色主题不用重开面板，diff 区当场变 Gerrit Light（auto 模式）。
40. 按 `t`（或点顶栏 `◐`）：按钮在 `◐ → ☀ → ☾` 之间循环，强制浅色时即使编辑器是深色，diff 区也是白底，再按回 `◐` 恢复跟随；关掉面板再打开，还是上次那一档（`globalState`）。
41. 想固定某一套配色、不要跟随：把 `prettyCommit.diffTheme` 设成 `light` 或 `dark`（面板上按过 `t` 之后以面板选择为准，设置改不动它 —— 这条与 `ignoreSymbolDiffs` 优先级一致）。
42. 连续多行的增/删块里**没有横向条纹**：底色是平涂；**行号列保持中性灰**（增删行的行号列不染绿/红，和上下文行长得一样），而**符号列和代码区是同一条均匀色带** —— `+` / `-` 那一小格不应该出现第二条更深或更亮的竖带。`d` 切到 `淡 / 标准 / 浓` 时，绿行和红行的**明暗要一致**（不能一行明显更重）。
43. `node assets/pc-lineno-test.js` 全过：其中 `[I]` 会把「淡」档的 Gerrit 官方取值逐个对一遍（改错一个色号就红），并复算「三档 × 两主题」的对比度、**绿红感知亮度相等**、**彩度比**，以及「行号列中性 / 符号列 inherit 色带 / 没有残留的 `--add-gutter`」这几条结构断言；`[L]` 验证 auto 认主题、强制模式、`t` / `d` 循环，以及「亮度判断全文件只有一份实现」；`[M]` 验证「删除行取消失位置」的跳转映射、点行号发出的 `openSource` 载荷（精确行号 / worktree）、`r` 与 `Shift+R` 的消息形状，以及重算后的位置还原（先记位置、路径优先、滚动按行锚定）。
44. 工作区 diff 下点**任意一行的行号**：原生编辑器里那个文件被打开、光标落在**这一行**（不是文件头），行号上有 pointer 光标和下划线。`+` 行、上下文行、`-`（删除）行都要对：删除行落到「这段改动消失的位置」，不会拿旧行号跳到别处。
45. 历史 commit 下点行号：打开的是**只读快照**，行号严格对齐；按住 `Alt` 再点行号，打开的则是当前工作区的同名文件（并有「行号可能已偏移」的提示）。`Ctrl`/`⌘`+点行号仍然是「跳到定义」，没有被抢。
46. 让 Cursor 的 Chat 引用过某个文件（比如把 `README.md` 拖进对话）之后再点它的行号：文件**仍然能被打开**，不再弹 `Documents above the size limit cannot be synchronized with extensions.`。如果光标没能落行（只滚到了那一行），提示里会写明「光标未落」；两条路都断了才会弹警告，且警告里必须点出文件、原因和办法。`node assets/pc-host-test.js` 的 `[N]` 段覆盖这条路。
46. 看第 3 个文件、滚到中间，然后按 `r`：状态栏闪一下「正在重读 diff…」，**仍然停在同一个文件、同一行**（不回到第一个文件、不滚回顶部）。在上面几行处新加/删几行再按 `r`，位置按**行**锚定，不漂。
47. 编辑当前工作区 diff 里的文件并 `Ctrl+S`：约 0.4s 后面板自己重读（状态栏「检测到变化（文件已保存），正在重读 diff…」），`Δ` 与列表跟着变。把 `prettyCommit.refreshOnSave` 关掉后保存不再触发；`prettyCommit.watchGitState` 关掉后，`git add` 也不会触发重读。
48. 在终端对同一个仓库 `git add` / 切分支后不碰面板：约 0.4s 后面板自己重读，「已暂存 / 未暂存」的分档跟上（`输出 → Pretty Commit` 里有 `已重读 diff（.git/index 变化）` 或 `（git 状态变化）`）。
49. 连开两个 diff 标签，在其中一个按 `Shift+R`：两个标签都重读（各自日志一行），互不串台。命令面板 `Pretty Commit: 重读当前 diff` 重读**焦点所在**的那个标签。
50. 一个文件有两段不相邻的改动：两段 `@@` 之间有一条「展开中间 N 行」；点它之后中间未改的源码出现在 diff 里，红绿行还在原位，行号能点。按 `e` 把文件头/末尾也补上；按 `E` 缝合上。左侧再点该文件仍然是「已折叠」整份 diff，不是把源码展开。`node assets/pc-lineno-test.js` 的 `[O]` 段和 `pc-host-test.js` 的 `[O]` 段覆盖行号切片与「两侧原文怎么取」。
