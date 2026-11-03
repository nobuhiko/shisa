<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden3\Service;

/**
 * 受け口(素の PHP 1 枚)を店の公開ディレクトリ直下に置く・消す。中身は 4 系の plugin/SelfHarden/Service/Installer.php と同じ。
 * 受け口のファイルは、4 系のもの(plugin/SelfHarden/Resource/receiver/self-harden.php)を、配る前に Resource/receiver/ に写して入れる
 * (plugin/build-zip.sh SelfHarden3、demo-servers/install-plugin.sh server-g)
 */
class Installer
{
    const RECEIVER = 'self-harden.php';
    const VAR_DIR = 'var/self-harden';
    const LAB_DIR = 'self-harden-lab';

    /**
     * 店の公開ディレクトリ(index.php のあるところ)。
     * 3.0 の既定は EC-CUBE の中の html/。index.php を EC-CUBE の直下に移す置き方(RELATIVE_PUBLIC_DIR_PATH が '/html')では直下
     */
    public static function publicDir($app)
    {
        $root = rtrim($app['config']['root_dir'], '/');
        if (defined('RELATIVE_PUBLIC_DIR_PATH') && RELATIVE_PUBLIC_DIR_PATH !== '' && is_file($root.'/index.php')) {
            return $root;
        }

        return $root.'/html';
    }

    public static function place($root)
    {
        $src = dirname(__DIR__).'/Resource/receiver/'.self::RECEIVER;
        if (!is_file($src)) {
            throw new \RuntimeException('受け口のファイルがプラグインに入っていません(Resource/receiver/'.self::RECEIVER.')');
        }
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
        foreach (array('', '/backups', '/nonces') as $sub) {
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
        foreach (array('probe.php', '.htaccess', '.user.ini') as $f) {
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
