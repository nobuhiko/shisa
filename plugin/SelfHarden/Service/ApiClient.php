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

    private function request($method, $base, $path, $body, $signWith)
    {
        $headers = ['Content-Type: application/json'];
        if ($signWith) {
            $ts = (string) time();
            $nonce = bin2hex(random_bytes(16));
            $s = implode("\n", ['SH1', $method, $path, $signWith['shop_id'], $ts, $nonce, hash('sha256', $body)]);
            $headers[] = 'X-SH-Shop: '.$signWith['shop_id'];
            $headers[] = 'X-SH-Timestamp: '.$ts;
            $headers[] = 'X-SH-Nonce: '.$nonce;
            $headers[] = 'X-SH-Signature: '.hash_hmac('sha256', $s, $signWith['secret']);
        }
        $ch = curl_init($base.$path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25,
            CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_HTTPHEADER => $headers, CURLOPT_FOLLOWLOCATION => false,
        ]);
        if ($method !== 'GET') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $out = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        $json = is_string($out) ? json_decode($out, true) : null;
        if (!is_array($json)) {
            return ['ok' => false, 'error' => 'api_unreachable', 'detail' => $err ?: 'HTTP '.$status];
        }

        return $json + ['ok' => $status < 400];
    }
}
