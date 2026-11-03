<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 受け口の 3 系(3.0.x)の地図のテスト。tests/run.sh から docker の中で動かす。
// 3 系の既定の置き方: 公開の場所は html/(窓口はここ)、本体のコード(src/ app/ vendor/)はその上の階。

$here = dirname(__DIR__);
$receiver = $here . '/SelfHarden/Resource/receiver/self-harden.php';
$work = $here . '/.work/t3-' . PHP_MAJOR_VERSION . PHP_MINOR_VERSION . '-' . getmypid();
$shop = $work . '/shop';
$pub = $shop . '/html';
$port = 17000 + (getmypid() % 900);
$base = "http://127.0.0.1:$port";
$vport = $port + 900;
$vbase = "http://127.0.0.1:$vport";
$secret = bin2hex(random_bytes(32));
$shopId = 'shp_test3001';

foreach (['/src/Eccube/Common', '/app/config/eccube', '/app/self-harden', '/app/cache/twig', '/vendor/acme/x', '/html/upload'] as $d) {
    @mkdir($shop . $d, 0777, true);
}
copy($receiver, $pub . '/self-harden.php');
file_put_contents($shop . '/src/Eccube/Application.php', "<?php\nnamespace Eccube;\nclass Application {}\n");
file_put_contents($shop . '/src/Eccube/Common/Constant.php', "<?php\nnamespace Eccube\\Common;\nclass Constant { const VERSION = '3.0.18'; }\n");
file_put_contents($shop . '/app/config/eccube/config.yml', "auth_magic: secretmagic\n");
file_put_contents($shop . '/app/config/eccube/database.yml', "password: dbsecret\n");
file_put_contents($shop . '/app/cache/twig/x.php', "<?php // cache\n");
file_put_contents($shop . '/app/self-harden/config.php', "<?php exit; ?>\n" . json_encode([
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

echo "3 系の地図\n";
$r = call('ping');
check('3 系: ping は地図 eccube3 を返す', !empty($r['json']['ok']) && $r['json']['result']['map'] === 'eccube3', $r['body']);
$r = call('inspect', ['sections' => ['app', 'paths']]);
check('3 系: 本体の一番上は html/ の上の階、公開の場所は html', !empty($r['json']['ok']) && realpath($r['json']['result']['paths']['root']) === realpath($shop)
    && $r['json']['result']['paths']['public'] === 'html', $r['body']);
check('3 系: 版を読める(3.0.18)', !empty($r['json']['ok']) && $r['json']['result']['app']['eccube_version'] === '3.0.18', $r['body']);
check('3 系: 鍵の置き場は公開の場所の外(app/self-harden)', is_dir($shop . '/app/self-harden/nonces') && !is_dir($pub . '/var'));

$r = call('read_file', ['path' => 'src/Eccube/Common/Constant.php']);
check('3 系: 公開の場所の外の本体のファイルを読める', !empty($r['json']['ok']) && strpos($r['json']['result']['content'], '3.0.18') !== false, $r['body']);
foreach (['app/config/eccube/config.yml', 'app/config/eccube/database.yml', 'html/self-harden.php', 'app/self-harden/config.php'] as $p) {
    $r = call('read_file', ['path' => $p]);
    check('3 系: 読ませない: ' . $p, err($r) === 'not_readable', $r['body']);
}
foreach (['../outside.txt', '/etc/passwd', '..'] as $p) {
    $r = call('read_file', ['path' => $p]);
    check('3 系: 本体の一番上より外は読めない: ' . $p, isset($r['json']['ok']) && $r['json']['ok'] === false, $r['body']);
}

$r = call('write_file', ['target' => 'root/.htaccess', 'content' => "# shisa test\nOptions -Indexes\n"]);
check('3 系: root/.htaccess は公開の場所(html/.htaccess)に書く', !empty($r['json']['ok']) && is_file($pub . '/.htaccess') && !is_file($shop . '/.htaccess'), $r['body']);
$r = call('write_file', ['target' => 'dir:html/.htaccess', 'content' => "Options -Indexes\n"]);
check('3 系: 公開の場所の .htaccess を dir: では書かせない', err($r) === 'bad_target', $r['body']);
$r = call('lab_arm');
check('3 系: 小部屋は公開の場所の中に作る', !empty($r['json']['ok']) && is_dir($pub . '/self-harden-lab') && $r['json']['result']['probe_path'] === '/self-harden-lab/probe.php', $r['body']);

$r = call('clear_cache', ['verify' => ['paths' => ['/']]]);
check('3 系: キャッシュは app/cache の下を消す', !empty($r['json']['ok']) && !is_dir($shop . '/app/cache/twig'), $r['body']);

$r = call('apply_official_release', ['ref' => '3.0.19', 'paths' => ['src/x.php'], 'expected_sha256' => ['src/x.php' => str_repeat('0', 64)]]);
check('3 系: リリースの配布物から当てる操作は断る(配布物が無い)', err($r) === 'no_release', $r['body']);
$r = call('restore_official', ['path' => 'html/index.php', 'ref' => '4.2.0']);
check('3 系: 4 系のタグからは戻さない', err($r) === 'bad_ref', $r['body']);
$r = call('restore_official', ['path' => 'html/index.php', 'ref' => '3.0.18', 'verify' => ['paths' => ['/']]]);
check('3 系: 書き換えられた html/index.php を公式のタグ 3.0.18 の中身に戻す', !empty($r['json']['ok']) && strpos((string) file_get_contents($pub . '/index.php'), 'tampered') === false
    && strpos((string) file_get_contents($pub . '/index.php'), 'autoload') !== false, $r['body']);

echo "\n$pass ok, $fail fail\n";
exit($fail === 0 ? 0 : 1);
