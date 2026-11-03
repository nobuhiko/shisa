# install-plugin.sh と connect-plugin.sh が読む。server-h(EC-CUBE 2.17)の管理画面に curl でログインする
# 使う前に B(店の URL)と J(クッキーの置き場)を決めておく
C=self-harden-demo-ec2-server-h-1
B=http://127.0.0.1:8088
ADMIN=$B/admin
mkdir -p ../.cache/curl
J=../.cache/curl/server-h.jar
# 画面の transactionid を取り出す
tid() { grep -o 'name="transactionid" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//'; }
login() {
  rm -f "$J"
  t=$(curl -s -c "$J" -b "$J" "$ADMIN/" | tid)
  curl -s -c "$J" -b "$J" -o /dev/null -d "mode=login&login_id=admin&password=password&transactionid=$t" "$ADMIN/index.php"
  curl -s -b "$J" -o /dev/null -w '%{http_code}' "$ADMIN/home.php" | grep -q 200 || { echo '管理画面にログインできませんでした' >&2; exit 1; }
}
# プラグイン管理の画面から SelfHarden2 の plugin_id を探す(無ければ空)
plugin_id() { curl -s -b "$J" "$ADMIN/ownersstore/" | grep -o "uninstall([0-9]*, 'SelfHarden2')" | grep -o '[0-9]*' | head -1; }
