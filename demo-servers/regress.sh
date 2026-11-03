#!/bin/sh
# 回帰の点検: デモのお店をまっさらにし、同じお知らせの URL で一斉に点検を走らせ、終わったら結果を表にする
#   ./regress.sh [server-a server-b server-c server-d]   (省略で全部)
#   費用: 1 店あたり初回の上限まで($12)。終わるまで 10〜20 分
set -eu
cd "$(dirname "$0")"
ADV="${ADV:-https://www.kagoya.jp/news/2026102337094/}"
SERVERS="${*:-server-a server-b server-c server-d}"
port() { case "$1" in server-a) echo 8081;; server-b) echo 8082;; server-c) echo 8083;; server-d) echo 8084;; esac; }
vols() { case "$1" in server-b) echo "server-b server-b-php";; *) echo "$1";; esac; }

(cd ../api && SH_AUTO_ON_CONNECT=0 docker compose up -d --build >/dev/null 2>&1)
for s in $SERVERS; do
  docker compose rm -sf $(vols "$s") >/dev/null 2>&1
  docker volume rm "self-harden-demo_${s}-docroot" >/dev/null 2>&1 || true
done
docker compose up -d $(for s in $SERVERS; do vols "$s"; done) >/dev/null 2>&1
RUNS=""
for s in $SERVERS; do
  c=self-harden-demo-$s-1; [ "$s" = server-b ] && c=self-harden-demo-server-b-php-1
  for i in $(seq 1 90); do docker logs "$c" 2>&1 | grep -q "\[setup\] 完了" && break; sleep 5; done
  ./install-plugin.sh "$s" >/dev/null
  for i in $(seq 1 20); do curl -sf 127.0.0.1:8787/health >/dev/null && break; sleep 1; done
  ./connect-plugin.sh "$s" >/dev/null
  B=http://127.0.0.1:$(port "$s"); J=.cache/curl/$s.jar
  tok=$(curl -s -c "$J" -b "$J" "$B/admin/store/plugin/SelfHarden/config" | grep -o 'name="_token" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
  curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "_token=$tok" --data-urlencode "advisory_url=$ADV" "$B/admin/store/plugin/SelfHarden/run"
  sleep 2
  id=$(curl -s -b "$J" "$B/admin/store/plugin/SelfHarden/runs" | grep -o '"run_id":"run_[0-9a-f]*"' | head -1 | sed 's/.*"\(run_[0-9a-f]*\)"/\1/')
  echo "[$s] $id"
  RUNS="$RUNS $s:$id"
done
# 全部が終わるまで待って、表にする
node ../api/scripts/regress-report.mjs ../api/data/runs $RUNS
