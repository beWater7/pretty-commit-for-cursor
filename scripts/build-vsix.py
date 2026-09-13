#!/usr/bin/env python3
"""手工打包 Pretty Commit 为 VSIX（不依赖 vsce / npm）。

为什么需要它：本机 npm registry 不通（registry.npmjs.org / npmmirror 都 ECONNRESET），
`npx @vscode/vsce` 装不下来，所以按 VSIX（本质是 ZIP）的规范自己打：

    pretty-commit.vsix
      ├── [Content_Types].xml        # 扩展名 -> MIME 映射
      ├── extension.vsixmanifest     # 包元数据（显示名/版本/依赖/资源清单）
      └── extension/                 # 实际负载
            ├── package.json
            ├── extension.js
            ├── readme.md
            ├── src/*.js
            └── media/panel.html

manifest 里的元数据全部来自 package.json。为了让本脚本不必重写那段 XML，打包前会**解析**旧包
manifest 并与 package.json 逐字段比对：一致就复用，有差异直接报错让你改用 vsce，避免打出一个
元数据过期（版本号/显示名对不上）的包。

用法：
    python3 scripts/build-vsix.py            # 打包；旧包自动备份为 *.vsix.bak
    python3 scripts/build-vsix.py --check    # 只校验 manifest 是否仍匹配，不打
"""

import io
import json
import os
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "pretty-commit.vsix")

# VSIX 内路径 -> 仓库内相对路径（新增负载文件要同时改这里）
PAYLOAD = [
    ("extension/package.json", "package.json"),
    ("extension/extension.js", "extension.js"),
    ("extension/readme.md", "README.md"),
    ("extension/src/parse.js", "src/parse.js"),
    ("extension/src/git.js", "src/git.js"),
    ("extension/src/ai.js", "src/ai.js"),
    ("extension/media/panel.html", "media/panel.html"),
    ("extension/images/icon.png", "images/icon.png"),
    ("extension/scripts/x11-raise.py", "scripts/x11-raise.py"),
]

NS = {"m": "http://schemas.microsoft.com/developer/vsx-schema/2011"}
# 逗号分隔、顺序不保证的字段
LIST_FIELDS = ("Categories", "Tags", "EnabledApiProposals")


def log(*a):
    print(*a, flush=True)


def load_payload():
    pkg_path = os.path.join(ROOT, "package.json")
    pkg = json.load(io.open(pkg_path, encoding="utf-8"))
    if pkg["name"] != "pretty-commit":
        raise SystemExit("package.json 的 name 不是 pretty-commit，拒绝打包")
    if "keybindings" not in pkg.get("contributes", {}):
        raise SystemExit("package.json 里没有 contributes.keybindings（Alt+Q 会失效）")
    return pkg


def read_manifest(z):
    """从旧 vsix 里取出 manifest 与 [Content_Types].xml。"""
    return z.read("extension.vsixmanifest"), z.read("[Content_Types].xml")


def manifest_fields(manifest_xml):
    """把 manifest 里与 package.json 对应的字段解析出来。

    同一信息在 VSIX manifest 里的位置不统一：Version/Publisher 是 <Identity> 的属性，
    DisplayName/Description/Categories/Tags 是子元素（Description 还带 xml:space），
    Engine/proposed API 在 <Properties> 里。所以按 XML 解析，别做字符串匹配。
    """
    root = ET.fromstring(manifest_xml)
    ident = root.find("m:Metadata/m:Identity", NS)
    props = root.find("m:Metadata/m:Properties", NS)

    def text(path):
        el = root.find(path, NS)
        return el.text if el is not None else None

    def prop(mid):
        if props is None:
            return None
        for el in props:
            if el.get("Id") == "Microsoft.VisualStudio.Code." + mid:
                return el.get("Value")
        return None

    return {
        "Id": ident.get("Id") if ident is not None else None,
        "Version": ident.get("Version") if ident is not None else None,
        "Publisher": ident.get("Publisher") if ident is not None else None,
        "DisplayName": text("m:Metadata/m:DisplayName"),
        "Description": text("m:Metadata/m:Description"),
        "Engine": prop("Engine"),
        "EnabledApiProposals": prop("EnabledApiProposals"),
        "Categories": text("m:Metadata/m:Categories"),
        "Tags": text("m:Metadata/m:Tags"),
    }


def check_manifest(manifest_xml, pkg):
    actual = manifest_fields(manifest_xml)
    expect = {
        "Id": pkg["name"],
        "Version": pkg["version"],
        "Publisher": pkg["publisher"],
        "DisplayName": pkg["displayName"],
        "Description": pkg["description"],
        "Engine": pkg["engines"]["vscode"],
        "EnabledApiProposals": ",".join(pkg.get("enabledApiProposals", [])),
        "Categories": ",".join(pkg["categories"]),
        "Tags": ",".join(pkg["keywords"]),
    }

    def norm(s):
        return None if s is None else " ".join(str(s).split())

    problems = []
    for k, want in expect.items():
        got = norm(actual.get(k))
        want = norm(want)
        if got is None:
            problems.append("  %s: manifest 里找不到" % k)
        elif k in LIST_FIELDS:
            if sorted(x.strip() for x in got.split(",")) != sorted(x.strip() for x in want.split(",")):
                problems.append("  %s: manifest=%r package.json=%r" % (k, got, want))
        elif got != want:
            problems.append("  %s: manifest=%r package.json=%r" % (k, got, want))
    return problems


def main():
    check_only = "--check" in sys.argv
    pkg = load_payload()
    if not os.path.exists(OUT):
        raise SystemExit("没有旧的 pretty-commit.vsix 可复用 manifest —— 请先用 vsce 打一次")

    with zipfile.ZipFile(OUT) as z:
        manifest, content_types = read_manifest(z)

    problems = check_manifest(manifest.decode("utf-8"), pkg)
    if problems:
        log("manifest 与 package.json 不一致，不能复用旧 manifest：")
        log("\n".join(problems))
        raise SystemExit("请改用 vsce 重新打包（或手工更新 manifest 后重试）")
    log("manifest 校验通过：%s %s（%s）" % (pkg["displayName"], pkg["version"], pkg["publisher"]))
    if check_only:
        return

    backup = OUT + ".bak"
    shutil.copyfile(OUT, backup)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("extension.vsixmanifest", manifest)
        for arc, rel in PAYLOAD:
            src = os.path.join(ROOT, rel)
            if not os.path.exists(src):
                raise SystemExit("缺少负载文件：%s" % rel)
            with io.open(src, "rb") as f:
                z.writestr(arc, f.read())

    with zipfile.ZipFile(OUT) as z:
        if z.testzip() is not None:
            raise SystemExit("生成的 zip 损坏")
        inner = json.loads(z.read("extension/package.json").decode("utf-8"))
        names = z.namelist()

    log("已生成 %s（%d 字节，%d 个条目），旧包备份在 %s" % (OUT, os.path.getsize(OUT), len(names), backup))
    log("包内 keybindings: " + json.dumps(inner["contributes"]["keybindings"], ensure_ascii=False))
    log("安装：cursor --install-extension pretty-commit.vsix --force")


if __name__ == "__main__":
    main()
