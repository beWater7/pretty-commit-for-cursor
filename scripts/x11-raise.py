#!/usr/bin/env python3
"""把 Pretty Commit 面板所在的 OS 窗口抬到前台（X11 / EWMH）。

## 为什么需要这个文件

面板被 `workbench.action.moveEditorToNewWindow` 搬到**另一个 OS 窗口**后，扩展宿主
（跑 extension.js 的进程）仍然留在原窗口。于是：

* `vscode.window` 里**没有**任何「聚焦某个窗口」的 API；
* 工作台内部只有主进程侧的 `nativeHostService.focusWindow`，扩展拿不到；
* webview 里调 `window.focus()` 抬不动自己的窗口 —— iframe 没有 user activation，
  实测日志一直是 `focused=no`。

唯一可行的路是直接对 X server 发 EWMH 的 `_NET_ACTIVE_WINDOW` 请求。本机装的是 GNOME Shell
（mutter），它支持该原子；`data[0]=2` 表示请求来自 pager，可以绕过焦点窃取保护。

## 依赖

只用 python3 标准库的 ctypes + 系统的 libX11（有 xprop 的机器必然有它），
不需要 xdotool / wmctrl。

## 用法

    x11-raise.py list                     列出所有顶层窗口（诊断）
    x11-raise.py ids                      每行一个窗口 id（供差集识别新窗口）
    x11-raise.py wm                       打印窗口管理器信息（诊断）
    x11-raise.py active                   打印当前活动窗口 id
    x11-raise.py activate --id 0x1234     按 id 置前
    x11-raise.py activate --title 0d731d1 按标题子串找窗口并置前

机器可读输出：成功时打印 `MATCHED=0x...` 与 `ACTIVE=0x...`，供 extension.js 解析并缓存窗口 id。
退出码：0 成功 / 2 参数错 / 3 连不上 X display / 4 没找到匹配窗口 / 5 指定的窗口 id 已失效
"""

import ctypes
import ctypes.util
import sys

X11 = ctypes.CDLL(ctypes.util.find_library('X11'))
c_voidp, c_ulong, c_long, c_int = ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long, ctypes.c_int

X11.XOpenDisplay.restype = c_voidp
X11.XOpenDisplay.argtypes = [ctypes.c_char_p]
X11.XDefaultRootWindow.restype = c_ulong
X11.XDefaultRootWindow.argtypes = [c_voidp]
X11.XInternAtom.restype = c_ulong
X11.XInternAtom.argtypes = [c_voidp, ctypes.c_char_p, c_int]
X11.XFree.argtypes = [c_voidp]
X11.XFetchName.restype = c_int
X11.XFetchName.argtypes = [c_voidp, c_ulong, ctypes.POINTER(ctypes.c_char_p)]
X11.XCloseDisplay.argtypes = [c_voidp]
X11.XFlush.argtypes = [c_voidp]
X11.XMapWindow.argtypes = [c_voidp, c_ulong]
# 必须显式声明：XGetWindowProperty 的 long_offset/long_length 是 C long(64 位)，
# 不声明时 ctypes 会按 32 位 int 传参，属性读残（表现就是标题读出来是空串）。
X11.XGetWindowProperty.restype = c_int
X11.XGetWindowProperty.argtypes = [
    c_voidp, c_ulong, c_ulong, c_long, c_long, c_int, c_ulong,
    ctypes.POINTER(c_ulong), ctypes.POINTER(c_int), ctypes.POINTER(c_ulong),
    ctypes.POINTER(c_ulong), ctypes.POINTER(c_voidp),
]
X11.XGetWindowAttributes.restype = c_int
X11.XGetWindowAttributes.argtypes = [c_voidp, c_ulong, c_voidp]
X11.XSendEvent.restype = c_int
X11.XSendEvent.argtypes = [c_voidp, c_ulong, c_int, c_long, c_voidp]
X11.XRaiseWindow.argtypes = [c_voidp, c_ulong]
X11.XSetInputFocus.argtypes = [c_voidp, c_ulong, c_int, c_ulong]

IS_VIEWABLE = 2  # XWindowAttributes.map_state

# Xlib 默认的错误处理会直接终止进程（"X Error of failed request: BadWindow"）。
# 这里换成忽略：窗口可能在我们枚举之后、激活之前就被关掉，那种竞态只应导致
# 「这个窗口不存在」而不是把帮助脚本崩掉。
XErrorHandler = ctypes.CFUNCTYPE(c_int, c_voidp, c_voidp)
X11.XSetErrorHandler.restype = c_voidp
X11.XSetErrorHandler.argtypes = [XErrorHandler]
_IGNORED_X_ERRORS = []


