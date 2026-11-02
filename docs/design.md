# 設計

## デモ用サーバー

Agent が自分で調べて手を選ぶところを見せるための舞台です。脆弱性を作り込む環境ではなく、**古い版に固定した検証環境**です。手元の docker だけで動かし、ポートは 127.0.0.1 にだけ開きます。

| | KAGOYA 風 `kagoya` | ロリポップ風 `lolipop` |
|---|---|---|
| Web と PHP | Apache 2.4.54 + mod_php(`php:8.1.10-apache`) | httpd 2.4.54 + PHP-FPM(`httpd:2.4.54` と `php:8.1.10-fpm` の 2 つのコンテナ) |
| 手元の URL | http://127.0.0.1:8081 | http://127.0.0.1:8082 |
| docker の中の名前 | `http://kagoya` | `http://lolipop` |
| EC-CUBE | 4.2.0(公式の配布物、sha256 を照合) | 同じ |

- PHP 8.1.10 は EC-CUBE 4.2.0 の公開日(2022-09-27)の時点の 8.1 系
- DB はコンテナの中の SQLite(`var/eccube.db`)。いちばん部品が少なくて済む
- 制約(`disable_functions` の exec 系 6 つ、`max_execution_time=30`)は Web から動く PHP にだけ読ませる。CLI に読ませないのは、EC-CUBE のインストールが子プロセスを使うため。レンタルサーバーでも Web とコマンドの PHP は別の設定のことが多い
- 管理画面は `/admin`、ログインは `admin` / `password`(EC-CUBE の既定のまま)

### 制約の確認(2026-11-02、`demo-servers/check.sh` で外から測った値)

| 項目 | KAGOYA 風 | ロリポップ風 | 期待 |
|---|---|---|---|
| SAPI | apache2handler | fpm-fcgi | mod_php / FPM |
| PHP | 8.1.10 | 8.1.10 | 古いパッチの版 |
| EC-CUBE | 4.2.0 | 4.2.0 | 4.2.0 |
| `disable_functions` | exec,shell_exec,system,passthru,proc_open,popen | 同じ | exec 系 6 つ |
| exec 系を呼べるか | 6 つとも呼べない | 6 つとも呼べない | 呼べない |
| `max_execution_time` | 30 | 30 | 30 |
| cron | なし | なし | なし |
| `.htaccess` の `php_value memory_limit 77M` | 200、77M になる | **500** | 効く / 500 |
| `.htaccess` の `php_flag short_open_tag Off` | 200、0 になる | **500** | 効く / 500 |
| `.htaccess` の `SetEnv PHP_VALUE` / `PHP_ADMIN_VALUE` | (mod_php では FastCGI を使わない) | 渡らない(httpd の `ProxyFCGISetEnvIf` で消す) | 渡らない |
| `.user.ini` の `memory_limit = 88M`(新しいディレクトリ) | 128M のまま(**読まれない**) | 88M になる | 読まれない / 効く |
| `user_ini.cache_ttl` | 300 | 300 | 既定の 300 |
| `allow_url_fopen` / curl | 1 / あり | 1 / あり | 使える |

確かめ方: 店の `_check/` の下にディレクトリごとに確認用の PHP と `.htaccess` / `.user.ini` を置き、外から curl で開いて `ini_get` の値と HTTP の状態を見た。終わったら `_check/` は消している。

測っていないこと: 一度読まれたディレクトリの `.user.ini` を書き換えたあと、効くまでにかかる時間。FPM は worker ごとに読んだ結果をためるので、開くたびに結果が変わる。ここは Agent が自分で調べて気づくところなので、この表では答えを書かない。

## API(頭)

- `api/src/agent.ts` の `step()` が 1 歩。Claude を 1 回呼び、出てきた道具を実行して保存する。`api/src/server.ts` が、点検が終わるまで `step()` を回す(`wait` があればその分あけて)
- 道具(`api/src/tools.ts`): `inspect` `list_dir` `read_file` `write_file` `restore` `list_backups` は受け口の操作そのまま。`http_get` は API から店を外から開く(同じ origin だけ)。`lab_test` / `probe_lab` は小部屋に書いて外から probe を開く。`wait` と `report`。公開の情報は Anthropic の `web_search` / `web_fetch`
- 鍵: Claude の API キーはリポジトリ直下の `.env`(コミットしない)から docker compose の `env_file` で読む。店には置かない

```sh
cd demo-servers && docker compose up -d kagoya lolipop-php lolipop
cd ../api && docker compose up -d --build        # 鍵は ../.env の ANTHROPIC_API_KEY
cd ../demo-servers && ./install-plugin.sh all    # プラグインを入れる(受け口が置かれる)
./connect-plugin.sh kagoya                       # 管理画面の「API とつなぐ」と同じ。つないだら点検が自分で始まる
open http://127.0.0.1:8081/admin/store/plugin/SelfHarden/config   # 開くだけで経過と結果が流れる
cd ../api && npx tsx scripts/dev-shop.ts break kagoya            # わざと壊して、同じリクエストの中で戻るかを確かめる
```

## プラグイン(ガワ)

- `plugin/SelfHarden/`(EC-CUBE 4.2、コード `SelfHarden`)。入れると `self-harden.php` を店の直下に置く
- 管理画面「オーナーズストア → プラグイン → self-harden の設定」: API とつなぐ。つないだら API が自分で点検を始め、そのあとも決まった間隔で点検する。画面は開くだけで、いま動いている点検の経過(Agent の一言・道具・結果の 1 行)と、終わったら報告が流れる。通知の URL を貼ると、動いている点検に渡す(動いていなければ新しく始める)
- `plugin/build-zip.sh` で管理画面から入れられる zip、`demo-servers/install-plugin.sh` でデモの店に直接入れる
