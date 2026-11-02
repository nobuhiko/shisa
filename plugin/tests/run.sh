#!/bin/sh
# 受け口の単体テスト。docker の php:<版>-cli の中で php -S を立てて、署名したリクエストを送る
#   ./tests/run.sh          PHP 8.1 と 7.4 の両方
#   ./tests/run.sh 8.1      その版だけ
set -eu
cd "$(dirname "$0")/.."
VERSIONS="${1:-8.1 7.4}"
status=0
for v in $VERSIONS; do
  echo "=== PHP $v"
  docker run --rm -v "$(cd .. && pwd):/repo" -w /repo/plugin -e PHP_CLI_SERVER_WORKERS=4 "php:$v-cli" php tests/receiver_test.php || status=1
done
exit $status
