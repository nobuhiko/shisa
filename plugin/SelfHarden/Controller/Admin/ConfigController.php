<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden\Controller\Admin;

use Eccube\Controller\AbstractController;
use Plugin\SelfHarden\Service\ApiClient;
use Sensio\Bundle\FrameworkExtraBundle\Configuration\Template;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Annotation\Route;

/**
 * 管理画面: API とつなぐ、点検を始める(通知の URL を貼ってもよい)、経過を見る
 */
class ConfigController extends AbstractController
{
    /** @var ApiClient */
    private $api;

    public function __construct(ApiClient $api)
    {
        $this->api = $api;
    }

    /**
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/config", name="self_harden_admin_config", methods={"GET"})
     * @Template("@SelfHarden/admin/config.twig")
     */
    public function index(Request $request)
    {
        $c = $this->api->config();
        $origin = $request->getSchemeAndHttpHost();

        return [
            'connected' => $c !== null,
            'shop_id' => $c['shop_id'] ?? null,
            'api_base' => $c['api_base'] ?? (getenv('SELF_HARDEN_API') ?: 'http://api:8787'),
            // API から店に届く URL。ふつうは外から見た URL と同じ。手元の検証環境のように違うときだけ、サーバー側で SELF_HARDEN_SELF_BASE を決める
            'self_base' => $c['self_base'] ?? (getenv('SELF_HARDEN_SELF_BASE') ?: $origin),
            'public_base' => $c['public_base'] ?? $origin,
            'runs' => $c ? ($this->api->listRuns()['runs'] ?? []) : [],
        ];
    }

    /**
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/connect", name="self_harden_admin_connect", methods={"POST"})
     */
    public function connect(Request $request)
    {
        $this->isTokenValid();
        $urls = [];
        foreach (['api_base', 'self_base', 'public_base'] as $k) {
            $v = trim((string) $request->get($k));
            if (!preg_match('#^https?://[A-Za-z0-9.\-]+(:[0-9]+)?/?$#', $v)) {
                $this->addError('URL の形が正しくありません: '.$k, 'admin');

                return $this->redirectToRoute('self_harden_admin_config');
            }
            $urls[$k] = $v;
        }
        $res = $this->api->connect($urls['api_base'], $urls['self_base'], $urls['public_base']);
        if (!empty($res['ok'])) {
            $this->addSuccess('API とつながりました(店の ID: '.$res['shop_id'].')', 'admin');
        } else {
            $this->addError('API とつなげませんでした: '.($res['error'] ?? '').' '.($res['detail'] ?? ''), 'admin');
        }

        return $this->redirectToRoute('self_harden_admin_config');
    }

    /**
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/run", name="self_harden_admin_run", methods={"POST"})
     */
    public function run(Request $request)
    {
        $this->isTokenValid();
        $url = trim((string) $request->get('advisory_url'));
        if ($url !== '' && (!preg_match('#^https?://\S{1,2000}$#', $url) || filter_var($url, FILTER_VALIDATE_URL) === false)) {
            return new JsonResponse(['ok' => false, 'error' => '通知の URL の形が正しくありません'], 400);
        }
        if ($this->api->config() === null) {
            return new JsonResponse(['ok' => false, 'error' => '先に API とつないでください'], 400);
        }

        return new JsonResponse($this->api->startRun($url === '' ? null : $url));
    }

    /**
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/runs", name="self_harden_admin_runs", methods={"GET"})
     */
    public function runs()
    {
        if ($this->api->config() === null) {
            return new JsonResponse(['ok' => false, 'error' => 'not_connected']);
        }

        return new JsonResponse($this->api->listRuns());
    }

    /**
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/run/{run_id}", name="self_harden_admin_run_status", methods={"GET"}, requirements={"run_id"="run_[0-9a-f]{8,32}"})
     */
    public function status($run_id)
    {
        return new JsonResponse($this->api->getRun($run_id));
    }
}
