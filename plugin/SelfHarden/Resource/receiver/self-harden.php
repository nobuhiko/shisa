<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// self-harden の受け口。フレームワークを読み込まない素の PHP 1 枚。
// API から署名付きで呼ばれ、決まった操作を 1 回だけやって返す。
// 任意のコードを動かす操作(eval・include・exec 相当)は持たない。つなぎ目は docs/api.md。

@ini_set('display_errors', '0');
error_reporting(0);

const SH_VERSION = '0.2.0';
const SH_TIME_WINDOW = 300;
const SH_NONCE_TTL = 600;
const SH_MAX_BODY = 1048576;
const SH_MAX_WRITE = 65536;
const SH_MAX_READ = 262144;
const SH_MAX_BACKUPS = 200;
const SH_LAB_DIR = 'self-harden-lab';
const SH_VAR_DIR = 'var/self-harden';
const SH_MAX_OFFICIAL = 4194304;
const SH_AUDIT_MAX = 1048576;
// 本体のファイルを書くときに中身を取ってきてよい、決まった公式の場所(受け口が自分で組み立てる。API からは URL を渡せない)
const SH_OFFICIAL_RAW = 'https://raw.githubusercontent.com/';
const SH_ECCUBE_REPO = 'EC-CUBE/ec-cube';

// 小部屋に置く固定の確認用 PHP。API からは中身を変えられない
const SH_PROBE = <<<'PROBE'
<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// self-harden の小部屋の確認用。受け口が置く固定の中身。合言葉が合ったときだけ、この場所での PHP の設定を返す
@ini_set('display_errors', '0');
header('Cache-Control: no-store');
$f = dirname(__DIR__) . '/var/self-harden/lab-token';
$t = isset($_GET['t']) ? (string) $_GET['t'] : '';
$raw = @file_get_contents($f);
$d = is_string($raw) ? json_decode($raw, true) : null;
if ($t === '' || !is_array($d) || !isset($d['token'], $d['expires_at']) || time() > (int) $d['expires_at'] || !hash_equals((string) $d['token'], $t)) {
    http_response_code(404);
    exit;
}
@unlink($f);
$ini = [];
foreach (ini_get_all(null, false) as $k => $v) {
    $ini[$k] = preg_match('/password|secret|key/i', $k) ? '<redacted>' : (string) $v;
}
header('Content-Type: application/json');
echo json_encode(['sapi' => php_sapi_name(), 'php_version' => PHP_VERSION, 'ini' => $ini, 'time' => time()]);
PROBE;

final class ShError extends Exception
{
    public $code_str;

    public function __construct($code, $detail = '')
    {
        parent::__construct($detail);
        $this->code_str = $code;
    }
}

function sh_root()
{
    return __DIR__;
}

function sh_var($sub = '')
{
    return sh_root() . '/' . SH_VAR_DIR . ($sub === '' ? '' : '/' . $sub);
}

function sh_send($status, array $data, $sign_nonce = null, $secret = null)
{
    $body = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    if ($sign_nonce !== null && $secret !== null) {
        $s = "SH1-RES\n" . $sign_nonce . "\n" . hash('sha256', $body);
        header('X-SH-Signature: ' . hash_hmac('sha256', $s, $secret));
    }
    echo $body;
    exit;
}

function sh_unauthorized()
{
    sh_send(401, ['ok' => false, 'error' => 'unauthorized']);
}

// 設定は var/self-harden/config.php。先頭行は PHP の exit だけの行、2 行目以降が JSON。include せずに読む
function sh_config()
{
    $raw = @file_get_contents(sh_var('config.php'));
    if (!is_string($raw)) {
        return null;
    }
    $pos = strpos($raw, "\n");
    if ($pos === false) {
        return null;
    }
    $c = json_decode(substr($raw, $pos + 1), true);
    if (!is_array($c) || !isset($c['shop_id'], $c['secret']) || !is_string($c['secret']) || strlen($c['secret']) < 64) {
        return null;
    }
    return $c;
}

function sh_header($name)
{
    $k = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return isset($_SERVER[$k]) ? (string) $_SERVER[$k] : null;
}

function sh_authenticate(array $cfg, $body)
{
    $shop = sh_header('X-SH-Shop');
    $ts = sh_header('X-SH-Timestamp');
    $nonce = sh_header('X-SH-Nonce');
    $sig = sh_header('X-SH-Signature');
    // 形
    if ($shop === null || $ts === null || $nonce === null || $sig === null) {
        return null;
    }
    if (!preg_match('/^[0-9]{1,12}$/', $ts) || !preg_match('/^[0-9a-f]{32,64}$/', $nonce) || !preg_match('/^[0-9a-f]{64}$/', $sig)) {
        return null;
    }
    if (!hash_equals((string) $cfg['shop_id'], $shop)) {
        return null;
    }
    // 時刻
    if (abs(time() - (int) $ts) > SH_TIME_WINDOW) {
        return null;
    }
    // 署名
    $path = parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH);
    $s = implode("\n", ['SH1', 'POST', (string) $path, $shop, $ts, $nonce, hash('sha256', $body)]);
    if (!hash_equals(hash_hmac('sha256', $s, $cfg['secret']), $sig)) {
        return null;
    }
    // nonce(署名が通ったものだけ記録する)
    $dir = sh_var('nonces');
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        return null;
    }
    $fh = @fopen($dir . '/' . $nonce, 'x');
    if ($fh === false) {
        return null; // 使い回し
    }
    fwrite($fh, $ts);
    fclose($fh);
    sh_purge_nonces($dir);
    return $nonce;
}

function sh_purge_nonces($dir)
{
    if (mt_rand(1, 20) !== 1) {
        return;
    }
    $now = time();
    foreach ((array) @scandir($dir) as $f) {
        if (preg_match('/^[0-9a-f]{32,64}$/', $f) && $now - (int) @filemtime($dir . '/' . $f) > SH_NONCE_TTL) {
            @unlink($dir . '/' . $f);
        }
    }
}

// ---- パス ----

// root からの相対パスを確かめて絶対パスにする。.. や絶対パス、シンボリックリンクは通さない
function sh_safe_path($rel, $must_exist = true)
{
    if (!is_string($rel) || strlen($rel) > 512 || strpos($rel, "\0") !== false || strpos($rel, '\\') !== false) {
        throw new ShError('bad_path', 'path の形が正しくありません');
    }
    if ($rel !== '' && ($rel[0] === '/' || preg_match('/^[a-z]+:/i', $rel))) {
        throw new ShError('path_outside', 'root からの相対パスにしてください');
    }
    $root = sh_root();
    $cur = $root;
    $parts = $rel === '' ? [] : explode('/', trim($rel, '/'));
    foreach ($parts as $p) {
        if ($p === '' || $p === '.' || $p === '..') {
            throw new ShError('path_outside', '. や .. は使えません');
        }
        $cur .= '/' . $p;
        if (is_link($cur)) {
            throw new ShError('symlink', 'シンボリックリンクはたどりません');
        }
    }
    if ($must_exist) {
        $real = realpath($cur);
        $rroot = realpath($root);
        if ($real === false) {
            throw new ShError('not_found', 'ありません: ' . $rel);
        }
        if ($real !== $rroot && strpos($real, $rroot . '/') !== 0) {
            throw new ShError('path_outside', 'root の外です');
        }
    }
    return $cur;
}

