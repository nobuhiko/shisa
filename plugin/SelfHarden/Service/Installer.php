<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden\Service;

/**
 * 受け口(素の PHP 1 枚)を店の公開ディレクトリ直下に置く・消す
 */
class Installer
{
    public const RECEIVER = 'self-harden.php';
    public const VAR_DIR = 'var/self-harden';
    public const LAB_DIR = 'self-harden-lab';

    public static function place($root)
    {
        $src = dirname(__DIR__).'/Resource/receiver/'.self::RECEIVER;
        $dst = $root.'/'.self::RECEIVER;
        if (is_link($dst)) {
            throw new \RuntimeException('受け口の置き場所がシンボリックリンクです');
        }
        $tmp = $dst.'.tmp-'.bin2hex(random_bytes(4));
        if (!copy($src, $tmp) || !rename($tmp, $dst)) {
            @unlink($tmp);
            throw new \RuntimeException('受け口を置けませんでした');
        }
        @chmod($dst, 0644);
        $var = $root.'/'.self::VAR_DIR;
        foreach (['', '/backups', '/nonces'] as $sub) {
            if (!is_dir($var.$sub)) {
                @mkdir($var.$sub, 0700, true);
            }
        }
        if (!file_exists($var.'/.htaccess')) {
            file_put_contents($var.'/.htaccess', "Require all denied\n");
        }
        if (!file_exists($var.'/index.html')) {
            file_put_contents($var.'/index.html', '');
        }
    }

    public static function remove($root)
    {
        @unlink($root.'/'.self::RECEIVER);
        @unlink($root.'/'.self::VAR_DIR.'/config.php');
        @unlink($root.'/'.self::VAR_DIR.'/lab-token');
        foreach (['probe.php', '.htaccess', '.user.ini'] as $f) {
            @unlink($root.'/'.self::LAB_DIR.'/'.$f);
        }
        @rmdir($root.'/'.self::LAB_DIR);
        foreach ((array) @scandir($root.'/'.self::VAR_DIR.'/nonces') as $f) {
            if ($f !== '.' && $f !== '..') {
                @unlink($root.'/'.self::VAR_DIR.'/nonces/'.$f);
            }
        }
    }
}
