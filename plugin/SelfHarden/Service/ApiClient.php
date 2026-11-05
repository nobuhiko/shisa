<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden\Service;

use Eccube\Common\EccubeConfig;

/**
 * 店 → API の呼び出し。鍵は var/self-harden/config.php(受け口と同じもの)。署名の形は docs/api.md
 */
class ApiClient
{
    /** @var string */
    private $root;

    public function __construct(EccubeConfig $eccubeConfig)
    {
        $this->root = $eccubeConfig->get('kernel.project_dir');
    }

    private function configPath()
    {
        return $this->root.'/'.Installer::VAR_DIR.'/config.php';
    }

    public function config()
    {
        $raw = @file_get_contents($this->configPath());
        if (!is_string($raw) || ($pos = strpos($raw, "\n")) === false) {
            return null;
        }
        $c = json_decode(substr($raw, $pos + 1), true);

        return is_array($c) ? $c : null;
    }

    private function saveConfig(array $c)
    {
        Installer::place($this->root);
        $p = $this->configPath();
        $tmp = $p.'.tmp-'.bin2hex(random_bytes(4));
        file_put_contents($tmp, "<?php exit; ?>\n".json_encode($c, JSON_UNESCAPED_SLASHES)."\n");
        @chmod($tmp, 0600);
        rename($tmp, $p);
    }

    /**
     * 鍵を作り、API に登録する。前の鍵があれば、それで署名して登録し直す
     */
    public function connect($apiBase, $selfBase, $publicBase)
    {
        $old = $this->config();
        $shopId = $old && isset($old['shop_id']) ? $old['shop_id'] : 'shp_'.bin2hex(random_bytes(8));
        $secret = bin2hex(random_bytes(32));
        $new = [
            'shop_id' => $shopId, 'secret' => $secret, 'api_base' => rtrim($apiBase, '/'),
            'self_base' => rtrim($selfBase, '/'), 'public_base' => rtrim($publicBase, '/'), 'created_at' => time(),
        ];
        $body = json_encode([
            'shop_id' => $shopId, 'receiver_url' => $new['self_base'].'/'.Installer::RECEIVER, 'shop_url' => $new['self_base'],
            'secret' => $secret, 'platform' => 'eccube-4.2', 'plugin_version' => '0.1.0',
        ], JSON_UNESCAPED_SLASHES);
        // 受け口が ping に答えられるように、先に新しい鍵を置く。失敗したら前の鍵に戻す
        $this->saveConfig($new);
        $res = $this->request('POST', $new['api_base'], '/v1/shops', $body, $old && isset($old['secret']) ? $old : null);
        if (!$res['ok'] && $old) {
            $this->saveConfig($old);
        }

        return $res;
    }

    public function startRun($advisoryUrl)
    {
        $c = $this->config();
        $body = json_encode($advisoryUrl ? ['advisory_url' => $advisoryUrl] : new \stdClass(), JSON_UNESCAPED_SLASHES);

        return $this->request('POST', $c['api_base'], '/v1/shops/'.$c['shop_id'].'/runs', $body, $c);
    }

    public function getRun($runId)
    {
        $c = $this->config();

        return $this->request('GET', $c['api_base'], '/v1/shops/'.$c['shop_id'].'/runs/'.rawurlencode($runId), '', $c);
    }

    public function listRuns()
    {
        $c = $this->config();

        return $this->request('GET', $c['api_base'], '/v1/shops/'.$c['shop_id'].'/runs', '', $c);
    }

    public function listProposals()
    {
        $c = $this->config();

        return $this->request('GET', $c['api_base'], '/v1/shops/'.$c['shop_id'].'/proposals', '', $c, 25, true);
    }

    public function getProposal($proposalId)
    {
        $c = $this->config();

        return $this->request('GET', $c['api_base'], '/v1/shops/'.$c['shop_id'].'/proposals/'.rawurlencode($proposalId), '', $c, 25, true);
    }

    /** 承認の印を API に渡す(API は窓口に取り次ぐだけ。印はお店の中の鍵で作ったもの) */
    public function approve($proposalId, array $approval)
    {
        $c = $this->config();
        $body = json_encode(['approval' => $approval], JSON_UNESCAPED_SLASHES);

        return $this->request('POST', $c['api_base'], '/v1/shops/'.$c['shop_id'].'/proposals/'.rawurlencode($proposalId).'/approve', $body, $c, 60, true);
    }

    /** 止まった版上げを戻す(API は、承認のときに控えた印で窓口に戻しを指示するだけ) */
    public function rollbackUpgrade($proposalId)
    {
        $c = $this->config();

        return $this->request('POST', $c['api_base'], '/v1/shops/'.$c['shop_id'].'/proposals/'.rawurlencode($proposalId).'/rollback', '{}', $c, 60, true);
    }

