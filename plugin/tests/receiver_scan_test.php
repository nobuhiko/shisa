<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 改造の点検(scan_custom)と、行の範囲で読む read_file のテスト(tests/run.sh から docker の中で動かす)。
// 取りこぼしより、秘密を返さないこと・上限を守ることを優先して確かめる。お店は data/ を公開の場所の中に置いた 2 系

$here = dirname(__DIR__);
$receiver = $here . '/SelfHarden/Resource/receiver/self-harden.php';
$work = $here . '/.work/ts-' . PHP_MAJOR_VERSION . PHP_MINOR_VERSION . '-' . getmypid();
$shop = $work . '/shop';
$odd = $work . '/odd';
$port = 18000 + (getmypid() % 900);
$base = "http://127.0.0.1:$port";
// 窓口が書いたあとに開いて確かめる先は、別の箱(同じ中身)。PHP 7.4 の php -S は自分自身を呼ぶと詰まる
$vport = $port + 900;
$vbase = "http://127.0.0.1:$vport";
$secret = bin2hex(random_bytes(32));
$shopId = 'shp_testscan01';

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


// 改造したファイル(どれも動かさない。中身を文字として調べるだけ)
@mkdir($shop . '/custom', 0777, true);
@mkdir($shop . '/upload/save_image', 0777, true);
@mkdir($shop . '/many', 0777, true);
$long = str_repeat('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo', 10);
file_put_contents($shop . '/custom/sqli.php', "<?php\n\$id = \$_GET['id'];\n\$rows = \$objQuery->getAll(\"SELECT * FROM dtb_x WHERE id = \" . \$id);\n");
file_put_contents($shop . '/custom/xss.php', "<?php\necho \$_GET['name'];\necho htmlspecialchars(\$_GET['safe'], ENT_QUOTES);\n");
file_put_contents($shop . '/custom/dyn.php', "<?php\n// eval(\$_POST['x']) はコメントなので数えない\n\$f = 'x';\neval(base64_decode(\$_POST['x']));\n");
file_put_contents($shop . '/custom/obf.php', "<?php\n\$p = '" . $long . "';\n");
file_put_contents($shop . '/custom/secret.php', "<?php\n\$db->query(\"SELECT 1 WHERE a=\" . \$_GET['a'], ['password' => 'hunter2pass']);\n\$token = 'tok-abcdefghijklmnopqrstuvwxyz0123456789'; echo \$_GET['t'];\n");
file_put_contents($shop . '/custom/clean.php', "<?php\n\$x = (int) \$_GET['n'];\nreturn \$x + 1;\n");
file_put_contents($shop . '/custom/view.tpl', "<p>{\$smarty.get.q}</p>\n<p>{\$smarty.get.r|h}</p>\n");
file_put_contents($shop . '/custom/notes.txt', "echo \$_GET['x'];\n");
file_put_contents($shop . '/upload/save_image/a.php', "<?php // 画像の置き場の PHP\n");
file_put_contents($shop . '/data/config/config.php', "<?php define('DB_PASSWORD', 'dbsecret'); echo \$_GET['leak'];\n");
file_put_contents($shop . '/many/lines.php', "<?php\n" . str_repeat("echo \$_GET['a'];\n", 30));
for ($i = 0; $i < 20; $i++) {
    file_put_contents($shop . "/many/f$i.php", "<?php\n" . str_repeat("echo \$_POST['b'];\n", 25));
}
@mkdir($shop . '/.git', 0777, true);
file_put_contents($shop . '/.git/hook.php', "<?php eval(\$_GET['x']);\n");

echo "改造の点検(渡したファイル)\n";
$paths = ['custom/sqli.php', 'custom/xss.php', 'custom/dyn.php', 'custom/obf.php', 'custom/secret.php', 'custom/clean.php', 'custom/view.tpl',
    'custom/notes.txt', 'upload/save_image/a.php', 'data/config/config.php', 'data/self-harden/config.php', 'self-harden.php', 'docker/prod/local.env',
    '../outside.php', '/etc/passwd', '.git/hook.php', 'custom/nothing.php'];
