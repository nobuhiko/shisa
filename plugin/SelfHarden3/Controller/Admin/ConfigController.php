<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden3\Controller\Admin;

use Eccube\Application;
use Eccube\Common\Constant;
use Eccube\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;

/**
 * 管理画面: API とつなぐ、点検を始める(通知の URL を貼ってもよい)、経過を見る。4 系の ConfigController と同じ動き
 */
class ConfigController extends AbstractController
{
    public function index(Application $app, Request $request)
    {
        $api = $app['self_harden3.api'];
        $c = $api->config();
        $origin = $request->getSchemeAndHttpHost();
        $runs = array();
        if ($c) {
            $r = $api->listRuns();
            $runs = isset($r['runs']) ? $r['runs'] : array();
        }
        $env = getenv('SELF_HARDEN_API');
        $self = getenv('SELF_HARDEN_SELF_BASE');

        return $app->render('SelfHarden3/Resource/template/admin/config.twig', array(
            'connected' => $c !== null,
            'shop_id' => isset($c['shop_id']) ? $c['shop_id'] : null,
            'api_base' => isset($c['api_base']) ? $c['api_base'] : ($env ?: 'http://api:8787'),
            // API から店に届く URL。ふつうは外から見た URL と同じ。手元の検証環境のように違うときだけ、サーバー側で SELF_HARDEN_SELF_BASE を決める
            'self_base' => isset($c['self_base']) ? $c['self_base'] : ($self ?: $origin),
            'public_base' => isset($c['public_base']) ? $c['public_base'] : $origin,
            'runs' => $runs,
            'token_name' => Constant::TOKEN_NAME,
            'token' => $app['form.csrf_provider']->getToken(Constant::TOKEN_NAME)->getValue(),
        ));
    }

    public function connect(Application $app, Request $request)
    {
        $this->isTokenValid($app);
        $urls = array();
        foreach (array('api_base', 'self_base', 'public_base') as $k) {
            $v = trim((string) $request->get($k));
            if (!preg_match('#^https?://[A-Za-z0-9.\-]+(:[0-9]+)?/?$#', $v)) {
                $app->addError('URL の形が正しくありません: '.$k, 'admin');

                return $app->redirect($app->url('plugin_SelfHarden3_config'));
            }
            $urls[$k] = $v;
        }
        $res = $app['self_harden3.api']->connect($urls['api_base'], $urls['self_base'], $urls['public_base']);
        if (!empty($res['ok'])) {
            $app->addSuccess('API とつながりました(店の ID: '.$res['shop_id'].')', 'admin');
        } else {
            $app->addError('API とつなげませんでした: '.(isset($res['error']) ? $res['error'] : '').' '.(isset($res['detail']) ? $res['detail'] : ''), 'admin');
        }

        return $app->redirect($app->url('plugin_SelfHarden3_config'));
    }

    public function run(Application $app, Request $request)
    {
        $this->isTokenValid($app);
        $api = $app['self_harden3.api'];
        $url = trim((string) $request->get('advisory_url'));
        if ($url !== '' && (!preg_match('#^https?://\S{1,2000}$#', $url) || filter_var($url, FILTER_VALIDATE_URL) === false)) {
            return $app->json(array('ok' => false, 'error' => '通知の URL の形が正しくありません'), 400);
        }
        if ($api->config() === null) {
            return $app->json(array('ok' => false, 'error' => '先に API とつないでください'), 400);
        }

        return $app->json($api->startRun($url === '' ? null : $url));
    }

    public function runs(Application $app)
    {
        $api = $app['self_harden3.api'];
        if ($api->config() === null) {
            return $app->json(array('ok' => false, 'error' => 'not_connected'));
        }

        return $app->json($api->listRuns());
    }

    public function status(Application $app, $run_id)
    {
        if ($app['self_harden3.api']->config() === null) {
            return $app->json(array('ok' => false, 'error' => 'not_connected'));
        }

        return $app->json($app['self_harden3.api']->getRun($run_id));
    }
}
