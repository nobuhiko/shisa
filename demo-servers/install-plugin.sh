#!/bin/sh
# デモの店に plugin/SelfHarden を入れて有効にする
#   ./install-plugin.sh kagoya|lolipop|all
set -eu
cd "$(dirname "$0")"
one() {
  case "$1" in kagoya) C=self-harden-demo-kagoya-1;; lolipop) C=self-harden-demo-lolipop-php-1;; *) echo "kagoya|lolipop|all"; exit 1;; esac
  docker exec "$C" rm -rf /var/www/html/app/Plugin/SelfHarden
  docker cp ../plugin/SelfHarden "$C:/var/www/html/app/Plugin/SelfHarden"
  docker exec "$C" chown -R www-data:www-data /var/www/html/app/Plugin/SelfHarden
  # CLI には Web 用の制約を読ませない(docs/design.md)
  docker exec -u www-data -e PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d "$C" sh -c 'cd /var/www/html && php bin/console eccube:plugin:install --code=SelfHarden && php bin/console eccube:plugin:enable --code=SelfHarden && php bin/console cache:clear'
  echo "[$1] SelfHarden を入れた"
}
if [ "$1" = all ]; then one kagoya; one lolipop; else one "$1"; fi
