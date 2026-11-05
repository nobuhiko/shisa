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

foreach (['/src/Eccube/Common', '/var/self-harden', '/app/Customize', '/vendor/acme/pkg'] as $d) {
    @mkdir($shop . $d, 0777, true);
}
copy($receiver, $shop . '/self-harden.php');
copy($runner, $shop . '/self-harden-upgrade.php');
file_put_contents($shop . '/src/Eccube/Kernel.php', "<?php\nclass Kernel {}\n");
file_put_contents($shop . '/vendor/acme/pkg/A.php', "<?php // a\n");
// 指紋(API の upgradeplan.ts の fingerprint と同じ作り)。vendor/ の全部と、渡した本体のファイル
const FP_PATHS = ['src/Eccube/Kernel.php'];
// API 側のテスト(api/test/upgradeplan.test.ts)と同じ値になること(作りが食い違っていないかの確かめ)
const FP_EXPECTED = '55210693e24fb4ef3a96a6b396c11aea8cfb33417ffb49aa1fb810d322c375e2';
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
    $a = ['proposal_id' => 'prp_' . bin2hex(random_bytes(8)), 'from' => '4.2.0', 'to' => '4.2.3-p2', 'expires_at' => time() + 1800, 'shop_id' => $shopId,
        'fp' => FP_EXPECTED, 'keep' => ''];
    $key = isset($over['key']) ? $over['key'] : $approveKey;
    unset($over['key']);
    $a = array_merge($a, $over);
    $a['sig'] = upsig($a, $key);
    return $a;
}
function upsig(array $a, $key)
{
    return hash_hmac('sha256', implode("\n", ['SH-UPGRADE2', $a['shop_id'], $a['proposal_id'], $a['from'], $a['to'], (string) $a['expires_at'], $a['fp'], $a['keep']]), $key);
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
check('偽の印では始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => $a])) === 'not_approved' && $jobs() === 0);
check('API の鍵で作った印では始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['key' => $secret])])) === 'not_approved' && $jobs() === 0);
check('期限切れの印では始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['expires_at' => time() - 5])])) === 'approval_expired' && $jobs() === 0);
check('先すぎる期限の印では始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['expires_at' => time() + 7200])])) === 'approval_expired' && $jobs() === 0);
check('別のお店の印では始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['shop_id' => 'shp_other0000001'])])) === 'not_approved' && $jobs() === 0);
check('承認したときと今の版が違えば始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['from' => '4.2.1'])])) === 'conflict' && $jobs() === 0);
check('系列の違う版には上げない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['to' => '4.3.0'])])) === 'bad_ref' && $jobs() === 0);
check('同じか古い版には上げない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['to' => '4.2.0'])])) === 'bad_ref' && $jobs() === 0);
check('版の形が正しくなければ始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['to' => '../../4.2.3'])])) === 'not_approved' && $jobs() === 0);

echo "版上げの承認(始めること)\n";
$ok = approval();
$r = call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => $ok]);
$st = isset($r['json']['result']) ? $r['json']['result'] : [];
check('正しい印なら作業を始める(この呼び出しでは段を進めない)', !empty($r['json']['ok']) && ($st['status'] ?? '') === 'running' && ($st['step'] ?? '') === 'fetch', $r['body']);
check('始めただけでは、メンテナンスにもしない', !file_exists($shop . '/.maintenance'));
$jd = $shop . '/var/self-harden/upgrade/' . $ok['proposal_id'];
check('作業の置き場は外から開けない(.htaccess と空の index.html)', is_file($jd . '/.htaccess') && strpos(file_get_contents($jd . '/.htaccess'), 'Require all denied') !== false && is_file($jd . '/index.html'));
check('返事に印を含めない', strpos($r['body'], $ok['sig']) === false);
$bad = $ok;
$bad['expires_at'] = $ok['expires_at'] + 1;
$bad['sig'] = upsig($bad, $approveKey);
check('同じ作業に、別の印では進めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => $bad])) === 'not_approved');
// 作業の記録を消しても、同じ印はもう使えない
exec('rm -rf ' . escapeshellarg($shop . '/var/self-harden/upgrade/' . $ok['proposal_id']));
check('同じ印は 1 回きり', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => $ok])) === 'approval_used');

echo "調べたときからの変化(指紋)と、残す部品\n";
check('残す部品の形が正しくなければ始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['keep' => 'acme/pkg@latest'])])) === 'not_approved' && $jobs() === 0);
check('指紋の形が正しくなければ始めない', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['fp' => 'xyz'])])) === 'not_approved' && $jobs() === 0);
check('残す部品を付けた正しい印も受け付ける(印に入る)', !empty(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval(['keep' => 'acme/pkg@v1.2.4'])])['json']['ok']));
$pre = $jobs();
file_put_contents($shop . '/vendor/acme/pkg/A.php', "<?php // changed\n");
$st1 = approval();
$r = call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => $st1]);
check('部品のファイルが調べたときから変わっていれば、何も書かずに止める(stale)', err($r) === 'stale' && $jobs() === $pre && !file_exists($shop . '/.maintenance'), $r['body']);
check('止めた印は使い済みにしない(調べ直したあとの新しい提案で承認し直す)', !file_exists($shop . '/var/self-harden/approvals/' . $st1['sig']));
file_put_contents($shop . '/vendor/acme/pkg/A.php', "<?php // a\n");
file_put_contents($shop . '/src/Eccube/Kernel.php', "<?php\nclass Kernel { /* x */ }\n");
check('置き換える本体のファイルが変わっていても止める', err(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval()])) === 'stale');
file_put_contents($shop . '/src/Eccube/Kernel.php', "<?php\nclass Kernel {}\n");
check('API が指紋の場所を減らして送っても止める(場所の一覧も指紋に入る)', err(call('upgrade', ['fp_paths' => [], 'approval' => approval()])) === 'stale');
check('指紋の場所に .. があれば断る', err(call('upgrade', ['fp_paths' => ['../etc/passwd'], 'approval' => approval()])) === 'bad_args');
check('元に戻れば、指紋が合って始められる', !empty(call('upgrade', ['fp_paths' => FP_PATHS, 'approval' => approval()])['json']['ok']));