function sh_rel($abs)
{
    $root = sh_root();
    return $abs === $root ? '' : substr($abs, strlen($root) + 1);
}

function sh_is_inside($rel, $dir)
{
    return $rel === $dir || strpos($rel, $dir . '/') === 0;
}

// 書いてよい場所の論理名を、絶対パスにする
function sh_resolve_target($target)
{
    if (!is_string($target)) {
        throw new ShError('bad_target', 'target がありません');
    }
    $map = [
        'root/.htaccess' => '.htaccess',
        'root/.user.ini' => '.user.ini',
        'lab/.htaccess' => SH_LAB_DIR . '/.htaccess',
        'lab/.user.ini' => SH_LAB_DIR . '/.user.ini',
    ];
    if (isset($map[$target])) {
        $rel = $map[$target];
        if (strpos($target, 'lab/') === 0) {
            sh_ensure_lab();
        }
    } elseif (strpos($target, 'code:') === 0) {
        $rel = sh_code_path(substr($target, 5));
    } elseif (strpos($target, 'dir:') === 0) {
        $rest = substr($target, 4);
        if (!preg_match('#^(.+)/\.htaccess$#', $rest, $m)) {
            throw new ShError('bad_target', 'dir: で書けるのは既にあるディレクトリの .htaccess だけです');
        }
        $dirabs = sh_safe_path($m[1], true);
        if (!is_dir($dirabs)) {
            throw new ShError('bad_target', 'ディレクトリではありません');
        }
        $drel = sh_rel($dirabs);
        if (sh_is_inside($drel, SH_VAR_DIR) || sh_is_inside($drel, SH_LAB_DIR) || $drel === '') {
            throw new ShError('bad_target', 'そのディレクトリには dir: で書けません');
        }
        $rel = $drel . '/.htaccess';
    } else {
        throw new ShError('bad_target', '書いてよい場所ではありません');
    }
    $abs = sh_safe_path($rel, false);
    // 親ディレクトリが root の中にあることを確かめる
    sh_safe_path(dirname($rel) === '.' ? '' : dirname($rel), true);
    if (is_link($abs) || (file_exists($abs) && !is_file($abs))) {
        throw new ShError('symlink', '書き先がふつうのファイルではありません');
    }
    return [$rel, $abs];
}

function sh_ensure_lab()
{
    $dir = sh_root() . '/' . SH_LAB_DIR;
    if (is_link($dir)) {
        throw new ShError('symlink', '小部屋がシンボリックリンクです');
    }
    if (!is_dir($dir) && !@mkdir($dir, 0755)) {
        throw new ShError('io', '小部屋を作れません');
    }
    $probe = $dir . '/probe.php';
    if (is_link($probe)) {
        @unlink($probe);
    }
    if (@file_get_contents($probe) !== SH_PROBE) {
        sh_atomic_write($probe, SH_PROBE);
    }
    return $dir;
}

function sh_ensure_var()
{
    foreach (['', 'backups', 'nonces'] as $sub) {
        $d = sh_var($sub);
        if (!is_dir($d)) {
            @mkdir($d, 0700, true);
        }
    }
    if (!file_exists(sh_var('.htaccess'))) {
        @file_put_contents(sh_var('.htaccess'), "Require all denied\n");
    }
    if (!file_exists(sh_var('index.html'))) {
        @file_put_contents(sh_var('index.html'), '');
    }
}

function sh_atomic_write($abs, $content)
{
    $tmp = dirname($abs) . '/.sh-tmp-' . bin2hex(random_bytes(6));
    if (@file_put_contents($tmp, $content, LOCK_EX) !== strlen($content)) {
        @unlink($tmp);
        throw new ShError('io', '書けませんでした');
    }
    @chmod($tmp, 0644);
    if (!@rename($tmp, $abs)) {
        @unlink($tmp);
        throw new ShError('io', '置き換えられませんでした');
    }
}

// ---- 書く中身の決まり(受け口が任意のコードを動かす道具にならないため) ----

const SH_FORBIDDEN_INI = [
    'auto_prepend_file', 'auto_append_file', 'include_path', 'open_basedir', 'disable_functions', 'disable_classes',
    'allow_url_include', 'extension', 'zend_extension', 'extension_dir', 'error_log', 'session.save_path',
    'upload_tmp_dir', 'sys_temp_dir', 'mail.log', 'user_ini.filename', 'doc_root', 'user_dir',
];

function sh_ini_key_forbidden($key)
{
    $key = strtolower(trim($key, " \t\"'"));
    if (in_array($key, SH_FORBIDDEN_INI, true)) {
        return true;
    }
    return strpos($key, 'opcache.') === 0 || strpos($key, 'phar.') === 0;
}

// 行の継続をつなぎ、小文字にして、空行とコメントを除いた行の一覧にする
function sh_content_lines($content)
{
    $out = [];
    $text = preg_replace("/\\\\\r?\n/", ' ', (string) $content);
    foreach (preg_split("/\r\n|\r|\n/", $text) as $line) {
        $l = strtolower(preg_replace('/\s+/', ' ', trim($line)));
        if ($l !== '' && $l[0] !== '#' && $l[0] !== ';') {
            $out[] = $l;
        }
    }
    return $out;
}

// PHP や CGI として動かす・サーバー側で取り込む、に当たる言葉
const SH_EXEC_WORDS = '/php|phtml|phar|cgi|fcgi|proxy:|x-httpd|server-parsed|includes|script/';

