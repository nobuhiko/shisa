#!/bin/sh
set -eu
setup-eccube
# apache2-foreground は envvars を読むので、Web 用の制約はそこで足される
exec docker-php-entrypoint "$@"
