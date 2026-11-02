# つなぎ目: API(頭)と受け口(手足)

この文書が 3 つの部品(`api/`、`plugin/`、`demo-servers/`)の契約です。ここを変えるときは 3 つを同時に直します。

## 登場するもの

| 名前 | 場所 | 役目 |
|---|---|---|
| API | 店の外(手元では docker、あとで Workers) | Claude を呼び、次の一手を決め、受け口を 1 歩ずつ呼ぶ。時計を持つ |
| 受け口 | 店の公開ディレクトリ直下の `self-harden.php`(素の PHP 1 枚) | 署名を確かめ、決まった操作を 1 回だけやって返す |
| 小部屋 | 公開ディレクトリ直下の `self-harden-lab/` | 設定を試す場所。中身は受け口が置く固定の `probe.php` と、試し用の `.htaccess` / `.user.ini` だけ |
| 置き場 | `<店のルート>/var/self-harden/` | 鍵(`config.php`)、退避ファイル(`backups/`)、使った nonce(`nonces/`)、小部屋の合言葉(`lab-token`)。Web から読めない場所 |
| プラグイン | EC-CUBE 4.2 の `app/Plugin/SelfHarden/` | 受け口を置き、API と鍵を交換し、管理画面に「点検」と「通知の URL を貼る」を出す |

EC-CUBE 4.2 は店のルート = 公開ディレクトリ(`index.php` がある場所)。以下 `<root>` と書く。

## 鍵と設定

インストール時にプラグインが作る `<root>/var/self-harden/config.php`:

```php
<?php return [
  'shop_id'    => 'shp_xxxxxxxx',      // API に登録したときの ID
  'secret'     => '<64 文字の 16 進数>', // random_bytes(32) を bin2hex したもの
  'api_base'   => 'http://api:8787',    // 店 → API の呼び出し先
  'self_base'  => 'http://localhost',   // 受け口が自分の店を開いて確かめるときの URL(同じ箱の中から見た URL)
  'public_base'=> 'http://localhost:8081', // 外から見た店の URL(表示用)
  'created_at' => 1730000000,
];
```

`config.php` は `return` で配列を返すだけなので、仮に Web から開かれても何も出ない。受け口はこれを `include` せず、`file_get_contents` して決まった形の文字列として読む(受け口の「include を持たない」を守るため。読み方は `plugin/` 側で決める。JSON の `config.json` に `<?php exit; ?>` の前置きを付ける形でもよい)。

鍵の交換(プラグインの「API とつなぐ」ボタン):

1. プラグインが `secret` を作る
2. プラグインが `POST {api_base}/v1/shops` に `{shop_id?, receiver_url, shop_url, secret, platform: "eccube-4.2", plugin_version}` を送る(本番は TLS 前提)
3. API が保存し、`{shop_id}` を返す。続けて API が受け口に `ping` を署名付きで送り、通れば `connected` になる
4. プラグインが `config.php` を書く(順番は 1→4→2→3 でもよい。受け口が ping に答えるには config が先に要る)

登録はだれでもできるが、受け口は自分の `secret` で署名されたものしか通さないので、他人の店を登録しても何もできない。

## 署名(API → 受け口、店 → API、両方向とも同じ形)

リクエストに付ける見出し:

| 見出し | 中身 |
|---|---|
| `X-SH-Shop` | `shop_id` |
| `X-SH-Timestamp` | UNIX 秒 |
| `X-SH-Nonce` | 16 バイト以上の乱数を 16 進数で(32 文字以上、`[0-9a-f]` のみ、64 文字まで) |
| `X-SH-Signature` | `hex(HMAC-SHA256(secret, 署名する文字列))` |

署名する文字列(改行は `\n`):

```
SH1
{METHOD}
{PATH}            ← クエリを含まないパス。受け口なら "/self-harden.php"
{X-SH-Shop}
{X-SH-Timestamp}
{X-SH-Nonce}
{hex(SHA256(body))}   ← 本文が空なら空文字の SHA256
```

受け口の確かめ方(どれか 1 つでも外れたら 401、本文は `{"ok":false,"error":"unauthorized"}` だけ。理由は返さない):

