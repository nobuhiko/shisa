# demo-servers

古い版に固定した検証環境(EC-CUBE 4.2.0 + PHP 8.1.10)。手元だけで使う。詳しくは [docs/design.md](../docs/design.md)。

```sh
cd demo-servers
docker compose --profile build-only build php-apache-base php-fpm-base   # 土台のイメージ(初回だけ)
docker compose up -d --build server-a server-b-php server-b
./check.sh                       # 制約が本物どおりかを確かめる
docker compose down -v           # 消して初期状態に戻す
```

EC-CUBE の配布物は `.cache/eccube-4.2.0.tar.gz` に置く(https://github.com/EC-CUBE/ec-cube/releases/tag/4.2.0 、sha256 `dc0ab44a2c26e69f6adc1f4755acab39f653d5218edaaad84777bde4f1f7129d`)。

## カスタマイズありで回す

`CUSTOM=1 ADV=<お知らせの URL> ./regress.sh server-d server-f server-g server-h` で回すと、点検の前に、弱点ではない普通のカスタマイズを入れます(`customize.sh`)。終わったら、入れたファイルが上書きされていないか、入れたページが開くかを確かめます。入れるのは、フッターの文言の書き換え、クラスへのコメント、次の公式の修正版が直すファイルへのコメント 1 行、安全な独自のページ(値は escape、DB にはパラメータで渡す)です。

2026-11-05 の結果(4.0.6・4.3.0・3.0.18・2.17.2):

- 入れたファイルは 4 店とも上書きされませんでした。お店の画面と独自のページも開いたままでした。
- 独自のページを「危ない」と誤って言ったお店はありませんでした。
- 公式の修正版の対象ファイルにカスタマイズがあると、修正版はそのファイルを上書きせずに止まり、制作会社への依頼か店主の判断待ちとして報告しました(4.0.6 は 4.0.6-p1 までは当てた)。
- 部品の差し替え(Symfony の部品、Smarty)は、カスタマイズがあっても今までどおり行いました。