def _ignore_x_error(display, event):
    _IGNORED_X_ERRORS.append(event)
    return 0


# 必须把这个 CFUNCTYPE 对象保存在模块级变量里：XSetErrorHandler 只存函数指针，
# 如果传临时对象，Python 侧一回收就变成野指针，下一次 X 错误直接段错误。
_X_ERROR_HANDLER = XErrorHandler(_ignore_x_error)
X11.XSetErrorHandler(_X_ERROR_HANDLER)


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ('x', c_int), ('y', c_int), ('width', c_int), ('height', c_int),
        ('border_width', c_int), ('depth', c_int), ('visual', c_voidp),
        ('root', c_ulong), ('class_', c_int), ('bit_gravity', c_int),
        ('win_gravity', c_int), ('backing_store', c_int),
        ('backing_planes', c_ulong), ('backing_pixel', c_ulong),
        ('save_under', c_int), ('colormap', c_ulong), ('map_installed', c_int),
        ('map_state', c_int), ('all_event_masks', c_long), ('your_event_mask', c_long),
        ('do_not_propagate_mask', c_long), ('override_redirect', c_int),
        ('screen', c_voidp),
    ]


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [
        ('type', c_int), ('serial', c_ulong), ('send_event', c_int), ('display', c_voidp),
        ('window', c_ulong), ('message_type', c_ulong), ('format', c_int),
        ('data', c_long * 5),
    ]


class XEvent(ctypes.Union):
    _fields_ = [('type', c_int), ('xclient', XClientMessageEvent), ('pad', c_long * 24)]


def _prop(display, win, name, length=4096):
    """读属性。format 32 → int 列表；format 8 → bytes。"""
    atom = X11.XInternAtom(display, name.encode(), False)
    if not atom:
        return None, 0
    actual_type, actual_format = c_ulong(), c_int()
    nitems, bytes_after = c_ulong(), c_ulong()
    data = c_voidp()
    r = X11.XGetWindowProperty(display, win, atom, 0, length, False, 0,
                               ctypes.byref(actual_type), ctypes.byref(actual_format),
                               ctypes.byref(nitems), ctypes.byref(bytes_after),
                               ctypes.byref(data))
    if r != 0 or not data.value:
        return None, 0
    try:
        if actual_format.value == 32:
            arr = ctypes.cast(data, ctypes.POINTER(c_ulong))
            return [arr[i] for i in range(nitems.value)], 32
        # 用 string_at 一次性取（不要用 POINTER(c_char) 逐字节取：那会得到一堆长度 1 的
        # bytes 对象，后续按 int 处理会抛 TypeError）
        return ctypes.string_at(data, nitems.value), 8
    finally:
        X11.XFree(data)


def win_name(display, win):
    """窗口标题：先 _NET_WM_NAME（UTF-8），再退回 XFetchName(WM_NAME)。"""
    vals, fmt = _prop(display, win, '_NET_WM_NAME')
    if fmt == 8 and vals:
        s = vals.decode('utf-8', 'replace')
        if s.strip():
            return s
    name = ctypes.c_char_p()
    if X11.XFetchName(display, win, ctypes.byref(name)) and name.value:
        s = name.value.decode('utf-8', 'replace')
        X11.XFree(name)
        return s
    return ''


def clients(display):
    root = X11.XDefaultRootWindow(display)
    wins, _ = _prop(display, root, '_NET_CLIENT_LIST')
    return root, (wins or [])


def is_viewable(display, win):
    if not win:
        return False
    attrs = XWindowAttributes()
    if not X11.XGetWindowAttributes(display, win, ctypes.byref(attrs)):
        return False
    return attrs.map_state == IS_VIEWABLE


def window_exists(display, win):
    return bool(win) and bool(X11.XGetWindowAttributes(display, win,
                                                       ctypes.byref(XWindowAttributes())))


def active_window(display, root):
    vals, _ = _prop(display, root, '_NET_ACTIVE_WINDOW')
    return vals[0] if vals else 0