$r = call('shop', 'scan_custom', ['paths' => $paths]);
check('答える', !empty($r['json']['ok']), $r['body']);
$res = !empty($r['json']['ok']) ? $r['json']['result'] : ['hits' => [], 'files' => [], 'skipped' => ['not_code' => 0, 'not_allowed' => 0, 'missing' => 0]];
$kinds = [];
foreach ($res['hits'] as $h) {
    $kinds[$h[0]][] = $h[2];
}
$has = function ($f, $k) use ($kinds) { return isset($kinds[$f]) && in_array($k, $kinds[$f], true); };
check('SQL の文字列に外の値をつないでいる', $has('custom/sqli.php', 'sql_with_input'), json_encode($kinds));
check('外の値をそのまま画面に出している', $has('custom/xss.php', 'output_with_input'));
check('escape した出力は数えない', count(isset($kinds['custom/xss.php']) ? $kinds['custom/xss.php'] : []) === 1, json_encode($kinds));
check('動的なコードの実行', $has('custom/dyn.php', 'dynamic_code'));
check('コメントの行は数えない', count(array_filter($res['hits'], function ($h) { return $h[0] === 'custom/dyn.php' && $h[1] === 2; })) === 0);
check('難読化した長い文字列', $has('custom/obf.php', 'obfuscated'));
check('テンプレートで外の値を escape せずに出す', $has('custom/view.tpl', 'output_with_input') && count($kinds['custom/view.tpl']) === 1, json_encode($kinds));
check('画像の置き場の PHP', $has('upload/save_image/a.php', 'php_in_data_dir'));
check('外の値を数字にしてから使うファイルは出ない', !isset($kinds['custom/clean.php']));
check('PHP・テンプレートでないファイルは調べない', !isset($kinds['custom/notes.txt']) && $res['skipped']['not_code'] >= 1);
$all = json_encode($res, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
foreach (['data/config/config.php', 'data/self-harden/config.php', 'self-harden.php', 'docker/prod/local.env', '.git/hook.php', '../outside.php', '/etc/passwd'] as $p) {
    check('調べない: ' . $p, !isset($kinds[$p]) && !in_array($p, array_column($res['files'], 0), true));
}
check('秘密のファイルの中身を返さない', strpos($all, 'dbsecret') === false && strpos($all, 'leak') === false && strpos($all, $secret) === false);
check('長い文字列は返さない', strpos($all, substr($long, 0, 60)) === false);
check('秘密らしい名前のそばの文字列は伏せる', strpos($all, 'hunter2pass') === false && strpos($all, 'tok-abcdefghijklmnopqrstuvwxyz') === false, $all);
check('ファイルの中身を丸ごとは返さない(1 行だけ・短い)', max(array_map(function ($h) { return strlen($h[3]); }, $res['hits'] ?: [[0, 0, 0, '']])) <= 170);
check('無い・外のファイルは数えて飛ばす', $res['skipped']['not_allowed'] >= 5 && $res['skipped']['missing'] >= 1, json_encode($res['skipped']));

echo "改造の点検(上限)\n";
$r = call('shop', 'scan_custom', ['paths' => ['many/lines.php']]);
$n = !empty($r['json']['ok']) ? count($r['json']['result']['hits']) : -1;
check('1 ファイルから返すのは 20 件まで', $n === 20, (string) $n);
$many = [];
for ($i = 0; $i < 20; $i++) {
    $many[] = "many/f$i.php";
}
$r = call('shop', 'scan_custom', ['paths' => $many]);
$n = !empty($r['json']['ok']) ? count($r['json']['result']['hits']) : -1;
check('1 回に返すのは 300 件まで、打ち切ったことを知らせる', $n === 300 && $r['json']['result']['truncated'] === true, (string) $n);
$r = call('shop', 'scan_custom', ['paths' => $many, 'max_files' => 2]);
check('調べるファイルの数の上限', !empty($r['json']['ok']) && $r['json']['result']['scanned'] === 2, $r['body']);

echo "改造の点検(渡さないときは本体の場所を歩く)\n";
$r = call('shop', 'scan_custom', []);
$names = !empty($r['json']['ok']) ? array_values(array_unique(array_column($r['json']['result']['hits'], 0))) : [];
check('歩いて見つける', in_array('custom/sqli.php', $names, true), json_encode($names));
check('件数で打ち切っても、置き場所のおかしな PHP は拾う', !empty($r['json']['ok']) && in_array('upload/save_image/a.php', $r['json']['result']['misplaced'], true), $r['body']);
check('歩いても秘密のファイル・窓口・.git は調べない', !in_array('data/config/config.php', $names, true) && !in_array('self-harden.php', $names, true)
    && !in_array('.git/hook.php', $names, true), json_encode($names));

echo "行の範囲で読む\n";
$r = call('shop', 'read_file', ['path' => 'many/lines.php', 'from' => 3, 'to' => 4]);
check('渡した行だけ返す', !empty($r['json']['ok']) && $r['json']['result']['from'] === 3 && $r['json']['result']['to'] === 4
    && substr_count($r['json']['result']['lines'], "\n") === 1 && !isset($r['json']['result']['content']), $r['body']);
$r = call('shop', 'read_file', ['path' => 'many/lines.php', 'from' => 1, 'to' => 500]);
check('1 回に 80 行まで(ファイルの終わりで止まる)', !empty($r['json']['ok']) && $r['json']['result']['to'] - $r['json']['result']['from'] + 1 <= 80, $r['body']);
$r = call('shop', 'read_file', ['path' => 'data/config/config.php', 'from' => 1, 'to' => 2]);
check('行の範囲でも、秘密のファイルは読めない', err($r) === 'not_readable', $r['body']);

echo "\n$pass ok, $fail fail\n";
exit($fail === 0 ? 0 : 1);