// $existing は今のファイルの中身。もともとある行(店の人や EC-CUBE が書いたもの)はそのまま残せるように、決まりは新しく足す行にだけ当てる
function sh_check_content($kind, $content, $existing = '')
{
    if (!is_string($content) || strlen($content) > SH_MAX_WRITE || strpos($content, "\0") !== false) {
        throw new ShError('bad_content', '中身は 64KB までの文字列にしてください');
    }
    $keep = array_flip(sh_content_lines($existing));
    foreach (sh_content_lines($content) as $l) {
        if (isset($keep[$l])) {
            continue;
        }
        if ($kind === 'htaccess') {
            $l = preg_replace('/^<[^>]*>\s*/', '', $l); // 1 行に書いたブロックの開始を外す
            // FastCGI に PHP の設定を渡す環境変数(PHP_VALUE / PHP_ADMIN_VALUE)は、どの書き方でも書かせない。
            // SetEnv・SetEnvIf・RewriteRule の E= などから FPM に渡ると、php_value の決まりを素通りしてしまう
            if (preg_match('/php_(admin_)?value|php_(admin_)?flag/', $l) && !preg_match('/^php_(value|flag)\s/', $l)) {
                throw new ShError('forbidden_directive', 'PHP_VALUE / PHP_ADMIN_VALUE を環境変数などで渡す書き方は受け口からは書けません');
            }
            if (preg_match('/^(php_admin_value|php_admin_flag)\b/', $l)) {
                throw new ShError('forbidden_directive', 'php_admin_* は書けません');
            }
            if (preg_match('/^(php_value|php_flag)\s+("?[^\s"]+"?)/', $l, $m) && sh_ini_key_forbidden($m[2])) {
                throw new ShError('forbidden_directive', $m[2] . ' は受け口からは書けません');
            }
            if (preg_match('/^(action|scriptalias|scriptaliasmatch)\b/', $l, $m)) {
                throw new ShError('forbidden_directive', $m[1] . ' は受け口からは書けません');
            }
            // 種類やハンドラの指定は、PHP や CGI として動かすものだけを断る(画像の種類の指定などは通す)
            if (preg_match('/^(sethandler|addhandler|addtype|forcetype|addoutputfilter|setoutputfilter|addinputfilter|setinputfilter|addoutputfilterbytype)\b/', $l, $m)
                && preg_match(SH_EXEC_WORDS, substr($l, strlen($m[1])))) {
                throw new ShError('forbidden_directive', $m[1] . ' で PHP や CGI として動かす指定は受け口からは書けません');
            }
            if (preg_match('/^options\b.*\b(execcgi|includes)\b/', $l)) {
                throw new ShError('forbidden_directive', 'Options の ExecCGI / Includes は書けません');
            }
            if (preg_match('/^rewriterule\b.*\[([^\]]*)\]/', $l, $m) && preg_match('/\b(h|handler|t|type)\s*=\s*([^,\]]*)/', $m[1], $f)
                && ($f[1] === 'h' || $f[1] === 'handler' || preg_match(SH_EXEC_WORDS, $f[2]))) {
                throw new ShError('forbidden_directive', 'RewriteRule で PHP や CGI として動かす指定は書けません');
            }
        } else {
            if ($l[0] === '[') {
                throw new ShError('forbidden_directive', '.user.ini に節は書けません');
            }
            $key = strpos($l, '=') === false ? $l : substr($l, 0, strpos($l, '='));
            if (sh_ini_key_forbidden($key)) {
                throw new ShError('forbidden_directive', trim($key) . ' は受け口からは書けません');
            }
        }
    }
}

// ---- 退避 ----

function sh_backup($rel, $abs, $target)
{
    sh_ensure_var();
    $id = gmdate('YmdHis') . '-' . bin2hex(random_bytes(4));
    $existed = is_file($abs);
    $content = $existed ? (string) @file_get_contents($abs) : '';
    if ($existed && @file_put_contents(sh_var('backups/' . $id . '.bak'), $content) !== strlen($content)) {
        throw new ShError('io', '退避を書けませんでした');
    }
    $meta = ['backup_id' => $id, 'target' => $target, 'rel' => $rel, 'existed' => $existed,
        'sha256' => $existed ? hash('sha256', $content) : null, 'created_at' => time()];
    if (@file_put_contents(sh_var('backups/' . $id . '.json'), json_encode($meta)) === false) {
        throw new ShError('io', '退避を書けませんでした');
    }
    sh_prune_backups();
    return $meta;
}

function sh_backup_list()
{
    $out = [];
    foreach ((array) @scandir(sh_var('backups')) as $f) {
        if (preg_match('/^([0-9]{14}-[0-9a-f]{8})\.json$/', $f)) {
            $m = json_decode((string) @file_get_contents(sh_var('backups/' . $f)), true);
            if (is_array($m)) {
                $out[] = $m;
            }
        }
    }
    usort($out, function ($a, $b) {
        return strcmp($b['backup_id'], $a['backup_id']);
    });
    return $out;
}

function sh_prune_backups()
{
    $list = sh_backup_list();
    foreach (array_slice($list, SH_MAX_BACKUPS) as $m) {
        @unlink(sh_var('backups/' . $m['backup_id'] . '.json'));
        @unlink(sh_var('backups/' . $m['backup_id'] . '.bak'));
    }
}

function sh_restore_backup($id)
{
    if (!is_string($id) || !preg_match('/^[0-9]{14}-[0-9a-f]{8}$/', $id)) {
        throw new ShError('bad_backup', 'backup_id の形が正しくありません');
    }
    $meta = json_decode((string) @file_get_contents(sh_var('backups/' . $id . '.json')), true);
    if (!is_array($meta) || !isset($meta['target'])) {
        throw new ShError('not_found', 'その退避はありません');
    }
    // 退避に書かれた場所をそのまま信じず、書いてよい場所かをもう一度確かめる
    list($rel, $abs) = sh_resolve_target($meta['target']);
    $now = sh_backup($rel, $abs, $meta['target']);
    if ($meta['existed']) {
        $content = @file_get_contents(sh_var('backups/' . $id . '.bak'));
        if (!is_string($content)) {
            throw new ShError('io', '退避を読めません');
        }
        sh_atomic_write($abs, $content);
    } elseif (is_file($abs)) {
        @unlink($abs);
    }
    return ['restored_to' => $meta['target'], 'sha256_after' => is_file($abs) ? hash_file('sha256', $abs) : null,
        'new_backup_id' => $now['backup_id']];
}

// ---- 自分の店を開いて確かめる ----

function sh_fetch_status($base, $path, $timeout)
{
    $url = rtrim($base, '/') . $path;
    $t0 = microtime(true);
    $status = 0;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_NOBODY => false, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_HTTPHEADER => ['X-SH-Verify: 1']]);
        curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
    } else {
        $u = parse_url($url);
        $port = isset($u['port']) ? $u['port'] : ($u['scheme'] === 'https' ? 443 : 80);
        $fp = @fsockopen(($u['scheme'] === 'https' ? 'ssl://' : '') . $u['host'], $port, $errno, $errstr, 3);
        if ($fp) {
            stream_set_timeout($fp, $timeout);
            $req = $path;
            fwrite($fp, "GET $req HTTP/1.0\r\nHost: {$u['host']}\r\nX-SH-Verify: 1\r\nConnection: close\r\n\r\n");
            $line = fgets($fp);
            if (is_string($line) && preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                $status = (int) $m[1];
            }
            fclose($fp);
        }
    }
    return ['path' => $path, 'status' => $status, 'ms' => (int) round((microtime(true) - $t0) * 1000)];
}

