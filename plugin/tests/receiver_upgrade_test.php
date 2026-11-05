<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 店主が承認した版上げ(upgrade)の入口の確かめのテスト(tests/run.sh から docker の中で動かす)。お店は 4 系の置き方(4.2.0)。
// 印が無い・偽造・API の鍵で作った印・期限切れ・別のお店・今の版と違う・系列の違う版や古い版・使い回し・作業と違う印は、どれも始めずに断ること。
// 正しい印なら作業を始めるだけ(その呼び出しではお店に何も書かない)。データベースの入口(self-harden-upgrade.php)は、
// 窓口が置く 1 回きりの合図が無ければ何もしないこと。公式の配布物を取る段から先は通信が要るので、実際の版上げは手元のデモのお店で確かめる

$here = dirname(__DIR__);
$receiver = $here . '/SelfHarden/Resource/receiver/self-harden.php';
$runner = $here . '/SelfHarden/Resource/receiver/self-harden-upgrade.php';
$work = $here . '/.work/tu-' . PHP_MAJOR_VERSION . PHP_MINOR_VERSION . '-' . getmypid();
$shop = $work . '/shop';
$port = 19800 + (getmypid() % 150);
$base = "http://127.0.0.1:$port";
$secret = bin2hex(random_bytes(32));
$approveKey = bin2hex(random_bytes(32));
$shopId = 'shp_testupgrade1';

foreach (['/src/Eccube/Common', '/var/self-harden', '/app/Customize'] as $d) {
    @mkdir($shop . $d, 0777, true);
}
copy($receiver, $shop . '/self-harden.php');
copy($runner, $shop . '/self-harden-upgrade.php');
file_put_contents($shop . '/src/Eccube/Kernel.php', "<?php\nclass Kernel {}\n");
file_put_contents($shop . '/src/Eccube/Common/Constant.php', "<?php\nclass Constant { const VERSION = '4.2.0'; }\n");
file_put_contents($shop . '/var/self-harden/config.php', "<?php exit; ?>\n" . json_encode(['shop_id' => $shopId, 'secret' => $secret, 'self_base' => $base, 'api_base' => 'http://api.invalid']));
file_put_contents($shop . '/var/self-harden/approve-key.php', "<?php exit; ?>\n" . json_encode(['key' => $approveKey, 'created_at' => time()]));

$srv = proc_open(['php', '-S', "127.0.0.1:$port", '-t', $shop, __DIR__ . '/router.php'],
    [0 => ['pipe', 'r'], 1 => ['file', $work . '/server.log', 'a'], 2 => ['file', $work . '/server.log', 'a']], $pipes);
register_shutdown_function(function () use ($srv, $work) {
    proc_terminate($srv);
    exec('rm -rf ' . escapeshellarg($work));
});
for ($i = 0; $i < 50; $i++) {
    if (@file_get_contents($base . '/self-harden.php') !== false) {
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
function approval(array $over = [])
{
    global $approveKey, $shopId;
    $a = ['proposal_id' => 'prp_' . bin2hex(random_bytes(8)), 'from' => '4.2.0', 'to' => '4.2.3-p2', 'expires_at' => time() + 1800, 'shop_id' => $shopId];
    $key = isset($over['key']) ? $over['key'] : $approveKey;
    unset($over['key']);
    $a = array_merge($a, $over);
    $a['sig'] = hash_hmac('sha256', implode("\n", ['SH-UPGRADE1', $a['shop_id'], $a['proposal_id'], $a['from'], $a['to'], (string) $a['expires_at']]), $key);
    return $a;
}
function runner(array $body)
{
    global $base;
    $ch = curl_init($base . '/self-harden-upgrade.php');
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($body), CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20]);
    $out = (string) curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$code, json_decode($out, true)];
}
$jobs = function () use ($shop) {
    return count((array) glob($shop . '/var/self-harden/upgrade/prp_*'));
};

