# サーバー Bの PHP 側: PHP-FPM。.user.ini が効く(user_ini.cache_ttl は既定の 300 秒のまま)
FROM self-harden/php-fpm:8.1.10
COPY common/web-limits.ini /usr/local/etc/php/web.d/zz-web-limits.ini
COPY common/setup-eccube.sh /usr/local/bin/setup-eccube
COPY common/plant-demo.sh /usr/local/bin/plant-demo
COPY server-b/entrypoint.sh /usr/local/bin/server-b-entrypoint
# FPM には Web 用の制約(web.d)も読ませる。CLI で使うときは PHP_INI_SCAN_DIR を conf.d だけに戻す
ENV PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d:/usr/local/etc/php/web.d
ENTRYPOINT ["server-b-entrypoint"]
CMD ["php-fpm"]
