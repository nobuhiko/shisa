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
        self::clearCacheAfterRequest(self::projectDir($container));
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

    /**
     * 有効にしたあと、管理画面の経路が読まれないことがある(EC-CUBE が有効の処理の途中で組み立て直す設定(コンテナ)に、まだこのプラグインが入っていない)。
     * そこで、このやり取りが全部終わってから(有効の記録が済んでから)、設定の読み込み口(*Container.php)と経路の控え(url_*_routes.php)だけを消し、
     * 次のやり取りで組み立て直させる。キャッシュのフォルダごと消すと、すでに走り出している次の画面が読むファイルまで消えて 500 になり、
     * EC-CUBE の自動のメンテナンスが解除されないまま残る
     */
    private static function clearCacheAfterRequest($root)
    {
        $env = getenv('APP_ENV') ?: (isset($_SERVER['APP_ENV']) ? $_SERVER['APP_ENV'] : 'prod');
        $dir = $root.'/var/cache/'.preg_replace('/[^a-z0-9_]/i', '', (string) $env);
        register_shutdown_function(function () use ($dir) {
            $files = array_merge((array) glob($dir.'/*Container.php'), (array) glob($dir.'/*Container.php.meta'), (array) glob($dir.'/*Container.preload.php'),
                array($dir.'/url_generating_routes.php', $dir.'/url_generating_routes.php.meta', $dir.'/url_matching_routes.php', $dir.'/url_matching_routes.php.meta'));
            foreach ($files as $p) {
                if (is_string($p) && is_file($p) && !is_link($p)) {
                    @unlink($p);
                }
            }
        });
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
