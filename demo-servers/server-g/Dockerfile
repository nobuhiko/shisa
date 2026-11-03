# サーバー G: mod_php、PHP 7.1、EC-CUBE 3.0.18(3 系の最後の版、サポート終了。Silex の時代)
# 3.0 の配布物は GitHub の releases に無いので、公式のタグ 3.0.18 のソース(.cache/eccube-3.0.18-src.tar.gz、git archive で作る)に、
# 同梱の composer.lock どおりに composer install して作る(公式の配布物の作り方と同じ)
FROM php:7.1-apache AS base
# buster の配布は archive.debian.org に移ったので、取得先をそちらに向ける
RUN set -eux; \
    printf 'deb http://archive.debian.org/debian buster main\ndeb http://archive.debian.org/debian-security buster/updates main\n' > /etc/apt/sources.list; \
    apt-get -o Acquire::Check-Valid-Until=false update; \
    apt-get install -y --no-install-recommends libzip-dev zlib1g-dev unzip; \
    docker-php-ext-install -j"$(nproc)" zip opcache; \
    rm -rf /var/lib/apt/lists/*

FROM base AS build
# composer は 1 系(3.0.18 の composer.json は 2 系では通らない名前を含むため。lock の配布 URL から直接取るので packagist の 1 系終了は関係しない)
ADD https://getcomposer.org/download/1.10.27/composer.phar /usr/local/bin/composer
COPY .cache/eccube-3.0.18-src.tar.gz /opt/src.tar.gz
RUN set -eux; \
    chmod +x /usr/local/bin/composer; \
    mkdir -p /opt/build; tar xzf /opt/src.tar.gz -C /opt/build; \
    cd /opt/build/eccube-3.0.18; \
    COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --no-progress --optimize-autoloader; \
    cd /opt/build; tar czf /opt/eccube-3.0.18.tar.gz eccube-3.0.18

FROM base
# 3.0 の既定の置き方: 店のフォルダの中の html/ を公開ディレクトリにする(EC-CUBE の本体は公開ディレクトリの外)
RUN set -eux; \
    a2enmod rewrite headers; \
    sed -ri 's#AllowOverride None#AllowOverride All#g' /etc/apache2/apache2.conf; \
    sed -ri 's#DocumentRoot /var/www/html$#DocumentRoot /var/www/html/html#' /etc/apache2/sites-available/000-default.conf; \
    echo 'export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d:/usr/local/etc/php/web.d' >> /etc/apache2/envvars; \
    mkdir -p /usr/local/etc/php/web.d /opt/eccube
COPY --from=build /opt/eccube-3.0.18.tar.gz /opt/eccube/eccube-3.0.18.tar.gz
COPY common/web-limits.ini /usr/local/etc/php/web.d/zz-web-limits.ini
COPY server-g/setup.sh /usr/local/bin/setup-eccube3
COPY server-a/entrypoint.sh /usr/local/bin/server-g-entrypoint
RUN sed -i 's/^setup-eccube$/setup-eccube3/' /usr/local/bin/server-g-entrypoint
ENTRYPOINT ["server-g-entrypoint"]
CMD ["apache2-foreground"]
