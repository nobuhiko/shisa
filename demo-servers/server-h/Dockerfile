# サーバー H: mod_php、PHP 7.4、EC-CUBE 2.17.2(2 系。上に公式のパッチ版 2.17.2-p1 / -p2 がある)
# 配布物は GitHub の releases の eccube-2.17.2.tar.gz(.cache に置き、同じリリースの .checksum.sha256 で確かめてある)。
# 2.17 の配布物には data/vendor/ が入っていない(リリースの説明に「composer install を実行してください」とある)ので、
# 同梱の composer.lock どおりに composer install して作る
FROM php:7.4-apache AS base
# bullseye のセキュリティ配布は archive.debian.org に移ったので、取得先をそちらに向ける
RUN set -eux; \
    printf 'deb http://deb.debian.org/debian bullseye main\ndeb http://deb.debian.org/debian bullseye-updates main\ndeb http://archive.debian.org/debian-security bullseye-security main\n' > /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends libpq-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev libzip-dev unzip postgresql-client; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    docker-php-ext-install -j"$(nproc)" pgsql gd zip opcache; \
    rm -rf /var/lib/apt/lists/*

FROM base AS build
# composer は 2.2 系(PHP 7.4 で動く長期サポート版)。lock の配布 URL から取るので、版は lock どおりになる
ADD https://getcomposer.org/download/2.2.24/composer.phar /usr/local/bin/composer
COPY .cache/eccube-2.17.2.tar.gz /opt/src.tar.gz
RUN set -eux; \
    chmod +x /usr/local/bin/composer; \
    mkdir -p /opt/build; tar xzf /opt/src.tar.gz -C /opt/build; \
    cd /opt/build/ec-cube2; \
    COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --no-progress; \
    cd /opt/build; tar czf /opt/eccube-2.17.2.tar.gz ec-cube2

FROM base
# 2 系の既定の置き方: 店のフォルダの中の html/ を公開ディレクトリにする(data/ は公開ディレクトリの外)
RUN set -eux; \
    a2enmod rewrite headers; \
    sed -ri 's#AllowOverride None#AllowOverride All#g' /etc/apache2/apache2.conf; \
    sed -ri 's#DocumentRoot /var/www/html$#DocumentRoot /var/www/html/html#' /etc/apache2/sites-available/000-default.conf; \
    echo 'export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d:/usr/local/etc/php/web.d' >> /etc/apache2/envvars; \
    cp /usr/local/etc/php/php.ini-production /usr/local/etc/php/php.ini; \
    printf 'date.timezone = Asia/Tokyo\n' > /usr/local/etc/php/conf.d/zz-timezone.ini; \
    mkdir -p /usr/local/etc/php/web.d /opt/eccube
COPY --from=build /opt/eccube-2.17.2.tar.gz /opt/eccube/eccube-2.17.2.tar.gz
COPY common/web-limits.ini /usr/local/etc/php/web.d/zz-web-limits.ini
COPY server-h/setup.sh /usr/local/bin/setup-eccube2
COPY server-a/entrypoint.sh /usr/local/bin/server-h-entrypoint
RUN sed -i 's/^setup-eccube$/setup-eccube2/' /usr/local/bin/server-h-entrypoint
ENTRYPOINT ["server-h-entrypoint"]
CMD ["apache2-foreground"]
