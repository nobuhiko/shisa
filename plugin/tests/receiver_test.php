<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 受け口(self-harden.php)の単体テスト。tests/run.sh から docker の中で動かす。
// 受け口だけを置いた空の root に php -S を立て、署名したリクエストを送って結果を確かめる。

$here = dirname(__DIR__);
$receiver = $here . '/SelfHarden/Resource/receiver/self-harden.php';
$work = $here . '/.work/t-' . PHP_MAJOR_VERSION . PHP_MINOR_VERSION . '-' . getmypid();
$root = $work . '/root';
$outside = $work . '/outside';
$port = 18000 + (getmypid() % 1000);
$base = "http://127.0.0.1:$port";
$secret = bin2hex(random_bytes(32));
$shop = 'shp_test0001';

@mkdir($root . '/var/self-harden', 0777, true);
@mkdir($outside, 0777, true);
@mkdir($root . '/html/sub', 0777, true);
copy($receiver, $root . '/self-harden.php');
file_put_contents($root . '/var/self-harden/config.php', "<?php exit; ?>\n" . json_encode([
    'shop_id' => $shop, 'secret' => $secret, 'self_base' => $base, 'api_base' => 'http://api.invalid',
]));
file_put_contents($root . '/.env', "APP_ENV=prod\nDATABASE_URL=sqlite:///secret/path.db\nECCUBE_AUTH_MAGIC=abcdefghijk\n");
file_put_contents($root . '/index.php', "<?php echo 'shop';");
@mkdir($root . '/src/Eccube/Common', 0777, true);
file_put_contents($root . '/src/Eccube/Common/Constant.php', "<?php\nnamespace Eccube\\Common;\nclass Constant { const VERSION = '4.2.0'; }\n");
@mkdir($root . '/vendor/twig/twig/src', 0777, true);
file_put_contents($root . '/vendor/twig/twig/src/Environment.php', "<?php // tampered\n");
file_put_contents($root . '/composer.lock', json_encode(['packages' => [
    ['name' => 'twig/twig', 'version' => 'v2.15.2', 'source' => ['type' => 'git', 'url' => 'https://github.com/twigphp/Twig.git', 'reference' => str_repeat('a', 40)]],
    ['name' => 'local/nogithub', 'version' => '1.0.0', 'source' => ['type' => 'git', 'url' => 'https://evil.example/x.git', 'reference' => str_repeat('b', 40)]],
]]));
@mkdir($root . '/bin', 0777, true);
file_put_contents($root . '/bin/console', "#!/usr/bin/env php\n");
file_put_contents($outside . '/target.txt', 'outside');
symlink($outside, $root . '/linkdir');

$srv = proc_open(['php', '-S', "127.0.0.1:$port", '-t', $root, __DIR__ . '/router.php'],
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

// ---- 道具 ----

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

function sign_headers($secret, $shop, $body, $ts = null, $nonce = null, $path = '/self-harden.php')
{
    $ts = $ts === null ? (string) time() : (string) $ts;
    $nonce = $nonce === null ? bin2hex(random_bytes(16)) : $nonce;
    $s = implode("\n", ['SH1', 'POST', $path, $shop, $ts, $nonce, hash('sha256', $body)]);
    return ['X-SH-Shop' => $shop, 'X-SH-Timestamp' => $ts, 'X-SH-Nonce' => $nonce,
        'X-SH-Signature' => hash_hmac('sha256', $s, $secret)];
}

function http($method, $url, $body = '', array $headers = [])
{
    $ch = curl_init($url);
    $h = [];
    foreach ($headers as $k => $v) {
        $h[] = "$k: $v";
    }
    $resp_headers = [];
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => $h, CURLOPT_POSTFIELDS => $method === 'POST' ? $body : null,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$resp_headers) {
            if (strpos($line, ':') !== false) {
                list($k, $v) = explode(':', $line, 2);
                $resp_headers[strtolower(trim($k))] = trim($v);
            }
            return strlen($line);
        }]);
    $out = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['status' => $code, 'body' => (string) $out, 'json' => json_decode((string) $out, true), 'headers' => $resp_headers];
}

// 正しく署名して操作を呼ぶ
function call($op, array $args = [])
{
    global $base, $secret, $shop;
    $body = json_encode(['op' => $op, 'args' => (object) $args]);
    $h = sign_headers($secret, $shop, $body);
    $r = http('POST', $base . '/self-harden.php', $body, $h);
    $r['nonce'] = $h['X-SH-Nonce'];
    return $r;
}