function sh_verify(array $cfg, $verify)
{
    if (!is_array($verify) || !isset($verify['paths']) || !is_array($verify['paths'])) {
        return null;
    }
    $base = isset($cfg['self_base']) ? (string) $cfg['self_base'] : '';
    if (!preg_match('#^https?://[A-Za-z0-9.\-]+(:[0-9]+)?$#', $base)) {
        throw new ShError('bad_config', 'self_base が正しくありません');
    }
    $timeout = isset($verify['timeout_sec']) ? max(1, min(8, (int) $verify['timeout_sec'])) : 8;
    $out = [];
    foreach (array_slice($verify['paths'], 0, 6) as $p) {
        if (!is_string($p) || strlen($p) > 512 || !preg_match('#^/[A-Za-z0-9._~\-/%?=&]*$#', $p)) {
            throw new ShError('bad_verify', 'verify.paths は / で始まるパスにしてください');
        }
        $out[] = sh_fetch_status($base, $p, $timeout);
    }
    return $out;
}

function sh_verify_failed($results)
{
    foreach ((array) $results as $r) {
        if ($r['status'] === 0 || $r['status'] >= 500) {
            return true;
        }
    }
    return false;
}

// ---- 伏せ方 ----

function sh_redact_value($v)
{
    $v = trim((string) $v, " \t\"'");
    return preg_match('/^(true|false|0|1|prod|dev|test|production|development|staging)$/i', $v) ? $v : '<redacted:' . strlen($v) . '>';
}

// ---- 操作 ----

function op_ping()
{
    return ['receiver_version' => SH_VERSION, 'php_version' => PHP_VERSION, 'time' => time()];
}

function op_inspect(array $args)
{
    $all = ['php', 'ini', 'extensions', 'server', 'app', 'paths'];
    $sections = isset($args['sections']) && is_array($args['sections']) ? array_values(array_intersect($all, $args['sections'])) : $all;
    $r = [];
    if (in_array('php', $sections, true)) {
        $r['php'] = ['version' => PHP_VERSION, 'sapi' => php_sapi_name(), 'os' => PHP_OS, 'zend_version' => zend_version()];
    }
    if (in_array('ini', $sections, true)) {
        $ini = [];
        foreach (ini_get_all(null, false) as $k => $v) {
            $ini[$k] = preg_match('/password|secret|key/i', $k) ? '<redacted>' : (string) $v;
        }
        $r['ini'] = $ini;
    }
    if (in_array('extensions', $sections, true)) {
        $ext = [];
        foreach (get_loaded_extensions() as $e) {
            $ext[$e] = (string) phpversion($e);
        }
        $r['extensions'] = $ext;
    }
    if (in_array('server', $sections, true)) {
        $s = [];
        foreach (['SERVER_SOFTWARE', 'SERVER_NAME', 'SERVER_PORT', 'HTTPS', 'DOCUMENT_ROOT', 'GATEWAY_INTERFACE'] as $k) {
            $s[$k] = isset($_SERVER[$k]) ? (string) $_SERVER[$k] : null;
        }
        if (function_exists('apache_get_modules')) {
            $s['apache_modules'] = apache_get_modules();
        }
        $r['server'] = $s;
    }
    if (in_array('app', $sections, true)) {
        $app = ['eccube_version' => null, 'packages' => [], 'env' => null];
        $c = @file_get_contents(sh_root() . '/src/Eccube/Common/Constant.php');
        if (is_string($c) && preg_match("/const\s+VERSION\s*=\s*'([^']+)'/", $c, $m)) {
            $app['eccube_version'] = $m[1];
        }
        $lock = json_decode((string) @file_get_contents(sh_root() . '/composer.lock'), true);
        if (is_array($lock)) {
            foreach (['packages', 'packages-dev'] as $k) {
                foreach (isset($lock[$k]) ? (array) $lock[$k] : [] as $p) {
                    if (isset($p['name'], $p['version'])) {
                        $app['packages'][] = ['name' => $p['name'], 'version' => $p['version'], 'dev' => $k === 'packages-dev'];
                    }
                }
            }
        }
        $env = @file_get_contents(sh_root() . '/.env');
        if (is_string($env)) {
            $app['env'] = [];
            foreach (preg_split("/\r\n|\n/", $env) as $line) {
                if (preg_match('/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/', $line, $m)) {
                    $app['env'][$m[1]] = sh_redact_value($m[2]);
                }
            }
        }
        $r['app'] = $app;
    }
    if (in_array('paths', $sections, true)) {
        $root = sh_root();
        $r['paths'] = [
            'root' => $root, 'root_writable' => is_writable($root),
            'receiver' => __FILE__, 'lab' => $root . '/' . SH_LAB_DIR, 'lab_exists' => is_dir($root . '/' . SH_LAB_DIR),
            'var' => sh_var(), 'var_writable' => is_writable(sh_var()),
        ];
    }
    return $r;
}

function op_list_dir(array $args)
{
    $rel = isset($args['path']) ? $args['path'] : '';
    $depth = isset($args['depth']) ? max(0, min(2, (int) $args['depth'])) : 0;
    $abs = sh_safe_path($rel, true);
    if (!is_dir($abs)) {
        throw new ShError('not_dir', 'ディレクトリではありません');
    }
    $entries = [];
    sh_walk($abs, sh_rel($abs), $depth, $entries);
    return ['path' => sh_rel($abs), 'entries' => $entries, 'truncated' => count($entries) >= 2000];
}

function sh_walk($abs, $rel, $depth, array &$entries)
{
    foreach ((array) @scandir($abs) as $name) {
        if ($name === '.' || $name === '..' || count($entries) >= 2000) {
            continue;
        }
        $p = $abs . '/' . $name;
        $st = @lstat($p);
        $type = is_link($p) ? 'link' : (is_dir($p) ? 'dir' : 'file');
        $entries[] = ['name' => ($rel === '' ? '' : $rel . '/') . $name, 'type' => $type,
            'size' => $st ? $st['size'] : null, 'mtime' => $st ? $st['mtime'] : null,
            'perms' => $st ? substr(sprintf('%o', $st['mode']), -4) : null];
        if ($type === 'dir' && $depth > 0) {
            sh_walk($p, ($rel === '' ? '' : $rel . '/') . $name, $depth - 1, $entries);
        }
    }
}

