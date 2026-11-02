#!/bin/sh
# デモの店に plugin/SelfHarden を入れて有効にする
#   ./install-plugin.sh server-a|server-b|all
set -eu
cd "$(dirname "$0")"
one() {
  case "$1" in server-a) C=self-harden-demo-server-a-1;; server-b) C=self-harden-demo-server-b-php-1;; *) echo "server-a|server-b|all"; exit 1;; esac
  copy() {
    docker exec "$C" rm -rf /var/www/html/app/Plugin/SelfHarden
    docker cp ../plugin/SelfHarden "$C:/var/www/html/app/Plugin/SelfHarden"
    docker exec "$C" chown -R www-data:www-data /var/www/html/app/Plugin/SelfHarden
    # docker cp は元の時刻を写すので、今の時刻にそろえる(キャッシュより古いファイルに見えないように)
    docker exec "$C" find /var/www/html/app/Plugin/SelfHarden -exec touch {} +
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
      $CONSOLE cache:clear >/dev/null 2>&1 || true
      [ \$($CONSOLE debug:router 2>/dev/null | grep -c self_harden) -gt 0 ] && exit 0
    done
    echo '管理画面の経路が読まれませんでした' >&2; exit 1"
  echo "[$1] SelfHarden を入れた"
}
if [ "$1" = all ]; then one server-a; one server-b; else one "$1"; fi
