#!/bin/sh
# Wave Flow 一键安装（macOS / Apple Silicon）
# 通过 curl 下载并挂载 dmg，复制 App 到 /Applications。
# 命令行下载不会被打上 Gatekeeper 隔离标记，安装后可直接打开。
set -eu

REPO="Oliver-Ysq/wave-flow"
TMP="$(mktemp -d)"
cleanup() {
  if [ -d "$TMP/mnt" ]; then hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# 解析最新发布中的 aarch64 dmg 地址。
#
# 不使用 GitHub REST API 作为首选：未认证的 API 调用按出口 IP 限流（60 次/小时），
# 公司网络、代理或共享 NAT 下会直接返回 403，导致安装脚本误报“没有 dmg 资产”。
# 这里改为走 GitHub 网页端的两个无鉴权、无限流接口：
#   1. /releases/latest 会 302 到 /releases/tag/<tag>，从最终 URL 取 tag；
#   2. /releases/expanded_assets/<tag> 是资产列表 HTML，从里面筛出 dmg 链接。
# REST API 只作为最后兜底，并允许通过 GITHUB_TOKEN 提高限额。
# 若后续在发布中额外上传一个版本号无关的资产（如 Wave.Flow_aarch64.dmg），
# 可直接改用 /releases/latest/download/<该文件名>，无需再解析 tag。
TAG=""
resolve_dmg_url() {
  TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest" 2>/dev/null |
    sed -n 's#.*/releases/tag/##p')" || TAG=""

  if [ -n "$TAG" ]; then
    asset="$(curl -fsSL "https://github.com/$REPO/releases/expanded_assets/$TAG" 2>/dev/null |
      grep -o 'href="[^"]*aarch64\.dmg"' | head -1 | sed 's/^href="//; s/"$//')" || asset=""
    if [ -n "$asset" ]; then
      # 版本号只用于提示，写到 stderr，避免污染命令替换捕获的 URL。
      echo "· 最新版本：$TAG" >&2
      case "$asset" in
        http*) printf '%s\n' "$asset" ;;
        *) printf 'https://github.com%s\n' "$asset" ;;
      esac
      return 0
    fi
  fi

  # 兜底：REST API（会消耗限流额度，GITHUB_TOKEN 可选）
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    printf '%s\n' "$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
      "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
      grep -o 'https://[^"]*aarch64\.dmg' | head -1)"
  else
    printf '%s\n' "$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
      grep -o 'https://[^"]*aarch64\.dmg' | head -1)"
  fi
}

echo "· 查询最新版本…"
URL="$(resolve_dmg_url || true)"
if [ -z "${URL:-}" ]; then
  echo "✗ 无法获取最新版本的 dmg 下载地址。" >&2
  echo "  可能原因：发布尚未创建、发布中没有 aarch64 dmg 资产，或 GitHub API 触发限流（403）。" >&2
  echo "  可手动下载：https://github.com/$REPO/releases/latest" >&2
  exit 1
fi
echo "· 下载：$URL"
curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "$TMP/wave-flow.dmg" ||
  { echo "✗ dmg 下载失败，请检查网络后重试。" >&2; exit 1; }

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
