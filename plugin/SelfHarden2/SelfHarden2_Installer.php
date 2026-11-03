<?php
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * 受け口(素の PHP 1 枚)を店の公開ディレクトリ(html/)直下に置く・消す。
 *
 * 置き場(鍵・退避・nonce)は、公開ディレクトリの外の data/self-harden/。
 * 受け口は自分の居場所(html/ の上に data/class/SC_Initial.php がある)を見て 2 系の地図を選び、同じ場所を読む。
 */
class SelfHarden2_Installer
{
    const RECEIVER = 'self-harden.php';
    const STORE_DIR = 'self-harden';       // 置き場の実体(data/ からの相対)
    const LAB_DIR = 'self-harden-lab';

    const DENY = "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n";

    /** 公開ディレクトリ(html/)。末尾の / なし */
    public static function htmlDir()
    {
        return rtrim(HTML_REALDIR, '/');
    }

    /** 置き場の実体(data/self-harden) */
    public static function storeDir()
    {
        $data = realpath(DATA_REALDIR);

        return rtrim($data !== false ? $data : DATA_REALDIR, '/') . '/' . self::STORE_DIR;
    }

    /** 受け口が読む置き場(受け口の 2 系の地図と同じ data/self-harden) */
    public static function varDir()
    {
        return self::storeDir();
    }

    public static function place()
    {
        $src = PLUGIN_UPLOAD_REALDIR . 'SelfHarden2/receiver/' . self::RECEIVER;
        $html = self::htmlDir();
        $dst = $html . '/' . self::RECEIVER;
        if (!is_file($src)) {
            throw new RuntimeException('受け口のファイルがプラグインの中にありません');
        }
        if (is_link($dst)) {
            throw new RuntimeException('受け口の置き場所がシンボリックリンクです');
        }
        $tmp = $dst . '.tmp-' . bin2hex(random_bytes(4));
        if (!@copy($src, $tmp) || !@rename($tmp, $dst)) {
            @unlink($tmp);
            throw new RuntimeException('受け口を置けませんでした(' . $html . ' に書けるか確かめてください)');
        }
        @chmod($dst, 0644);

        // 置き場(公開ディレクトリの外)
        self::protectedDir(self::storeDir());
        $var = self::varDir();
        foreach (array('', '/backups', '/nonces') as $sub) {
            if (!is_dir($var . $sub)) {
                @mkdir($var . $sub, 0700, true);
            }
        }
        if (!is_dir($var . '/nonces')) {
            throw new RuntimeException('置き場を作れませんでした: ' . $var);
        }
    }

    public static function remove()
    {
        $html = self::htmlDir();
        $var = self::varDir();
        @unlink($html . '/' . self::RECEIVER);
        @unlink($var . '/config.php');
        @unlink($var . '/lab-token');
        foreach (array('probe.php', '.htaccess', '.user.ini') as $f) {
            @unlink($html . '/' . self::LAB_DIR . '/' . $f);
        }
        @rmdir($html . '/' . self::LAB_DIR);
        foreach ((array) @scandir($var . '/nonces') as $f) {
            if ($f !== '.' && $f !== '..') {
                @unlink($var . '/nonces/' . $f);
            }
        }
    }

    /** フォルダを作り、Web から読ませない .htaccess と空の index.html を置く */
    private static function protectedDir($dir, $private = true)
    {
        if (!is_dir($dir)) {
            @mkdir($dir, $private ? 0700 : 0755, true);
        }
        if (!is_dir($dir)) {
            throw new RuntimeException('フォルダを作れませんでした: ' . $dir);
        }
        if (!file_exists($dir . '/.htaccess')) {
            file_put_contents($dir . '/.htaccess', self::DENY);
            @chmod($dir . '/.htaccess', 0644);
        }
        if (!file_exists($dir . '/index.html')) {
            file_put_contents($dir . '/index.html', '');
            @chmod($dir . '/index.html', 0644);
        }
    }
}
