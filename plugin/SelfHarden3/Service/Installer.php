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
    // 鍵と退避の置き場。受け口の 3 系の地図と同じく、本体の一番上の app/self-harden(公開ディレクトリの外)
    const VAR_DIR = 'app/self-harden';
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

    /**
     * 本体の一番上。受け口と同じ見分け方: 公開ディレクトリが html/ で、その上に 3 系の目印があれば上の階
     */
    public static function projectRoot($pub)
    {
        $up = dirname($pub);
        if (basename($pub) === 'html' && is_file($up.'/src/Eccube/Application.php')) {
            return $up;
        }

        return $pub;
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
        $var = self::projectRoot($root).'/'.self::VAR_DIR;
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
        $var = self::projectRoot($root).'/'.self::VAR_DIR;
        @unlink($var.'/config.php');
        @unlink($var.'/lab-token');
        foreach (array('probe.php', '.htaccess', '.user.ini') as $f) {
            @unlink($root.'/'.self::LAB_DIR.'/'.$f);
        }
        @rmdir($root.'/'.self::LAB_DIR);
        foreach ((array) @scandir($var.'/nonces') as $f) {
            if ($f !== '.' && $f !== '..') {
                @unlink($var.'/nonces/'.$f);
            }
        }
    }
}
