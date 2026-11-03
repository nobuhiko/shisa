#!/bin/sh
# 初回だけ EC-CUBE 2.17.2 を展開して、同梱のインストーラー(eccube_install.sh)で入れる。2 回目以降は何もしない
# データベースは PostgreSQL(2 系が使えるのは PostgreSQL と MySQL だけ。SQLite は使えない)。server-h だけの小さな箱で動かす
set -eu
ROOT=/var/www/html
if [ -f "$ROOT/data/config/config.php" ] && grep -q ECCUBE_INSTALL "$ROOT/data/config/config.php"; then
  echo "[setup] EC-CUBE 2 は既にインストール済み"
  exit 0
fi
echo "[setup] EC-CUBE 2.17.2 を展開"
tar xzf /opt/eccube/eccube-2.17.2.tar.gz -C "$ROOT" --strip-components=1
cd "$ROOT"
# CLI には Web 用の制約(web.d)を読ませない
export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d
export DBSERVER="${ECCUBE_DB_HOST:-server-h-db}" DBNAME=eccube_db DBUSER=eccube_db_user DBPASS=password
echo "[setup] データベースを待つ"
i=0
until pg_isready -q -h "$DBSERVER" -U "$DBUSER"; do
  i=$((i + 1)); [ $i -gt 60 ] && { echo "[setup] データベースにつながりません" >&2; exit 1; }
  sleep 1
done
# 管理者は admin / password(インストーラーの既定のまま)。店の URL はブラウザから開く URL
export HTTP_URL="${ECCUBE_HTTP_URL:-http://127.0.0.1:8088/}" HTTPS_URL="${ECCUBE_HTTP_URL:-http://127.0.0.1:8088/}"
export ROOT_URLPATH=/ ADMIN_DIR=admin/ SHOP_NAME='EC-CUBE SHOP' ADMIN_MAIL=admin@example.com MAIL_BACKEND=mail
sh eccube_install.sh pgsql >/var/log/eccube-install.log 2>&1 || { cat /var/log/eccube-install.log >&2; exit 1; }
grep -q ECCUBE_INSTALL data/config/config.php || { cat /var/log/eccube-install.log >&2; exit 1; }
chown -R www-data:www-data "$ROOT"
echo "[setup] 完了"
