#!/bin/sh
# 管理画面から入れられる zip を作る
#   ./build-zip.sh              EC-CUBE 4 系(zip の直下に composer.json)
#   ./build-zip.sh SelfHarden3  EC-CUBE 3.0 系(zip の直下に config.yml)。受け口は 4 系のものを写して入れる
set -eu
cd "$(dirname "$0")"
mkdir -p dist
if [ "${1:-SelfHarden}" = SelfHarden3 ]; then
  VER=$(sed -n 's/^version: *//p' SelfHarden3/config.yml)
  STAGE=dist/.stage-SelfHarden3
  rm -rf "$STAGE" "dist/SelfHarden3-$VER.zip"
  mkdir -p "$STAGE"
  cp -R SelfHarden3/. "$STAGE/"
  mkdir -p "$STAGE/Resource/receiver"
  cp SelfHarden/Resource/receiver/self-harden.php "$STAGE/Resource/receiver/self-harden.php"
  (cd "$STAGE" && zip -qr "../SelfHarden3-$VER.zip" . -x '.*' -x '*/.*')
  rm -rf "$STAGE"
  echo "plugin/dist/SelfHarden3-$VER.zip"
  exit 0
fi
cd SelfHarden
VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' composer.json)
rm -f "../dist/SelfHarden-$VER.zip"
zip -qr "../dist/SelfHarden-$VER.zip" . -x '.*' -x '*/.*'
echo "plugin/dist/SelfHarden-$VER.zip"
