#!/bin/bash
# slack-cli - Diagnostic Script (macOS/Linux)
#
#   ./diagnose.sh          report runtime, Chrome, configuration, network, auth cache
#   ./diagnose.sh --reset  delete the auth cache and the Chrome profile (forces a fresh login)
#
# Reports metadata only. It never prints the token or cookies.

AUTH_FILE="$HOME/.slack-cli-auth.json"
PROFILE_DIR="${SLACK_CLI_PROFILE:-$HOME/.slack-cli}"
CONFIG_FILE="$HOME/.config/slack-cli/config.json"

if [ "$1" = "--reset" ] || [ "$1" = "-r" ]; then
    echo "Resetting slack-cli session state..."
    echo ""
    if [ -f "$AUTH_FILE" ]; then
        rm "$AUTH_FILE"
        echo "   deleted auth cache: $AUTH_FILE"
    else
        echo "   auth cache not found (already clean)"
    fi
    if [ -d "$PROFILE_DIR" ]; then
        rm -rf "$PROFILE_DIR"
        echo "   deleted browser profile: $PROFILE_DIR"
    else
        echo "   browser profile not found (already clean)"
    fi
    echo ""
    echo "Reset complete. The next command opens Chrome for a fresh sign-in."
    exit 0
fi

echo "slack-cli - Diagnostics"
echo "======================="
echo ""

echo "Node.js:"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
    if [ "$MAJOR" -ge 22 ]; then
        echo "   ok: $NODE_VERSION (>= 22.12 required)"
    else
        echo "   FAIL: $NODE_VERSION is too old (need >= 22.12)"
    fi
else
    echo "   FAIL: not installed"
fi
echo ""

echo "Google Chrome:"
if [ -n "$CHROME_PATH" ]; then
    if [ -f "$CHROME_PATH" ]; then
        echo "   ok: CHROME_PATH=$CHROME_PATH"
    else
        echo "   FAIL: CHROME_PATH set but not found: $CHROME_PATH"
    fi
else
    if [[ "$OSTYPE" == "darwin"* ]]; then
        CHROME_PATHS=(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
        )
    else
        CHROME_PATHS=(
            "/usr/bin/google-chrome"
            "/usr/bin/google-chrome-stable"
            "/usr/bin/chromium-browser"
            "/usr/bin/chromium"
            "/snap/bin/chromium"
        )
    fi
    FOUND_CHROME=""
    for p in "${CHROME_PATHS[@]}"; do
        if [ -f "$p" ]; then FOUND_CHROME="$p"; break; fi
    done
    if [ -n "$FOUND_CHROME" ]; then
        echo "   ok: $FOUND_CHROME"
    else
        echo "   FAIL: not found in standard locations (set CHROME_PATH=/path/to/chrome)"
    fi
fi
echo ""

echo "Configuration:"
WORKSPACE="${SLACK_WORKSPACE_URL:-}"
SOURCE="env SLACK_WORKSPACE_URL"
if [ -z "$WORKSPACE" ] && [ -f "$CONFIG_FILE" ]; then
    MODE=$(stat -f '%Lp' "$CONFIG_FILE" 2>/dev/null || stat -c '%a' "$CONFIG_FILE" 2>/dev/null)
    if [ "$MODE" != "600" ]; then
        echo "   FAIL: $CONFIG_FILE is mode $MODE; the tool refuses it. Run: chmod 600 $CONFIG_FILE"
    fi
    WORKSPACE=$(sed -n 's/.*"workspace_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG_FILE" | head -1)
    SOURCE="$CONFIG_FILE"
fi
if [ -n "$WORKSPACE" ]; then
    echo "   ok: workspace $WORKSPACE (from $SOURCE)"
else
    echo "   FAIL: no workspace configured"
    echo "         export SLACK_WORKSPACE_URL=https://yourco.slack.com/"
    echo "         or write $CONFIG_FILE (chmod 600) as {\"workspace_url\": \"https://yourco.slack.com/\"}"
fi
[ -n "$SLACK_ENTERPRISE_ID" ] && echo "   enterprise id pinned: SLACK_ENTERPRISE_ID is set"
echo ""

if [ -n "$WORKSPACE" ]; then
    echo "Network ($WORKSPACE):"
    CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$WORKSPACE")
    case "$CODE" in
        200|301|302) echo "   ok: reachable (HTTP $CODE)" ;;
        *) echo "   FAIL: not reachable (HTTP ${CODE:-none}) — VPN or proxy required?" ;;
    esac
    echo ""
fi

echo "Authentication cache:"
if [ -f "$AUTH_FILE" ]; then
    MODE=$(stat -f '%Lp' "$AUTH_FILE" 2>/dev/null || stat -c '%a' "$AUTH_FILE" 2>/dev/null)
    echo "   ok: $AUTH_FILE exists (mode $MODE)"
    [ "$MODE" != "600" ] && echo "   WARN: expected mode 600 — run: chmod 600 $AUTH_FILE"
    if grep -q '"token"' "$AUTH_FILE" 2>/dev/null; then
        echo "   ok: token field present"
    else
        echo "   WARN: token field missing (re-run: node cli.js login)"
    fi
    CACHED_WS=$(sed -n 's/.*"workspace"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AUTH_FILE" | head -1)
    [ -n "$CACHED_WS" ] && echo "   session belongs to: $CACHED_WS"
else
    echo "   none yet — the first command opens Chrome for sign-in (or run: node cli.js login)"
fi
echo ""

echo "Browser profile:"
if [ -d "$PROFILE_DIR" ]; then
    echo "   ok: $PROFILE_DIR exists"
else
    echo "   none yet — created on first sign-in"
fi
echo ""

echo "======================="
echo "Helpful commands:"
echo "   Who am I:      node cli.js whoami"
echo "   Fresh login:   node cli.js login"
echo "   Reset session: $0 --reset"
echo "   Cache details: ls -l $AUTH_FILE   (metadata only; never cat this file — it holds a live token)"