def activate(display, win, root):
    """三重保险：_NET_ACTIVE_WINDOW(pager 来源) + XRaiseWindow + XSetInputFocus。

    只发 _NET_ACTIVE_WINDOW 在部分 WM 上会被焦点窃取保护挡掉，所以补一把
    XRaiseWindow（堆叠顺序）和 XSetInputFocus（键盘焦点）。
    """
    net_active = X11.XInternAtom(display, b'_NET_ACTIVE_WINDOW', False)
    ev = XEvent()
    ev.xclient.type = 33  # ClientMessage
    ev.xclient.serial = 0
    ev.xclient.send_event = True
    ev.xclient.display = display
    ev.xclient.window = win
    ev.xclient.message_type = net_active
    ev.xclient.format = 32
    ev.xclient.data[0] = 2  # 来源 = pager，绕过焦点窃取保护
    ev.xclient.data[1] = 0  # CurrentTime
    ev.xclient.data[2] = 0
    mask = (1 << 20) | (1 << 19)  # SubstructureRedirectMask | SubstructureNotifyMask
    sent = X11.XSendEvent(display, root, False, mask, ctypes.byref(ev))
    X11.XRaiseWindow(display, win)
    X11.XSetInputFocus(display, win, 2, 0)  # RevertToParent, CurrentTime
    X11.XFlush(display)
    return sent


def pick_by_title(display, wins, needle, act):
    """标题含 needle 的窗口；有多个候选时优先「不是当前活动窗口」的那个 —— 要抬的正是后台窗口。"""
    hits = [(w, win_name(display, w)) for w in wins]
    hits = [(w, n) for (w, n) in hits if needle and needle in n]
    cand = [(w, n) for (w, n) in hits if is_viewable(display, w)] or hits
    cand.sort(key=lambda h: h[0] == act)
    return cand


def do_activate(display, root, target):
    if not is_viewable(display, target):
        X11.XMapWindow(display, target)  # 最小化的先映射回来
        X11.XFlush(display)
    ok = activate(display, target, root)
    return ok, active_window(display, root)


def main():
    argv = sys.argv
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    display = X11.XOpenDisplay(None)
    if not display:
        print('ERROR: XOpenDisplay 失败（连不上 X display）')
        return 3
    try:
        root, wins = clients(display)
        act = active_window(display, root)

        if cmd == 'wm':
            check, _ = _prop(display, root, '_NET_SUPPORTING_WM_CHECK')
            name = win_name(display, check[0]) if check else ''
            supported, _ = _prop(display, root, '_NET_SUPPORTED')
            names = {X11.XInternAtom(display, n.encode(), False): n for n in
                     ('_NET_ACTIVE_WINDOW', '_NET_CLOSE_WINDOW', '_NET_WM_STATE')}
            print(f'WM 名称: {name or "(未知)"}')
            print(f'支持的 EWMH 原子: {[names[a] for a in supported if a in names] or "(无)"}')
            print(f'顶层窗口数: {len(wins)}')
            return 0

        if cmd == 'list':
            print(f'{"WINDOW_ID":>12}  {"PID":>8}  {"VIEW":>4}  {"ACTIVE":>6}  NAME')
            for w in wins:
                pid, _ = _prop(display, w, '_NET_WM_PID')
                print(f'{hex(w):>12}  {(pid[0] if pid else 0):>8}  '
                      f'{"yes" if is_viewable(display, w) else "no":>4}  '
                      f'{"<--" if w == act else "":>6}  {win_name(display, w)[:80]}')
            return 0

        if cmd == 'active':
            print(f'ACTIVE={hex(act)}')
            return 0

        if cmd == 'ids':
            # 每行一个窗口 id：扩展在弹窗前/后各取一次，差集就是新建的面板窗口
            for w in wins:
                print(hex(w))
            return 0

        if cmd == 'activate':
            target = None
            if '--id' in argv:
                target = int(argv[argv.index('--id') + 1], 0)
                if not window_exists(display, target):
                    print(f'ERROR: 窗口 {hex(target)} 已不存在')
                    return 5
                print(f'按 id 命中 {hex(target)}  «{win_name(display, target)[:70]}»')
            elif '--title' in argv:
                needle = argv[argv.index('--title') + 1]
                cand = pick_by_title(display, wins, needle, act)
                if not cand:
                    print(f'ERROR: 没有窗口标题包含 {needle!r}')
                    return 4
                target = cand[0][0]
                print(f'按标题命中 {len(cand)} 个候选，选中 {hex(target)}  «{cand[0][1][:70]}»')
            if target is None:
                print('ERROR: 需要 --id 或 --title')
                return 2
            ok, now = do_activate(display, root, target)
            print(f'MATCHED={hex(target)}')
            print(f'ACTIVE={hex(now)}')
            ok_str = '成功' if now == target else 'WM 未接受（可能被焦点窃取保护挡掉）'
            print(f'XSendEvent={ok}；{ok_str}')
            return 0

        print(__doc__)
        return 2
    finally:
        X11.XCloseDisplay(display)


if __name__ == '__main__':
    sys.exit(main())