function err($r)
{
    return isset($r['json']['error']) ? $r['json']['error'] : null;
}

function denied($r)
{
    return $r['status'] === 401 && $r['json'] === ['ok' => false, 'error' => 'unauthorized'];
}

// ---- 署名の見本 ----
echo "署名の見本\n";
$v = json_decode(file_get_contents(dirname(__DIR__, 2) . '/docs/signature-test-vector.json'), true);
$q = $v['request'];
$s = implode("\n", ['SH1', $q['method'], $q['path'], $q['shop'], $q['timestamp'], $q['nonce'], hash('sha256', $q['body'])]);
check('リクエストの署名が見本と一致', hash_hmac('sha256', $s, $v['secret']) === $q['signature']);
$rs = "SH1-RES\n" . $q['nonce'] . "\n" . hash('sha256', $v['response']['body']);
check('返事の署名が見本と一致', hash_hmac('sha256', $rs, $v['secret']) === $v['response']['signature']);

// ---- 生きているかの確認 ----
echo "GET\n";
$r = http('GET', $base . '/self-harden.php');
check('GET は最小の JSON だけ返す', $r['status'] === 200 && $r['json'] === ['ok' => true, 'service' => 'self-harden-receiver'], $r['body']);

// ---- 署名・時刻・使い回し ----
echo "署名がない・古い・使い回し\n";
$body = json_encode(['op' => 'ping', 'args' => (object) []]);
check('署名なしは 401', denied(http('POST', $base . '/self-harden.php', $body)));
$h = sign_headers($secret, $shop, $body);
unset($h['X-SH-Signature']);
check('署名の見出しだけ欠けても 401', denied(http('POST', $base . '/self-harden.php', $body, $h)));
$h = sign_headers($secret, $shop, $body);
check('本文を書き換えたら 401', denied(http('POST', $base . '/self-harden.php', json_encode(['op' => 'inspect']), $h)));
check('違う鍵で署名したら 401', denied(http('POST', $base . '/self-harden.php', $body, sign_headers(bin2hex(random_bytes(32)), $shop, $body))));
check('違う店の ID なら 401', denied(http('POST', $base . '/self-harden.php', $body, sign_headers($secret, 'shp_other', $body))));
check('301 秒前の時刻は 401', denied(http('POST', $base . '/self-harden.php', $body, sign_headers($secret, $shop, $body, time() - 301))));
check('301 秒先の時刻は 401', denied(http('POST', $base . '/self-harden.php', $body, sign_headers($secret, $shop, $body, time() + 301))));
check('違うパスで署名したら 401', denied(http('POST', $base . '/self-harden.php', $body, sign_headers($secret, $shop, $body, null, null, '/other.php'))));
$h = sign_headers($secret, $shop, $body);
$first = http('POST', $base . '/self-harden.php', $body, $h);
check('1 回目は通る', $first['status'] === 200 && !empty($first['json']['ok']), $first['body']);
check('同じリクエストの使い回しは 401', denied(http('POST', $base . '/self-harden.php', $body, $h)));
$bad = sign_headers($secret, $shop, $body);
$bad['X-SH-Nonce'] = '../../etc/passwd0000000000000000';
check('nonce の形がおかしければ 401', denied(http('POST', $base . '/self-harden.php', $body, $bad)));
check('GET 以外の変な method は 401', denied(http('PUT', $base . '/self-harden.php', $body, sign_headers($secret, $shop, $body))));

// ---- 正しい呼び出しと返事の署名 ----
echo "正しい呼び出し\n";
$r = call('ping');
$expect = hash_hmac('sha256', "SH1-RES\n" . $r['nonce'] . "\n" . hash('sha256', $r['body']), $secret);
check('ping が通る', !empty($r['json']['ok']) && isset($r['json']['result']['php_version']));
check('返事に正しい署名が付く', isset($r['headers']['x-sh-signature']) && hash_equals($expect, $r['headers']['x-sh-signature']));
check('知らない操作は unknown_op', err(call('eval', ['code' => 'phpinfo();'])) === 'unknown_op');
$r = call('inspect', ['sections' => ['app', 'php']]);
check('inspect が EC-CUBE の版を include せずに読む', !empty($r['json']['ok']) && $r['json']['result']['app']['eccube_version'] === '4.2.0');
$env = $r['json']['result']['app']['env'];
check('.env の秘密は伏せる', $env['APP_ENV'] === 'prod' && strpos($env['DATABASE_URL'], '<redacted') === 0 && strpos($env['ECCUBE_AUTH_MAGIC'], '<redacted') === 0);
check('返事に .env の秘密が入らない', strpos($r['body'], 'abcdefghijk') === false && strpos($r['body'], 'secret/path') === false);

