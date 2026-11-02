#!/bin/sh
# デモの店に plugin/SelfHarden を入れて有効にする
#   ./install-plugin.sh kagoya|lolipop|all
set -eu
cd "$(dirname "$0")"
one() {
  case "$1" in kagoya) C=self-harden-demo-kagoya-1;; lolipop) C=self-harden-demo-lolipop-php-1;; *) echo "kagoya|lolipop|all"; exit 1;; esac
  copy() {
    docker exec "$C" rm -rf /var/www/html/app/Plugin/SelfHarden
    docker cp ../plugin/SelfHarden "$C:/var/www/html/app/Plugin/SelfHarden"
    docker exec "$C" chown -R www-data:www-data /var/www/html/app/Plugin/SelfHarden
  }
  # CLI には Web 用の制約を読ませない(docs/design.md)
  CONSOLE='cd /var/www/html && php -d memory_limit=-1 bin/console'
  copy
  docker exec -u www-data -e PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d "$C" sh -c "$CONSOLE eccube:plugin:install --code=SelfHarden >/dev/null 2>&1 || true"
  # 初めて入れたあとは、プラグインのファイルを入れ直してから有効にしないと管理画面の経路が読まれなかった(原因は追っていない)
  copy
  docker exec -u www-data -e PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d "$C" sh -c "
    for i in 1 2 3; do
      $CONSOLE eccube:plugin:enable --code=SelfHarden >/dev/null 2>&1 || true
      [ \$($CONSOLE debug:router 2>/dev/null | grep -c self_harden) -gt 0 ] && exit 0
    done
    echo '管理画面の経路が読まれませんでした' >&2; exit 1"
  echo "[$1] SelfHarden を入れた"
}
if [ "$1" = all ]; then one kagoya; one lolipop; else one "$1"; fi
