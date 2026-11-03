#!/bin/sh
# EC-CUBE 2 系の管理画面(オーナーズストア → プラグイン管理)から入れられる tar.gz を作る
#   ./build-ec2.sh   → plugin/dist/SelfHarden2.tar.gz(直下に plugin_info.php)
# 受け口は 4 系のもの(SelfHarden/Resource/receiver/self-harden.php)を、そのまま写して receiver/ に入れる
set -eu
cd "$(dirname "$0")"
mkdir -p dist
STAGE=dist/.stage-SelfHarden2
OUT=dist/SelfHarden2.tar.gz
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/receiver"
cp SelfHarden2/*.php SelfHarden2/*.tpl "$STAGE/"
cp SelfHarden/Resource/receiver/self-harden.php "$STAGE/receiver/self-harden.php"
cmp -s SelfHarden/Resource/receiver/self-harden.php "$STAGE/receiver/self-harden.php"
# macOS の tar が隠しファイル(._*)を足さないようにする。中身は「./」を付けずに直下に並べる
(cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf ../SelfHarden2.tar.gz *.php *.tpl receiver)
rm -rf "$STAGE"
echo "plugin/$OUT"
