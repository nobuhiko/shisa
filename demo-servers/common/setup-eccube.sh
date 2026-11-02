#!/bin/sh
# 初回だけ EC-CUBE 4.2.0 を展開してインストールする。2 回目以降は何もしない
set -eu
DOCROOT=/var/www/html
if [ -f "$DOCROOT/.env" ]; then
  echo "[setup] EC-CUBE は既にインストール済み"
  exit 0
fi
echo "[setup] EC-CUBE 4.2.0 を展開"
tar xzf /opt/eccube/eccube-4.2.0.tar.gz -C "$DOCROOT" --strip-components=1
cd "$DOCROOT"
# インストールは CLI で行う。CLI には Web 用の制約(web.d)を読ませない
export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d
export APP_ENV=prod APP_DEBUG=0
export DATABASE_URL="sqlite:///$DOCROOT/var/eccube.db"
export DATABASE_SERVER_VERSION=3
export MAILER_DSN="null://null"
export ECCUBE_AUTH_MAGIC="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export ECCUBE_ADMIN_ROUTE=admin
export ECCUBE_TEMPLATE_CODE=default
export ECCUBE_LOCALE=ja
export TRUSTED_HOSTS="$TRUSTED_HOSTS_VALUE"
php -d memory_limit=-1 bin/console eccube:install --no-interaction
# --no-interaction では .env が書かれないので、同じ値で書く(店の人がインストーラーで作る .env と同じ中身)
cat > .env <<ENV
APP_ENV=$APP_ENV
APP_DEBUG=$APP_DEBUG
DATABASE_URL=$DATABASE_URL
DATABASE_SERVER_VERSION=$DATABASE_SERVER_VERSION
DATABASE_CHARSET=utf8
MAILER_DSN=$MAILER_DSN
ECCUBE_AUTH_MAGIC=$ECCUBE_AUTH_MAGIC
ECCUBE_ADMIN_ROUTE=$ECCUBE_ADMIN_ROUTE
ECCUBE_TEMPLATE_CODE=$ECCUBE_TEMPLATE_CODE
ECCUBE_LOCALE=$ECCUBE_LOCALE
TRUSTED_HOSTS=$TRUSTED_HOSTS
ENV
php bin/console cache:clear --no-warmup >/dev/null
chown -R www-data:www-data "$DOCROOT"
echo "[setup] 完了"
