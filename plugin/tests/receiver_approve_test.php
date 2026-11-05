<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 店主が承認した直し(apply_approved_fix)のテスト(tests/run.sh から docker の中で動かす)。お店は 4 系の置き方。
// 承認の鍵はお店の中だけにある。印が無い・偽造・期限切れ・使い回し・中身のすり替え・前のファイルが変わった・範囲の外・新しいファイルは、
// どれも書かずに断ること。正しい印なら控えを取って書き、書いたあと確かめて、だめなら戻すこと

$here = dirname(__DIR__);
$receiver = $here . '/SelfHarden/Resource/receiver/self-harden.php';
$work = $here . '/.work/ta-' . PHP_MAJOR_VERSION . PHP_MINOR_VERSION . '-' . getmypid();
$shop = $work . '/shop';
$port = 19000 + (getmypid() % 400);
$base = "http://127.0.0.1:$port";
// 書いたあとに開いて確かめる先は別の箱(同じ中身)。PHP 7.4 の php -S は自分自身を呼ぶと詰まる
$vport = $port + 400;
$vbase = "http://127.0.0.1:$vport";
$secret = bin2hex(random_bytes(32));
$approveKey = bin2hex(random_bytes(32));
$shopId = 'shp_testapprove1';

foreach (['/src/Eccube', '/var/self-harden', '/var/cache/prod/twig/ab', '/app/Customize/Controller', '/app/template/default/Note', '/app/config/eccube', '/vendor/acme/lib'] as $d) {
    @mkdir($shop . $d, 0777, true);
}
copy($receiver, $shop . '/self-harden.php');
file_put_contents($shop . '/src/Eccube/Kernel.php', "<?php\nclass Kernel {}\n");
file_put_contents($shop . '/src/Eccube/Other.php', "<?php\n// 公式の本体\n");
file_put_contents($shop . '/vendor/acme/lib/A.php', "<?php\n// 部品\n");
file_put_contents($shop . '/app/config/eccube/services.yaml', "# 設定\n");
file_put_contents($shop . '/var/cache/prod/twig/ab/compiled.php', "<?php // 組み立て済み\n");
file_put_contents($shop . '/var/self-harden/config.php', "<?php exit; ?>\n" . json_encode(['shop_id' => $shopId, 'secret' => $secret, 'self_base' => $vbase, 'api_base' => 'http://api.invalid']));
file_put_contents($shop . '/var/self-harden/approve-key.php', "<?php exit; ?>\n" . json_encode(['key' => $approveKey, 'created_at' => time()]));
$weak = "<?php\n// カスタマイズ: お問い合わせ番号の確認\necho 'no: ' . (isset(\$_GET['no']) ? \$_GET['no'] : '');\n";
$fixed = "<?php\n// カスタマイズ: お問い合わせ番号の確認\necho 'no: ' . htmlspecialchars(isset(\$_GET['no']) ? (string) \$_GET['no'] : '', ENT_QUOTES, 'UTF-8');\n";
file_put_contents($shop . '/app/Customize/Controller/Page.php', $weak);
file_put_contents($shop . '/app/template/default/Note/index.twig', "<p>{{ q|raw }}</p>\n");

$srv = proc_open(['php', '-S', "127.0.0.1:$port", '-t', $shop, __DIR__ . '/router.php'],
    [0 => ['pipe', 'r'], 1 => ['file', $work . '/server.log', 'a'], 2 => ['file', $work . '/server.log', 'a']], $pipes);
$vsrv = proc_open(['php', '-S', "127.0.0.1:$vport", '-t', $shop, __DIR__ . '/router.php'],
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
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => ["X-SH-Shop: $shopId", "X-SH-Timestamp: $ts", "X-SH-Nonce: $nonce", 'X-SH-Signature: ' . hash_hmac('sha256', $s, $secret)]]);
    $out = (string) curl_exec($ch);
    curl_close($ch);
    return ['body' => $out, 'json' => json_decode($out, true)];
}
function err($r)
{
    return isset($r['json']['error']) ? $r['json']['error'] : null;
}
// プラグイン(お店の中)が作るのと同じ印
function approval($path, $content, $before, array $over = [])
{
    global $approveKey, $shopId;
    $a = ['proposal_id' => 'prp_' . bin2hex(random_bytes(8)), 'path' => $path, 'sha256_new' => hash('sha256', $content),
        'sha256_before' => $before, 'expires_at' => time() + 1800, 'shop_id' => $shopId];
    $a = array_merge($a, $over);
    $key = isset($over['key']) ? $over['key'] : $approveKey;
    unset($a['key']);
    $a['sig'] = hash_hmac('sha256', implode("\n", ['SH-APPROVE1', $a['shop_id'], $a['proposal_id'], $a['path'], $a['sha256_new'], $a['sha256_before'], (string) $a['expires_at']]), $key);
    return $a;
}

$page = 'app/Customize/Controller/Page.php';
$pageAbs = $shop . '/' . $page;
$verify = ['paths' => ['/', '/app/Customize/Controller/Page.php'], 'timeout_sec' => 5];

echo "承認の用意\n";
$r = call('inspect', ['sections' => ['paths']]);
check('inspect は承認の用意があることだけ言う', !empty($r['json']['result']['paths']['approve_ready']) && strpos($r['body'], $approveKey) === false, $r['body']);
check('承認の鍵は read_file で読めない', err(call('read_file', ['path' => 'var/self-harden/approve-key.php'])) === 'not_readable');
$r = call('hash_tree', []);
check('承認の鍵は hash_tree にも出ない', strpos($r['body'], 'approve-key') === false);

