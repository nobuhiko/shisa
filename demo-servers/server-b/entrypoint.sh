#!/bin/sh
set -eu
setup-eccube
exec docker-php-entrypoint "$@"
