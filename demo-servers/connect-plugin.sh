#!/bin/sh
# デモの店の管理画面にログインし、プラグインの「API とつなぐ」を送る(ブラウザで押すのと同じ)
#   ./connect-plugin.sh server-a|server-b|server-c|server-d|server-e|server-f
set -eu
cd "$(dirname "$0")"
case "$1" in server-a) P=8081;; server-b) P=8082;; server-c) P=8083;; server-d) P=8084;; server-e) P=8085;; server-f) P=8086;; *) echo "server-a|server-b|server-c|server-d|server-e|server-f"; exit 1;; esac
B=http://127.0.0.1:$P
mkdir -p .cache/curl && J=.cache/curl/$1.jar && rm -f "$J"
t=$(curl -s -c "$J" -b "$J" "$B/admin/login" | grep -o 'name="_csrf_token" value="[^"]*"' | sed 's/.*value="//;s/"//')
curl -s -c "$J" -b "$J" -o /dev/null -d "login_id=admin&password=password&_csrf_token=$t" "$B/admin/login"
tok=$(curl -s -c "$J" -b "$J" "$B/admin/store/plugin/SelfHarden/config" | grep -o 'name="_token" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "_token=$tok" --data-urlencode "api_base=http://api:8787" \
  --data-urlencode "self_base=http://$1" --data-urlencode "public_base=$B" "$B/admin/store/plugin/SelfHarden/connect"
curl -s -c "$J" -b "$J" "$B/admin/store/plugin/SelfHarden/config" | grep -oE "API とつながりました[^<]*|API とつなげませんでした[^<]*" | head -1
curl -s -b "$J" "$B/admin/store/plugin/SelfHarden/runs"; echo
