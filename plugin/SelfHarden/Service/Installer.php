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
    // 店主の承認の印を作る鍵。お店の中だけに置き、API には決して渡さない(窓口も同じ場所から読む)
    public const APPROVE_KEY = 'approve-key.php';
    // 承認で直してよい場所(窓口の決まりと同じ)
    public const APPROVE_DIRS = ['app/Customize', 'app/template'];

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
        self::ensureApproveKey($root);
    }

    /** 承認の鍵が無ければ作る。先頭行は PHP の exit だけ(開かれても中身を出さない)、2 行目が JSON */
    public static function ensureApproveKey($root)
    {
        $p = $root.'/'.self::VAR_DIR.'/'.self::APPROVE_KEY;
        if (is_link($p) || self::approveKey($root) !== null) {
            return;
        }
        $tmp = $p.'.tmp-'.bin2hex(random_bytes(4));
        // 作った瞬間から自分だけが読めるように(chmod までのすき間を作らない)
        $old = umask(0077);
        try {
            file_put_contents($tmp, "<?php exit; ?>\n".json_encode(['key' => bin2hex(random_bytes(32)), 'created_at' => time()])."\n");
            @chmod($tmp, 0600);
            rename($tmp, $p);
        } finally {
            umask($old);
        }
    }

    public static function approveKey($root)
    {
        $raw = @file_get_contents($root.'/'.self::VAR_DIR.'/'.self::APPROVE_KEY);
        if (!is_string($raw) || ($pos = strpos($raw, "\n")) === false) {
            return null;
        }
        $c = json_decode(substr($raw, $pos + 1), true);

        return is_array($c) && isset($c['key']) && is_string($c['key']) && preg_match('/^[0-9a-f]{64}$/', $c['key']) ? $c['key'] : null;
    }

    public static function remove($root)
    {
        @unlink($root.'/'.self::RECEIVER);
        @unlink($root.'/'.self::VAR_DIR.'/config.php');
        @unlink($root.'/'.self::VAR_DIR.'/lab-token');
        @unlink($root.'/'.self::VAR_DIR.'/'.self::APPROVE_KEY);
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
