# サーバー E: mod_php、PHP 7.4、EC-CUBE 4.1.2-p3。同じ 4.1 系のパッチ版(4.1.2-p4 以降)への上げを確かめる台
FROM self-harden/php-apache:7.4
RUN set -eux; \
    a2enmod rewrite headers; \
    sed -ri 's#AllowOverride None#AllowOverride All#g' /etc/apache2/apache2.conf; \
    echo 'export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d:/usr/local/etc/php/web.d' >> /etc/apache2/envvars
COPY .cache/eccube-4.1.2-p3.tar.gz /opt/eccube/eccube-4.1.2-p3.tar.gz
COPY common/web-limits.ini /usr/local/etc/php/web.d/zz-web-limits.ini
COPY common/setup-eccube.sh /usr/local/bin/setup-eccube
COPY common/plant-demo.sh /usr/local/bin/plant-demo
COPY server-a/entrypoint.sh /usr/local/bin/server-e-entrypoint
ENV ECCUBE_VERSION=4.1.2-p3
ENTRYPOINT ["server-e-entrypoint"]
CMD ["apache2-foreground"]