function op_read_file(array $args)
{
    $rel = isset($args['path']) ? $args['path'] : null;
    $abs = sh_safe_path($rel, false);
    $relnorm = sh_rel($abs);
    $base = basename($relnorm);
    $top = strpos($relnorm, '/') === false ? '' : substr($relnorm, 0, strpos($relnorm, '/'));
    $is_backup = (bool) preg_match('#^' . preg_quote(SH_VAR_DIR, '#') . '/backups/[0-9]{14}-[0-9a-f]{8}\.bak$#', $relnorm);
    // 読めるのは、設定ファイルと本体・部品のファイル(公式と比べるため)。鍵・.env・var/ の中(退避を除く)は読めない
    $allowed = $is_backup
        || in_array($base, ['.htaccess', '.user.ini', 'composer.json', 'composer.lock', 'web.config', 'robots.txt'], true)
        || (in_array($top, ['', 'src', 'app', 'html', 'vendor'], true) && !sh_is_protected($relnorm));
    if (!$allowed) {
        throw new ShError('not_readable', 'このファイルは読めません');
    }
    if (!file_exists($abs)) {
        return ['exists' => false];
    }
    sh_safe_path($rel, true);
    if (!is_file($abs) || filesize($abs) > SH_MAX_READ) {
        throw new ShError('too_large', '256KB までのふつうのファイルだけ読めます');
    }
    $c = (string) file_get_contents($abs);
    return ['exists' => true, 'content' => $c, 'sha256' => hash('sha256', $c), 'size' => strlen($c), 'mtime' => filemtime($abs)];
}

function op_write_file(array $cfg, array $args)
{
    $target = isset($args['target']) ? $args['target'] : null;
    list($rel, $abs) = sh_resolve_target($target);
    $kind = substr($rel, -9) === '.htaccess' ? 'htaccess' : 'userini';
    $content = isset($args['content']) ? $args['content'] : null;
    sh_check_content($kind, $content, is_file($abs) ? (string) @file_get_contents($abs) : '');

    $lock = @fopen(sh_var('lock'), 'c');
    if ($lock) {
        flock($lock, LOCK_EX);
    }
    $cur = is_file($abs) ? hash_file('sha256', $abs) : null;
    $expected = array_key_exists('expected_sha256', $args) ? $args['expected_sha256'] : null;
    if ($expected !== $cur) {
        throw new ShError('conflict', '今の中身が expected_sha256 と違います(今: ' . ($cur === null ? 'なし' : $cur) . ')');
    }
    $meta = sh_backup($rel, $abs, $target);
    sh_atomic_write($abs, $content);
    $res = ['backup_id' => $meta['backup_id'], 'sha256_before' => $cur, 'sha256_after' => hash('sha256', $content),
        'verify' => null, 'rolled_back' => false];
    if (isset($args['verify'])) {
        $res['verify'] = sh_verify($cfg, $args['verify']);
        if (sh_verify_failed($res['verify'])) {
            // 同じリクエストの中で戻す
            if ($meta['existed']) {
                sh_atomic_write($abs, (string) file_get_contents(sh_var('backups/' . $meta['backup_id'] . '.bak')));
            } else {
                @unlink($abs);
            }
            $res['rolled_back'] = true;
            $res['rollback_verify'] = sh_verify($cfg, $args['verify']);
        }
    }
    return $res;
}

function op_lab_arm()
{
    sh_ensure_var();
    sh_ensure_lab();
    $token = bin2hex(random_bytes(32));
    $exp = time() + 120;
    if (@file_put_contents(sh_var('lab-token'), json_encode(['token' => $token, 'expires_at' => $exp])) === false) {
        throw new ShError('io', '合言葉を書けません');
    }
    return ['token' => $token, 'expires_at' => $exp, 'probe_path' => '/' . SH_LAB_DIR . '/probe.php'];
}

// ---- 本体のファイル(公式と照らし合わせる・公式に戻す・隔離する) ----

// 受け口から触ってはいけない場所
function sh_is_protected($rel)
{
    $base = basename($rel);
    return $rel === 'self-harden.php' || sh_is_inside($rel, 'var') || sh_is_inside($rel, SH_LAB_DIR)
        || preg_match('/^\.env/', $base) || $rel === 'composer.json' || $rel === 'composer.lock' || sh_is_inside($rel, '.git');
}

// 公式の中身で書いてよい本体のファイル: src/ app/ html/ vendor/ の中と、root 直下のファイル
// $missing_dirs を渡したときだけ、無い親フォルダを許す(作るのは呼び出し側。公式の修正を置くときだけ)
function sh_code_path($rel, &$missing_dirs = null)
{
    if (!is_string($rel) || $rel === '') {
        throw new ShError('bad_path', 'path がありません');
    }
    $abs = sh_safe_path($rel, false);
    $r = sh_rel($abs);
    $top = strpos($r, '/') === false ? '' : substr($r, 0, strpos($r, '/'));
    if (!in_array($top, ['', 'src', 'app', 'html', 'vendor'], true) || sh_is_protected($r)) {
        throw new ShError('bad_target', 'そのファイルは受け口からは書けません: ' . $r);
    }
    // 親フォルダは root の中に実在すること(シンボリックリンクはたどらない)。
    // 作ってよいのは src/ app/ html/ vendor/ の中だけ
    $dir = dirname($r);
    if ($missing_dirs !== null && $top !== '') {
        $missing_dirs = [];
        $cur = '';
        foreach (explode('/', $dir) as $part) {
            $cur = $cur === '' ? $part : $cur . '/' . $part;
            if (!file_exists(sh_root() . '/' . $cur) && !is_link(sh_root() . '/' . $cur)) {
                $missing_dirs[] = $cur;
            } elseif ($missing_dirs) {
                throw new ShError('bad_target', 'フォルダの途中がおかしい: ' . $cur);
            }
        }
        $existing = $missing_dirs ? dirname($missing_dirs[0]) : $dir;
        sh_safe_path($existing === '.' ? '' : $existing, true);
        if (!$missing_dirs && !is_dir(sh_root() . '/' . $dir)) {
            throw new ShError('bad_target', 'フォルダではありません: ' . $dir);
        }
    } else {
        if (!is_dir(sh_root() . '/' . ($dir === '.' ? '' : $dir))) {
            throw new ShError('no_parent', 'フォルダがありません: ' . $dir . '(公式の修正で新しく置くファイルは apply_official_fix で置く)');
        }
        sh_safe_path($dir === '.' ? '' : $dir, true);
    }
    if (is_link($abs) || (file_exists($abs) && !is_file($abs))) {
        throw new ShError('symlink', '書き先がふつうのファイルではありません');
    }
    return $r;
}

function sh_eccube_version()
{
    $c = @file_get_contents(sh_root() . '/src/Eccube/Common/Constant.php');
    return is_string($c) && preg_match("/const\s+VERSION\s*=\s*'([^']+)'/", $c, $m) ? $m[1] : null;
}

