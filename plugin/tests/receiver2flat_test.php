<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 受け口の置き方のテスト(tests/run.sh から docker の中で動かす)。
// 1. 2 系で data/ を公開の場所の中に置いた店(窓口のすぐ横に data/class/SC_Initial.php)。お店はサブディレクトリ(/shop/)の下
// 2. どの地図にも当てはまらない店: ping と inspect だけ答え、ほかは断る

$here = dirname(__DIR__);
$receiver = $here . '/SelfHarden/Resource/receiver/self-harden.php';
$work = $here . '/.work/tf-' . PHP_MAJOR_VERSION . PHP_MINOR_VERSION . '-' . getmypid();
$shop = $work . '/shop';
$odd = $work . '/odd';
$port = 17000 + (getmypid() % 900);
$base = "http://127.0.0.1:$port";
// 窓口が書いたあとに開いて確かめる先は、別の箱(同じ中身)。PHP 7.4 の php -S は自分自身を呼ぶと詰まる
$vport = $port + 900;
$vbase = "http://127.0.0.1:$vport";
$secret = bin2hex(random_bytes(32));
$shopId = 'shp_testflat01';

foreach (['/data/class', '/data/config', '/data/self-harden', '/manager', '/docker/prod', '/upload'] as $d) {
    @mkdir($shop . $d, 0777, true);
}
@mkdir($odd . '/var/self-harden', 0777, true);
copy($receiver, $shop . '/self-harden.php');
copy($receiver, $odd . '/self-harden.php');
file_put_contents($shop . '/data/class/SC_Initial.php', "<?php\nclass SC_Initial {\n    public function __construct()\n    {\n        define('ECCUBE_VERSION', '2.17.2');\n    }\n}\n");
file_put_contents($shop . '/data/config/config.php', "<?php define('DB_PASSWORD', 'dbsecret');\n");
file_put_contents($shop . '/docker/prod/local.env', "ECCUBE_AUTH_MAGIC=secret\n");
file_put_contents($shop . '/manager/index.php', "<?php // 管理画面の名前を変えた店\n");
file_put_contents($shop . '/index.php', "<?php echo 'tampered';\n");
file_put_contents($shop . '/composer.lock', json_encode(['packages' => []]));
$cfg = function ($self) use ($shopId, $secret) {
    return "<?php exit; ?>\n" . json_encode(['shop_id' => $shopId, 'secret' => $secret, 'self_base' => $self, 'api_base' => 'http://api.invalid']);
};
// お店の URL はサブディレクトリ(/shop)
file_put_contents($shop . '/data/self-harden/config.php', $cfg($vbase . '/shop'));
file_put_contents($odd . '/var/self-harden/config.php', $cfg($vbase . '/odd'));

$srv = proc_open(['php', '-S', "127.0.0.1:$port", '-t', $work, __DIR__ . '/router.php'],
    [0 => ['pipe', 'r'], 1 => ['file', $work . '/server.log', 'a'], 2 => ['file', $work . '/server.log', 'a']], $pipes);
$vsrv = proc_open(['php', '-S', "127.0.0.1:$vport", '-t', $work, __DIR__ . '/router.php'],
    [0 => ['pipe', 'r'], 1 => ['file', $work . '/server.log', 'a'], 2 => ['file', $work . '/server.log', 'a']], $vpipes);
