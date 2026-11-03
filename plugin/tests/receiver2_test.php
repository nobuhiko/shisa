<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 受け口の 2 系(2.13〜)の地図のテスト。tests/run.sh から docker の中で動かす。
// 2 系の置き方: 公開の場所は html/(窓口はここ)、本体は data/(その上の階)。

$here = dirname(__DIR__);
$receiver = $here . '/SelfHarden/Resource/receiver/self-harden.php';
$work = $here . '/.work/t3-' . PHP_MAJOR_VERSION . PHP_MINOR_VERSION . '-' . getmypid();
$shop = $work . '/shop';
$pub = $shop . '/html';
$port = 16000 + (getmypid() % 900);
$base = "http://127.0.0.1:$port";
$vport = $port + 900;
$vbase = "http://127.0.0.1:$vport";
$secret = bin2hex(random_bytes(32));
$shopId = 'shp_test2001';

foreach (['/data/class', '/data/config', '/data/self-harden', '/html/upload'] as $d) {
    @mkdir($shop . $d, 0777, true);
}
copy($receiver, $pub . '/self-harden.php');
file_put_contents($shop . '/data/class/SC_Initial.php', "<?php\nclass SC_Initial {\n    public function __construct()\n    {\n        define('ECCUBE_VERSION', '2.17.2');\n    }\n}\n");
file_put_contents($shop . '/data/config/config.php', "<?php define('DB_PASSWORD', 'dbsecret');\n");
file_put_contents($shop . '/data/self-harden/config.php', "<?php exit; ?>\n" . json_encode([
    'shop_id' => $shopId, 'secret' => $secret, 'self_base' => $vbase, 'api_base' => 'http://api.invalid',
]));
file_put_contents($pub . '/index.php', "<?php echo 'tampered';\n");
file_put_contents($shop . '/composer.lock', json_encode(['packages' => []]));

$srv = proc_open(['php', '-S', "127.0.0.1:$port", '-t', $pub, __DIR__ . '/router.php'],
    [0 => ['pipe', 'r'], 1 => ['file', $work . '/server.log', 'a'], 2 => ['file', $work . '/server.log', 'a']], $pipes);
$vsrv = proc_open(['php', '-S', "127.0.0.1:$vport", '-t', $pub, __DIR__ . '/router.php'],
    [0 => ['pipe', 'r'], 1 => ['file', $work . '/server.log', 'a'], 2 => ['file', $work . '/server.log', 'a']], $vpipes);
register_shutdown_function(function () use ($srv, $vsrv, $work) {
    proc_terminate($srv);
    proc_terminate($vsrv);
    exec('rm -rf ' . escapeshellarg($work));
});
for ($i = 0; $i < 50; $i++) {
    if (@file_get_contents($base . '/self-harden.php') !== false && @file_get_contents($vbase . '/self-harden.php') !== false) {
        break;
    }
    usleep(100000);
}

$pass = 0;
$fail = 0;
function check($name, $cond, $info = '')
{
    global $pass, $fail;
    if ($cond) {
        $pass++;
        echo "  ok    $name\n";
    } else {
        $fail++;
        echo "  FAIL  $name" . ($info !== '' ? "  -- $info" : '') . "\n";
    }
}
function call($op, array $args = [])
{
    global $base, $secret, $shopId;
    $body = json_encode(['op' => $op, 'args' => (object) $args]);
    $ts = (string) time();
    $nonce = bin2hex(random_bytes(16));
    $s = implode("\n", ['SH1', 'POST', '/self-harden.php', $shopId, $ts, $nonce, hash('sha256', $body)]);
    $ch = curl_init($base . '/self-harden.php');
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 60,
        CURLOPT_HTTPHEADER => ["X-SH-Shop: $shopId", "X-SH-Timestamp: $ts", "X-SH-Nonce: $nonce", 'X-SH-Signature: ' . hash_hmac('sha256', $s, $secret)]]);
    $out = (string) curl_exec($ch);
    curl_close($ch);
    return ['body' => $out, 'json' => json_decode($out, true)];
}
function err($r)
{
    return isset($r['json']['error']) ? $r['json']['error'] : null;
}