echo "途中で止まった版上げを、放っておかない(ping・inspect のたびに窓口が自分で着地させる)\n";
// テスト専用の目印: 「止まった」とみなすまでを 2 秒にする(本番は 10 分)。目印が無いお店では効かない
file_put_contents($shop . '/var/self-harden/.test-mode', json_encode(['stale_after' => 2]));
$mkjob = function ($st, array $files = []) use ($shop) {
    $pid = 'prp_' . bin2hex(random_bytes(8));
    $d = $shop . '/var/self-harden/upgrade/' . $pid;
    @mkdir($d, 0700, true);
    foreach ($files as $rel => $data) {
        @mkdir(dirname($d . '/' . $rel), 0700, true);
        file_put_contents($d . '/' . $rel, $data);
    }
    $st = array_merge(['pid' => $pid, 'sig' => str_repeat('0', 64), 'from' => '4.2.0', 'to' => '4.2.3-p2', 'fp' => FP_EXPECTED, 'fp_paths' => [], 'keep' => [],
        'i' => 0, 'log' => [], 'maintenance_before' => false, 'db' => null, 'error' => null, 'started_at' => time() - 100, 'updated_at' => time() - 100], $st);
    file_put_contents($d . '/state.json', json_encode($st));
    return $pid;
};
$state = function ($pid) use ($shop) {
    return json_decode((string) @file_get_contents($shop . '/var/self-harden/upgrade/' . $pid . '/state.json'), true);
};
// 1 回の ping で使う時間には上限がある(8 秒)ので、着地まで何回か呼ぶことがある(点検のたびに呼ばれる)
$land = function ($pid, $op = 'ping') use ($state) {
    // (PHP 7.4 の php -S は、入れ子の呼び出しにまれに 30 秒答えないことがある。そのあいだ別の呼び出しは作業の鍵が空くのを待たずに返るので、時間で待つ)
    $r = null;
    $t0 = time();
    do {
        $r = call($op, $op === 'inspect' ? ['sections' => ['php']] : []);
        if (!in_array($state($pid)['status'] ?? '', ['running', 'rolling_back'], true)) {
            break;
        }
        sleep(1);
    } while (time() - $t0 < 90);
    return $r;
};
$constant = $shop . '/src/Eccube/Common/Constant.php';
$orig = file_get_contents($constant);
// 1) ファイルを置き換えている途中で殺された(メンテナンス中、半分置き換え): 控えから戻してメンテナンスを外す
file_put_contents($constant, "<?php\nclass Constant { const VERSION = '4.2.3-p2'; }\n");
file_put_contents($shop . '/src/NewInRelease.php', "<?php // new\n");
file_put_contents($shop . '/.maintenance', '');
// 門(.htaccess の 503)も立っていた
$gateHt = "# >>> self-harden upgrade gate(テスト)\nRewriteRule ^ - [R=503,L]\n# <<< self-harden upgrade gate\n# shop\n";
file_put_contents($shop . '/.htaccess', $gateHt);
$p1 = $mkjob(['status' => 'running', 'step' => 'files'], ['files/src/Eccube/Common/Constant.php' => $orig, 'created.txt' => "src/NewInRelease.php\n"]);
$r = $land($p1);
$s1 = $state($p1);
check('ファイルの置き換え中に止まった作業は、次の ping で控えから戻る', ($s1['status'] ?? '') === 'rolled_back' && file_get_contents($constant) === $orig, json_encode($s1['log'] ?? null, JSON_UNESCAPED_UNICODE));
check('戻したら、版上げで増えたファイルも消える', !file_exists($shop . '/src/NewInRelease.php'));
check('戻したら、メンテナンスを外す', !file_exists($shop . '/.maintenance'));
check('戻したら、門(.htaccess の 503)も外す。お店のもとの設定は残る', file_get_contents($shop . '/.htaccess') === "# shop\n");
$jobs1 = $r['json']['result']['upgrade_jobs'] ?? [];
check('ping の返事に、作業の様子が出る(点検の報告に使う)', (bool) array_filter($jobs1, function ($j) use ($p1) { return $j['proposal_id'] === $p1 && $j['status'] === 'rolled_back'; }));
// 2) まだお店に書く前(配布物を広げる段)で止まった: 断って片付ける。メンテナンスにはしない
$p2 = $mkjob(['status' => 'running', 'step' => 'stage'], ['stage/x.php' => 'x']);
$land($p2, 'inspect');
$s2 = $state($p2);
check('書く前の段で止まった作業は、inspect で断って片付ける(メンテナンスにしない)', ($s2['status'] ?? '') === 'refused' && !is_dir($shop . '/var/self-harden/upgrade/' . $p2 . '/stage') && !file_exists($shop . '/.maintenance'));
// 3) 動きが新しい作業(誰かが進めている最中)には手を出さない
$p3 = $mkjob(['status' => 'running', 'step' => 'files', 'updated_at' => time() + 60]);
call('ping');
check('動いている最中の作業には手を出さない', ($state($p3)['status'] ?? '') === 'running');
@unlink($shop . '/var/self-harden/upgrade/' . $p3 . '/state.json');
// 4) 戻しの途中で止まっていた: 戻しを続ける
file_put_contents($constant, "<?php\nclass Constant { const VERSION = '4.2.3-p2'; }\n");
file_put_contents($shop . '/.maintenance', '');
$p4 = $mkjob(['status' => 'rolling_back', 'step' => 'rb_files'], ['files/src/Eccube/Common/Constant.php' => $orig]);
$land($p4);
check('戻しの途中で止まった作業は、戻しを続けて着地する', ($state($p4)['status'] ?? '') === 'rolled_back' && file_get_contents($constant) === $orig && !file_exists($shop . '/.maintenance'));
// 5) どうしても戻せない(戻したあとも版が合わない): メンテナンスのまま黙って止めず、店主への案内を出す
$p5 = $mkjob(['status' => 'running', 'step' => 'verify', 'from' => '4.1.9']);
$r = $land($p5);
$s5 = $state($p5);
$j5 = array_values(array_filter($r['json']['result']['upgrade_jobs'] ?? [], function ($j) use ($p5) { return $j['proposal_id'] === $p5; }));
check('自動で戻せないときは stuck にして、メンテナンスのまま止める', ($s5['status'] ?? '') === 'stuck' && file_exists($shop . '/.maintenance'));
check('stuck でも門は外す(店主が管理画面に入って戻すボタンを押せるように)', strpos((string) @file_get_contents($shop . '/.htaccess'), 'self-harden upgrade gate') === false);
check('stuck のときは、店主にわかる案内(メンテナンス中・戻すボタン・外し方)を出す', isset($j5[0]['owner_message']) && strpos($j5[0]['owner_message'], 'メンテナンス中') !== false
    && strpos($j5[0]['owner_message'], '止まった作業を戻す') !== false && strpos($j5[0]['owner_message'], 'メンテナンス管理') !== false && $j5[0]['maintenance'] === true);
