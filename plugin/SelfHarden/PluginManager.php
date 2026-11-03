<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden;

use Eccube\Plugin\AbstractPluginManager;
use Plugin\SelfHarden\Service\Installer;

/**
 * 入れたら受け口を置く。無効にしても受け口は残す(EC-CUBE が死んでも動く命綱なので)。
 * 削除したら受け口と鍵と小部屋を消す。退避ファイルは、人が手で戻せるように残す。
 *
 * $container に型を書かない: 4.0〜4.2 の親は Symfony の ContainerInterface、4.3 の親は Psr の ContainerInterface を取る。
 * 型を書かなければ、どちらの親とも食い違わない(PHP 7.2 からは引数の型を子で外してよい)。
 */
class PluginManager extends AbstractPluginManager
{
    public function install(array $meta, $container)
    {
        Installer::place(self::projectDir($container));
    }

    public function enable(array $meta, $container)
    {
        Installer::place(self::projectDir($container));
    }

    public function update(array $meta, $container)
    {
        Installer::place(self::projectDir($container));
    }

    public function disable(array $meta, $container)
    {
    }

    public function uninstall(array $meta, $container)
    {
        Installer::remove(self::projectDir($container));
    }

    /** EC-CUBE を置いたところ。4.3 で渡される入れ物は getParameter を持たないことがあるので、そのときはこのファイルの場所(app/Plugin/SelfHarden)からたどる */
    private static function projectDir($container)
    {
        if (is_object($container) && method_exists($container, 'getParameter')) {
            return $container->getParameter('kernel.project_dir');
        }

        return dirname(__DIR__, 3);
    }
}
