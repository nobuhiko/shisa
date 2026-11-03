<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden3;

use Eccube\Plugin\AbstractPluginManager;
use Plugin\SelfHarden3\Service\Installer;

/**
 * 入れたら受け口を置く。無効にしても受け口は残す(EC-CUBE が死んでも動く命綱なので)。
 * 削除したら受け口と鍵と小部屋を消す。退避ファイルは、人が手で戻せるように残す。(4 系と同じ)
 *
 * 3.0 では、各メソッドに config.yml の中身と Silex のアプリが渡される(PluginService::callPluginManagerMethod)
 */
class PluginManager extends AbstractPluginManager
{
    public function install($config, $app)
    {
        Installer::place(Installer::publicDir($app));
    }

    public function enable($config, $app)
    {
        Installer::place(Installer::publicDir($app));
    }

    public function update($config, $app)
    {
        Installer::place(Installer::publicDir($app));
    }

    public function disable($config, $app)
    {
    }

    public function uninstall($config, $app)
    {
        Installer::remove(Installer::publicDir($app));
    }
}