@unlink($shop . '/.maintenance');
@unlink($shop . '/var/self-harden/upgrade/' . $p5 . '/state.json');
// 6) テスト用の目印が無いお店では、10 分たたないと手を出さない
@unlink($shop . '/var/self-harden/.test-mode');
$p6 = $mkjob(['status' => 'running', 'step' => 'files']);
call('ping');
check('目印が無ければ、止まったとみなすのは 10 分後(100 秒では手を出さない)', ($state($p6)['status'] ?? '') === 'running');
@unlink($shop . '/var/self-harden/upgrade/' . $p6 . '/state.json');
check('データベースの入口は、窓口の読む・隔離するの外(守る場所)', err(call('read_file', ['path' => 'self-harden-upgrade.php'])) === 'not_readable');

echo "版上げの門(.htaccess の 503)を放置しない\n";
// ここまでのテストで始めた作業(running のまま)を終わらせておく
foreach (glob($shop . '/var/self-harden/upgrade/prp_*/state.json') as $f) {
    $x = json_decode(file_get_contents($f), true);
    if (in_array($x['status'] ?? '', ['running', 'rolling_back'], true)) {
        $x['status'] = 'refused';
        file_put_contents($f, json_encode($x));
    }
}
file_put_contents($shop . '/.htaccess', $gateHt);
$pa = $mkjob(['status' => 'running', 'step' => 'files', 'updated_at' => time() + 60]);
call('ping');
check('動いている版上げがあるあいだは、門を外さない', strpos(file_get_contents($shop . '/.htaccess'), 'self-harden upgrade gate') !== false);
@unlink($shop . '/var/self-harden/upgrade/' . $pa . '/state.json');
file_put_contents($shop . '/.htaccess', $gateHt);
call('ping');
check('動いている版上げが無いのに門だけ残っていたら、次の ping で外す', file_get_contents($shop . '/.htaccess') === "# shop\n");
file_put_contents($shop . '/.htaccess', $gateHt);
@unlink($shop . '/var/self-harden/gate-check');
$ch = curl_init($base . '/self-harden.php?sh_gate=1');
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20]);
$page = (string) curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
check('門の画面は 503 で「メンテナンス中」を出す(認証は要らない)', $code === 503 && strpos($page, 'メンテナンス中') !== false);
check('門の画面を見た人がいたら、動いている版上げが無い門は外す(API が来なくても)', file_get_contents($shop . '/.htaccess') === "# shop\n");
$ch = curl_init($base . '/self-harden.php?sh_gate=1');
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_POSTFIELDS => 'a=1', CURLOPT_TIMEOUT => 20]);
curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
check('元の要求が POST(注文など)でも、門の画面は 503', $code === 503);
@unlink($shop . '/.htaccess');

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
check('違う合図では、本物の合図は消えない(当てずっぽうで版上げを止められない)', file_exists($dir . '/runner-token'));
file_put_contents($dir . '/runner-token', str_repeat('d', 64));
file_put_contents($dir . '/state.json', json_encode(['pid' => $pid, 'status' => 'running', 'step' => 'files']));
[$c] = runner(['job' => $pid, 'token' => str_repeat('d', 64)]);
check('データベースの段でなければ何もしない(404)', $c === 404);
file_put_contents($dir . '/runner-token', str_repeat('e', 64));
file_put_contents($dir . '/state.json', json_encode(['pid' => $pid, 'status' => 'running', 'step' => 'db']));
[$c, $j] = runner(['job' => $pid, 'token' => str_repeat('e', 64)]);
check('合図が合っても、上げ先の版が置き場に無ければ何も読み込まない', $c === 200 && isset($j['error']) && $j['error'] === 'no_stage');
file_put_contents($dir . '/runner-token', str_repeat('f', 64));
file_put_contents($dir . '/state.json', json_encode(['pid' => $pid, 'status' => 'running', 'step' => 'warmup']));
[$c, $j] = runner(['job' => $pid, 'token' => str_repeat('f', 64)]);
check('キャッシュの作り直しの段では、お店の EC-CUBE が無ければ何も読み込まない', $c === 200 && isset($j['error']) && $j['error'] === 'no_app');
file_put_contents($dir . '/runner-token', str_repeat('a', 64));
file_put_contents($dir . '/state.json', json_encode(['pid' => $pid, 'status' => 'rolling_back', 'step' => 'warmup']));
[$c] = runner(['job' => $pid, 'token' => str_repeat('a', 64)]);
check('戻しの途中で、作り直しの段(rb_warmup)でなければ何もしない(404)', $c === 404);
[$c] = runner(['job' => '../../etc', 'token' => str_repeat('e', 64)]);
check('作業の名前の形が違えば何もしない(404)', $c === 404);

echo "\n$pass ok, $fail fail\n";
exit($fail === 0 ? 0 : 1);
