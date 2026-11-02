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
