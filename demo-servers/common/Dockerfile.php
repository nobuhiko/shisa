# EC-CUBE 4.2.0 を動かす PHP。BASE で mod_php(apache)か FPM かを選ぶ
ARG BASE
FROM ${BASE}
# bullseye のセキュリティ配布は archive.debian.org に移ったので、取得先をそちらに向ける
RUN set -eux; \
    printf 'deb http://deb.debian.org/debian bullseye main\ndeb http://deb.debian.org/debian bullseye-updates main\ndeb http://archive.debian.org/debian-security bullseye-security main\n' > /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends libicu-dev libzip-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    docker-php-ext-install -j"$(nproc)" intl zip gd opcache; \
    rm -rf /var/lib/apt/lists/*
RUN mkdir -p /usr/local/etc/php/web.d /opt/eccube
COPY .cache/eccube-4.2.0.tar.gz /opt/eccube/eccube-4.2.0.tar.gz
