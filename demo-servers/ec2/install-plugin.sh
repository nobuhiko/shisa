#!/bin/sh
# server-h(EC-CUBE 2.17)に plugin/SelfHarden2 を入れて有効にする。店の人と同じく、管理画面のプラグイン管理から tar.gz を上げる
#   ./ec2/install-plugin.sh
# 入れてあるときは、消さずに(鍵を残したまま)中身だけ新しくして、有効にし直す(受け口も置き直す)
set -eu
cd "$(dirname "$0")"
. ./lib.sh
TGZ=$(cd ../../plugin && ./build-ec2.sh)
TGZ=../../$TGZ
login
id=$(plugin_id)
if [ -z "$id" ]; then
  t=$(curl -s -b "$J" "$ADMIN/ownersstore/" | tid)
  curl -s -c "$J" -b "$J" -o ../.cache/curl/server-h-install.html -F mode=install -F "transactionid=$t" -F "plugin_file=@$TGZ;filename=SelfHarden2.tar.gz" "$ADMIN/ownersstore/"
  grep -q 'プラグインをインストールしました' ../.cache/curl/server-h-install.html || {
    echo '入れられませんでした:' >&2; grep -o 'class="attention">[^<]*' ../.cache/curl/server-h-install.html | head -5 >&2; exit 1; }
  id=$(plugin_id)
  echo "[server-h] SelfHarden2 を入れた(plugin_id=$id)"
else
  # 中身だけ入れ替える(管理画面の「アップデート」は plugin_update.php を要るので使わない)
  D=/var/www/html/data/downloads/plugin/SelfHarden2
  mkdir -p ../.cache/ec2-plugin && rm -rf ../.cache/ec2-plugin/* && tar xzf "$TGZ" -C ../.cache/ec2-plugin
  docker exec "$C" sh -c "rm -rf $D && mkdir -p $D"
  docker cp ../.cache/ec2-plugin/. "$C:$D"
  docker exec "$C" sh -c "chown -R www-data:www-data $D && find $D -exec touch {} + && rm -f /var/www/html/data/Smarty/templates_c/admin/*"
  # opcache は 2 秒ごとにしかファイルの時刻を見ないので、古い中身で動かないように待つ
  sleep 3
  echo "[server-h] SelfHarden2 の中身を新しくした(plugin_id=$id)"
fi
# 有効にする(有効なら一度無効にしてから。有効にするときに受け口を置き直す)
page=$(curl -s -b "$J" "$ADMIN/ownersstore/")
t=$(echo "$page" | tid)
if echo "$page" | grep -q "name=\"disable\" value=\"$id\""; then
  curl -s -c "$J" -b "$J" -o /dev/null -d "mode=disable&plugin_id=$id&transactionid=$t" "$ADMIN/ownersstore/"
  t=$(curl -s -b "$J" "$ADMIN/ownersstore/" | tid)
fi
curl -s -c "$J" -b "$J" -o ../.cache/curl/server-h-enable.html -d "mode=enable&plugin_id=$id&transactionid=$t" "$ADMIN/ownersstore/"
grep -q "name=\"disable\" value=\"$id\"" ../.cache/curl/server-h-enable.html || { echo '有効にできませんでした' >&2; exit 1; }
# 受け口が 4 系のものと同じ中身で置かれたか
docker exec "$C" cat /var/www/html/html/self-harden.php | cmp -s - ../../plugin/SelfHarden/Resource/receiver/self-harden.php || { echo '受け口の中身が違います' >&2; exit 1; }
echo "[server-h] SelfHarden2 を有効にした。設定画面: $ADMIN/load_plugin_config.php?plugin_id=$id"