// どこから取ってくるかを、受け口が自分で決める。API が渡せるのは「どの版か(ref)」だけ
function sh_official_url($rel, $ref)
{
    if (!is_string($ref) || $ref === '') {
        throw new ShError('bad_ref', 'ref がありません');
    }
    $sha = (bool) preg_match('/^[0-9a-f]{40}$/', $ref);
    if (strpos($rel, 'vendor/') === 0) {
        $parts = explode('/', $rel, 4);
        if (count($parts) < 4) {
            throw new ShError('bad_target', 'vendor/<vendor>/<package>/<file> の形にしてください');
        }
        $name = $parts[1] . '/' . $parts[2];
        $lock = json_decode((string) @file_get_contents(sh_root() . '/composer.lock'), true);
        $pkg = null;
        foreach (['packages', 'packages-dev'] as $k) {
            foreach (isset($lock[$k]) ? (array) $lock[$k] : [] as $p) {
                if (isset($p['name']) && $p['name'] === $name) {
                    $pkg = $p;
                }
            }
        }
        if (!$pkg || !isset($pkg['source']['url'], $pkg['source']['reference'], $pkg['version'])
            || !preg_match('#^https://github\.com/([A-Za-z0-9_.\-]+)/([A-Za-z0-9_.\-]+?)(\.git)?$#', $pkg['source']['url'], $m)) {
            throw new ShError('no_official_source', 'composer.lock に GitHub の公式の置き場が書かれていない部品です');
        }
        $locked = ltrim($pkg['version'], 'v');
        if ($ref !== $pkg['source']['reference']) {
            // ロックされた版か、同じメジャー版で新しいタグだけ
            if (!preg_match('/^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/', $ref, $t) || !preg_match('/^([0-9]+)\./', $locked, $lm)
                || $t[1] !== $lm[1] || version_compare(ltrim($ref, 'v'), $locked, '<')) {
                throw new ShError('bad_ref', '部品はロックされた版か、同じメジャー版の新しいタグだけにできます(ロック: ' . $pkg['version'] . ')');
            }
        }
        return SH_OFFICIAL_RAW . $m[1] . '/' . $m[2] . '/' . $ref . '/' . $parts[3];
    }
    $installed = sh_eccube_version();
    if (!$sha) {
        if (!preg_match('/^4\.[0-9]+\.[0-9]+(-p[0-9]+)?$/', $ref) || $installed === null || version_compare($ref, $installed, '<')) {
            throw new ShError('bad_ref', 'EC-CUBE は今の版(' . $installed . ')以上のタグか、公式のコミットの番号(40 文字の 16 進数。短い形は不可)だけにできます');
        }
    }
    return SH_OFFICIAL_RAW . SH_ECCUBE_REPO . '/' . $ref . '/' . $rel;
}

function sh_fetch_official($url)
{
    if (strpos($url, SH_OFFICIAL_RAW) !== 0 || !function_exists('curl_init')) {
        throw new ShError('no_official_source', '公式の場所から取れません');
    }
    $ch = curl_init($url);
    $buf = '';
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => false, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 12,
        CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_WRITEFUNCTION => function ($ch, $data) use (&$buf) {
            $buf .= $data;
            return strlen($buf) > SH_MAX_OFFICIAL ? 0 : strlen($data);
        }]);
    curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status !== 200) {
        throw new ShError('official_fetch_failed', '公式の場所から取れませんでした(HTTP ' . $status . ')');
    }
    return $buf;
}

function op_restore_official(array $cfg, array $args)
{
    $rel = sh_code_path(isset($args['path']) ? $args['path'] : null);
    $abs = sh_root() . '/' . $rel;
    $url = sh_official_url($rel, isset($args['ref']) ? $args['ref'] : null);
    $content = sh_fetch_official($url);
    if (isset($args['expected_sha256']) && $args['expected_sha256'] !== null && !hash_equals((string) $args['expected_sha256'], hash('sha256', $content))) {
        throw new ShError('official_mismatch', '公式から取った中身が expected_sha256 と違います(取った中身: ' . hash('sha256', $content) . ')');
    }
    $lock = @fopen(sh_var('lock'), 'c');
    if ($lock) {
        flock($lock, LOCK_EX);
    }
    $before = is_file($abs) ? hash_file('sha256', $abs) : null;
    if (array_key_exists('current_sha256', $args) && $args['current_sha256'] !== $before) {
        throw new ShError('conflict', '今の中身が current_sha256 と違います(今: ' . ($before === null ? 'なし' : $before) . ')');
    }
    $meta = sh_backup($rel, $abs, 'code:' . $rel);
    sh_atomic_write($abs, $content);
    if (function_exists('opcache_invalidate')) {
        @opcache_invalidate($abs, true);
    }
    $res = ['backup_id' => $meta['backup_id'], 'source' => $url, 'sha256_before' => $before, 'sha256_after' => hash('sha256', $content),
        'verify' => null, 'rolled_back' => false];
    if (isset($args['verify'])) {
        $res['verify'] = sh_verify($cfg, $args['verify']);
        if (sh_verify_failed($res['verify'])) {
            if ($meta['existed']) {
                sh_atomic_write($abs, (string) file_get_contents(sh_var('backups/' . $meta['backup_id'] . '.bak')));
            } else {
                @unlink($abs);
            }
            if (function_exists('opcache_invalidate')) {
                @opcache_invalidate($abs, true);
            }
            $res['rolled_back'] = true;
            $res['rollback_verify'] = sh_verify($cfg, $args['verify']);
        }
    }
    return $res;
}

