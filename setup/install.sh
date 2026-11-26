#!/bin/sh
set -eu
if [ "$(uname)" = Darwin ]; then
  launchctl bootout "gui/$(id -u)/com.totalrecall.serve" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.totalrecall.serve.plist"
else
  systemctl --user disable --now totalrecall 2>/dev/null || true
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/totalrecall.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi
