# サーバー D: mod_php、PHP 7.4、EC-CUBE 4.0.6(composer v1 の時代の版)
FROM self-harden/php-apache:7.4
RUN set -eux; \
    a2enmod rewrite headers; \
    sed -ri 's#AllowOverride None#AllowOverride All#g' /etc/apache2/apache2.conf; \
    echo 'export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d:/usr/local/etc/php/web.d' >> /etc/apache2/envvars
COPY .cache/eccube-4.0.6.tar.gz /opt/eccube/eccube-4.0.6.tar.gz
COPY common/web-limits.ini /usr/local/etc/php/web.d/zz-web-limits.ini
COPY common/setup-eccube.sh /usr/local/bin/setup-eccube
COPY common/plant-demo.sh /usr/local/bin/plant-demo
COPY server-a/entrypoint.sh /usr/local/bin/server-d-entrypoint
ENV ECCUBE_VERSION=4.0.6
ENTRYPOINT ["server-d-entrypoint"]
CMD ["apache2-foreground"]
