#!/bin/sh
# 初回だけ EC-CUBE 3.0.18 を展開して、同梱のインストーラー(eccube_install.php)で入れる。2 回目以降は何もしない
# データベースは SQLite(3.0 の CLI インストーラーが持っている選び方。公式のテストもこれで回している)
set -eu
DOCROOT=/var/www/html
if [ -f "$DOCROOT/app/config/eccube/config.yml" ]; then
  echo "[setup] EC-CUBE 3 は既にインストール済み"
  exit 0
fi
echo "[setup] EC-CUBE 3.0.18 を展開"
tar xzf /opt/eccube/eccube-3.0.18.tar.gz -C "$DOCROOT" --strip-components=1
cd "$DOCROOT"
# CLI には Web 用の制約(web.d)を読ませない
export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d
export ADMIN_USER=admin ADMIN_PASS=password ADMIN_MAIL=admin@example.com SHOP_NAME='EC-CUBE SHOP'
export ADMIN_ROUTE=admin ROOT_URLPATH= MAIL_BACKEND=smtp MAIL_HOST=localhost MAIL_PORT=25
# 第 2 引数 none: composer は配布物を作るときに済ませてある
php -d memory_limit=-1 eccube_install.php sqlite3 none --no-ansi
chown -R www-data:www-data "$DOCROOT"
echo "[setup] 完了"
