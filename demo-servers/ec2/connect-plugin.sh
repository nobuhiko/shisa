#!/bin/sh
# server-h(EC-CUBE 2.17)の管理画面にログインし、プラグインの設定画面の「API とつなぐ」を送る(ブラウザで押すのと同じ)
#   ./ec2/connect-plugin.sh
set -eu
cd "$(dirname "$0")"
. ./lib.sh
login
id=$(plugin_id)
[ -n "$id" ] || { echo 'SelfHarden2 が入っていません(先に ./ec2/install-plugin.sh)' >&2; exit 1; }
P="$ADMIN/load_plugin_config.php?plugin_id=$id"
t=$(curl -s -b "$J" "$P" | tid)
curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "transactionid=$t" --data-urlencode mode=connect --data-urlencode "api_base=http://api:8787" \
  --data-urlencode "self_base=http://127.0.0.1:8088" --data-urlencode "public_base=$B" "$P"
page=$(curl -s -b "$J" "$P")
echo "$page" | grep -oE "API とつながりました[^<]*|API とつなげませんでした[^<]*" | head -1
t=$(echo "$page" | tid)
curl -s -b "$J" "$P&mode=runs&transactionid=$t"; echo