- 見出しが全部ある。形が正しい
- `|now - timestamp| <= 300`
- 署名が合う(`hash_equals`)
- nonce が未使用。使った nonce は `var/self-harden/nonces/` に `timestamp` 付きで残し、600 秒より古いものは消す。ファイル作成は `fopen(..., 'x')` で原子的に
- 順番: 形 → 時刻 → 署名 → nonce の記録(署名が通ったものだけ記録する。偽物で置き場を埋められないように)

返事にも署名を付ける: `X-SH-Signature: hex(HMAC-SHA256(secret, "SH1-RES\n{リクエストの nonce}\n" + hex(SHA256(返事の本文))))`。API は返事の署名を確かめてから使う(途中で書き換えられた返事で判断しないため)。

## 受け口の呼び方

```
POST /self-harden.php
Content-Type: application/json

{"op": "<操作名>", "args": { ... }}
```

返事はいつも JSON。`{"ok": true, "result": {...}}` か `{"ok": false, "error": "<短いコード>", "detail": "<人が読む説明>"}`。HTTP の状態は、署名で弾いたら 401、それ以外は 200(操作の失敗も 200 + `ok:false`)。本文は 1MB まで。1 回の操作は 20 秒以内に終わらせる(サーバーの 30 秒の上限に余裕を持たせる)。

`GET /self-harden.php` は署名なしで `{"ok":true,"service":"self-harden-receiver"}` だけ返す(生きているかの確認用。中身は何も出さない)。

## 操作の一覧

操作は下の 8 つだけ。これ以外の `op` は `unknown_op`。

### `ping`
- args: なし
- result: `{receiver_version, php_version, time}`

### `inspect`
自分の置かれたサーバーを調べる。読むだけ。
- args: `{"sections": ["php","ini","extensions","server","app","paths"]}`(省略で全部)
- result:
  - `php`: `version`, `sapi`(`php_sapi_name()`), `os`, `zend_version`
  - `ini`: `ini_get_all(null, false)` の全部(値は文字列)。ただし名前に `password`/`secret`/`key` を含むものは値を伏せる
  - `extensions`: `get_loaded_extensions()` と、それぞれの `phpversion($ext)`
  - `server`: `$_SERVER` のうち `SERVER_SOFTWARE`, `SERVER_NAME`, `SERVER_PORT`, `HTTPS`, `DOCUMENT_ROOT`, `GATEWAY_INTERFACE`。`function_exists('apache_get_modules')` なら `apache_get_modules()`
  - `app`: EC-CUBE の版(`src/Eccube/Common/Constant.php` を読んで `VERSION` を正規表現で抜く。include しない)、`composer.lock` の `packages[].name/version`、`.env` があれば鍵の名前と、伏せた値(下の「伏せ方」)
  - `paths`: `<root>`, 受け口・小部屋・置き場の場所、それぞれ書けるか(`is_writable`)
- 伏せ方: 値が `true|false|0|1|prod|dev|test|production|development|staging` のどれかならそのまま、それ以外は `"<redacted:長さ>"`

### `list_dir`
- args: `{"path": "<root からの相対パス。'' は root>", "depth": 0..2}`
- result: `{entries: [{name, type: "file"|"dir"|"link", size, mtime, perms: "0644"}]}`。1 回 2000 件まで
- `<root>` の外は `path_outside`。シンボリックリンクは辿らない(`type: "link"` として名前だけ返す)

### `read_file`
- args: `{"path": "<root からの相対パス>"}`
- 読めるのは名前が `.htaccess`, `.user.ini`, `composer.json`, `composer.lock`, `web.config`, `robots.txt` のものと、`var/self-harden/backups/` の退避ファイルだけ。`.env` 系は `inspect` の伏せた形でしか出さない
- 256KB まで。result: `{content, sha256, size, mtime}`。無いファイルは `{exists: false}`

### `write_file`
書いてよい場所にだけ書く。書く前に必ず退避を取る。
- args:
  ```json
  {
    "target": "root/.htaccess" | "root/.user.ini" | "lab/.htaccess" | "lab/.user.ini" | "dir:<root からの相対ディレクトリ>/.htaccess",
    "content": "<全文>",
    "expected_sha256": "<今の中身の sha256。無いファイルなら null>",
    "verify": {"paths": ["/", "/self-harden.php"], "timeout_sec": 8}
  }
  ```
