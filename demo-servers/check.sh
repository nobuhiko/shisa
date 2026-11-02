#!/bin/sh
# 2 台の制約が本物どおりかを外から確かめる。
#   ./check.sh            すぐ終わる確認だけ
#   ./check.sh --ttl      .user.ini を書き換えてから効くまでも測る(約 5 分待つ)
# 確認用のファイルは店の _check/ に一時的に置き、終わったら消す
set -eu
cd "$(dirname "$0")"
WAIT_TTL=0; [ "${1:-}" = "--ttl" ] && WAIT_TTL=1

php_container() { case "$1" in kagoya) echo self-harden-demo-kagoya-1;; lolipop) echo self-harden-demo-lolipop-php-1;; esac; }
port() { case "$1" in kagoya) echo 8081;; lolipop) echo 8082;; esac; }

get() { # host path -> "status body"
  out=$(curl -s -w '\n%{http_code}' "http://127.0.0.1:$(port "$1")$2")
  code=$(printf '%s' "$out" | tail -n1); body=$(printf '%s' "$out" | sed '$d')
  printf '%s %s' "$code" "$body"
}
put() { # host relpath content
  printf '%s' "$3" | docker exec -i -u www-data "$(php_container "$1")" sh -c "mkdir -p \"\$(dirname /var/www/html/$2)\" && cat > /var/www/html/$2"
}
field() { python3 -c 'import sys,json; d=json.loads(sys.argv[1]); v=d.get(sys.argv[2])
print(json.dumps(v,ensure_ascii=False) if isinstance(v,(dict,list)) else v)' "$1" "$2" 2>/dev/null || echo "-"; }
# 同じパスを n 回開き、memory_limit が want だった回数を返す(FPM は worker ごとに .user.ini をためるので 1 回では決められない)
count_ml() { n=0; i=0; while [ $i -lt "$3" ]; do set -- "$1" "$2" "$3" $(get "$1" "$2"); [ "$(field "$5" memory_limit)" = "$want" ] && n=$((n+1)); i=$((i+1)); done; echo $n; }

for h in kagoya lolipop; do
  C=$(php_container "$h")
  docker exec "$C" rm -rf /var/www/html/_check
  probe=$(cat check/probe.php)
  put "$h" _check/probe.php "$probe"
  # .htaccess の php_value
  put "$h" _check/htvalue/probe.php "$probe"; put "$h" _check/htvalue/.htaccess "php_value memory_limit 77M"
  # .htaccess の php_flag
  put "$h" _check/htflag/probe.php "$probe"; put "$h" _check/htflag/.htaccess "php_flag short_open_tag Off"
  # 新しいディレクトリに最初から .user.ini を置いた場合
  put "$h" _check/uinew/probe.php "$probe"; put "$h" _check/uinew/.user.ini "memory_limit = 88M"
  # 一度開いたディレクトリの .user.ini をあとから書き換えた場合
  put "$h" _check/uichg/probe.php "$probe"
  want=128M; before=$(count_ml "$h" /_check/uichg/probe.php 20)
  put "$h" _check/uichg/.user.ini "memory_limit = 99M"
  want=99M; right_after=$(count_ml "$h" /_check/uichg/probe.php 10)

  set -- $(get "$h" /_check/probe.php); base="$2"
  set -- $(get "$h" /_check/htvalue/probe.php); hv_code=$1; hv=$( [ "$1" = 200 ] && field "$2" memory_limit || echo "-")
  set -- $(get "$h" /_check/htflag/probe.php); hf_code=$1; hf=$( [ "$1" = 200 ] && field "$2" short_open_tag || echo "-")
  set -- $(get "$h" /_check/uinew/probe.php); un=$(field "$2" memory_limit)
  exec_test=$(docker exec "$C" sh -c 'command -v cron crontab' || true)

  echo "== $h"
  echo "sapi                     : $(field "$base" sapi)"
  echo "php_version              : $(field "$base" php_version)"
  echo "eccube_version           : $(field "$base" eccube_version)"
  echo "disable_functions        : $(field "$base" disable_functions)"
  echo "exec 系が呼べるか        : $(field "$base" callable)"
  echo "max_execution_time       : $(field "$base" max_execution_time)"
  echo "memory_limit(既定)      : $(field "$base" memory_limit)"
  echo "user_ini.filename        : $(field "$base" user_ini.filename)"
  echo "user_ini.cache_ttl       : $(field "$base" user_ini.cache_ttl)"
  echo "allow_url_fopen / curl   : $(field "$base" allow_url_fopen) / $(field "$base" curl)"
  echo "cron の実行ファイル      : php から=$(field "$base" cron_binary) / コンテナ内=${exec_test:-なし}"
  echo ".htaccess php_value      : HTTP $hv_code, memory_limit=$hv (書いた値 77M)"
  echo ".htaccess php_flag       : HTTP $hf_code, short_open_tag=$hf (既定 1、書いた値 Off)"
  echo ".user.ini 新しいディレクトリ : memory_limit=$un (書いた値 88M)"
  echo ".user.ini 書き換え直後   : 書く前に 20 回開いて 128M が $before 回、書いた直後に 10 回開いて 99M が $right_after 回"
  eval "BEFORE_$h=\$before"
done

if [ "$WAIT_TTL" = 1 ]; then
  start=$(date +%s)
  echo "== .user.ini の書き換えが効くまで待つ(10 秒おき、最大 330 秒)"
  for h in kagoya lolipop; do eval "DONE_$h="; done
  while :; do
    now=$(date +%s); el=$((now-start))
    for h in kagoya lolipop; do
      eval "d=\$DONE_$h"; [ -n "$d" ] && continue
      want=99M; n=$(count_ml "$h" /_check/uichg/probe.php 10)
      if [ "$n" = 10 ]; then echo "$h: ${el} 秒後に 10 回とも 99M になった"; eval "DONE_$h=1"; fi
    done
    [ -n "$DONE_kagoya" ] && [ -n "$DONE_lolipop" ] && break
    [ $el -ge 330 ] && break
    sleep 10
  done
  for h in kagoya lolipop; do eval "d=\$DONE_$h"; [ -z "$d" ] && echo "$h: 330 秒待っても 99M にならなかった"; done
fi

for h in kagoya lolipop; do docker exec "$(php_container "$h")" rm -rf /var/www/html/_check; done
echo "== 確認用のファイルを消した"