echo "版上げの承認(断ること)\n";
check('印が無ければ始めない', err(call('upgrade', [])) === 'not_approved' && $jobs() === 0);
$a = approval();
$a['sig'] = str_repeat('a', 64);
check('偽の印では始めない', err(call('upgrade', ['approval' => $a])) === 'not_approved' && $jobs() === 0);
check('API の鍵で作った印では始めない', err(call('upgrade', ['approval' => approval(['key' => $secret])])) === 'not_approved' && $jobs() === 0);
check('期限切れの印では始めない', err(call('upgrade', ['approval' => approval(['expires_at' => time() - 5])])) === 'approval_expired' && $jobs() === 0);
check('先すぎる期限の印では始めない', err(call('upgrade', ['approval' => approval(['expires_at' => time() + 7200])])) === 'approval_expired' && $jobs() === 0);
check('別のお店の印では始めない', err(call('upgrade', ['approval' => approval(['shop_id' => 'shp_other0000001'])])) === 'not_approved' && $jobs() === 0);
check('承認したときと今の版が違えば始めない', err(call('upgrade', ['approval' => approval(['from' => '4.2.1'])])) === 'conflict' && $jobs() === 0);
check('系列の違う版には上げない', err(call('upgrade', ['approval' => approval(['to' => '4.3.0'])])) === 'bad_ref' && $jobs() === 0);
check('同じか古い版には上げない', err(call('upgrade', ['approval' => approval(['to' => '4.2.0'])])) === 'bad_ref' && $jobs() === 0);
check('版の形が正しくなければ始めない', err(call('upgrade', ['approval' => approval(['to' => '../../4.2.3'])])) === 'not_approved' && $jobs() === 0);

echo "版上げの承認(始めること)\n";
$ok = approval();
$r = call('upgrade', ['approval' => $ok]);
$st = isset($r['json']['result']) ? $r['json']['result'] : [];
check('正しい印なら作業を始める(この呼び出しでは段を進めない)', !empty($r['json']['ok']) && ($st['status'] ?? '') === 'running' && ($st['step'] ?? '') === 'fetch', $r['body']);
check('始めただけでは、メンテナンスにもしない', !file_exists($shop . '/.maintenance'));
check('返事に印を含めない', strpos($r['body'], $ok['sig']) === false);
$bad = $ok;
$bad['expires_at'] = $ok['expires_at'] + 1;
$bad['sig'] = hash_hmac('sha256', implode("\n", ['SH-UPGRADE1', $bad['shop_id'], $bad['proposal_id'], $bad['from'], $bad['to'], (string) $bad['expires_at']]), $approveKey);
check('同じ作業に、別の印では進めない', err(call('upgrade', ['approval' => $bad])) === 'not_approved');
// 作業の記録を消しても、同じ印はもう使えない
exec('rm -rf ' . escapeshellarg($shop . '/var/self-harden/upgrade/' . $ok['proposal_id']));
check('同じ印は 1 回きり', err(call('upgrade', ['approval' => $ok])) === 'approval_used');

echo "データベースの入口(self-harden-upgrade.php)\n";
[$c] = runner([]);
check('合図が無ければ何もしない(404)', $c === 404);
$pid = 'prp_' . bin2hex(random_bytes(8));
$dir = $shop . '/var/self-harden/upgrade/' . $pid;
@mkdir($dir, 0700, true);
file_put_contents($dir . '/state.json', json_encode(['pid' => $pid, 'status' => 'running', 'step' => 'db']));
file_put_contents($dir . '/runner-token', str_repeat('b', 64));
[$c] = runner(['job' => $pid, 'token' => str_repeat('c', 64)]);
check('合図が違えば何もしない(404)', $c === 404);
check('違う合図を送られたら、合図は消える(当てずっぽうを続けられない)', !file_exists($dir . '/runner-token'));
file_put_contents($dir . '/runner-token', str_repeat('d', 64));
file_put_contents($dir . '/state.json', json_encode(['pid' => $pid, 'status' => 'running', 'step' => 'files']));
[$c] = runner(['job' => $pid, 'token' => str_repeat('d', 64)]);
check('データベースの段でなければ何もしない(404)', $c === 404);
file_put_contents($dir . '/runner-token', str_repeat('e', 64));
file_put_contents($dir . '/state.json', json_encode(['pid' => $pid, 'status' => 'running', 'step' => 'db']));
[$c, $j] = runner(['job' => $pid, 'token' => str_repeat('e', 64)]);
check('合図が合っても、上げ先の版が置き場に無ければ何も読み込まない', $c === 200 && isset($j['error']) && $j['error'] === 'no_stage');
[$c] = runner(['job' => '../../etc', 'token' => str_repeat('e', 64)]);
check('作業の名前の形が違えば何もしない(404)', $c === 404);

echo "\n$pass ok, $fail fail\n";
exit($fail === 0 ? 0 : 1);