- `dir:` は `<root>` の中に既にあるディレクトリだけ(作らない)。名前は `.htaccess` だけ
- `expected_sha256` が今と違えば `conflict`(だれかが先に書き換えた)
- 中身の決まり(受け口自身が裏口にならないため。詳しくは `docs/security.md`): 64KB まで、NUL なし。PHP に他のファイルを読ませる・別の形式を PHP として動かす指示は `forbidden_directive` で断る(`auto_prepend_file`, `auto_append_file`, `include_path`, `SetHandler`/`AddHandler`/`AddType`/`ForceType` で php を含むもの, `Action`, `php_admin_*`, `extension`, `zend_extension`, `open_basedir` を緩めるもの, `disable_functions` を空にするもの, `allow_url_include`)。これは「受け口を通して任意のコードを動かせない」ための決まりで、守りの手の答えではない
- 書き方: 退避(`backups/<id>.bak` と `<id>.json` に元の場所・sha256・時刻) → 同じディレクトリの一時ファイルに書く → `rename` で置き換え
- `verify` があれば、置き換えたあと同じリクエストの中で `self_base + path` を順に開く(`curl` 拡張、無ければ `fsockopen`)。どれかが 500 以上か、つながらなければ、すぐ退避から戻し、もう一度開いて確かめる
- result: `{backup_id, sha256_before, sha256_after, verify: [{path, status, ms}], rolled_back: bool, rollback_verify?: [...]}`

### `restore`
- args: `{"backup_id": "..."}`
- 退避から元に戻す(元が「無いファイル」だったなら消す)。戻す前の今の中身もまた退避する
- result: `{restored_to, sha256_after, new_backup_id}`

### `list_backups`
- args: なし
- result: `{backups: [{backup_id, target, created_at, sha256, existed}]}`(新しい順、200 件まで)

### `lab_arm`
小部屋を外から試すための合言葉を出す。
- args: なし
- 小部屋が無ければ作る(`self-harden-lab/` と、受け口が持つ固定の `probe.php`。中身は受け口のコードに埋め込んだ定数で、API からは変えられない)
- `var/self-harden/lab-token` に 32 バイトの乱数と 120 秒の期限を書く
- result: `{token, expires_at, probe_path: "/self-harden-lab/probe.php"}`

`probe.php` の決まり:
- `GET /self-harden-lab/probe.php?t=<token>` で、`lab-token` を `file_get_contents` で読み、期限内で `hash_equals` が通れば JSON を返す。通らなければ 404 で空
- 返す JSON: `{sapi, php_version, ini: ini_get_all(null,false) の全部(伏せ方は inspect と同じ), time}`
- 合言葉は 1 回使ったら消す(probe.php が `lab-token` を消す)

## API が外から確かめること

受け口とは別に、API 自身が店を外から開く(`http_get`)。開いてよいのは登録された `shop_url` と同じ origin だけ。結果は状態・見出し・本文の先頭 4KB。小部屋の `probe.php` もこれで開く。

手元の docker では、API から店へは docker のネットワーク名で届く(`shop_url` を `http://kagoya`, `http://lolipop` のように登録する)。

## 店 → API(プラグインの管理画面から)

プラグインのコントローラーが、店のサーバーから API を呼ぶ(ブラウザから API を直接呼ばない)。署名は上と同じ形で、`PATH` は API 側のパス。

| 呼び方 | 中身 |
|---|---|
| `POST /v1/shops` | 登録(上の鍵の交換。ここだけ署名なし) |
| `POST /v1/shops/{shop_id}/runs` | 点検を始める。本文 `{"advisory_url": "<任意>"}`。返事 `{run_id}` |
| `GET /v1/shops/{shop_id}/runs/{run_id}` | 経過。返事 `{status: "running"|"done"|"failed", steps: [{at, kind, title, detail}], report?: {...}}` |
| `GET /v1/shops/{shop_id}/runs` | これまでの点検の一覧 |

管理画面は数秒おきにプラグインの中継先を呼んで経過を出す。

## 報告(`report`)の形

```json
{
  "summary": "店の人向けの 3 行",
  "findings": [{"title": "", "severity": "high|medium|low|info", "evidence": "", "status": "fixed|mitigated|needs_human|not_affected"}],
  "actions":  [{"title": "", "target": "root/.htaccess", "backup_id": "", "verified": "どう確かめたか"}],
  "remaining":[{"title": "", "why": "", "who": "店の人|サーバー会社|制作会社"}],
  "sources":  [{"title": "", "url": ""}]
}
```

全部日本語。`remaining` には PHP の更新など、受け口ではできない人の仕事を書く。