// ---- 決まった場所の外 ----
echo "決まった場所の外への書き込み・読み出し\n";
$outside_targets = ['root/index.php', 'index.php', '../.htaccess', '/etc/passwd', 'root/../../x', 'lab/../index.php',
    'dir:../.htaccess', 'dir:/etc/.htaccess', 'dir:var/self-harden/.htaccess', 'dir:self-harden-lab/.htaccess',
    'dir:html/sub/index.php', 'dir:html/missing/.htaccess', 'dir:linkdir/.htaccess', "root/.htaccess\0x", 'dir:html/sub/../../../.htaccess'];
foreach ($outside_targets as $t) {
    $r = call('write_file', ['target' => $t, 'content' => "# x\n", 'expected_sha256' => null]);
    check('書けない: ' . str_replace("\0", '\\0', $t), isset($r['json']['ok']) && $r['json']['ok'] === false, $r['body']);
}
check('root の外のファイルは変わっていない', file_get_contents($outside . '/target.txt') === 'outside' && !file_exists($outside . '/.htaccess'));
check('index.php は変わっていない', file_get_contents($root . '/index.php') === "<?php echo 'shop';");

// 書き先そのものがシンボリックリンク
symlink($outside . '/target.txt', $root . '/.user.ini');
$r = call('write_file', ['target' => 'root/.user.ini', 'content' => "memory_limit = 64M\n", 'expected_sha256' => hash('sha256', 'outside')]);
check('書き先がシンボリックリンクなら書けない', err($r) === 'symlink', $r['body']);
check('リンクの先は変わっていない', file_get_contents($outside . '/target.txt') === 'outside');
unlink($root . '/.user.ini');

foreach (['../', '/etc', 'html/../../', 'linkdir', 'linkdir/', "html\0"] as $p) {
    $r = call('list_dir', ['path' => $p]);
    check('一覧できない: ' . str_replace("\0", '\\0', $p), isset($r['json']['ok']) && $r['json']['ok'] === false, $r['body']);
}
$r = call('list_dir', ['path' => '', 'depth' => 1]);
$names = array_column($r['json']['result']['entries'], 'type', 'name');
check('一覧ではリンクを辿らない', isset($names['linkdir']) && $names['linkdir'] === 'link' && !isset($names['linkdir/target.txt']));
foreach (['.env', 'self-harden.php', 'var/self-harden/config.php', 'var/self-harden/nonces', 'linkdir/target.txt', '../outside/target.txt', '/etc/passwd', 'bin/console'] as $p) {
    $r = call('read_file', ['path' => $p]);
    check('読めない: ' . $p, isset($r['json']['ok']) && $r['json']['ok'] === false, $r['body']);
}

