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
  # CLI には Web 用の制約を読ませない(docs/design.md)。
  # 入れた直後の有効化では管理画面の経路が読まれないことがあるので、読まれるまで有効化を流し直す(何度流しても同じ)
  docker exec -u www-data -e PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d "$C" sh -c 'cd /var/www/html && C="php -d memory_limit=-1 bin/console" && ($C eccube:plugin:install --code=SelfHarden || true)
    for i in 1 2 3 4; do
      $C eccube:plugin:enable --code=SelfHarden >/dev/null 2>&1 || true
      [ "$($C debug:router 2>/dev/null | grep -c self_harden)" -gt 0 ] && exit 0
    done
    echo "管理画面の経路が読まれませんでした" >&2; exit 1'
  echo "[$1] SelfHarden を入れた"
}
if [ "$1" = all ]; then one kagoya; one lolipop; else one "$1"; fi
