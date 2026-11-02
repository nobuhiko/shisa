<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden;

use Eccube\Plugin\AbstractPluginManager;
use Plugin\SelfHarden\Service\Installer;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * 入れたら受け口を置く。無効にしても受け口は残す(EC-CUBE が死んでも動く命綱なので)。
 * 削除したら受け口と鍵と小部屋を消す。退避ファイルは、人が手で戻せるように残す。
 */
class PluginManager extends AbstractPluginManager
{
    public function install(array $meta, ContainerInterface $container)
    {
        Installer::place($container->getParameter('kernel.project_dir'));
    }

    public function enable(array $meta, ContainerInterface $container)
    {
        Installer::place($container->getParameter('kernel.project_dir'));
    }

    public function update(array $meta, ContainerInterface $container)
    {
        Installer::place($container->getParameter('kernel.project_dir'));
    }

    public function disable(array $meta, ContainerInterface $container)
    {
    }

    public function uninstall(array $meta, ContainerInterface $container)
    {
        Installer::remove($container->getParameter('kernel.project_dir'));
    }
}