// ---- 書く中身の決まり ----
echo "書く中身の決まり\n";
$bad_contents = [
    ['root/.htaccess', "php_value auto_prepend_file /tmp/x.php\n"],
    ['root/.htaccess', "  PHP_VALUE   Auto_Prepend_File \"/tmp/x\"\n"],
    ['root/.htaccess', "<IfModule mod_php.c>\n  php_value include_path /tmp\n</IfModule>\n"],
    ['root/.htaccess', "php_value \\\n auto_append_file /tmp/x\n"],
    ['root/.htaccess', "AddType application/x-httpd-php .jpg\n"],
    ['root/.htaccess', "<FilesMatch \"\\.txt$\">\nSetHandler application/x-httpd-php\n</FilesMatch>\n"],
    ['root/.htaccess', "<Files x.txt> SetHandler php-script </Files>\n"],
    ['root/.htaccess', "AddHandler cgi-script .txt\nOptions +ExecCGI\n"],
    ['root/.htaccess', "<FilesMatch x> SetHandler \"proxy:fcgi://127.0.0.1:9000\" </FilesMatch>\n"],
    ['root/.htaccess', "AddOutputFilter INCLUDES .html\n"],
    ['root/.htaccess', "Action my-handler /x.cgi\n"],
    ['root/.htaccess', "php_admin_value open_basedir none\n"],
    ['root/.htaccess', "RewriteEngine On\nRewriteRule ^x$ - [H=application/x-httpd-php]\n"],
    ['root/.htaccess', "php_value error_log /var/www/html/x.php\n"],
    ['root/.user.ini', "auto_prepend_file = /tmp/x.php\n"],
    ['root/.user.ini', "  Error_Log=/var/www/html/log.php\n"],
    ['root/.user.ini', "session.save_path = /var/www/html\n"],
    ['root/.user.ini', "[PATH=/var/www]\nmemory_limit=1G\n"],
    ['root/.user.ini', "opcache.file_cache=/var/www/html\n"],
    ['lab/.user.ini', "extension=/tmp/evil.so\n"],
    ['root/.htaccess', "a\0b"],
    ['root/.htaccess', str_repeat('#', 70000)],
];
foreach ($bad_contents as $i => $bc) {
    $r = call('write_file', ['target' => $bc[0], 'content' => $bc[1], 'expected_sha256' => null]);
    check('断る ' . $i . ': ' . substr(str_replace(["\n", "\0"], ['⏎', '\\0'], $bc[1]), 0, 50),
        in_array(err($r), ['forbidden_directive', 'bad_content'], true), $r['body']);
}
check('断ったあと root/.htaccess は作られていない', !file_exists($root . '/.htaccess'));

// PHP と関係のない種類の指定は通す(EC-CUBE がもともと書いている webp の行など)
$ok_contents = [
    "AddType image/webp .webp\n",
    "RewriteEngine On\nRewriteCond %{HTTP_ACCEPT} image/webp\nRewriteRule (.+)\\.(jpe?g|png)$ $1.webp [T=image/webp,E=REQUEST_image]\n",
    "RemoveHandler .phtml\n",
];
foreach ($ok_contents as $i => $oc) {
    $cur = is_file($root . '/.htaccess') ? hash_file('sha256', $root . '/.htaccess') : null;
    $r = call('write_file', ['target' => 'root/.htaccess', 'content' => $oc, 'expected_sha256' => $cur]);
    check('通す ' . $i . ': ' . substr(str_replace("\n", '⏎', $oc), 0, 50), !empty($r['json']['ok']), $r['body']);
}
// もともとある行は、決まりに当たっても残せる。新しく足した行は断る
file_put_contents($root . '/.htaccess', "AddType application/x-httpd-php .php5\n");
$cur = hash_file('sha256', $root . '/.htaccess');
$r = call('write_file', ['target' => 'root/.htaccess', 'content' => "AddType application/x-httpd-php .php5\nHeader always set X-Frame-Options SAMEORIGIN\n", 'expected_sha256' => $cur]);
check('もともとある行は残したまま書ける', !empty($r['json']['ok']), $r['body']);
$cur = hash_file('sha256', $root . '/.htaccess');
$r = call('write_file', ['target' => 'root/.htaccess', 'content' => "AddType application/x-httpd-php .php5\nAddType application/x-httpd-php .jpg\n", 'expected_sha256' => $cur]);
check('同じ種類でも新しく足した行は断る', err($r) === 'forbidden_directive', $r['body']);
unlink($root . '/.htaccess');

