#!/bin/sh
# 照らし合わせを確かめるための仕込み(中身は無害)。攻撃のコードは入れない
#  1. 本体のファイルを 1 つ書き換える(特定のクエリのときに見出しを 1 つ足すだけの行)
#  2. 公開ディレクトリに、覚えのない PHP のファイルを 1 つ置く(ok と出すだけ)
set -eu
DOCROOT=/var/www/html
F="$DOCROOT/src/Eccube/Controller/TopController.php"
if ! grep -q 'X-Demo-Planted' "$F"; then
  sed -i "s#^namespace Eccube\\\\Controller;#namespace Eccube\\\\Controller;\n\nif (isset(\$_GET['__demo'])) { header('X-Demo-Planted: 1'); }#" "$F"
fi
printf '%s\n' '<?php' "echo 'ok';" > "$DOCROOT/sitemap-gen.php"
chown www-data:www-data "$F" "$DOCROOT/sitemap-gen.php"
echo "[plant] 仕込みを入れた"
