<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden3\ServiceProvider;

use Plugin\SelfHarden3\Service\ApiClient;
use Plugin\SelfHarden3\Service\Installer;
use Silex\Application as BaseApplication;
use Silex\ServiceProviderInterface;

/**
 * 3.0 の経路と部品の登録。管理画面の経路は /<管理画面の経路>/ の下なので、EC-CUBE のログインで守られる。
 * 設定画面の経路名 plugin_SelfHarden3_config は、プラグイン一覧の「設定」から開くための決まった名前
 */
class SelfHarden3ServiceProvider implements ServiceProviderInterface
{
    public function register(BaseApplication $app)
    {
        $base = '/'.trim($app['config']['admin_route'], '/').'/plugin/SelfHarden3';
        $c = 'Plugin\SelfHarden3\Controller\Admin\ConfigController';
        $app->match($base.'/config', $c.'::index')->method('GET')->bind('plugin_SelfHarden3_config');
        $app->match($base.'/connect', $c.'::connect')->method('POST')->bind('self_harden3_admin_connect');
        $app->match($base.'/run', $c.'::run')->method('POST')->bind('self_harden3_admin_run');
        $app->match($base.'/runs', $c.'::runs')->method('GET')->bind('self_harden3_admin_runs');
        $app->match($base.'/run/{run_id}', $c.'::status')->method('GET')->assert('run_id', 'run_[0-9a-f]{8,32}')->bind('self_harden3_admin_run_status');

        $app['self_harden3.api'] = $app->share(function () use ($app) {
            return new ApiClient(Installer::publicDir($app));
        });
    }

    public function boot(BaseApplication $app)
    {
    }
}