// ---- 退避して書く・戻す ----
echo "退避と戻し\n";
$c1 = "# first\nphp_flag display_errors Off\n";
$r = call('write_file', ['target' => 'root/.htaccess', 'content' => $c1, 'expected_sha256' => null]);
check('無いファイルに書ける', !empty($r['json']['ok']) && file_get_contents($root . '/.htaccess') === $c1, $r['body']);
$b1 = $r['json']['result']['backup_id'];
$r = call('write_file', ['target' => 'root/.htaccess', 'content' => "# second\n", 'expected_sha256' => null]);
check('expected_sha256 が違えば conflict', err($r) === 'conflict');
$r = call('write_file', ['target' => 'root/.htaccess', 'content' => "# second\n", 'expected_sha256' => hash('sha256', $c1)]);
check('今の中身を指定すれば書き換えられる', !empty($r['json']['ok']) && file_get_contents($root . '/.htaccess') === "# second\n");
$b2 = $r['json']['result']['backup_id'];
$r = call('read_file', ['path' => 'var/self-harden/backups/' . $b2 . '.bak']);
check('退避ファイルが読める', !empty($r['json']['ok']) && $r['json']['result']['content'] === $c1);
$r = call('restore', ['backup_id' => $b2]);
check('戻すと前の中身になる', !empty($r['json']['ok']) && file_get_contents($root . '/.htaccess') === $c1, $r['body']);
$r = call('restore', ['backup_id' => $b1]);
check('元が無かった退避に戻すとファイルが消える', !empty($r['json']['ok']) && !file_exists($root . '/.htaccess'), $r['body']);
check('変な backup_id は断る', err(call('restore', ['backup_id' => '../../config'])) === 'bad_backup');
$r = call('list_backups');
check('退避の一覧が出る', !empty($r['json']['ok']) && count($r['json']['result']['backups']) >= 4);
file_put_contents($root . '/var/self-harden/backups/20990101000000-deadbeef.json', json_encode(['target' => 'root/index.php', 'existed' => true]));
file_put_contents($root . '/var/self-harden/backups/20990101000000-deadbeef.bak', 'hacked');
check('退避に書かれた場所が決まりの外なら戻さない', err(call('restore', ['backup_id' => '20990101000000-deadbeef'])) === 'bad_target' && file_get_contents($root . '/index.php') === "<?php echo 'shop';");

// ---- 書いたあと店を開いて、だめなら同じリクエストの中で戻す ----
echo "同じリクエストの中で戻す\n";
$r = call('write_file', ['target' => 'root/.htaccess', 'content' => "# ok\n", 'expected_sha256' => null, 'verify' => ['paths' => ['/'], 'timeout_sec' => 5]]);
check('店が開ければそのまま', !empty($r['json']['ok']) && $r['json']['result']['rolled_back'] === false && $r['json']['result']['verify'][0]['status'] === 200, $r['body']);
$r = call('write_file', ['target' => 'root/.htaccess', 'content' => "# BREAK-ME\n", 'expected_sha256' => hash('sha256', "# ok\n"), 'verify' => ['paths' => ['/'], 'timeout_sec' => 5]]);
check('500 になったら戻す', !empty($r['json']['ok']) && $r['json']['result']['rolled_back'] === true && file_get_contents($root . '/.htaccess') === "# ok\n", $r['body']);
check('戻したあと店が開ける', isset($r['json']['result']['rollback_verify'][0]['status']) && $r['json']['result']['rollback_verify'][0]['status'] === 200);
check('verify に外の URL は渡せない', err(call('write_file', ['target' => 'root/.htaccess', 'content' => "# x\n", 'expected_sha256' => hash('sha256', "# ok\n"), 'verify' => ['paths' => ['http://evil.example/']]])) === 'bad_verify');

// ---- 小部屋 ----
echo "小部屋\n";
$r = call('lab_arm');
$tok = $r['json']['result']['token'];
check('小部屋と probe.php ができる', !empty($r['json']['ok']) && is_file($root . '/self-harden-lab/probe.php'));
$p = http('GET', $base . '/self-harden-lab/probe.php');
check('合言葉なしの probe は 404', $p['status'] === 404 && $p['body'] === '');
$p = http('GET', $base . '/self-harden-lab/probe.php?t=' . str_repeat('0', 64));
check('違う合言葉は 404', $p['status'] === 404);
$p = http('GET', $base . '/self-harden-lab/probe.php?t=' . $tok);
check('合言葉が合えば設定が返る', $p['status'] === 200 && isset($p['json']['ini']['memory_limit']));
$p = http('GET', $base . '/self-harden-lab/probe.php?t=' . $tok);
check('合言葉は 1 回きり', $p['status'] === 404);
$r = call('lab_arm');
$t2 = $r['json']['result']['token'];
file_put_contents($root . '/var/self-harden/lab-token', json_encode(['token' => $t2, 'expires_at' => time() - 1]));
check('期限切れの合言葉は 404', http('GET', $base . '/self-harden-lab/probe.php?t=' . $t2)['status'] === 404);
$r = call('write_file', ['target' => 'lab/.user.ini', 'content' => "memory_limit = 64M\n", 'expected_sha256' => null]);
check('小部屋の .user.ini は書ける', !empty($r['json']['ok']));
file_put_contents($root . '/self-harden-lab/probe.php', '<?php echo "tampered";');
call('lab_arm');
check('lab_arm で probe.php が固定の中身に戻る', strpos(file_get_contents($root . '/self-harden-lab/probe.php'), 'tampered') === false);


