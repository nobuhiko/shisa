<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden\Controller\Admin;

use Eccube\Controller\AbstractController;
use Plugin\SelfHarden\Service\ApiClient;
use Plugin\SelfHarden\Service\Installer;
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
        // お店がサブディレクトリにあれば、その下までをお店の URL にする
        $origin = $request->getSchemeAndHttpHost().rtrim($request->getBasePath(), '/');

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
            if (!preg_match('#^https?://[A-Za-z0-9.\-]+(:[0-9]+)?(/[A-Za-z0-9._~\-/]*)?$#', $v)) {
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
     * 店主の承認を待つ直し方の提案。今のファイルの中身はお店の中で読み、画面で書く中身と見比べられるようにする
     *
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/proposals", name="self_harden_admin_proposals", methods={"GET"})
     */
    public function proposals()
    {
        if ($this->api->config() === null) {
            return new JsonResponse(['ok' => false, 'error' => 'not_connected']);
        }
        $res = $this->api->listProposals();
        if (empty($res['ok']) || !isset($res['proposals']) || !is_array($res['proposals'])) {
            return new JsonResponse($res);
        }
        foreach ($res['proposals'] as $i => $p) {
            if (($p['status'] ?? '') !== 'pending') {
                unset($res['proposals'][$i]['new_content']);
                continue;
            }
            $cur = $this->localFile((string) ($p['path'] ?? ''));
            $res['proposals'][$i]['current'] = $cur;
            $res['proposals'][$i]['changed'] = $cur === null || !hash_equals((string) ($p['sha256_before'] ?? ''), hash('sha256', $cur));
            $res['proposals'][$i]['content_ok'] = isset($p['new_content'], $p['sha256_new']) && is_string($p['new_content']) && hash_equals((string) $p['sha256_new'], hash('sha256', $p['new_content']));
        }
        $res['proposals'] = array_values($res['proposals']);

        return new JsonResponse($res);
    }

    /**
     * 店主が「承認して直す」を押した。お店の中の承認の鍵で印を作り、API(→ 窓口)に渡す。
     * 印は、画面で見せた書く中身(ここでハッシュを取り直す)と、今のファイルの中身に結びつく。期限は 30 分
     *
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/approve/{proposal_id}", name="self_harden_admin_approve", methods={"POST"}, requirements={"proposal_id"="prp_[0-9a-f]{16}"})
     */
    public function approve($proposal_id)
    {
        $this->isTokenValid();
        if ($this->api->config() === null) {
            return new JsonResponse(['ok' => false, 'error' => '先に API とつないでください'], 400);
        }
        $key = Installer::approveKey($this->api->root());
        if ($key === null) {
            return new JsonResponse(['ok' => false, 'error' => '承認の鍵がありません。プラグインを有効にし直してください'], 400);
        }
        $res = $this->api->getProposal($proposal_id);
        $p = isset($res['proposal']) && is_array($res['proposal']) ? $res['proposal'] : null;
        if (!$p || ($p['status'] ?? '') !== 'pending' || !isset($p['new_content']) || !is_string($p['new_content'])) {
            return new JsonResponse(['ok' => false, 'error' => 'この提案はもう承認できません'], 409);
        }
        $path = (string) ($p['path'] ?? '');
        $cur = $this->localFile($path);
        if ($cur === null) {
            return new JsonResponse(['ok' => false, 'error' => '直す先のファイルが見つからないか、承認で直せる場所ではありません'], 400);
        }
        $before = hash('sha256', $cur);
        if (!hash_equals((string) ($p['sha256_before'] ?? ''), $before)) {
            return new JsonResponse(['ok' => false, 'error' => '提案のあとにファイルが変わっています。次の点検で提案し直します'], 409);
        }
        $new = hash('sha256', $p['new_content']);
        if (!hash_equals((string) ($p['sha256_new'] ?? ''), $new)) {
            return new JsonResponse(['ok' => false, 'error' => '提案の中身が合いません'], 409);
        }
        $a = ['proposal_id' => $proposal_id, 'path' => $path, 'sha256_new' => $new, 'sha256_before' => $before,
            'expires_at' => time() + 1800, 'shop_id' => (string) $this->api->shopId()];
        $a['sig'] = hash_hmac('sha256', implode("\n", ['SH-APPROVE1', $a['shop_id'], $a['proposal_id'], $a['path'], $a['sha256_new'], $a['sha256_before'], (string) $a['expires_at']]), $key);

        return new JsonResponse($this->api->approve($proposal_id, $a));
    }

    /** 承認で直してよい場所の中の、今あるファイルの中身(無い・場所の外なら null) */
    private function localFile($path)
    {
        if (!preg_match('#^[A-Za-z0-9._\-/]+$#', $path) || in_array('..', explode('/', $path), true) || in_array('', explode('/', $path), true)) {
            return null;
        }
        $inside = false;
        foreach (Installer::APPROVE_DIRS as $d) {
            if (strpos($path, $d.'/') === 0) {
                $inside = true;
            }
        }
        $root = realpath($this->api->root());
        $abs = realpath($this->api->root().'/'.$path);
        if (!$inside || $root === false || $abs === false || strpos($abs, $root.'/') !== 0 || !is_file($abs) || is_link($this->api->root().'/'.$path) || filesize($abs) > 262144) {
            return null;
        }
        $c = file_get_contents($abs);

        return is_string($c) ? $c : null;
    }

    /**
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/run/{run_id}", name="self_harden_admin_run_status", methods={"GET"}, requirements={"run_id"="run_[0-9a-f]{8,32}"})
     */
    public function status($run_id)
    {
        return new JsonResponse($this->api->getRun($run_id));
    }
}