register_shutdown_function(function () use ($srv, $vsrv, $work) {
    proc_terminate($srv);
    proc_terminate($vsrv);
    exec('rm -rf ' . escapeshellarg($work));
});
for ($i = 0; $i < 50; $i++) {
    if (@file_get_contents($base . '/shop/self-harden.php') !== false && @file_get_contents($vbase . '/shop/self-harden.php') !== false) {
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
function call($dir, $op, array $args = [])
{
    global $base, $secret, $shopId;
    $body = json_encode(['op' => $op, 'args' => (object) $args]);
    $ts = (string) time();
    $nonce = bin2hex(random_bytes(16));
    $path = '/' . $dir . '/self-harden.php';
    $s = implode("\n", ['SH1', 'POST', $path, $shopId, $ts, $nonce, hash('sha256', $body)]);
    $ch = curl_init($base . $path);
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

echo "2 系(data/ を公開の場所の中に置いた店、サブディレクトリ)\n";
$r = call('shop', 'ping');
check('ping は地図 eccube2・flat を返す', !empty($r['json']['ok']) && $r['json']['result']['map'] === 'eccube2' && $r['json']['result']['flat'] === true, $r['body']);
$r = call('shop', 'inspect', ['sections' => ['app', 'paths']]);
check('本体の一番上は窓口の場所、公開の場所も同じ', !empty($r['json']['ok']) && realpath($r['json']['result']['paths']['root']) === realpath($shop)
    && $r['json']['result']['paths']['public'] === '', $r['body']);
check('版を読める(2.17.2)', !empty($r['json']['ok']) && $r['json']['result']['app']['eccube_version'] === '2.17.2', $r['body']);
$r = call('shop', 'read_file', ['path' => 'data/class/SC_Initial.php']);
check('data/ の本体のファイルを読める', !empty($r['json']['ok']) && strpos($r['json']['result']['content'], '2.17.2') !== false, $r['body']);
$r = call('shop', 'read_file', ['path' => 'manager/index.php']);
check('名前を変えた管理画面など、一番上のフォルダのファイルも読める', !empty($r['json']['ok']) && !empty($r['json']['result']['exists']), $r['body']);
foreach (['data/config/config.php', 'data/self-harden/config.php', 'self-harden.php', 'docker/prod/local.env'] as $p) {
    $r = call('shop', 'read_file', ['path' => $p]);
    check('読ませない: ' . $p, err($r) === 'not_readable', $r['body']);
}
$r = call('shop', 'hash_tree', ['limit' => 5000]);
$names = !empty($r['json']['ok']) ? array_column($r['json']['result']['files'], 0) : [];
check('照らし合わせの一覧に、一番上と data/ の中のファイルが入る', in_array('index.php', $names, true) && in_array('data/class/SC_Initial.php', $names, true)
    && in_array('manager/index.php', $names, true), $r['body']);
check('照らし合わせの一覧に、秘密のファイルは入らない', !in_array('data/config/config.php', $names, true) && !in_array('docker/prod/local.env', $names, true)
    && !in_array('data/self-harden/config.php', $names, true), implode(',', $names));
$r = call('shop', 'write_file', ['target' => 'root/.htaccess', 'content' => "Options -Indexes\n", 'verify' => ['paths' => ['/']]]);
check('root/.htaccess は窓口の場所に書き、確かめはお店の URL(/shop/)の下を開く', !empty($r['json']['ok']) && is_file($shop . '/.htaccess')
    && $r['json']['result']['verify'][0]['status'] === 200, $r['body']);
// 公式の index.php は本体を読み込むので、テストの箱では開けない。確かめは窓口のページで
$r = call('shop', 'restore_official', ['path' => 'index.php', 'ref' => 'eccube-2.17.2', 'verify' => ['paths' => ['/self-harden.php']]]);
check('一番上の index.php を、公式の html/index.php の中身に戻す', !empty($r['json']['ok']) && strpos((string) file_get_contents($shop . '/index.php'), 'tampered') === false
    && strpos((string) $r['json']['result']['source'], '/html/index.php') !== false, $r['body']);
$r = call('shop', 'lab_arm');
check('小部屋は窓口の場所に作る', !empty($r['json']['ok']) && is_dir($shop . '/self-harden-lab'), $r['body']);
$tok = isset($r['json']['result']['token']) ? $r['json']['result']['token'] : '';
$pr = @file_get_contents($base . '/shop/self-harden-lab/probe.php?t=' . $tok);
check('小部屋の確認ページが、data/self-harden の合言葉で開く', is_string($pr) && strpos($pr, 'memory_limit') !== false, (string) $pr);

echo "見分けがつかない店\n";
$r = call('odd', 'ping');
check('ping は地図 unknown を返す', !empty($r['json']['ok']) && $r['json']['result']['map'] === 'unknown', $r['body']);
$r = call('odd', 'inspect', ['sections' => ['app', 'paths']]);
check('inspect は答える(版は不明)', !empty($r['json']['ok']) && $r['json']['result']['app']['eccube_version'] === null, $r['body']);
foreach ([['read_file', ['path' => 'self-harden.php']], ['list_dir', ['path' => '']], ['write_file', ['target' => 'root/.htaccess', 'content' => "x\n"]],
    ['hash_tree', []], ['lab_arm', []]] as $c) {
    $r = call('odd', $c[0], $c[1]);
    check('断る: ' . $c[0], err($r) === 'unknown_layout', $r['body']);
}
check('見分けがつかない店には何も書いていない', !is_file($odd . '/.htaccess') && !is_dir($odd . '/self-harden-lab'));

echo "\n$pass ok, $fail fail\n";
exit($fail === 0 ? 0 : 1);