// ---- 公式と照らし合わせる ----
echo "ファイルの一覧と SHA-256\n";
$r = call('hash_tree', ['limit' => 2]);
check('hash_tree は件数の上限で切り、続きの印を返す', !empty($r['json']['ok']) && count($r['json']['result']['files']) === 2 && $r['json']['result']['next_cursor'] !== null, $r['body']);
$all = [];
$cursor = '';
for ($i = 0; $i < 50; $i++) {
    $r = call('hash_tree', ['limit' => 2, 'cursor' => $cursor]);
    foreach ($r['json']['result']['files'] as $f) {
        $all[$f[0]] = $f[1];
    }
    if ($r['json']['result']['next_cursor'] === null) {
        break;
    }
    $cursor = $r['json']['result']['next_cursor'];
}
check('続きから取ると全部そろう', count($all) === $r['json']['result']['total'] && isset($all['src/Eccube/Common/Constant.php']) && $all['index.php'] === hash_file('sha256', $root . '/index.php'));
check('一覧に .env・var・受け口自身は出ない', !isset($all['.env']) && !isset($all['self-harden.php']) && !preg_grep('#^var/#', array_keys($all)));
check('roots に決まり以外は渡せない', err(call('hash_tree', ['roots' => ['../']])) === 'bad_root');
$r = call('read_file', ['path' => 'src/Eccube/Common/Constant.php']);
check('本体のファイルは読める', !empty($r['json']['ok']) && strpos($r['json']['result']['content'], '4.2.0') !== false);

echo "公式の中身に戻す\n";
$bad_official = [
    ['path' => 'var/self-harden/config.php', 'ref' => '4.2.0'],
    ['path' => 'self-harden.php', 'ref' => '4.2.0'],
    ['path' => '.env', 'ref' => '4.2.0'],
    ['path' => 'composer.lock', 'ref' => '4.2.0'],
    ['path' => 'bin/console', 'ref' => '4.2.0'],
    ['path' => '../outside/target.txt', 'ref' => '4.2.0'],
    ['path' => 'linkdir/target.txt', 'ref' => '4.2.0'],
    ['path' => 'self-harden-lab/probe.php', 'ref' => '4.2.0'],
    ['path' => 'index.php', 'ref' => 'main'],
    ['path' => 'index.php', 'ref' => '4.1.2'],
    ['path' => 'index.php', 'ref' => '../../evil/repo/main'],
    ['path' => 'index.php', 'ref' => 'https://evil.example/x.php'],
    ['path' => 'vendor/twig/twig/src/Environment.php', 'ref' => 'v3.0.0'],
    ['path' => 'vendor/twig/twig/src/Environment.php', 'ref' => 'v2.15.1'],
    ['path' => 'vendor/local/nogithub/x.php', 'ref' => str_repeat('b', 40)],
    ['path' => 'vendor/unknown/pkg/x.php', 'ref' => 'v1.0.0'],
];
foreach ($bad_official as $b) {
    $r = call('restore_official', $b);
    check('断る: ' . $b['path'] . ' @ ' . $b['ref'], isset($r['json']['ok']) && $r['json']['ok'] === false, $r['body']);
}
check('断ったあと、受け口も鍵も変わっていない', file_get_contents($root . '/self-harden.php') === file_get_contents($receiver) && strpos(file_get_contents($root . '/var/self-harden/config.php'), $secret) !== false);
check('API から URL や中身は渡せない(渡しても使わない)', err(call('restore_official', ['path' => 'index.php', 'ref' => '4.2.0', 'url' => 'https://evil.example/x', 'content' => '<?php evil();', 'expected_sha256' => str_repeat('0', 64)])) === 'official_mismatch');
check('取ってきた中身が違えば書かない', file_get_contents($root . '/index.php') === "<?php echo 'shop';");
$r = call('restore_official', ['path' => 'index.php', 'ref' => '4.2.0', 'verify' => ['paths' => ['/self-harden.php']]]);
check('公式(GitHub の EC-CUBE 4.2.0)から取ってきて戻せる', !empty($r['json']['ok']) && strpos($r['json']['result']['source'], 'https://raw.githubusercontent.com/EC-CUBE/ec-cube/4.2.0/index.php') === 0
    && strpos(file_get_contents($root . '/index.php'), 'Kernel') !== false, $r['body']);