echo "2 系の地図\n";
$r = call('ping');
check('2 系: ping は地図 eccube2 を返す', !empty($r['json']['ok']) && $r['json']['result']['map'] === 'eccube2', $r['body']);
$r = call('inspect', ['sections' => ['app', 'paths']]);
check('2 系: 本体の一番上は html/ の上の階、公開の場所は html', !empty($r['json']['ok']) && realpath($r['json']['result']['paths']['root']) === realpath($shop)
    && $r['json']['result']['paths']['public'] === 'html', $r['body']);
check('2 系: 版を読める(2.17.2)', !empty($r['json']['ok']) && $r['json']['result']['app']['eccube_version'] === '2.17.2', $r['body']);
check('2 系: 鍵の置き場は公開の場所の外(data/self-harden)', is_dir($shop . '/data/self-harden/nonces') && !is_dir($pub . '/var'));
$r = call('read_file', ['path' => 'data/class/SC_Initial.php']);
check('2 系: data/ の本体のファイルを読める', !empty($r['json']['ok']) && strpos($r['json']['result']['content'], '2.17.2') !== false, $r['body']);
foreach (['data/config/config.php', 'html/self-harden.php', 'data/self-harden/config.php'] as $p) {
    $r = call('read_file', ['path' => $p]);
    check('2 系: 読ませない: ' . $p, err($r) === 'not_readable', $r['body']);
}
foreach (['../outside.txt', '/etc/passwd', 'src/x.php'] as $p) {
    $r = call('read_file', ['path' => $p]);
    check('2 系: 読めない(外・本体のフォルダ以外): ' . $p, isset($r['json']['ok']) && $r['json']['ok'] === false, $r['body']);
}
$r = call('write_file', ['target' => 'root/.htaccess', 'content' => "Options -Indexes\n"]);
check('2 系: root/.htaccess は公開の場所(html/.htaccess)に書く', !empty($r['json']['ok']) && is_file($pub . '/.htaccess') && !is_file($shop . '/.htaccess'), $r['body']);
$r = call('lab_arm');
check('2 系: 小部屋は公開の場所の中に作る', !empty($r['json']['ok']) && is_dir($pub . '/self-harden-lab'), $r['body']);

$tok = isset($r['json']['result']['token']) ? $r['json']['result']['token'] : '';
$pr = @file_get_contents($base . '/self-harden-lab/probe.php?t=' . $tok);
check('2 系: 小部屋の確認ページが、地図の置き場の合言葉で開く', is_string($pr) && strpos($pr, 'memory_limit') !== false, (string) $pr);
$pr = @file_get_contents($base . '/self-harden-lab/probe.php?t=wrong');
check('2 系: 合言葉が違えば開かない', $pr === false);$r = call('clear_cache', ['verify' => ['paths' => ['/']]]);
check('2 系: キャッシュを消す操作は断る', err($r) === 'no_cache', $r['body']);
$r = call('restore_official', ['path' => 'html/index.php', 'ref' => '2.17.2']);
check('2 系: eccube- の付かないタグは断る', err($r) === 'bad_ref', $r['body']);
$r = call('restore_official', ['path' => 'html/index.php', 'ref' => 'eccube-2.13.5']);
check('2 系: 今の版より古いタグは断る', err($r) === 'bad_ref', $r['body']);
$r = call('restore_official', ['path' => 'html/index.php', 'ref' => 'eccube-2.17.2', 'verify' => ['paths' => ['/']]]);
check('2 系: 書き換えられた html/index.php を公式のタグ eccube-2.17.2 の中身に戻す', !empty($r['json']['ok']) && strpos((string) file_get_contents($pub . '/index.php'), 'tampered') === false
    && strpos((string) file_get_contents($pub . '/index.php'), 'require') !== false, $r['body']);
$r = call('apply_official_release', ['ref' => 'eccube-2.17.1', 'paths' => ['data/x.php'], 'expected_sha256' => ['data/x.php' => str_repeat('0', 64)]]);
check('2 系: 古い版への配布物は断る', err($r) === 'bad_ref', $r['body']);

echo "\n$pass ok, $fail fail\n";
exit($fail === 0 ? 0 : 1);
