<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 4 系のプラグインの ApiClient のテスト(tests/run.sh から docker の中で動かす)。
// 承認にかかわる API の返事は、API の署名(呼び出しの nonce に結びつく)が合わなければ使わないことを、偽の API(php -S)で確かめる。
// EC-CUBE 本体は要らない(EccubeConfig は型の名前だけで、コンストラクタは通さない)

namespace Eccube\Common {
    if (!class_exists(EccubeConfig::class)) {
        class EccubeConfig
        {
        }
    }
}

namespace {
    require __DIR__.'/../SelfHarden/Service/Installer.php';
    require __DIR__.'/../SelfHarden/Service/ApiClient.php';

    use Plugin\SelfHarden\Service\ApiClient;

    $fail = 0;
    function ok($cond, $name)
    {
        global $fail;
        echo ($cond ? '  ok    ' : '  FAIL  ').$name."\n";
        if (!$cond) {
            $fail++;
        }
    }

    // 偽の API: 返事の署名の付け方を、置いたファイル(mode)で切り替える
    $dir = sys_get_temp_dir().'/sh-apiclient-'.bin2hex(random_bytes(4));
    mkdir($dir.'/var/self-harden', 0700, true);
    $secret = bin2hex(random_bytes(32));
    $router = $dir.'/api.php';
    file_put_contents($router, '<?php
$mode = trim((string) @file_get_contents('.var_export($dir.'/mode', true).'));
$body = json_encode(["ok" => true, "proposals" => [["proposal_id" => "prp_0123456789abcdef", "status" => "pending"]], "status" => "applied"]);
$nonce = isset($_SERVER["HTTP_X_SH_NONCE"]) ? $_SERVER["HTTP_X_SH_NONCE"] : "";
$sig = hash_hmac("sha256", "SH1-API-RES\n".$nonce."\n".hash("sha256", $body), '.var_export($secret, true).');
if ($mode === "good") { header("X-SH-Api-Signature: ".$sig); }
if ($mode === "bad") { header("X-SH-Api-Signature: ".str_repeat("0", 64)); }
if ($mode === "other_nonce") { header("X-SH-Api-Signature: ".hash_hmac("sha256", "SH1-API-RES\nzzz\n".hash("sha256", $body), '.var_export($secret, true).')); }
if ($mode === "other_body") { header("X-SH-Api-Signature: ".$sig); $body = str_replace("pending", "applied", $body); }
header("Content-Type: application/json");
echo $body;
');
    $port = 18000 + random_int(0, 999);
    $proc = proc_open(['php', '-S', '127.0.0.1:'.$port, $router], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
    for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
        usleep(100000);
    }

    // 手元の http を許す(デモと同じ。https 以外は環境変数で明示したときだけ)
    putenv('SELF_HARDEN_ALLOW_HTTP_API=1');
    file_put_contents($dir.'/var/self-harden/config.php', "<?php exit; ?>\n".json_encode([
        'shop_id' => 'shp_0123456789abcdef', 'secret' => $secret, 'api_base' => 'http://127.0.0.1:'.$port,
        'self_base' => 'http://127.0.0.1', 'public_base' => 'http://127.0.0.1',
    ])."\n");
    $rc = new ReflectionClass(ApiClient::class);
    $api = $rc->newInstanceWithoutConstructor();
    $rp = $rc->getProperty('root');
    $rp->setAccessible(true);
    $rp->setValue($api, $dir);

    echo "API の返事の署名(承認にかかわる返事)\n";
    $set = function ($m) use ($dir) { file_put_contents($dir.'/mode', $m); };
    $set('good');
    $r = $api->listProposals();
    ok(!empty($r['ok']) && isset($r['proposals'][0]['proposal_id']), '正しい署名の返事は使う(提案の一覧)');
    $r = $api->approve('prp_0123456789abcdef', ['sig' => 'x']);
    ok(!empty($r['ok']) && ($r['status'] ?? '') === 'applied', '正しい署名の返事は使う(承認の取り次ぎ)');
    foreach (['bad' => '壊れた署名', 'none' => '署名なし', 'other_nonce' => '別の呼び出しの署名', 'other_body' => '署名のあとに中身を書き換えた'] as $m => $label) {
        $set($m);
        $r1 = $api->listProposals();
        $r2 = $api->getProposal('prp_0123456789abcdef');
        $r3 = $api->approve('prp_0123456789abcdef', ['sig' => 'x']);
        ok(($r1['error'] ?? '') === 'bad_api_signature' && empty($r1['ok']) && !isset($r1['proposals']), $label.' → 提案の一覧を使わない');
        ok(($r2['error'] ?? '') === 'bad_api_signature' && empty($r2['ok']), $label.' → 提案 1 件を使わない');
        ok(($r3['error'] ?? '') === 'bad_api_signature' && empty($r3['ok']) && !isset($r3['status']), $label.' → 承認の結果を使わない');
    }

    echo "API の URL\n";
    ok(ApiClient::apiBaseAllowed('https://api.example.com'), 'https は許す');
    putenv('SELF_HARDEN_ALLOW_HTTP_API');
    ok(!ApiClient::apiBaseAllowed('http://127.0.0.1:8787'), 'http は、明示して許さない限り断る');
    putenv('SELF_HARDEN_ALLOW_HTTP_API=1');
    ok(ApiClient::apiBaseAllowed('http://api:8787'), '明示して許したときは、手元の名前の http を許す');
    ok(!ApiClient::apiBaseAllowed('http://api.example.com'), '明示して許しても、外の名前の http は断る');
    ok(!ApiClient::apiBaseAllowed('http://8.8.8.8'), '明示して許しても、外の住所の http は断る');
    $set('good');
    putenv('SELF_HARDEN_ALLOW_HTTP_API');
    $r = $api->listProposals();
    ok(($r['error'] ?? '') === 'api_base_not_https', 'http の API には、そもそも送らない');

    proc_terminate($proc);
    array_map('unlink', glob($dir.'/var/self-harden/*'));
    @rmdir($dir.'/var/self-harden');
    @rmdir($dir.'/var');
    array_map('unlink', glob($dir.'/*'));
    @rmdir($dir);
    echo $fail === 0 ? "ApiClient: all ok\n" : "ApiClient: {$fail} fail\n";
    exit($fail === 0 ? 0 : 1);
}
