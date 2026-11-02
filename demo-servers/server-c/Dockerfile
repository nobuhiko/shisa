# サーバー C: Apache + mod_php、EC-CUBE 4.2.3。パッチ版(4.2.3-p2 など)への上げを確かめるための 3 台目
FROM self-harden/php-apache:8.1.10
RUN set -eux; \
    a2enmod rewrite headers; \
    sed -ri 's#AllowOverride None#AllowOverride All#g' /etc/apache2/apache2.conf; \
    echo 'export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d:/usr/local/etc/php/web.d' >> /etc/apache2/envvars
COPY .cache/eccube-4.2.3.tar.gz /opt/eccube/eccube-4.2.3.tar.gz
COPY common/web-limits.ini /usr/local/etc/php/web.d/zz-web-limits.ini
COPY common/setup-eccube.sh /usr/local/bin/setup-eccube
COPY common/plant-demo.sh /usr/local/bin/plant-demo
COPY server-a/entrypoint.sh /usr/local/bin/server-c-entrypoint
ENV ECCUBE_VERSION=4.2.3
ENTRYPOINT ["server-c-entrypoint"]
CMD ["apache2-foreground"]