// 公式の修正を、全部そろえて当てるか、何も置かないか。
// 先に全部を公式から取ってくる(1 つでも取れなければ何も書かない)→ 全部を退避して書く → 店を開く → 壊れたら全部戻す
function op_apply_official_fix(array $cfg, array $args)
{
    $ref = isset($args['ref']) ? $args['ref'] : null;
    $paths = isset($args['paths']) && is_array($args['paths']) ? array_values($args['paths']) : [];
    if (!$paths || count($paths) > 30 || count(array_unique($paths)) !== count($paths)) {
        throw new ShError('bad_request', 'paths は 1〜30 件の重ならないファイルにしてください');
    }
    $expected = isset($args['expected_sha256']) && is_array($args['expected_sha256']) ? $args['expected_sha256'] : [];
    // 1. 場所を確かめ、全部を取ってくる
    $items = [];
    $dirs_to_make = [];
    $t0 = microtime(true);
    foreach ($paths as $p) {
        $missing = [];
        $r = sh_code_path($p, $missing);
        $url = sh_official_url($r, $ref);
        if (microtime(true) - $t0 > 14) {
            throw new ShError('timeout', '公式から取るのに時間がかかりすぎたので、何も置いていません');
        }
        try {
            $content = sh_fetch_official($url);
        } catch (ShError $e) {
            throw new ShError('official_fetch_failed', '公式から取れないファイルがあるので、何も置いていません: ' . $r . '(' . $e->getMessage() . ')');
        }
        if (isset($expected[$p]) && !hash_equals((string) $expected[$p], hash('sha256', $content))) {
            throw new ShError('official_mismatch', '公式から取った中身が expected_sha256 と違うので、何も置いていません: ' . $r);
        }
        $items[] = ['rel' => $r, 'url' => $url, 'content' => $content];
        foreach ($missing as $d) {
            $dirs_to_make[$d] = true;
        }
    }
    $lock = @fopen(sh_var('lock'), 'c');
    if ($lock) {
        flock($lock, LOCK_EX);
    }
    // 2. フォルダを作り、全部を退避して書く
    $created = [];
    $written = [];
    $rollback = function () use (&$written, &$created) {
        foreach (array_reverse($written) as $w) {
            $abs = sh_root() . '/' . $w['rel'];
            if ($w['existed']) {
                sh_atomic_write($abs, (string) file_get_contents(sh_var('backups/' . $w['backup_id'] . '.bak')));
            } else {
                @unlink($abs);
            }
            if (function_exists('opcache_invalidate')) {
                @opcache_invalidate($abs, true);
            }
        }
        foreach (array_reverse($created) as $d) {
            @rmdir(sh_root() . '/' . $d);
        }
    };
    try {
        $make = array_keys($dirs_to_make);
        usort($make, function ($a, $b) {
            return substr_count($a, '/') - substr_count($b, '/');
        });
        foreach ($make as $d) {
            if (!@mkdir(sh_root() . '/' . $d, 0755)) {
                throw new ShError('io', 'フォルダを作れませんでした: ' . $d);
            }
            $created[] = $d;
        }
        foreach ($items as $it) {
            $abs = sh_root() . '/' . $it['rel'];
            $meta = sh_backup($it['rel'], $abs, 'code:' . $it['rel']);
            $written[] = ['rel' => $it['rel'], 'backup_id' => $meta['backup_id'], 'existed' => $meta['existed']];
            sh_atomic_write($abs, $it['content']);
            if (function_exists('opcache_invalidate')) {
                @opcache_invalidate($abs, true);
            }
        }
    } catch (Throwable $e) {
        $rollback();
        throw $e instanceof ShError ? $e : new ShError('io', '書いている途中で失敗したので、全部戻しました');
    }
    $res = ['ref' => $ref, 'applied' => [], 'created_dirs' => $created, 'verify' => null, 'rolled_back' => false];
    foreach ($items as $i => $it) {
        $res['applied'][] = ['path' => $it['rel'], 'source' => $it['url'], 'backup_id' => $written[$i]['backup_id'],
            'existed_before' => $written[$i]['existed'], 'sha256_after' => hash('sha256', $it['content'])];
    }
    // 3. 店を開いて確かめ、だめなら全部戻す
    if (isset($args['verify'])) {
        $res['verify'] = sh_verify($cfg, $args['verify']);
        if (sh_verify_failed($res['verify'])) {
            $rollback();
            $res['rolled_back'] = true;
            $res['rollback_verify'] = sh_verify($cfg, $args['verify']);
        }
    }
    return $res;
}

// 公式に無い不審なファイルを、消さずに Web から読めない場所へ移す
function op_quarantine(array $cfg, array $args)
{
    $rel = isset($args['path']) ? $args['path'] : null;
    $abs = sh_safe_path($rel, true);
    $r = sh_rel($abs);
    if ($r === '' || sh_is_protected($r) || !is_file($abs) || is_link($abs)) {
        throw new ShError('bad_target', 'そのファイルは隔離できません');
    }
    sh_ensure_var();
    $qdir = sh_var('quarantine');
    if (!is_dir($qdir)) {
        @mkdir($qdir, 0700, true);
    }
    $id = gmdate('YmdHis') . '-' . bin2hex(random_bytes(4));
    $meta = ['quarantine_id' => $id, 'rel' => $r, 'sha256' => hash_file('sha256', $abs), 'size' => filesize($abs), 'created_at' => time()];
    if (@file_put_contents($qdir . '/' . $id . '.json', json_encode($meta)) === false || !@rename($abs, $qdir . '/' . $id . '.q')) {
        @unlink($qdir . '/' . $id . '.json');
        throw new ShError('io', '隔離できませんでした');
    }
    @chmod($qdir . '/' . $id . '.q', 0600);
    $res = $meta + ['verify' => null, 'released' => false];
    if (isset($args['verify'])) {
        $res['verify'] = sh_verify($cfg, $args['verify']);
        if (sh_verify_failed($res['verify'])) {
            sh_release($id);
            $res['released'] = true;
            $res['release_verify'] = sh_verify($cfg, $args['verify']);
        }
    }
    return $res;
}

function sh_release($id)
{
    if (!is_string($id) || !preg_match('/^[0-9]{14}-[0-9a-f]{8}$/', $id)) {
        throw new ShError('bad_quarantine', 'quarantine_id の形が正しくありません');
    }
    $qdir = sh_var('quarantine');
    $meta = json_decode((string) @file_get_contents($qdir . '/' . $id . '.json'), true);
    if (!is_array($meta) || !isset($meta['rel']) || !is_file($qdir . '/' . $id . '.q')) {
        throw new ShError('not_found', 'その隔離はありません');
    }
    // 元の場所が決まりの中かを、もう一度確かめる
    $abs = sh_safe_path($meta['rel'], false);
    $r = sh_rel($abs);
    if ($r === '' || sh_is_protected($r)) {
        throw new ShError('bad_target', '元の場所に戻せません');
    }
    $dir = dirname($r);
    sh_safe_path($dir === '.' ? '' : $dir, true);
    if (file_exists($abs) || is_link($abs)) {
        throw new ShError('conflict', '元の場所に別のファイルがあります');
    }
    if (!@rename($qdir . '/' . $id . '.q', $abs)) {
        throw new ShError('io', '戻せませんでした');
    }
    @unlink($qdir . '/' . $id . '.json');
    return ['released_to' => $r];
}

function op_list_quarantine()
{
    $out = [];
    foreach ((array) @scandir(sh_var('quarantine')) as $f) {
        if (preg_match('/^[0-9]{14}-[0-9a-f]{8}\.json$/', $f)) {
            $m = json_decode((string) @file_get_contents(sh_var('quarantine/' . $f)), true);
            if (is_array($m)) {
                $out[] = $m;
            }
        }
    }
    return ['quarantine' => $out];
}