    /**
     * 止まったままの版上げがあれば、窓口に ping を送って着地させる(API が来なくても、店主が管理画面を開けば回復の機会になる)。
     * 版上げの作業の記録(state.json)を見るだけで、止まっていなければ何もしない。窓口への呼び出しは、受け口と同じ鍵で署名する
     */
    public function pokeStalledUpgrade()
    {
        $dir = $this->root.'/'.Installer::VAR_DIR.'/upgrade';
        if (!is_dir($dir)) {
            return false;
        }
        $staleAfter = 600;
        $tm = $this->root.'/'.Installer::VAR_DIR.'/.test-mode';
        if (is_file($tm)) {
            $t = json_decode((string) @file_get_contents($tm), true);
            if (is_array($t) && isset($t['stale_after'])) {
                $staleAfter = max(1, (int) $t['stale_after']);
            }
        }
        $stalled = false;
        foreach ((array) glob($dir.'/prp_*/state.json') as $f) {
            $st = json_decode((string) @file_get_contents($f), true);
            if (is_array($st) && in_array($st['status'] ?? '', ['running', 'rolling_back'], true) && time() - (int) ($st['updated_at'] ?? 0) >= $staleAfter) {
                $stalled = true;
                break;
            }
        }
        $c = $this->config();
        if (!$stalled || !$c || empty($c['self_base']) || empty($c['secret']) || empty($c['shop_id'])) {
            return false;
        }
        $base = rtrim((string) $c['self_base'], '/');
        $path = (string) (parse_url($base, PHP_URL_PATH) ?: '').'/self-harden.php';
        $body = json_encode(['op' => 'ping', 'args' => new \stdClass()]);
        $ts = (string) time();
        $nonce = bin2hex(random_bytes(16));
        $s = implode("\n", ['SH1', 'POST', $path, $c['shop_id'], $ts, $nonce, hash('sha256', $body)]);
        $ch = curl_init($base.'/self-harden.php');
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25, CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-SH-Shop: '.$c['shop_id'], 'X-SH-Timestamp: '.$ts, 'X-SH-Nonce: '.$nonce,
                'X-SH-Signature: '.hash_hmac('sha256', $s, (string) $c['secret'])]]);
        curl_exec($ch);
        curl_close($ch);

        return true;
    }

    public function shopId()
    {
        $c = $this->config();

        return $c ? $c['shop_id'] : null;
    }

    public function root()
    {
        return $this->root;
    }

    /**
     * API の URL は https だけ。手元の検証環境だけ、サーバー側の SELF_HARDEN_ALLOW_HTTP_API=1 で http を許す。
     * そのときも、行き先は手元の名前(点の無い名前・localhost・ループバック・プライベートの住所)に限る(外の http には送らない)
     */
    public static function apiBaseAllowed($base)
    {
        if (!is_string($base)) {
            return false;
        }
        if (strpos($base, 'https://') === 0) {
            return true;
        }
        if (getenv('SELF_HARDEN_ALLOW_HTTP_API') !== '1' || strpos($base, 'http://') !== 0) {
            return false;
        }
        $host = strtolower((string) parse_url($base, PHP_URL_HOST));
        if ($host === '') {
            return false;
        }
        if ($host === 'localhost' || strpos($host, '.') === false) {
            return true;
        }
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
        }

        return false;
    }

    /**
     * $requireSig: 承認にかかわる返事は、API の署名(呼び出しの nonce に結びつく)を確かめ、合わなければ使わない
     */
    private function request($method, $base, $path, $body, $signWith, $timeout = 25, $requireSig = false)
    {
        if (!self::apiBaseAllowed($base)) {
            return ['ok' => false, 'error' => 'api_base_not_https', 'detail' => 'API の URL は https にしてください'];
        }
        $headers = ['Content-Type: application/json'];
        $nonce = null;
        if ($signWith) {
            $ts = (string) time();
            $nonce = bin2hex(random_bytes(16));
            $s = implode("\n", ['SH1', $method, $path, $signWith['shop_id'], $ts, $nonce, hash('sha256', $body)]);
            $headers[] = 'X-SH-Shop: '.$signWith['shop_id'];
            $headers[] = 'X-SH-Timestamp: '.$ts;
            $headers[] = 'X-SH-Nonce: '.$nonce;
            $headers[] = 'X-SH-Signature: '.hash_hmac('sha256', $s, $signWith['secret']);
        }
        $resSig = null;
        $ch = curl_init($base.$path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_HTTPHEADER => $headers, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$resSig) {
                if (stripos($line, 'X-SH-Api-Signature:') === 0) {
                    $resSig = trim(substr($line, strlen('X-SH-Api-Signature:')));
                }

                return strlen($line);
            },
        ]);
        if ($method !== 'GET') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $out = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($requireSig) {
            $expect = ($signWith && $nonce !== null && is_string($out))
                ? hash_hmac('sha256', "SH1-API-RES\n".$nonce."\n".hash('sha256', $out), $signWith['secret']) : null;
            if ($expect === null || !is_string($resSig) || !hash_equals($expect, $resSig)) {
                return ['ok' => false, 'error' => 'bad_api_signature', 'detail' => 'API からの返事の署名が合いません(途中で書き換えられたおそれ)'];
            }
        }
        $json = is_string($out) ? json_decode($out, true) : null;
        if (!is_array($json)) {
            return ['ok' => false, 'error' => 'api_unreachable', 'detail' => $err ?: 'HTTP '.$status];
        }

        return $json + ['ok' => $status < 400];
    }
}
