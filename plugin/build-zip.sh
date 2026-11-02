#!/bin/sh
# EC-CUBE 4.2 の管理画面から入れられる zip を作る(zip の直下に composer.json)
set -eu
cd "$(dirname "$0")/SelfHarden"
VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' composer.json)
mkdir -p ../dist
rm -f "../dist/SelfHarden-$VER.zip"
zip -qr "../dist/SelfHarden-$VER.zip" . -x '.*' -x '*/.*'
echo "plugin/dist/SelfHarden-$VER.zip"