$r = call('restore', ['backup_id' => $r['json']['result']['backup_id']]);
check('公式に戻したものも退避から戻せる', !empty($r['json']['ok']) && file_get_contents($root . '/index.php') === "<?php echo 'shop';", $r['body']);


echo "公式の修正を全部そろえて当てる\n";
$bad_sets = [
    ['ref' => '4.2.0', 'paths' => ['var/self-harden/x.php']],
    ['ref' => '4.2.0', 'paths' => ['self-harden.php']],
    ['ref' => '4.2.0', 'paths' => ['.env']],
    ['ref' => '4.2.0', 'paths' => ['bin/new/x.php']],
    ['ref' => '4.2.0', 'paths' => ['linkdir/new/x.php']],
    ['ref' => '4.2.0', 'paths' => ['../outside/new/x.php']],
    ['ref' => '4.2.0', 'paths' => ['self-harden-lab/new/x.php']],
    ['ref' => '4.2.0', 'paths' => ['index.php', 'index.php']],
    ['ref' => '4.2.0', 'paths' => []],
    ['ref' => 'c07e298', 'paths' => ['index.php']],
    ['ref' => '4.1.0', 'paths' => ['index.php']],
];
foreach ($bad_sets as $b) {
    $r = call('apply_official_fix', $b);
    check('断る: ' . implode(',', $b['paths']) . ' @ ' . $b['ref'], isset($r['json']['ok']) && $r['json']['ok'] === false, $r['body']);
}
check('断ったあと、フォルダは作られていない', !is_dir($root . '/bin/new') && !is_dir($outside . '/new') && !is_dir($root . '/self-harden-lab/new'));
$r = call('apply_official_fix', ['ref' => '4.2.0', 'paths' => ['src/Eccube/Kernel.php', 'app/config/eccube/routes.yaml', 'src/Eccube/NoSuchFile.php']]);
check('1 つでも公式から取れなければ、何も置かない', err($r) === 'official_fetch_failed' && !file_exists($root . '/src/Eccube/Kernel.php') && !is_dir($root . '/app/config'), $r['body']);
check('短いコミットの番号は、40 文字にするよう伝える', strpos(call('restore_official', ['path' => 'index.php', 'ref' => 'c07e298'])['body'], '40') !== false);
check('親フォルダが無いときは apply_official_fix を案内する', strpos(call('restore_official', ['path' => 'app/config/eccube/routes.yaml', 'ref' => '4.2.0'])['body'], 'apply_official_fix') !== false);
touch($root . '/.break-when-app-config');
$r = call('apply_official_fix', ['ref' => '4.2.0', 'paths' => ['src/Eccube/Kernel.php', 'app/config/eccube/routes.yaml'], 'verify' => ['paths' => ['/']]]);
check('当てたあと店が壊れたら、全部戻してフォルダも消す', !empty($r['json']['ok']) && $r['json']['result']['rolled_back'] === true
    && !file_exists($root . '/src/Eccube/Kernel.php') && !is_dir($root . '/app/config') && $r['json']['result']['rollback_verify'][0]['status'] === 200, $r['body']);
unlink($root . '/.break-when-app-config');
$r = call('apply_official_fix', ['ref' => '4.2.0', 'paths' => ['src/Eccube/Kernel.php', 'app/config/eccube/routes.yaml'], 'verify' => ['paths' => ['/']]]);
check('全部そろえば、フォルダも作って当てる', !empty($r['json']['ok']) && $r['json']['result']['rolled_back'] === false
    && strpos(file_get_contents($root . '/src/Eccube/Kernel.php'), 'class Kernel') !== false && is_file($root . '/app/config/eccube/routes.yaml')
    && $r['json']['result']['created_dirs'] === ['app', 'app/config', 'app/config/eccube'], $r['body']);
$r = call('restore', ['backup_id' => $r['json']['result']['applied'][0]['backup_id']]);
check('当てたものは退避から 1 つずつ戻せる(元が無ければ消える)', !empty($r['json']['ok']) && !file_exists($root . '/src/Eccube/Kernel.php'), $r['body']);