echo "断る\n";
$before = hash('sha256', $weak);
check('印が無ければ断る', err(call('apply_approved_fix', ['content' => $fixed])) === 'not_approved' && file_get_contents($pageAbs) === $weak);
$a = approval($page, $fixed, $before);
$a['sig'] = str_repeat('0', 64);
check('偽造した印は断る', err(call('apply_approved_fix', ['approval' => $a, 'content' => $fixed])) === 'not_approved' && file_get_contents($pageAbs) === $weak);
check('API の鍵で作った印は断る', err(call('apply_approved_fix', ['approval' => approval($page, $fixed, $before, ['key' => $secret]), 'content' => $fixed])) === 'not_approved');
check('期限切れは断る', err(call('apply_approved_fix', ['approval' => approval($page, $fixed, $before, ['expires_at' => time() - 10]), 'content' => $fixed])) === 'approval_expired');
check('期限が先すぎる印は断る', err(call('apply_approved_fix', ['approval' => approval($page, $fixed, $before, ['expires_at' => time() + 86400]), 'content' => $fixed])) === 'approval_expired');
check('別のお店の印は断る', err(call('apply_approved_fix', ['approval' => approval($page, $fixed, $before, ['shop_id' => 'shp_otherotherxx']), 'content' => $fixed])) === 'not_approved');
$evil = "<?php system(\$_GET['c']);\n";
check('承認と違う中身(すり替え)は断る', err(call('apply_approved_fix', ['approval' => approval($page, $fixed, $before), 'content' => $evil])) === 'not_approved' && file_get_contents($pageAbs) === $weak);
check('前のファイルが変わっていたら断る', err(call('apply_approved_fix', ['approval' => approval($page, $fixed, hash('sha256', 'old')), 'content' => $fixed])) === 'conflict' && file_get_contents($pageAbs) === $weak);
foreach (['src/Eccube/Other.php' => '公式の本体', 'vendor/acme/lib/A.php' => '部品', 'app/config/eccube/services.yaml' => '設定', 'self-harden.php' => '窓口自身', 'var/self-harden/config.php' => '窓口の鍵'] as $p => $label) {
    $cur = hash('sha256', (string) file_get_contents($shop . '/' . $p));
    $e = err(call('apply_approved_fix', ['approval' => approval($p, "<?php\n", $cur), 'content' => "<?php\n"]));
    check("範囲の外は断る($label)", in_array($e, ['bad_target', 'not_readable'], true) && hash('sha256', (string) file_get_contents($shop . '/' . $p)) === $cur, (string) $e);
}
check('新しいファイルは作らない', err(call('apply_approved_fix', ['approval' => approval('app/Customize/Controller/New.php', "<?php\n", hash('sha256', '')), 'content' => "<?php\n"])) === 'not_found' && !file_exists($shop . '/app/Customize/Controller/New.php'));
check('.. で外へは出られない', in_array(err(call('apply_approved_fix', ['approval' => approval('app/Customize/../../src/Eccube/Other.php', "<?php\n", hash('sha256', '')), 'content' => "<?php\n"])), ['path_outside', 'bad_path'], true));
check('PHP の書き方の誤りは書かない', err(call('apply_approved_fix', ['approval' => approval($page, "<?php echo 'x'\nfunction (\n", $before), 'content' => "<?php echo 'x'\nfunction (\n"])) === 'php_syntax' && file_get_contents($pageAbs) === $weak);

echo "書く\n";
$a = approval($page, $fixed, $before);
$r = call('apply_approved_fix', ['approval' => $a, 'content' => $fixed, 'verify' => $verify]);
check('正しい印なら書く', !empty($r['json']['ok']) && file_get_contents($pageAbs) === $fixed && $r['json']['result']['rolled_back'] === false, $r['body']);
$bid = isset($r['json']['result']['backup_id']) ? $r['json']['result']['backup_id'] : '';
check('控えを取っている', $bid !== '' && file_get_contents($shop . '/var/self-harden/backups/' . $bid . '.bak') === $weak);
check('書いたあとページが開く', isset($r['json']['result']['verify'][1]['status']) && $r['json']['result']['verify'][1]['status'] === 200, $r['body']);
check('同じ印の使い回しは断る', err(call('apply_approved_fix', ['approval' => $a, 'content' => $fixed])) === 'approval_used');
$r = call('restore', ['backup_id' => $bid]);
check('控えから戻せる', !empty($r['json']['ok']) && file_get_contents($pageAbs) === $weak, $r['body']);

echo "確かめで落ちたら戻す\n";
$broken = "<?php\nhttp_response_code(500);\necho 'broken';\n";
$r = call('apply_approved_fix', ['approval' => approval($page, $broken, hash('sha256', $weak)), 'content' => $broken, 'verify' => $verify]);
check('開けなくなったら、その場で戻す', !empty($r['json']['ok']) && $r['json']['result']['rolled_back'] === true && file_get_contents($pageAbs) === $weak, $r['body']);

echo "テンプレート\n";
$tpl = 'app/template/default/Note/index.twig';
$tnew = "<p>{{ q }}</p>\n";
$r = call('apply_approved_fix', ['approval' => approval($tpl, $tnew, hash('sha256', "<p>{{ q|raw }}</p>\n")), 'content' => $tnew, 'verify' => ['paths' => ['/']]]);
check('テンプレートも直せる', !empty($r['json']['ok']) && file_get_contents($shop . '/' . $tpl) === $tnew, $r['body']);
check('Twig の組み立て済みを捨てる(本番は読み直さないため)', !file_exists($shop . '/var/cache/prod/twig/ab/compiled.php'));
$r = call('audit_tail', []);
check('記録に中身も印も残さない', strpos($r['body'], 'htmlspecialchars') === false && strpos($r['body'], $a['sig']) === false);

echo "\n$pass ok, $fail fail\n";
exit($fail ? 1 : 0);
