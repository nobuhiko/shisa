<?php
// SPDX-License-Identifier: GPL-2.0-or-later

require_once CLASS_EX_REALDIR . 'page_extends/admin/LC_Page_Admin_Ex.php';
require_once PLUGIN_UPLOAD_REALDIR . 'SelfHarden2/SelfHarden2_ApiClient.php';

/**
 * 管理画面: API とつなぐ、点検を始める(通知の URL を貼ってもよい)、経過を見る。
 * 4 系の Controller/Admin/ConfigController.php と同じ働き。経路は 1 つ(load_plugin_config.php?plugin_id=N)で、mode で分ける:
 *   (なし)      画面
 *   connect     POST: API とつなぐ(終わったら画面に戻す)
 *   run         POST: 点検を始める(JSON)
 *   runs        GET : 点検の一覧(JSON)
 *   run_status  GET : 1 つの点検の経過(JSON)
 * mode が付いた呼び出しは、EC-CUBE がトランザクショントークン(transactionid)を確かめてから通す(LC_Page_Admin::init)
 */
class LC_Page_Plugin_SelfHarden2_Config extends LC_Page_Admin_Ex
{
    /** @var SelfHarden2_ApiClient */
    private $api;

    public function init()
    {
        parent::init();
        $this->tpl_mainpage = PLUGIN_UPLOAD_REALDIR . 'SelfHarden2/config.tpl';
        $this->tpl_subtitle = 'Shisa(シーサー) お店の守り神';
        $this->api = new SelfHarden2_ApiClient();
    }

    public function process()
    {
        $this->action();
        $this->sendResponse();
    }

    public function action()
    {
        $post = $_SERVER['REQUEST_METHOD'] === 'POST';
        switch ($this->getMode()) {
            case 'connect':
                if ($post) {
                    $this->connect();
                }
                $this->backToPage();
                break;
            case 'run':
                $this->json($post ? $this->run() : array('ok' => false, 'error' => 'POST で送ってください'), $post ? 200 : 405);
                break;
            case 'runs':
                $this->json($this->api->config() === null ? array('ok' => false, 'error' => 'not_connected') : $this->api->listRuns());
                break;
            case 'run_status':
                $id = isset($_GET['run_id']) ? (string) $_GET['run_id'] : '';
                if (!preg_match('/^run_[0-9a-f]{8,32}$/', $id)) {
                    $this->json(array('ok' => false, 'error' => 'bad_run_id'), 400);
                }
                $this->json($this->api->config() === null ? array('ok' => false, 'error' => 'not_connected') : $this->api->getRun($id));
                break;
            default:
                $this->show();
                break;
        }
        // 管理画面のナビゲーションを使わない、ポップアップ用の 1 枚
        $this->setTemplate($this->tpl_mainpage);
    }

    private function show()
    {
        $c = $this->api->config();
        $origin = (SC_Utils_Ex::sfIsHTTPS() ? 'https' : 'http') . '://' . $_SERVER['HTTP_HOST'];
        $this->connected = $c !== null;
        $this->shop_id = $c && isset($c['shop_id']) ? $c['shop_id'] : '';
        $this->api_base = $c && isset($c['api_base']) ? $c['api_base'] : (getenv('SELF_HARDEN_API') ?: 'http://api:8787');
        // API から店に届く URL。ふつうは外から見た URL と同じ。手元の検証環境のように違うときだけ、サーバー側で SELF_HARDEN_SELF_BASE を決める
        $this->self_base = $c && isset($c['self_base']) ? $c['self_base'] : (getenv('SELF_HARDEN_SELF_BASE') ?: $origin);
        $this->public_base = $c && isset($c['public_base']) ? $c['public_base'] : $origin;
        $runs = array();
        if ($c) {
            $res = $this->api->listRuns();
            foreach (isset($res['runs']) && is_array($res['runs']) ? $res['runs'] : array() as $r) {
                $runs[] = array(
                    'run_id' => (string) $r['run_id'],
                    'when' => date('Y-m-d H:i', (int) floor($r['created_at'] / 1000)),
                    'status' => (string) $r['status'],
                    'status_label' => $r['status'] === 'done' ? '完了' : ($r['status'] === 'running' ? '実行中' : '失敗'),
                    'advisory_url' => isset($r['advisory_url']) ? (string) $r['advisory_url'] : '',
                );
            }
        }
        $this->arrRuns = $runs;
        // 画面の JavaScript に渡すもの(呼び先とトークン)
        $base = $this->pageUrl() . '&' . TRANSACTION_ID_NAME . '=' . rawurlencode(SC_Helper_Session_Ex::getToken());
        $this->tpl_sh_js = json_encode(array(
            'connected' => $this->connected,
            'token_name' => TRANSACTION_ID_NAME,
            'token' => SC_Helper_Session_Ex::getToken(),
            'start_url' => $base . '&mode=run',
            'runs_url' => $base . '&mode=runs',
            'status_base' => $base . '&mode=run_status&run_id=',
        ), JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
        $this->tpl_page_url = $this->pageUrl();
        // 前の操作(つなぐ)の結果
        if (isset($_SESSION['self_harden2_flash'])) {
            $this->tpl_flash = $_SESSION['self_harden2_flash'];
            unset($_SESSION['self_harden2_flash']);
        }
    }

    private function connect()
    {
        $urls = array();
        foreach (array('api_base', 'self_base', 'public_base') as $k) {
            $v = isset($_POST[$k]) ? trim((string) $_POST[$k]) : '';
            if (!preg_match('#^https?://[A-Za-z0-9.\-]+(:[0-9]+)?/?$#', $v)) {
                $this->flash('error', 'URL の形が正しくありません: ' . $k);

                return;
            }
            $urls[$k] = $v;
        }
        try {
            $res = $this->api->connect($urls['api_base'], $urls['self_base'], $urls['public_base']);
        } catch (Exception $e) {
            $res = array('ok' => false, 'error' => $e->getMessage());
        }
        if (!empty($res['ok'])) {
            $this->flash('success', 'API とつながりました(店の ID: ' . $res['shop_id'] . ')');
        } else {
            $this->flash('error', 'API とつなげませんでした: ' . (isset($res['error']) ? $res['error'] : '') . ' ' . (isset($res['detail']) ? $res['detail'] : ''));
        }
    }

    private function run()
    {
        $url = isset($_POST['advisory_url']) ? trim((string) $_POST['advisory_url']) : '';
        if ($url !== '' && (!preg_match('#^https?://\S{1,2000}$#', $url) || filter_var($url, FILTER_VALIDATE_URL) === false)) {
            return array('ok' => false, 'error' => '通知の URL の形が正しくありません');
        }
        if ($this->api->config() === null) {
            return array('ok' => false, 'error' => '先に API とつないでください');
        }

        return $this->api->startRun($url === '' ? null : $url);
    }

    private function flash($kind, $message)
    {
        $_SESSION['self_harden2_flash'] = array('kind' => $kind, 'message' => $message);
    }

    /** この画面の URL(plugin_id 付き) */
    private function pageUrl()
    {
        $id = isset($_GET['plugin_id']) && is_numeric($_GET['plugin_id']) ? (int) $_GET['plugin_id'] : 0;

        return ROOT_URLPATH . ADMIN_DIR . 'load_plugin_config.php?plugin_id=' . $id;
    }

    private function backToPage()
    {
        header('Location: ' . $this->pageUrl(), true, 303);
        exit;
    }

    private function json(array $data, $status = 200)
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}