echo "隔離\n";
file_put_contents($root . '/html/sub/odd.php', "<?php echo 'odd';");
foreach (['self-harden.php', 'var/self-harden/config.php', '.env', 'linkdir/target.txt', '../outside/target.txt', 'html/sub', 'composer.lock'] as $p) {
    $r = call('quarantine', ['path' => $p]);
    check('隔離できない: ' . $p, isset($r['json']['ok']) && $r['json']['ok'] === false, $r['body']);
}
$r = call('quarantine', ['path' => 'html/sub/odd.php', 'verify' => ['paths' => ['/']]]);
$qid = isset($r['json']['result']['quarantine_id']) ? $r['json']['result']['quarantine_id'] : null;
check('不審なファイルを隔離できる', !empty($r['json']['ok']) && !file_exists($root . '/html/sub/odd.php') && is_file($root . '/var/self-harden/quarantine/' . $qid . '.q'), $r['body']);
$r = call('list_quarantine');
check('隔離の一覧に出る', !empty($r['json']['ok']) && $r['json']['result']['quarantine'][0]['rel'] === 'html/sub/odd.php');
file_put_contents($root . '/html/sub/odd.php', 'new');
check('元の場所に別のファイルがあれば戻さない', err(call('release_quarantine', ['quarantine_id' => $qid])) === 'conflict');
unlink($root . '/html/sub/odd.php');
$r = call('release_quarantine', ['quarantine_id' => $qid]);
check('隔離から元の場所に戻せる', !empty($r['json']['ok']) && file_get_contents($root . '/html/sub/odd.php') === "<?php echo 'odd';", $r['body']);
check('変な quarantine_id は断る', err(call('release_quarantine', ['quarantine_id' => '../../x'])) === 'bad_quarantine');
file_put_contents($root . '/var/self-harden/quarantine/20990101000000-deadbeef.json', json_encode(['rel' => 'self-harden.php']));
file_put_contents($root . '/var/self-harden/quarantine/20990101000000-deadbeef.q', '<?php evil();');
check('隔離の記録に書かれた戻し先が決まりの外なら戻さない', err(call('release_quarantine', ['quarantine_id' => '20990101000000-deadbeef'])) === 'bad_target'
    && file_get_contents($root . '/self-harden.php') === file_get_contents($receiver));

echo "記録\n";
$r = call('audit_tail', ['lines' => 500]);
$entries = isset($r['json']['result']['entries']) ? $r['json']['result']['entries'] : [];
$ops = array_column($entries, 'op');
check('署名が通った操作が 1 行ずつ残る', !empty($r['json']['ok']) && in_array('write_file', $ops, true) && in_array('quarantine', $ops, true) && in_array('restore_official', $ops, true));
$log = file_get_contents($root . '/var/self-harden/audit.log');
check('記録に鍵や中身は書かない', strpos($log, $secret) === false && strpos($log, 'BREAK-ME') === false && strpos($log, 'auto_prepend') === false);
check('署名が通らなかった呼び出しは記録しない(知らない操作は記録する)', strpos($log, '"op":"eval"') !== false && substr_count($log, '"op":"ping"') < 10);

// ---- 受け口に危ない関数が無いこと ----
echo "受け口のコード\n";
$src = file_get_contents($receiver);
$code = '';
foreach (token_get_all($src) as $tk) {
    if (is_array($tk) && in_array($tk[0], [T_COMMENT, T_DOC_COMMENT, T_CONSTANT_ENCAPSED_STRING, T_ENCAPSED_AND_WHITESPACE, T_INLINE_HTML, T_START_HEREDOC, T_END_HEREDOC], true)) {
        continue;
    }
    $code .= is_array($tk) ? $tk[1] : $tk;
}
foreach (['eval', 'include', 'include_once', 'require', 'require_once', 'exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen',
    'assert', 'create_function', 'unserialize', 'call_user_func', 'call_user_func_array', 'pcntl_exec', 'dl'] as $fn) {
    check("$fn を使っていない", !preg_match('/(?<![A-Za-z0-9_>$:])' . $fn . '\s*\(|\b' . $fn . '\s+[\'"$]/i', $code));
}
check('バッククォートを使っていない', strpos($code, '`') === false);

echo "\n$pass ok, $fail fail\n";
exit($fail === 0 ? 0 : 1);
