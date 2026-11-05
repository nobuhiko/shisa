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
    /** 画面で見せた提案の中身(ハッシュ)と確認コードを覚えておく、セッションの名前 */
    const SEEN_KEY = 'self_harden_seen_proposals';
    /** 承認できる権限(EC-CUBE 4 の mtb_authority: 0 システム管理者、1 店舗オーナー) */
    const APPROVE_AUTHORITIES = [0, 1];

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
        if (!ApiClient::apiBaseAllowed($urls['api_base'])) {
            $this->addError('API の URL は https にしてください', 'admin');

            return $this->redirectToRoute('self_harden_admin_config');
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
    public function proposals(Request $request)
    {
        if ($this->api->config() === null) {
            return new JsonResponse(['ok' => false, 'error' => 'not_connected']);
        }
        $res = $this->api->listProposals();
        if (empty($res['ok']) || !isset($res['proposals']) || !is_array($res['proposals'])) {
            return new JsonResponse($res);
        }
        // 画面に見せた中身(ハッシュ)と確認コードを、この管理者のセッションに覚える。承認はこれと完全に一致するときだけ
        $session = $request->getSession();
        $seen = (array) $session->get(self::SEEN_KEY, []);
        $res['can_approve'] = $this->canApprove();
        foreach ($res['proposals'] as $i => $p) {
            if (($p['status'] ?? '') !== 'pending') {
                unset($res['proposals'][$i]['new_content']);
                continue;
            }
            if (($p['kind'] ?? 'fix') === 'upgrade') {
                // 版上げ: 今の版が提案の「今の版」と同じか。中身は公式の配布物なので、版の組み合わせに結びつける
                $from = (string) ($p['from_version'] ?? '');
                $to = (string) ($p['to_version'] ?? '');
                $res['proposals'][$i]['installed'] = \Eccube\Common\Constant::VERSION;
                $res['proposals'][$i]['changed'] = !hash_equals($from, \Eccube\Common\Constant::VERSION);
                $res['proposals'][$i]['content_ok'] = hash_equals((string) ($p['sha256_before'] ?? ''), hash('sha256', 'SH-UPGRADE|'.$from))
                    && hash_equals((string) ($p['sha256_new'] ?? ''), $this->upgradeNewHash($p));
            } else {
                $cur = $this->localFile((string) ($p['path'] ?? ''));
                $res['proposals'][$i]['current'] = $cur;
                $res['proposals'][$i]['changed'] = $cur === null || !hash_equals((string) ($p['sha256_before'] ?? ''), hash('sha256', $cur));
                $res['proposals'][$i]['content_ok'] = isset($p['new_content'], $p['sha256_new']) && is_string($p['new_content']) && hash_equals((string) $p['sha256_new'], hash('sha256', $p['new_content']));
            }
            $pid = (string) ($p['proposal_id'] ?? '');
            if (preg_match('/^prp_[0-9a-f]{16}$/', $pid) && $res['proposals'][$i]['content_ok']) {
                $prev = $seen[$pid] ?? null;
                $same = is_array($prev) && hash_equals((string) $prev['new'], (string) $p['sha256_new']) && hash_equals((string) $prev['before'], (string) $p['sha256_before']);
                $seen[$pid] = ['new' => (string) $p['sha256_new'], 'before' => (string) $p['sha256_before'],
                    'code' => $same ? $prev['code'] : sprintf('%04d', random_int(0, 9999)), 'at' => time()];
                $res['proposals'][$i]['confirm_code'] = $seen[$pid]['code'];
            }
        }
        $session->set(self::SEEN_KEY, array_slice($seen, -20, null, true));
        $res['proposals'] = array_values($res['proposals']);

        return new JsonResponse($res);
    }

    /**
     * 止まった版上げを、控えから戻す(メンテナンス中のまま放っておかないため)
     *
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/rollback/{proposal_id}", name="self_harden_admin_rollback", methods={"POST"}, requirements={"proposal_id"="prp_[0-9a-f]{16}"})
     */
    public function rollback(Request $request, $proposal_id)
    {
        $this->isTokenValid();
        if (!$this->canApprove()) {
            return new JsonResponse(['ok' => false, 'error' => '戻せるのは、システム管理者か店舗オーナーの権限の管理者だけです'], 403);
        }
        if ($this->api->config() === null) {
            return new JsonResponse(['ok' => false, 'error' => '先に API とつないでください'], 400);
        }

        return new JsonResponse($this->api->rollbackUpgrade($proposal_id));
    }

    /**
     * 店主が「承認して直す」を押した。お店の中の承認の鍵で印を作り、API(→ 窓口)に渡す。
     * 印は、画面で見せた書く中身(ここでハッシュを取り直す)と、今のファイルの中身に結びつく。期限は 30 分
     *
     * @Route("/%eccube_admin_route%/store/plugin/SelfHarden/approve/{proposal_id}", name="self_harden_admin_approve", methods={"POST"}, requirements={"proposal_id"="prp_[0-9a-f]{16}"})
     */
    public function approve(Request $request, $proposal_id)
    {
        $this->isTokenValid();
        // 承認できるのは、システム管理者か店舗オーナーの権限の管理者だけ
        if (!$this->canApprove()) {
            return new JsonResponse(['ok' => false, 'error' => '承認できるのは、システム管理者か店舗オーナーの権限の管理者だけです'], 403);
        }
        // 画面で見せた中身と確認コード(セッションに覚えたもの)と、送られてきたものが一致すること
        $session = $request->getSession();
        $seen = (array) $session->get(self::SEEN_KEY, []);
        $mine = $seen[$proposal_id] ?? null;
        if (!is_array($mine) || time() - (int) $mine['at'] > 1800) {
            return new JsonResponse(['ok' => false, 'error' => '画面を開き直して、中身を見てから承認してください'], 409);
        }
        $seenNew = (string) $request->get('sha256_new');
        $seenBefore = (string) $request->get('sha256_before');
        $code = (string) $request->get('confirm_code');
        if (!hash_equals((string) $mine['code'], $code)) {
            return new JsonResponse(['ok' => false, 'error' => '確認コードが違います'], 400);
        }
        if (!hash_equals((string) $mine['new'], $seenNew) || !hash_equals((string) $mine['before'], $seenBefore)) {
            return new JsonResponse(['ok' => false, 'error' => '画面で見た中身と合いません。画面を開き直してください'], 409);
        }
        if ($this->api->config() === null) {
            return new JsonResponse(['ok' => false, 'error' => '先に API とつないでください'], 400);
        }
        $key = Installer::approveKey($this->api->root());
        if ($key === null) {
            return new JsonResponse(['ok' => false, 'error' => '承認の鍵がありません。プラグインを有効にし直してください'], 400);
        }
        $res = $this->api->getProposal($proposal_id);
        $p = isset($res['proposal']) && is_array($res['proposal']) ? $res['proposal'] : null;
        if ($p && ($p['kind'] ?? 'fix') === 'upgrade') {
            return $this->approveUpgrade($request, $proposal_id, $p, $mine, $seen, $key);
        }
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
        // API から取り直した提案が、画面で見せたもの(セッション)と同じであること。違えば署名しない
        if (!hash_equals((string) $mine['new'], $new) || !hash_equals((string) $mine['before'], $before)) {
            return new JsonResponse(['ok' => false, 'error' => '画面で見たあとに、提案の中身が変わっています。画面を開き直してください'], 409);
        }
        unset($seen[$proposal_id]);
        $session->set(self::SEEN_KEY, $seen);
        $a = ['proposal_id' => $proposal_id, 'path' => $path, 'sha256_new' => $new, 'sha256_before' => $before,
            'expires_at' => time() + 1800, 'shop_id' => (string) $this->api->shopId()];
        $a['sig'] = hash_hmac('sha256', implode("\n", ['SH-APPROVE1', $a['shop_id'], $a['proposal_id'], $a['path'], $a['sha256_new'], $a['sha256_before'], (string) $a['expires_at']]), $key);

        return new JsonResponse($this->api->approve($proposal_id, $a));
    }

    /**
     * 版上げの承認。印は「今の版 → 上げ先の版」に結びつく。中身(公式の配布物)は窓口がチェックサムで確かめて取る
     */
    private function approveUpgrade(Request $request, $proposal_id, array $p, array $mine, array $seen, $key)
    {
        $from = (string) ($p['from_version'] ?? '');
        $to = (string) ($p['to_version'] ?? '');
        if (($p['status'] ?? '') !== 'pending' || !preg_match('/^4\.\d+\.\d+(-p\d+)?$/', $from) || !preg_match('/^4\.\d+\.\d+(-p\d+)?$/', $to)) {
            return new JsonResponse(['ok' => false, 'error' => 'この提案はもう承認できません'], 409);
        }
        if (!hash_equals($from, \Eccube\Common\Constant::VERSION)) {
            return new JsonResponse(['ok' => false, 'error' => '提案のあとに EC-CUBE の版が変わっています。次の点検で提案し直します'], 409);
        }
        $before = hash('sha256', 'SH-UPGRADE|'.$from);
        $new = $this->upgradeNewHash($p);
        if ($new === '') {
            return new JsonResponse(['ok' => false, 'error' => '提案の中身が合わないので、承認できません'], 409);
        }
        if (!hash_equals((string) ($p['sha256_before'] ?? ''), $before) || !hash_equals((string) ($p['sha256_new'] ?? ''), $new)
            || !hash_equals((string) $mine['new'], $new) || !hash_equals((string) $mine['before'], $before)) {
            return new JsonResponse(['ok' => false, 'error' => '画面で見たあとに、提案の中身が変わっています。画面を開き直してください'], 409);
        }
        unset($seen[$proposal_id]);
        $request->getSession()->set(self::SEEN_KEY, $seen);
        $a = ['proposal_id' => $proposal_id, 'from' => $from, 'to' => $to, 'expires_at' => time() + 1800, 'shop_id' => (string) $this->api->shopId(),
            'fp' => (string) $p['fingerprint'], 'keep' => $this->keepString($p)];
        $a['sig'] = hash_hmac('sha256', implode("\n", ['SH-UPGRADE2', $a['shop_id'], $a['proposal_id'], $a['from'], $a['to'], (string) $a['expires_at'], $a['fp'], $a['keep']]), $key);

        return new JsonResponse($this->api->approve($proposal_id, $a));
    }

    /**
     * 残す部品(新しい修正版のため上書きしない部品)を、印に入れる形にする: "vendor/package@版" を名前の順にカンマでつなぐ
     */
    private function keepString(array $p)
    {
        $out = [];
        foreach ((array) ($p['keep'] ?? []) as $k) {
            $name = is_array($k) ? (string) ($k['name'] ?? '') : '';
            $ver = is_array($k) ? (string) ($k['version'] ?? '') : '';
            if (!preg_match('#^[a-z0-9][a-z0-9_.\-]*/[a-z0-9][a-z0-9_.\-]*$#', $name) || strpos($name, '..') !== false || !preg_match('/^v?[0-9]+\.[0-9]+\.[0-9]+$/', $ver)) {
                return null;
            }
            $out[$name] = $name.'@'.$ver;
        }
        ksort($out, SORT_STRING);

        return implode(',', $out);
    }

    /**
     * 版上げの提案の「新しい中身」のハッシュ: 上げ先の版・調べたときのファイルの指紋・残す部品。画面で見たものと承認を結びつける
     */
    private function upgradeNewHash(array $p)
    {
        $fp = (string) ($p['fingerprint'] ?? '');
        $keep = $this->keepString($p);
        if (!preg_match('/^[0-9a-f]{64}$/', $fp) || $keep === null) {
            return '';
        }

        return hash('sha256', 'SH-UPGRADE|'.(string) ($p['to_version'] ?? '').'|'.$fp.'|'.$keep);
    }

    private function canApprove()
    {
        $u = $this->getUser();
        if (!is_object($u) || !method_exists($u, 'getAuthority')) {
            return false;
        }
        $a = $u->getAuthority();

        return is_object($a) && method_exists($a, 'getId') && in_array((int) $a->getId(), self::APPROVE_AUTHORITIES, true);
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
        if (!$inside || $root === false || $abs === false || strpos($abs, $root.'/') !== 0 || !is_file($abs) || filesize($abs) > 262144) {
            return null;
        }
        // 途中のフォルダも含めて、どこにもシンボリックリンクが無いこと(窓口と同じ)
        $cur = $this->api->root();
        foreach (explode('/', $path) as $part) {
            $cur .= '/'.$part;
            if (is_link($cur)) {
                return null;
            }
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
