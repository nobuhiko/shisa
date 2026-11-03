#!/bin/sh
# 回帰の点検: デモのお店をまっさらにし、同じお知らせの URL で一斉に点検を走らせ、終わったら結果を表にする
#   ./regress.sh [server-a ... server-h]   (省略で server-a〜server-d)
#   server-g は EC-CUBE 3.0、server-h は EC-CUBE 2.17(別の compose: docker-compose.ec2.yml)
#   費用: 1 店あたり初回の上限まで($12)。終わるまで 10〜20 分
set -eu
cd "$(dirname "$0")"
ADV="${ADV:-https://www.kagoya.jp/news/2026102337094/}"
SERVERS="${*:-server-a server-b server-c server-d}"
port() { case "$1" in server-a) echo 8081;; server-b) echo 8082;; server-c) echo 8083;; server-d) echo 8084;; server-e) echo 8085;; server-f) echo 8086;; server-g) echo 8087;; server-h) echo 8088;; esac; }
svcs() { case "$1" in server-b) echo "server-b server-b-php";; *) echo "$1";; esac; }

(cd ../api && SH_AUTO_ON_CONNECT=0 docker compose up -d --build >/dev/null 2>&1)
# まっさらにする
for s in $SERVERS; do
  if [ "$s" = server-h ]; then
    docker compose -f docker-compose.ec2.yml down -v >/dev/null 2>&1
    docker compose -f docker-compose.ec2.yml up -d >/dev/null 2>&1
  else
    docker compose rm -sf $(svcs "$s") >/dev/null 2>&1
    docker volume rm "self-harden-demo_${s}-docroot" >/dev/null 2>&1 || true
  fi
done
docker compose up -d $(for s in $SERVERS; do [ "$s" = server-h ] || svcs "$s"; done) >/dev/null 2>&1
RUNS=""
for s in $SERVERS; do
  B=http://127.0.0.1:$(port "$s")
  for i in $(seq 1 120); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/")" = 200 ] && break; sleep 5; done
  sleep 5
  for i in $(seq 1 20); do curl -sf 127.0.0.1:8787/health >/dev/null && break; sleep 1; done
  case "$s" in
    server-h)
      ./ec2/install-plugin.sh >/dev/null
      ./ec2/connect-plugin.sh >/dev/null
      J=.cache/curl/server-h.jar; U="$B/admin/load_plugin_config.php?plugin_id=10000"
      t=$(curl -s -c "$J" -b "$J" "$U" | grep -o 'name="transactionid" value="[^"]*"\|transactionid[^,]*: *"[^"]*"' | head -1 | grep -o '[0-9a-f]\{20,\}')
      out=$(curl -s -c "$J" -b "$J" --data-urlencode "mode=run" --data-urlencode "transactionid=$t" --data-urlencode "advisory_url=$ADV" "$U") ;;
    server-g)
      ./install-plugin.sh "$s" >/dev/null
      ./connect-plugin.sh "$s" >/dev/null
      J=.cache/curl/$s.jar
      tok=$(curl -s -b "$J" -c "$J" "$B/admin/plugin/SelfHarden3/config" | grep -o '_token" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
      out=$(curl -s -b "$J" -c "$J" --data-urlencode "_token=$tok" --data-urlencode "advisory_url=$ADV" "$B/admin/plugin/SelfHarden3/run") ;;
    *)
      ./install-plugin.sh "$s" >/dev/null
      ./connect-plugin.sh "$s" >/dev/null
      J=.cache/curl/$s.jar
      tok=$(curl -s -c "$J" -b "$J" "$B/admin/store/plugin/SelfHarden/config" | grep -o 'name="_token" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
      curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "_token=$tok" --data-urlencode "advisory_url=$ADV" "$B/admin/store/plugin/SelfHarden/run"
      sleep 2
      out=$(curl -s -b "$J" "$B/admin/store/plugin/SelfHarden/runs")
      # 4.3 は有効にしたときの自動のメンテナンスが残ることがあるので外す
      [ "$s" = server-f ] && docker exec "self-harden-demo-$s-1" rm -f /var/www/html/.maintenance 2>/dev/null || true ;;
  esac
  id=$(echo "$out" | grep -o '"run_id":"run_[0-9a-f]*"' | head -1 | sed 's/.*"\(run_[0-9a-f]*\)"/\1/')
  echo "[$s] $id"
  RUNS="$RUNS $s:$id"
done
# 全部が終わるまで待って、表にする
node ../api/scripts/regress-report.mjs ../api/data/runs $RUNS