// ファイルの一覧と SHA-256。読むだけ。件数と時間の上限があり、cursor から続きを取れる
function op_hash_tree(array $args)
{
    $roots = isset($args['roots']) && is_array($args['roots']) ? $args['roots'] : ['', 'app', 'html', 'src', 'vendor'];
    $limit = isset($args['limit']) ? max(1, min(5000, (int) $args['limit'])) : 3000;
    $cursor = isset($args['cursor']) && is_string($args['cursor']) ? $args['cursor'] : '';
    $paths = [];
    foreach ($roots as $root) {
        if (!in_array($root, ['', 'app', 'html', 'src', 'vendor'], true)) {
            throw new ShError('bad_root', 'roots は "", app, html, src, vendor から選んでください');
        }
        $abs = $root === '' ? sh_root() : sh_root() . '/' . $root;
        if ($root !== '' && (is_link($abs) || !is_dir($abs))) {
            continue;
        }
        sh_collect($abs, $root, $root !== '', $paths);
    }
    sort($paths, SORT_STRING);
    $t0 = microtime(true);
    $files = [];
    $next = null;
    foreach ($paths as $p) {
        if ($cursor !== '' && strcmp($p, $cursor) <= 0) {
            continue;
        }
        if (count($files) >= $limit || microtime(true) - $t0 > 15) {
            $next = end($files)[0];
            break;
        }
        $abs = sh_root() . '/' . $p;
        $files[] = [$p, is_link($abs) ? 'link' : (string) @hash_file('sha256', $abs), (int) @filesize($abs)];
    }
    return ['files' => $files, 'next_cursor' => $next, 'total' => count($paths)];
}

function sh_collect($abs, $rel, $recursive, array &$out)
{
    foreach ((array) @scandir($abs) as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        $r = $rel === '' ? $name : $rel . '/' . $name;
        $p = $abs . '/' . $name;
        if (sh_is_protected($r) && $r !== 'composer.json' && $r !== 'composer.lock' && !preg_match('/^\.env/', $name)) {
            continue;
        }
        if (is_link($p)) {
            $out[] = $r;
        } elseif (is_dir($p)) {
            if ($recursive && $name !== 'node_modules') {
                sh_collect($p, $r, true, $out);
            }
        } elseif (is_file($p) && !preg_match('/^\.env/', $name)) {
            $out[] = $r;
        }
    }
}

// ---- 記録(署名が通った操作を 1 行ずつ。中身や鍵は書かない) ----

function sh_audit($op, array $args, $ok, $code, $result)
{
    $f = sh_var('audit.log');
    if (@filesize($f) > SH_AUDIT_MAX) {
        $keep = (string) @file_get_contents($f, false, null, (int) (SH_AUDIT_MAX / 2));
        @file_put_contents($f, substr($keep, strpos($keep, "\n") + 1), LOCK_EX);
    }
    $path = null;
    foreach (['target', 'path', 'backup_id', 'quarantine_id'] as $k) {
        if (isset($args[$k]) && is_string($args[$k])) {
            $path = substr($args[$k], 0, 300);
            break;
        }
    }
    if ($path === null && isset($args['paths']) && is_array($args['paths'])) {
        $path = substr(implode(',', array_filter($args['paths'], 'is_string')), 0, 300);
    }
    $line = ['t' => gmdate('c'), 'op' => $op, 'path' => $path, 'ok' => $ok, 'code' => $code,
        'backup_id' => is_array($result) && isset($result['backup_id']) ? $result['backup_id'] : null,
        'rolled_back' => is_array($result) && !empty($result['rolled_back']) ? true : null];
    @file_put_contents($f, json_encode($line, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
    @chmod($f, 0600);
}

function op_audit_tail(array $args)
{
    $n = isset($args['lines']) ? max(1, min(500, (int) $args['lines'])) : 100;
    $lines = preg_split("/\n/", trim((string) @file_get_contents(sh_var('audit.log'))));
    $out = [];
    foreach (array_slice($lines, -$n) as $l) {
        $d = json_decode($l, true);
        if (is_array($d)) {
            $out[] = $d;
        }
    }
    return ['entries' => $out];
}

// ---- 入口 ----

function sh_main()
{
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
    if ($method === 'GET' || $method === 'HEAD') {
        sh_send(200, ['ok' => true, 'service' => 'self-harden-receiver']);
    }
    if ($method !== 'POST') {
        sh_unauthorized();
    }
    $cfg = sh_config();
    if ($cfg === null) {
        sh_unauthorized();
    }
    $len = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
    if ($len > SH_MAX_BODY) {
        sh_unauthorized();
    }
    $body = (string) file_get_contents('php://input', false, null, 0, SH_MAX_BODY + 1);
    if (strlen($body) > SH_MAX_BODY) {
        sh_unauthorized();
    }
    $nonce = sh_authenticate($cfg, $body);
    if ($nonce === null) {
        sh_unauthorized();
    }
    $secret = $cfg['secret'];
    $req = json_decode($body, true);
    if (!is_array($req) || !isset($req['op']) || !is_string($req['op'])) {
        sh_send(200, ['ok' => false, 'error' => 'bad_request', 'detail' => 'JSON の op がありません'], $nonce, $secret);
    }
    $args = isset($req['args']) && is_array($req['args']) ? $req['args'] : [];
    @set_time_limit(25);
    try {
        switch ($req['op']) {
            case 'ping': $r = op_ping(); break;
            case 'inspect': $r = op_inspect($args); break;
            case 'list_dir': $r = op_list_dir($args); break;
            case 'read_file': $r = op_read_file($args); break;
            case 'write_file': $r = op_write_file($cfg, $args); break;
            case 'restore': $r = sh_restore_backup(isset($args['backup_id']) ? $args['backup_id'] : null); break;
            case 'list_backups': $r = ['backups' => array_slice(sh_backup_list(), 0, 200)]; break;
            case 'lab_arm': $r = op_lab_arm(); break;
            case 'hash_tree': $r = op_hash_tree($args); break;
            case 'restore_official': $r = op_restore_official($cfg, $args); break;
            case 'apply_official_fix': $r = op_apply_official_fix($cfg, $args); break;
            case 'quarantine': $r = op_quarantine($cfg, $args); break;
            case 'release_quarantine': $r = sh_release(isset($args['quarantine_id']) ? $args['quarantine_id'] : null); break;
            case 'list_quarantine': $r = op_list_quarantine(); break;
            case 'audit_tail': $r = op_audit_tail($args); break;
            default:
                throw new ShError('unknown_op', 'その操作はありません');
        }
        sh_audit($req['op'], $args, true, null, $r);
        sh_send(200, ['ok' => true, 'result' => $r], $nonce, $secret);
    } catch (ShError $e) {
        sh_audit($req['op'], $args, false, $e->code_str, null);
        sh_send(200, ['ok' => false, 'error' => $e->code_str, 'detail' => $e->getMessage()], $nonce, $secret);
    } catch (Throwable $e) {
        sh_audit($req['op'], $args, false, 'internal', null);
        sh_send(200, ['ok' => false, 'error' => 'internal', 'detail' => '受け口の中で失敗しました'], $nonce, $secret);
    }
}

sh_main();
