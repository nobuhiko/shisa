<?php
// SPDX-License-Identifier: GPL-2.0-or-later

require_once PLUGIN_UPLOAD_REALDIR . 'SelfHarden2/SelfHarden2_Installer.php';

/**
 * 入れたら受け口を置く。無効にしても受け口は残す(EC-CUBE が死んでも動く命綱なので)。
 * 削除したら受け口と鍵と小部屋を消す。退避ファイルは、人が手で戻せるように残す(4 系と同じ)。
 *
 * install などは EC-CUBE 2 の親(SC_Plugin_Base)に合わせて static にする。
 * 入れるときは、ファイルがまだ一時展開の場所(DOWNLOADS_TEMP_PLUGIN_INSTALL_DIR)にもあるが、
 * install が呼ばれる時点で data/downloads/plugin/SelfHarden2/ に写し終わっているので、そちらを使う
 */
class SelfHarden2 extends SC_Plugin_Base
{
    public function __construct(array $arrSelfInfo)
    {
        parent::__construct($arrSelfInfo);
    }

    public static function install($arrPlugin, $objPluginInstaller = null)
    {
        return self::place();
    }

    public static function enable($arrPlugin, $objPluginInstaller = null)
    {
        return self::place();
    }

    public static function disable($arrPlugin, $objPluginInstaller = null)
    {
    }

    public static function uninstall($arrPlugin, $objPluginInstaller = null)
    {
        SelfHarden2_Installer::remove();
    }

    // 処理の介入箇所は使わない(画面はプラグイン設定の 1 枚だけ)
    public function register(SC_Helper_Plugin $objHelperPlugin, $priority)
    {
        parent::register($objHelperPlugin, $priority);
    }

    // 失敗したら、その理由を返す(EC-CUBE がインストールを取り消してエラーを出す)
    private static function place()
    {
        try {
            SelfHarden2_Installer::place();
        } catch (Exception $e) {
            return '※ ' . htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8') . '<br/>';
        }

        return null;
    }
}
