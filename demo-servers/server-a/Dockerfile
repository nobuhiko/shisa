# サーバー A: Apache + mod_php。.htaccess の php_value/php_flag が効き、.user.ini は読まれない
FROM self-harden/php-apache:8.1.10
RUN set -eux; \
    a2enmod rewrite headers; \
    sed -ri 's#AllowOverride None#AllowOverride All#g' /etc/apache2/apache2.conf; \
    echo 'export PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d:/usr/local/etc/php/web.d' >> /etc/apache2/envvars
COPY common/web-limits.ini /usr/local/etc/php/web.d/zz-web-limits.ini
COPY common/setup-eccube.sh /usr/local/bin/setup-eccube
COPY common/plant-demo.sh /usr/local/bin/plant-demo
COPY server-a/entrypoint.sh /usr/local/bin/server-a-entrypoint
ENTRYPOINT ["server-a-entrypoint"]
CMD ["apache2-foreground"]
