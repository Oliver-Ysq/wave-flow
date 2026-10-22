#!/bin/sh
# Wave Flow 一键安装（macOS / Apple Silicon）
# 通过 curl 下载并挂载 dmg，复制 App 到 /Applications。
# 命令行下载不会被打上 Gatekeeper 隔离标记，安装后可直接打开。
set -e

REPO="Oliver-Ysq/wave-flow"
TMP="$(mktemp -d)"
cleanup() {
  if [ -d "$TMP/mnt" ]; then hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "· 查询最新版本…"
URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o 'https://[^"]*aarch64\.dmg' | head -1)"
if [ -z "$URL" ]; then
  echo "没有找到最新发布的 dmg 资产。" >&2
  exit 1
fi
echo "· 下载：$URL"
curl -fsSL "$URL" -o "$TMP/wave-flow.dmg"

echo "· 挂载 dmg…"
hdiutil attach -quiet -nobrowse -mountpoint "$TMP/mnt" "$TMP/wave-flow.dmg"

if [ -d "/Applications/Wave Flow.app" ]; then
  echo "· 移除旧版本…"
  rm -rf "/Applications/Wave Flow.app"
fi
echo "· 安装到 /Applications…"
cp -R "$TMP/mnt/Wave Flow.app" /Applications/

echo "✓ 安装完成：/Applications/Wave Flow.app"
echo "  首次启动后，请在设置页选择一个已登录的本机 CLI（Codex / DeepSeek Harness / Claude Code）。"
