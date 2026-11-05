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
// 店主の承認で書く直し: 承認の鍵(お店の中だけ。API には渡さない)と、使った印の記録
const SH_APPROVE_KEY = 'approve-key.php';
const SH_APPROVE_MAX_TTL = 3600;
const SH_APPROVE_EXT = '/\\.(php|twig|tpl|html?)$/i';
// 承認の直しは小さく: 変わる行の幅(先頭と末尾の同じ行を除いた範囲)の上限
const SH_APPROVE_MAX_LINES = 200;
// 本体のファイルを書くときに中身を取ってきてよい、決まった公式の場所(受け口が自分で組み立てる。API からは URL を渡せない)
const SH_OFFICIAL_RAW = 'https://raw.githubusercontent.com/';
// コミットの番号が公式のものかを確かめる先(受け口が自分で組み立てる)。フォークにだけあるコミットも、親のリポジトリの名前で取れてしまうため
const SH_GITHUB_API = 'https://api.github.com/repos/';
// 地図: 仕組み(アプリと版の系統)ごとの違いをここにまとめる。書いてよい場所、版の読み方、公式の置き場、版の形。
// どの地図を使うかは、窓口が自分の居場所を見て決める。API からは選べない(鍵が漏れても、ゆるい地図を選ばせない)
const SH_MAPS = [
    'eccube4' => [
        'code_tops' => ['', 'src', 'app', 'html', 'vendor'],
        'var_dir' => 'var/self-harden',
        'vendor_dir' => 'vendor',
        'cache' => ['base' => 'var/cache', 'dirs' => ['prod']],
        // PHP が置かれるはずのない場所(画像・アップロード・利用者のファイル・記録)。作り直されるキャッシュ(PHP で書かれる)は除く
        'drop_dirs' => ['html/upload', 'html/user_data', 'var'],
        'drop_skip' => ['var/cache'],
        'secrets' => [],
        'version_file' => 'src/Eccube/Common/Constant.php',
        'version_re' => "/const\\s+VERSION\\s*=\\s*'([^']+)'/",
        'repo' => 'EC-CUBE/ec-cube',
        // 書いたあとに必ず開いて確かめるページ(API が渡すものに足す。API 任せにしない)
        'verify_paths' => ['/', '/products/list', '/cart'],
        'official_branches' => ['%line%', 'maintenance/%line%'],
        'tag_re' => '/^4\\.[0-9]+\\.[0-9]+(-p[0-9]+)?$/',
        'line_re' => '/^(4\\.[0-9]+)\\./',
        'release_asset' => 'eccube-%s.tar.gz',
    ],
    // 3 系(3.0.x)。公開の場所は既定で html/、本体はその上の階。修正版の配布物は GitHub のリリースに無い
    'eccube3' => [
        'code_tops' => ['', 'src', 'app', 'html', 'vendor'],
        'var_dir' => 'app/self-harden',
        'vendor_dir' => 'vendor',
        'cache' => ['base' => 'app/cache', 'dirs' => ['twig', 'doctrine', 'eccube', 'plugin', 'translator', 'prod']],
        'drop_dirs' => ['html/upload', 'html/user_data', 'app/log'],
        'drop_skip' => [],
        'secrets' => ['app/config/eccube/config.yml', 'app/config/eccube/database.yml', 'app/config/eccube/mail.yml'],
        'version_file' => 'src/Eccube/Common/Constant.php',
        'version_re' => "/const\\s+VERSION\\s*=\\s*'([^']+)'/",
        // 3 系の修正版(3.0.18-p1〜)は EC-CUBE/ec-cube3 のタグにある
        'repo' => 'EC-CUBE/ec-cube3',
        // 書いたあとに必ず開いて確かめるページ(API が渡すものに足す。API 任せにしない)
        'verify_paths' => ['/', '/products/list', '/cart'],
        'official_branches' => ['3.0'],
        'tag_re' => '/^3\\.0\\.[0-9]+(-p[0-9]+)?$/',
        'line_re' => '/^(3\\.0)\\./',
        'release_asset' => null,
    ],
    // 2 系(2.13〜。PHP 7 以上で動くもの)。公開の場所は html/、本体は data/。公式のタグには eccube- が付く
    'eccube2' => [
        'code_tops' => ['', 'data', 'html'],
        'var_dir' => 'data/self-harden',
        'vendor_dir' => 'data/vendor',
        'cache' => null,
        // 2 系の html/user_data は、店が自分のページ(PHP)を置く場所なので含めない
        'drop_dirs' => ['html/upload', 'data/upload', 'data/logs'],
        'drop_skip' => [],
        'secrets' => ['data/config/config.php'],
        'version_file' => 'data/class/SC_Initial.php',
        'version_re' => "/define\\(\\s*'ECCUBE_VERSION'\\s*,\\s*'([^']+)'\\s*\\)/",
        'repo' => 'EC-CUBE/ec-cube2',
        // 書いたあとに必ず開いて確かめるページ(API が渡すものに足す。API 任せにしない)
        'verify_paths' => ['/', '/products/list.php', '/cart/'],
        'official_branches' => ['master'],
        'tag_prefix' => 'eccube-',
        'tag_re' => '/^eccube-2\\.[0-9]+\\.[0-9]+(-p[0-9]+)?$/',
        'line_re' => '/^(2\\.[0-9]+)\\./',
        'release_asset' => '%s.tar.gz',
    ],
    // 見分けがつかない店。読む操作(ping・inspect)だけ答え、書く操作は断る。鍵の置き場は 4 系と同じ場所を見る
    'unknown' => [
        'code_tops' => [],
        'drop_dirs' => [],
        'drop_skip' => [],
        'var_dir' => 'var/self-harden',
        'vendor_dir' => 'vendor',
        'cache' => null,
        'secrets' => [],
        'version_file' => null,
        'version_re' => null,
        'repo' => null,
        // 書いたあとに必ず開いて確かめるページ(API が渡すものに足す。API 任せにしない)
        'verify_paths' => ['/'],
        'official_branches' => [],
        'tag_re' => null,
        'line_re' => null,
        'release_asset' => null,
    ],
];

// 公式のタグから版の数字だけを取り出す(2 系のタグは eccube-2.17.2-p1 の形)
function sh_tagver($ref)
{
    $p = isset(sh_map()['tag_prefix']) ? sh_map()['tag_prefix'] : '';
    return ($p !== '' && strpos((string) $ref, $p) === 0) ? substr($ref, strlen($p)) : (string) $ref;
}

// 店の作り(どの地図か、本体の一番上、公開の場所)を、窓口が自分の居場所のファイルの目印だけで決める。
// 上の階を本体とみなすのは、3 系の既定の置き方(窓口が html/ にあり、上の階に 3 系の目印がある)のときだけ
function sh_layout()
{
    static $l = null;
    if ($l === null) {
        $here = __DIR__;
        $up = dirname(__DIR__);
        $c = @file_get_contents($here . '/src/Eccube/Common/Constant.php');
        $v4 = is_string($c) && preg_match("/const\\s+VERSION\\s*=\\s*'4\\./", $c);
        if (is_file($here . '/src/Eccube/Kernel.php') || ($v4 && !is_file($here . '/src/Eccube/Application.php'))) {
            $l = ['map' => 'eccube4', 'root' => $here, 'pub' => ''];
        } elseif (is_file($here . '/src/Eccube/Application.php')) {
            $l = ['map' => 'eccube3', 'root' => $here, 'pub' => ''];
        } elseif (basename($here) === 'html' && is_file($up . '/src/Eccube/Application.php') && !is_file($up . '/src/Eccube/Kernel.php')) {
            $l = ['map' => 'eccube3', 'root' => $up, 'pub' => 'html'];
        } elseif (basename($here) === 'html' && is_file($up . '/data/class/SC_Initial.php')) {
            $l = ['map' => 'eccube2', 'root' => $up, 'pub' => 'html'];
        } elseif (is_file($here . '/data/class/SC_Initial.php')) {
            // 2 系で、data/ を公開の場所の中に置いた店(レンタルサーバーでよくある)。公式の配布物の html/ の中身が、窓口の場所にそのまま並ぶ
            $l = ['map' => 'eccube2', 'root' => $here, 'pub' => '', 'flat' => true];
        } else {
            // 見分けがつかないときは、どの地図にも当てはめない(読むだけにして、書く操作は断る)
            $l = ['map' => 'unknown', 'root' => $here, 'pub' => ''];
        }
    }
    return $l;
}

// 本体として読み書きしてよい一番上のフォルダか('*' はどのフォルダでも。守るファイルは別に断る)
function sh_code_top_ok($top)
{
    $tops = sh_map()['code_tops'];
    return in_array($top, $tops, true) || (in_array('*', $tops, true) && $top !== '.git');
}

// 店の中の場所を、公式の配布物の中の場所にする。data/ を公開の場所の中に置いた 2 系だけ、data/ と composer.* 以外は html/ の下
function sh_official_rel($rel)
{
    if (empty(sh_map()['flat']) || strpos($rel, 'data/') === 0 || $rel === 'composer.json' || $rel === 'composer.lock') {
        return $rel;
    }
    return 'html/' . $rel;
}

// 公開の場所の中の場所を、一番上からの相対にする
function sh_pub($rel = '')
{
    $p = sh_layout()['pub'];
    return $p === '' ? $rel : ($rel === '' ? $p : $p . '/' . $rel);
}

function sh_map()
{
    static $m = null;
    if ($m === null) {
        $name = sh_layout()['map'];
        $m = ['name' => $name] + SH_MAPS[$name];
        if (!empty(sh_layout()['flat'])) {
            // data/ を公開の場所の中に置いた 2 系: 公式の html/ の中身が一番上に並ぶので、一番上のどのフォルダも本体として扱う
            $m['code_tops'] = ['*'];
            $m['flat'] = true;
        }
    }
    return $m;
}

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
    return sh_layout()['root'];
}

function sh_var($sub = '')
{
    return sh_root() . '/' . sh_map()['var_dir'] . ($sub === '' ? '' : '/' . $sub);
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
// $allow_code は restore(退避から戻す)のときだけ true。write_file からは code: を受け付けない
function sh_resolve_target($target, $allow_code = false)
{
    if (!is_string($target)) {
        throw new ShError('bad_target', 'target がありません');
    }
    $map = [
        'root/.htaccess' => sh_pub('.htaccess'),
        'root/.user.ini' => sh_pub('.user.ini'),
        'lab/.htaccess' => sh_pub(SH_LAB_DIR . '/.htaccess'),
        'lab/.user.ini' => sh_pub(SH_LAB_DIR . '/.user.ini'),
    ];
    if (isset($map[$target])) {
        $rel = $map[$target];
        if (strpos($target, 'lab/') === 0) {
            sh_ensure_lab();
        }
    } elseif (strpos($target, 'code:') === 0) {
        if (!$allow_code) {
            throw new ShError('bad_target', 'code: は退避から戻すときと公式の修正の経路でだけ使えます');
        }
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
        if (sh_is_inside($drel, sh_map()['var_dir']) || sh_is_inside($drel, sh_pub(SH_LAB_DIR)) || $drel === '' || $drel === sh_pub()) {
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
    $dir = sh_root() . '/' . sh_pub(SH_LAB_DIR);
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
    // 確認ページは合言葉を地図の置き場から読む(3 系・2 系は公開の場所の外)
    $code = str_replace("dirname(__DIR__) . '/var/self-harden/lab-token'", var_export(sh_var('lab-token'), true), SH_PROBE);
    if (@file_get_contents($probe) !== $code) {
        sh_atomic_write($probe, $code);
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

// .htaccess の守りの行(アクセスを止める・PHP を動かさない・一覧を出さない など)。今の中身にあるものは、新しい中身から消させない
function sh_guard_line($l)
{
    return (bool) preg_match('/^(order\s|deny\s|allow\s|require\s|satisfy\s|php_flag\s+engine\s+off|php_value\s+engine\s+(off|0)|sethandler\s+none|removehandler\s|removetype\s|options\s+.*-(execcgi|indexes|includes)|<files|<filesmatch|<\/files|<directorymatch|<\/directorymatch|rewriterule\s.*\[[^\]]*\bf\b)/', $l);
}

function sh_check_guards($content, $existing)
{
    $new = array_flip(sh_content_lines($content));
    foreach (sh_content_lines($existing) as $l) {
        if (sh_guard_line($l) && !isset($new[$l])) {
            throw new ShError('removes_guard', '今の .htaccess にある守りの行を消す中身は書けません: ' . $l);
        }
    }
}

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
    if (empty($GLOBALS['sh_defer_prune'])) {
        sh_prune_backups();
    }
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

function sh_prune_backups($keep = SH_MAX_BACKUPS)
{
    $list = sh_backup_list();
    foreach (array_slice($list, max(SH_MAX_BACKUPS, (int) $keep)) as $m) {
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
    list($rel, $abs) = sh_resolve_target($meta['target'], true);
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
            $req = (isset($u['path']) ? $u['path'] : '/') . (isset($u['query']) ? '?' . $u['query'] : '');
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
    if (!preg_match('#^https?://[A-Za-z0-9.\-]+(:[0-9]+)?(/[A-Za-z0-9._~\-/]*)?$#', $base)) {
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
    return ['receiver_version' => SH_VERSION, 'php_version' => PHP_VERSION, 'time' => time(), 'map' => sh_map()['name'], 'flat' => !empty(sh_map()['flat'])];
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
        $app = ['map' => sh_map()['name'], 'eccube_version' => sh_eccube_version(), 'packages' => [], 'env' => null];
        $lock = json_decode((string) @file_get_contents(sh_root() . '/composer.lock'), true);
        if (is_array($lock)) {
            foreach (['packages', 'packages-dev'] as $k) {
                foreach (isset($lock[$k]) ? (array) $lock[$k] : [] as $p) {
                    if (isset($p['name'], $p['version'])) {
                        $app['packages'][] = ['name' => $p['name'], 'version' => $p['version'], 'dev' => $k === 'packages-dev',
                            'source' => isset($p['source']['url']) && is_string($p['source']['url']) ? $p['source']['url'] : null,
                            'reference' => isset($p['source']['reference']) && is_string($p['source']['reference']) ? $p['source']['reference'] : null];
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
            'receiver' => __FILE__, 'public' => sh_pub(), 'map' => sh_map()['name'], 'flat' => !empty(sh_map()['flat']),
            'lab' => $root . '/' . sh_pub(SH_LAB_DIR), 'lab_exists' => is_dir($root . '/' . sh_pub(SH_LAB_DIR)),
            'var' => sh_var(), 'var_writable' => is_writable(sh_var()),
            'approve_ready' => sh_approve_key() !== null, 'approve_dirs' => sh_approve_dirs(),
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
    $is_backup = (bool) preg_match('#^' . preg_quote(sh_map()['var_dir'], '#') . '/backups/[0-9]{14}-[0-9a-f]{8}\.bak$#', $relnorm);
    // 読めるのは、設定ファイルと本体・部品のファイル(公式と比べるため)。鍵・.env・var/ の中(退避を除く)は読めない
    $named = in_array($base, ['.htaccess', '.user.ini', 'composer.json', 'composer.lock', 'web.config', 'robots.txt'], true);
    $allowed = $is_backup
        || ($named && (!sh_is_protected($relnorm) || in_array($relnorm, ['composer.json', 'composer.lock'], true) || strpos($relnorm, sh_pub(SH_LAB_DIR) . '/') === 0))
        || (sh_code_top_ok($top) && !sh_is_protected($relnorm));
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
    // 行の範囲を渡されたら、その行だけ返す(カスタマイズの点検で、怪しい所の前後だけ読む)。1 回に 80 行まで
    if (isset($args['from']) || isset($args['to'])) {
        $lines = preg_split("/\r\n|\n|\r/", $c);
        $from = isset($args['from']) ? max(1, (int) $args['from']) : 1;
        $to = isset($args['to']) ? (int) $args['to'] : $from + 79;
        $to = max($from, min($to, $from + 79, count($lines)));
        return ['exists' => true, 'from' => $from, 'to' => $to, 'total_lines' => count($lines),
            'lines' => implode("\n", array_slice($lines, $from - 1, $to - $from + 1)), 'sha256' => hash('sha256', $c), 'size' => strlen($c), 'mtime' => filemtime($abs)];
    }
    return ['exists' => true, 'content' => $c, 'sha256' => hash('sha256', $c), 'size' => strlen($c), 'mtime' => filemtime($abs)];
}

function op_write_file(array $cfg, array $args)
{
    $target = isset($args['target']) ? $args['target'] : null;
    list($rel, $abs) = sh_resolve_target($target);
    // write_file で書けるのは .htaccess と .user.ini だけ(名前で確かめる。中身の決まりの種類もここで決まる)
    $base = basename($rel);
    if ($base === '.htaccess') {
        $kind = 'htaccess';
    } elseif ($base === '.user.ini') {
        $kind = 'userini';
    } else {
        throw new ShError('bad_target', 'write_file で書けるのは .htaccess と .user.ini だけです');
    }
    $content = isset($args['content']) ? $args['content'] : null;
    $existing = is_file($abs) ? (string) @file_get_contents($abs) : '';
    sh_check_content($kind, $content, $existing);
    if ($kind === 'htaccess' && strpos($rel, sh_pub(SH_LAB_DIR) . '/') !== 0) {
        sh_check_guards($content, $existing);
    }

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
    // 大文字と小文字を区別しないファイルシステム(Windows・macOS)でも破れないよう、小文字にそろえて比べる
    $rel = strtolower((string) $rel);
    $base = basename($rel);
    $low = function ($x) { return strtolower((string) $x); };
    return $rel === $low(sh_pub('self-harden.php')) || sh_is_inside($rel, 'var') || sh_is_inside($rel, $low(sh_map()['var_dir'])) || sh_is_inside($rel, $low(sh_pub(SH_LAB_DIR)))
        || preg_match('/^\.env|\.env$/', $base) || $rel === 'composer.json' || $rel === 'composer.lock' || sh_is_inside($rel, '.git')
        || in_array($rel, array_map($low, sh_map()['secrets']), true);
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
    if (!sh_code_top_ok($top) || sh_is_protected($r)) {
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
    if (empty(sh_map()['version_file'])) {
        return null;
    }
    $c = @file_get_contents(sh_root() . '/' . sh_map()['version_file']);
    return is_string($c) && preg_match(sh_map()['version_re'], $c, $m) ? $m[1] : null;
}

// どこから取ってくるかを、受け口が自分で決める。API が渡せるのは「どの版か(ref)」だけ
function sh_official_url($rel, $ref)
{
    if (!is_string($ref) || $ref === '') {
        throw new ShError('bad_ref', 'ref がありません');
    }
    $sha = (bool) preg_match('/^[0-9a-f]{40}$/', $ref);
    $vd = sh_map()['vendor_dir'];
    if (strpos($rel, $vd . '/') === 0) {
        $parts = explode('/', substr($rel, strlen($vd) + 1), 3);
        if (count($parts) < 3) {
            throw new ShError('bad_target', $vd . '/<vendor>/<package>/<file> の形にしてください');
        }
        $name = $parts[0] . '/' . $parts[1];
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
        return SH_OFFICIAL_RAW . $m[1] . '/' . $m[2] . '/' . $ref . '/' . $parts[2];
    }
    $installed = sh_eccube_version();
    if ($sha) {
        // コミットの番号なら、その時点の公式の Constant.php を受け口が自分で取り、版が今より古くないかを確かめる
        $c = sh_fetch_official(SH_OFFICIAL_RAW . sh_map()['repo'] . '/' . $ref . '/' . sh_map()['version_file']);
        if (!preg_match(sh_map()['version_re'], $c, $m) || $installed === null || version_compare($m[1], $installed, '<')) {
            throw new ShError('bad_ref', 'そのコミットの版(' . (isset($m[1]) ? $m[1] : '不明') . ')は今の版(' . $installed . ')より古いので使えません');
        }
        // そのコミットが公式のブランチかタグから辿れること(フォークにだけあるコミットを断る)
        sh_require_official_commit($ref, $installed);
    }
    if (!$sha) {
        if (!preg_match(sh_map()['tag_re'], $ref) || $installed === null || version_compare(sh_tagver($ref), $installed, '<')) {
            throw new ShError('bad_ref', 'EC-CUBE は今の版(' . $installed . ')以上のタグか、公式のコミットの番号(40 文字の 16 進数。短い形は不可)だけにできます');
        }
    }
    return SH_OFFICIAL_RAW . sh_map()['repo'] . '/' . $ref . '/' . sh_official_rel($rel);
}

// GitHub の compare(base...sha)の返事を固く読む。sha が base の祖先(behind)か同じ(identical)で、
// 共通の祖先がその sha そのものであるときだけ「base から辿れる」とする。形が違えば辿れないとする
function sh_compare_reaches($json, $sha)
{
    $d = json_decode((string) $json, true);
    if (!is_array($d) || !isset($d['status'], $d['merge_base_commit']['sha']) || !is_string($d['status']) || !is_string($d['merge_base_commit']['sha'])) {
        return false;
    }
    if ($d['status'] !== 'behind' && $d['status'] !== 'identical') {
        return false;
    }
    if (isset($d['ahead_by']) && (int) $d['ahead_by'] !== 0) {
        return false;
    }
    return hash_equals(strtolower($sha), strtolower($d['merge_base_commit']['sha']));
}

// コミットの番号(40 文字)が、公式のリポジトリの公式のブランチか、今の版以上の公式のタグから辿れることを確かめる。
// 確かめる先は地図とタグの一覧で受け口が決め、API からは選べない。辿れなければ断る(迷えば断る)
function sh_require_official_commit($sha, $installed)
{
    $map = sh_map();
    if (empty($map['repo']) || !preg_match('/^[0-9a-f]{40}$/', $sha)) {
        throw new ShError('bad_ref', '公式のコミットとして確かめられません');
    }
    $cache = sh_var('official-commits.json');
    $known = json_decode((string) @file_get_contents($cache), true);
    $known = is_array($known) ? $known : [];
    if (isset($known[$map['repo'] . '@' . $sha])) {
        return;
    }
    $line = ($installed !== null && preg_match($map['line_re'], $installed, $lm)) ? $lm[1] : null;
    $remember = function ($base) use ($cache, $known, $map, $sha) {
        $known[$map['repo'] . '@' . $sha] = $base;
        if (count($known) > 500) {
            $known = array_slice($known, -500, null, true);
        }
        @file_put_contents($cache, json_encode($known), LOCK_EX);
    };
    $reaches = function ($base) use ($map, $sha) {
        try {
            return sh_compare_reaches(sh_fetch_official(SH_GITHUB_API . $map['repo'] . '/compare/' . rawurlencode($base) . '...' . $sha), $sha);
        } catch (ShError $e) {
            return false;
        }
    };
    // まず地図に決めた公式のブランチ、だめなら今の版以上の公式のタグ(新しい順に 4 つまで)
    foreach ($map['official_branches'] as $br) {
        if (strpos($br, '%line%') !== false) {
            if ($line === null) {
                continue;
            }
            $br = str_replace('%line%', $line, $br);
        }
        if ($reaches($br)) {
            $remember($br);
            return;
        }
    }
    try {
        $tags = json_decode((string) sh_fetch_official(SH_GITHUB_API . $map['repo'] . '/tags?per_page=100'), true);
    } catch (ShError $e) {
        $tags = null;
    }
    $cands = [];
    foreach (is_array($tags) ? $tags : [] as $t) {
        if (isset($t['name']) && is_string($t['name']) && preg_match($map['tag_re'], $t['name'])
            && $installed !== null && version_compare(sh_tagver($t['name']), $installed, '>=')
            && ($line === null || strpos(sh_tagver($t['name']), $line . '.') === 0)) {
            $cands[] = $t['name'];
        }
    }
    usort($cands, function ($a, $b) { return version_compare(sh_tagver($b), sh_tagver($a)); });
    foreach (array_slice($cands, 0, 4) as $tag) {
        if ($reaches($tag)) {
            $remember($tag);
            return;
        }
    }
    throw new ShError('not_official_commit', 'そのコミットは、公式のブランチやタグから辿れません(公式のものと確かめられないので使いません)');
}

function sh_fetch_official($url)
{
    if ((strpos($url, SH_OFFICIAL_RAW) !== 0 && strpos($url, SH_GITHUB_API) !== 0) || !function_exists('curl_init')) {
        throw new ShError('no_official_source', '公式の場所から取れません');
    }
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['User-Agent: self-harden-receiver', 'Accept: application/vnd.github+json']);
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
    // 本体の修正は 30 件まで。部品(vendor/ の 1 つの部品)の修正は 100 件まで
    $one_pkg = $paths && preg_match('#^' . preg_quote(sh_map()['vendor_dir'], '#') . '/[^/]+/[^/]+/#', (string) $paths[0], $pm) && count(array_filter($paths, function ($p) use ($pm) { return strpos((string) $p, $pm[0]) === 0; })) === count($paths);
    if (!$paths || count($paths) > ($one_pkg ? 100 : 30) || count(array_unique($paths)) !== count($paths)) {
        throw new ShError('bad_request', 'paths は 1〜30 件(1 つの部品なら 100 件)の重ならないファイルにしてください');
    }
    if ($one_pkg) {
        @set_time_limit(90);
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
        if (microtime(true) - $t0 > ($one_pkg ? 40 : 14)) {
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
    return sh_apply_items($cfg, $args, $ref, $items, $dirs_to_make);
}

// 公式の中身を、全部を退避してから書き、店を開いて確かめる。だめなら全部戻す(apply_official_fix と apply_official_release で共通)
function sh_apply_items(array $cfg, array $args, $ref, array $items, array $dirs_to_make)
{
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
        // 何百ものファイルを書くときに途中で古い退避を消すと戻せなくなるので、消すのは最後にまとめて(この回の退避は全部残す)
        $GLOBALS['sh_defer_prune'] = true;
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
        $GLOBALS['sh_defer_prune'] = false;
        throw $e instanceof ShError ? $e : new ShError('io', '書いている途中で失敗したので、全部戻しました');
    }
    $GLOBALS['sh_defer_prune'] = false;
    sh_prune_backups(count($written) + 50);
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

// ---- 公式のリリースの配布物(tar.gz)から当てる ----
// 取りに行くのは GitHub の EC-CUBE 公式リポジトリのリリースの添付ファイルだけ。転送先も GitHub の配布用の場所だけ。
// 同じリリースのチェックサムで配布物を確かめ、さらに API が渡す expected_sha256 と 1 つずつ照らす。
// 部品(vendor/)や composer.lock の入れ替えも、composer を動かさずに公式の配布物どおりに置ける
const SH_RELEASE_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const SH_MAX_RELEASE = 104857600;

function sh_release_get($url, $dest)
{
    if (strpos($url, 'https://github.com/' . sh_map()['repo'] . '/releases/download/') !== 0 || !function_exists('curl_init')) {
        throw new ShError('no_official_source', '公式のリリースから取れません');
    }
    $fp = $dest !== null ? @fopen($dest, 'wb') : null;
    if ($dest !== null && !$fp) {
        throw new ShError('io', '配布物の置き場を作れませんでした');
    }
    $buf = '';
    $size = 0;
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => false, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
        CURLOPT_TIMEOUT => 90, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_WRITEFUNCTION => function ($ch, $data) use (&$buf, &$size, $fp) {
            $host = parse_url((string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL), PHP_URL_HOST);
            $size += strlen($data);
            if (!in_array($host, SH_RELEASE_HOSTS, true) || $size > SH_MAX_RELEASE) {
                return 0;
            }
            if ($fp) {
                return fwrite($fp, $data);
            }
            $buf .= $data;
            return strlen($data);
        }]);
    curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $host = parse_url((string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL), PHP_URL_HOST);
    curl_close($ch);
    if ($fp) {
        fclose($fp);
    }
    if ($status !== 200 || !in_array($host, SH_RELEASE_HOSTS, true) || $size > SH_MAX_RELEASE) {
        if ($dest !== null) {
            @unlink($dest);
        }
        throw new ShError('official_fetch_failed', '公式のリリースから取れませんでした(HTTP ' . $status . ')');
    }
    return $buf;
}

// 公式の配布物を取って、同じリリースのチェックサムで確かめる。確かめた配布物は var/self-harden/release/ に残して使い回す
function sh_release_tarball($ref, array $keep = [])
{
    $dir = sh_var('release');
    if (!is_dir($dir) && !@mkdir($dir, 0700)) {
        throw new ShError('io', '配布物の置き場を作れませんでした');
    }
    $base = 'https://github.com/' . sh_map()['repo'] . '/releases/download/' . $ref . '/' . sprintf(sh_map()['release_asset'], $ref);
    $path = $dir . '/eccube-' . $ref . '.tar.gz';
    $sum = strtolower(trim(strtok(sh_release_get($base . '.checksum.sha256', null), " \t\r\n")));
    if (!preg_match('/^[0-9a-f]{64}$/', $sum)) {
        throw new ShError('official_fetch_failed', '公式のチェックサムが読めませんでした');
    }
    if (!is_file($path) || !hash_equals($sum, (string) hash_file('sha256', $path))) {
        sh_release_get($base, $path . '.part');
        if (!hash_equals($sum, (string) hash_file('sha256', $path . '.part'))) {
            @unlink($path . '.part');
            throw new ShError('official_mismatch', '公式の配布物がチェックサムと合わないので、何も置いていません');
        }
        rename($path . '.part', $path);
    }
    // 古い版の配布物は 1 つだけ残す
    foreach ((array) glob($dir . '/eccube-*.tar.gz') as $old) {
        if ($old !== $path && !in_array(basename($old), array_map(function ($k) { return 'eccube-' . $k . '.tar.gz'; }, $keep), true)) {
            @unlink($old);
        }
    }
    return $path;
}

// tar.gz を先頭から少しずつ読み、欲しいファイルだけを取り出す(全体をメモリに載せない)。先頭のフォルダ名は外す
function sh_tar_pick($gz, array $want)
{
    $fp = @gzopen($gz, 'rb');
    if (!$fp) {
        throw new ShError('io', '配布物を開けませんでした');
    }
    $out = [];
    $long = null;
    $read = function ($n) use ($fp) {
        $b = '';
        while (strlen($b) < $n) {
            $c = gzread($fp, min(1048576, $n - strlen($b)));
            if ($c === false || $c === '') {
                break;
            }
            $b .= $c;
        }
        return $b;
    };
    $skip = function ($n) use ($fp) {
        while ($n > 0) {
            $c = gzread($fp, min(1048576, $n));
            if ($c === false || $c === '') {
                break;
            }
            $n -= strlen($c);
        }
    };
    while (count($out) < count($want)) {
        $h = $read(512);
        if (strlen($h) < 512 || trim($h, "\0") === '') {
            break;
        }
        $name = rtrim(substr($h, 0, 100), "\0");
        $prefix = rtrim(substr($h, 345, 155), "\0");
        $size = octdec(trim(substr($h, 124, 12), " \0"));
        $type = $h[156];
        $pad = (512 - $size % 512) % 512;
        if ($type === 'x' || $type === 'L') {
            $data = $read($size);
            $skip($pad);
            if ($type === 'L') {
                $long = rtrim($data, "\0");
            } elseif (preg_match('/\d+ path=([^\n]*)\n/', $data, $m)) {
                $long = $m[1];
            }
            continue;
        }
        $full = $long !== null ? $long : ($prefix !== '' ? $prefix . '/' . $name : $name);
        $long = null;
        $rel = preg_replace('#^[^/]+/#', '', $full);
        if (($type === '0' || $type === "\0") && isset($want[$rel])) {
            if ($size > SH_MAX_OFFICIAL) {
                throw new ShError('too_large', '大きすぎるファイルがあります: ' . $rel);
            }
            $out[$rel] = $read($size);
            $skip($pad);
        } else {
            $skip($size + $pad);
        }
    }
    gzclose($fp);
    return $out;
}

function op_apply_official_release(array $cfg, array $args)
{
    if (empty(sh_map()['release_asset'])) {
        throw new ShError('no_release', 'この版の系統には、公式のリリースの配布物がありません');
    }
    @set_time_limit(150);
    $ref = isset($args['ref']) ? $args['ref'] : null;
    $installed = sh_eccube_version();
    // 同じ系列(4.x.y の x.y が同じ)で、今の版より新しいリリースのタグだけ
    if (!is_string($ref) || !preg_match(sh_map()['tag_re'], $ref) || !preg_match(sh_map()['line_re'], sh_tagver($ref), $rm) || $installed === null
        || !preg_match(sh_map()['line_re'], $installed, $im) || $rm[1] !== $im[1] || version_compare(sh_tagver($ref), $installed, '<=')) {
        throw new ShError('bad_ref', 'リリースは、今の版(' . $installed . ')と同じ系列の新しいタグだけにできます');
    }
    $paths = isset($args['paths']) && is_array($args['paths']) ? array_values($args['paths']) : [];
    $expected = isset($args['expected_sha256']) && is_array($args['expected_sha256']) ? $args['expected_sha256'] : [];
    if (!$paths || count($paths) > 2000 || count(array_unique($paths)) !== count($paths)) {
        throw new ShError('bad_request', 'paths は 1〜2000 件の重ならないファイルにしてください');
    }
    // 1. 場所を確かめる(composer.json と composer.lock は、公式の配布物から置くときだけ書ける)
    $rels = [];
    $dirs_to_make = [];
    foreach ($paths as $p) {
        if ($p === 'composer.json' || $p === 'composer.lock') {
            $r = $p;
        } else {
            $missing = [];
            $r = sh_code_path($p, $missing);
            foreach ($missing as $d) {
                $dirs_to_make[$d] = true;
            }
        }
        if (!isset($expected[$p]) || !preg_match('/^[0-9a-f]{64}$/', (string) $expected[$p])) {
            throw new ShError('bad_request', 'expected_sha256 が無いファイルがあります: ' . $p);
        }
        $rels[$r] = $p;
    }
    // 2. 公式の配布物を取り、チェックサムで確かめ、欲しいファイルを取り出す
    $gz = sh_release_tarball($ref);
    // 配布物の中の名前で取り出す(data/ を公開の場所の中に置いた 2 系では、html/ の下の名前)
    $want = [];
    foreach ($rels as $r => $p) {
        $want[sh_official_rel($r)] = $r;
    }
    $got = sh_tar_pick($gz, $want);
    $items = [];
    $url = 'https://github.com/' . sh_map()['repo'] . '/releases/download/' . $ref . '/' . sprintf(sh_map()['release_asset'], $ref);
    foreach ($rels as $r => $p) {
        $o = sh_official_rel($r);
        if (!isset($got[$o])) {
            throw new ShError('official_fetch_failed', '公式の配布物に無いファイルがあるので、何も置いていません: ' . $o);
        }
        if (!hash_equals((string) $expected[$p], hash('sha256', $got[$o]))) {
            throw new ShError('official_mismatch', '公式の配布物の中身が expected_sha256 と違うので、何も置いていません: ' . $o);
        }
        $items[] = ['rel' => $r, 'url' => $url . '#' . $o, 'content' => $got[$o]];
    }
    return sh_apply_items($cfg, $args, $ref, $items, $dirs_to_make);
}

// アプリのキャッシュ(var/cache/prod)を消す。いったん別の名前に付け替えてから(すぐに効く)、時間の許す範囲で中身を消す
function op_clear_cache(array $cfg, array $args)
{
    $cache = sh_map()['cache'];
    if (!$cache) {
        throw new ShError('no_cache', 'この版の系統では、キャッシュを消す操作はありません');
    }
    $base = sh_root() . '/' . $cache['base'];
    if (is_link($base)) {
        throw new ShError('symlink', 'キャッシュの場所がシンボリックリンクです');
    }
    $moved = false;
    foreach ($cache['dirs'] as $d) {
        $prod = $base . '/' . $d;
        if (is_link($prod)) {
            throw new ShError('symlink', 'キャッシュの場所がシンボリックリンクです');
        }
        if (is_dir($prod)) {
            $old = $base . '/.sh-old-' . bin2hex(random_bytes(4));
            if (!@rename($prod, $old)) {
                throw new ShError('io', 'キャッシュを付け替えられませんでした');
            }
            $moved = true;
        }
    }
    // 付け替えた古いキャッシュを消す(前回の残りも)。時間を超えたら次の呼び出しで続きを消す
    $t0 = microtime(true);
    $left = 0;
    foreach ((array) @scandir($base) as $name) {
        if (strpos($name, '.sh-old-') !== 0 || is_link($base . '/' . $name)) {
            continue;
        }
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base . '/' . $name, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $f) {
            if (microtime(true) - $t0 > 10) {
                $left++;
                break 2;
            }
            if ($f->isLink() || $f->isFile()) {
                @unlink($f->getPathname());
            } elseif ($f->isDir()) {
                @rmdir($f->getPathname());
            }
        }
        @rmdir($base . '/' . $name);
    }
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }
    $res = ['moved' => $moved, 'finished' => $left === 0, 'verify' => null];
    if (isset($args['verify'])) {
        $res['verify'] = sh_verify($cfg, $args['verify']);
    }
    return $res;
}

// ---- 店主が承認した直し(カスタマイズしたファイルだけ) ----
// 窓口が書けるプログラムは、公式の中身か、店主がお店の管理画面で中身を見て承認したものだけ。
// 承認の印は、お店の中だけにある承認の鍵で、プラグイン(管理画面)が作る。API はこの鍵を持たないので、
// API の鍵が漏れても印は作れず、ここで断る。印には、直す先・書く中身のハッシュ・書く前のハッシュ・期限・お店の ID が入る

// 承認の鍵(var の中。先頭行は PHP の exit だけ、2 行目が JSON)。無ければ null
function sh_approve_key()
{
    $raw = @file_get_contents(sh_var(SH_APPROVE_KEY));
    if (!is_string($raw) || ($pos = strpos($raw, "\n")) === false) {
        return null;
    }
    $c = json_decode(substr($raw, $pos + 1), true);
    return is_array($c) && isset($c['key']) && is_string($c['key']) && preg_match('/^[0-9a-f]{64}$/', $c['key']) ? $c['key'] : null;
}

// 承認で直してよい場所(カスタマイズの置き場)。公式の本体・部品・設定・窓口自身は入らない
function sh_approve_dirs()
{
    switch (sh_map()['name']) {
        case 'eccube4': return ['app/Customize', 'app/template'];
        case 'eccube3': return ['app/template'];
        case 'eccube2': return [sh_pub('user_data'), 'data/Smarty/templates', 'data/class_extends'];
    }
    return [];
}

function sh_approval_string($sid, $pid, $path, $new, $before, $exp)
{
    return implode("\n", ['SH-APPROVE1', $sid, $pid, $path, $new, $before, (string) $exp]);
}

// 直す先を確かめる: 今あるふつうのファイル(新しく作らない)、カスタマイズの置き場の中、決めた種類だけ
function sh_approved_path($p)
{
    $abs = sh_safe_path($p, true);
    $rel = sh_rel($abs);
    if (!is_file($abs) || is_link($abs)) {
        throw new ShError('bad_target', '今あるふつうのファイルだけ直せます(新しいファイルは作りません)');
    }
    if (sh_is_protected($rel) || !preg_match(SH_APPROVE_EXT, $rel)) {
        throw new ShError('bad_target', 'そのファイルは承認の直しでも書けません: ' . $rel);
    }
    foreach (sh_approve_dirs() as $d) {
        if ($rel !== $d && sh_is_inside($rel, $d)) {
            return $rel;
        }
    }
    throw new ShError('bad_target', '承認の直しで書けるのは、カスタマイズの置き場(' . implode('・', sh_approve_dirs()) . ')の中だけです');
}

// Twig の組み立て済みのテンプレートを捨てる(本番の設定では書き換えを自分で読み直さないため)。プログラムの設定や経路の控えは残す
function sh_clear_twig_cache()
{
    $name = sh_map()['name'];
    $dirs = [];
    if ($name === 'eccube4') {
        foreach ((array) @glob(sh_root() . '/var/cache/*/twig', GLOB_ONLYDIR) as $d) {
            $dirs[] = $d;
        }
    } elseif ($name === 'eccube3') {
        $dirs[] = sh_root() . '/app/cache/twig';
    }
    foreach ($dirs as $d) {
        if (!is_string($d) || !is_dir($d) || is_link($d)) {
            continue;
        }
        $old = dirname($d) . '/.sh-old-twig-' . bin2hex(random_bytes(4));
        if (!@rename($d, $old)) {
            continue;
        }
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($old, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $f) {
            if ($f->isLink() || $f->isFile()) {
                @unlink($f->getPathname());
            } elseif ($f->isDir()) {
                @rmdir($f->getPathname());
            }
        }
        @rmdir($old);
    }
}

function op_apply_approved_fix(array $cfg, array $args)
{
    $key = sh_approve_key();
    if ($key === null) {
        throw new ShError('no_approval_key', 'このお店には承認の鍵がありません(プラグインを有効にし直してください)');
    }
    $a = isset($args['approval']) && is_array($args['approval']) ? $args['approval'] : null;
    if ($a === null) {
        throw new ShError('not_approved', '店主の承認の印がありません');
    }
    foreach (['proposal_id', 'path', 'sha256_new', 'sha256_before', 'expires_at', 'shop_id', 'sig'] as $k) {
        if (!isset($a[$k]) || !is_scalar($a[$k])) {
            throw new ShError('not_approved', '承認の印の形が正しくありません');
        }
    }
    $pid = (string) $a['proposal_id'];
    $path = (string) $a['path'];
    $new = (string) $a['sha256_new'];
    $before = (string) $a['sha256_before'];
    $exp = (int) $a['expires_at'];
    $sid = (string) $a['shop_id'];
    $sig = (string) $a['sig'];
    if (!preg_match('/^prp_[0-9a-f]{16}$/', $pid) || !preg_match('/^[0-9a-f]{64}$/', $new) || !preg_match('/^[0-9a-f]{64}$/', $before) || !preg_match('/^[0-9a-f]{64}$/', $sig)) {
        throw new ShError('not_approved', '承認の印の形が正しくありません');
    }
    if (!hash_equals((string) $cfg['shop_id'], $sid)) {
        throw new ShError('not_approved', '別のお店の承認です');
    }
    if (!hash_equals(hash_hmac('sha256', sh_approval_string($sid, $pid, $path, $new, $before, $exp), $key), $sig)) {
        throw new ShError('not_approved', '承認の印が合いません');
    }
    $now = time();
    if ($exp < $now || $exp > $now + SH_APPROVE_MAX_TTL) {
        throw new ShError('approval_expired', '承認の期限が切れています。管理画面でもう一度承認してください');
    }
    $content = isset($args['content']) ? $args['content'] : null;
    if (!is_string($content) || strlen($content) > SH_MAX_READ) {
        throw new ShError('bad_content', '書く中身がないか、大きすぎます');
    }
    if (!hash_equals($new, hash('sha256', $content))) {
        throw new ShError('not_approved', '承認された中身と、書こうとしている中身が違います');
    }
    $rel = sh_approved_path($path);
    $abs = sh_root() . '/' . $rel;
    if (sh_changed_span((string) file_get_contents($abs), $content) > SH_APPROVE_MAX_LINES) {
        throw new ShError('too_large_change', '変わる行が多すぎます(' . SH_APPROVE_MAX_LINES . ' 行まで)。承認の直しは小さな直しだけにしています');
    }
    if (preg_match('/\\.php$/i', $rel)) {
        // 動かさずに、PHP の書き方として正しいかだけ確かめる
        try {
            token_get_all($content, defined('TOKEN_PARSE') ? TOKEN_PARSE : 0);
        } catch (ParseError $e) {
            throw new ShError('php_syntax', 'PHP の書き方に誤りがあるので書きません(' . $e->getLine() . ' 行目)');
        }
    }
    $lock = @fopen(sh_var('lock'), 'c');
    if ($lock) {
        flock($lock, LOCK_EX);
    }
    // 1 回きり: 使った印を覚える(書く前に。失敗して戻しても、同じ印はもう使えない)
    $used_dir = sh_var('approvals');
    if (!is_dir($used_dir)) {
        @mkdir($used_dir, 0700, true);
    }
    $used = $used_dir . '/' . $sig;
    if (file_exists($used)) {
        throw new ShError('approval_used', 'この承認はもう使われています');
    }
    if (!hash_equals($before, (string) hash_file('sha256', $abs))) {
        throw new ShError('conflict', '承認したあとに、ファイルの中身が変わっています。もう一度見てから承認してください');
    }
    if (@file_put_contents($used, json_encode(['proposal_id' => $pid, 'path' => $rel, 'at' => $now])) === false) {
        throw new ShError('io', '承認の記録を書けません');
    }
    $meta = sh_backup($rel, $abs, 'code:' . $rel);
    sh_atomic_write($abs, $content);
    if (function_exists('opcache_invalidate')) {
        @opcache_invalidate($abs, true);
    }
    if (preg_match('/\\.twig$/i', $rel)) {
        sh_clear_twig_cache();
    }
    $res = ['proposal_id' => $pid, 'path' => $rel, 'backup_id' => $meta['backup_id'], 'sha256_before' => $before,
        'sha256_after' => $new, 'verify' => null, 'rolled_back' => false];
    // 書いたあとは必ず確かめる。確かめるページは窓口の決めたもの(地図)に、API が渡したものを足す。確かめが例外で終わっても戻す
    $paths = sh_map()['verify_paths'];
    if (isset($args['verify']['paths']) && is_array($args['verify']['paths'])) {
        foreach ($args['verify']['paths'] as $p) {
            if (is_string($p) && !in_array($p, $paths, true)) {
                $paths[] = $p;
            }
        }
    }
    $verify = ['paths' => array_slice($paths, 0, 6), 'timeout_sec' => 8];
    try {
        $res['verify'] = sh_verify($cfg, $verify);
        $failed = sh_verify_failed($res['verify']);
    } catch (Throwable $e) {
        $res['verify'] = ['error' => $e instanceof ShError ? $e->code_str : 'internal'];
        $failed = true;
    }
    if ($failed) {
        sh_atomic_write($abs, (string) file_get_contents(sh_var('backups/' . $meta['backup_id'] . '.bak')));
        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($abs, true);
        }
        if (preg_match('/\\.twig$/i', $rel)) {
            sh_clear_twig_cache();
        }
        $res['rolled_back'] = true;
        try {
            $res['rollback_verify'] = sh_verify($cfg, $verify);
        } catch (Throwable $e) {
            $res['rollback_verify'] = null;
        }
    }
    return $res;
}

// ---- 店主の承認で、同じ系列の公式の修正版へ上げる(データベースの作り変えを含む) ----
// 印は「承認して直す」と同じ鍵で、店主がお店の管理画面で作る。中身は公式の配布物(窓口がチェックサムで確かめたもの)だけ。
// 段ごとに呼ばれ、どこまで進んだかを var の中に残す。失敗したら、控えからファイルとデータベースを戻す。
// データベースの作り変え(スキーマの差とマイグレーション)だけは EC-CUBE 自身を読み込む必要があるので、窓口は include せず、
// プラグインが置く別の入口(self-harden-upgrade.php)に 1 回きりの合図を渡して頼む。
const SH_UPGRADE_REPLACED = ['app/config/eccube/', 'app/DoctrineMigrations/', 'bin/', 'src/', 'html/'];
const SH_UPGRADE_SKIP = ['var/', 'app/Plugin/', 'app/Customize/', 'app/proxy/', 'app/template/', 'html/upload/', 'html/user_data/', 'html/plugin/'];
const SH_UPGRADE_BATCH = 1500;
const SH_UPGRADE_MAX_DB = 524288000;
const SH_UPGRADE_RUNNER = 'self-harden-upgrade.php';

// 印に入るもの: お店・提案・今の版・上げ先の版・期限・提案のときのファイルの指紋・残す部品(新しい修正版のため上書きしない部品)
function sh_upgrade_string($sid, $pid, $from, $to, $exp, $fp, $keep)
{
    return implode("\n", ['SH-UPGRADE2', $sid, $pid, $from, $to, (string) $exp, $fp, $keep]);
}

// 版上げが触る場所の指紋: vendor/ の全部のファイルと、置き換える本体のファイル(API が渡す一覧)の「場所<TAB>sha256」を場所の順に並べたもののハッシュ。
// API が提案のときに hash_tree で取った一覧から同じ形で作る。調べたあとにファイルが変わっていれば合わなくなる
function sh_upgrade_fingerprint(array $paths)
{
    $all = [];
    $vd = sh_root() . '/vendor';
    if (is_dir($vd) && !is_link($vd)) {
        sh_collect($vd, 'vendor', true, $all);
    }
    foreach ($paths as $p) {
        if (!is_string($p) || $p === '' || strlen($p) > 300 || $p[0] === '/' || strpos($p, '..') !== false || strpos($p, "\0") !== false || strpos($p, 'vendor/') === 0) {
            throw new ShError('bad_args', '指紋の場所の形が正しくありません');
        }
        $all[] = $p;
    }
    $all = array_values(array_unique($all));
    sort($all, SORT_STRING);
    $ctx = hash_init('sha256');
    foreach ($all as $p) {
        $abs = sh_root() . '/' . $p;
        $sha = is_link($abs) ? 'link' : (is_file($abs) ? (string) @hash_file('sha256', $abs) : '-');
        hash_update($ctx, $p . "\t" . $sha . "\n");
    }
    return hash_final($ctx);
}

// 残す部品の一覧の形: "vendor/package@版" をカンマでつなぐ(名前の順)。空でもよい
function sh_upgrade_keep_list($keep)
{
    if ($keep === '') {
        return [];
    }
    $out = [];
    foreach (explode(',', $keep) as $k) {
        if (!preg_match('#^([a-z0-9][a-z0-9_.\-]*/[a-z0-9][a-z0-9_.\-]*)@(v?[0-9]+\.[0-9]+\.[0-9]+)$#', $k, $m) || strpos($m[1], '..') !== false) {
            throw new ShError('not_approved', '承認の印の形が正しくありません');
        }
        $out[$m[1]] = $m[2];
    }
    return $out;
}

// テストのときだけ、決めた段でわざと失敗させる(本番の環境変数には無い)
function sh_upgrade_test_fail($step)
{
    $f = getenv('SELF_HARDEN_TEST_FAIL_AT');
    if (is_string($f) && $f !== '' && $f === $step) {
        throw new ShError('test_fail', 'テストのために、この段(' . $step . ')でわざと失敗させました');
    }
}

function sh_upgrade_dir($pid)
{
    return sh_var('upgrade/' . $pid);
}

function sh_upgrade_state($pid)
{
    $raw = @file_get_contents(sh_upgrade_dir($pid) . '/state.json');
    $s = is_string($raw) ? json_decode($raw, true) : null;
    return is_array($s) ? $s : null;
}

function sh_upgrade_save(array $st)
{
    $st['updated_at'] = time();
    sh_atomic_write(sh_upgrade_dir($st['pid']) . '/state.json', json_encode($st, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

function sh_upgrade_log(array &$st, $text)
{
    $st['log'][] = ['at' => time(), 'step' => $st['step'], 'text' => $text];
    $st['log'] = array_slice($st['log'], -60);
}

// tar.gz を先頭から読み、ふつうのファイルごとに $fn(相対の名前, 中身) を呼ぶ。先頭のフォルダ名は外す。リンクや .. は無視する
function sh_tar_each($gz, callable $fn, $max_file = 33554432)
{
    $fp = @gzopen($gz, 'rb');
    if (!$fp) {
        throw new ShError('io', '配布物を開けませんでした');
    }
    $read = function ($n) use ($fp) {
        $b = '';
        while (strlen($b) < $n) {
            $c = gzread($fp, min(1048576, $n - strlen($b)));
            if ($c === false || $c === '') {
                break;
            }
            $b .= $c;
        }
        return $b;
    };
    $long = null;
    while (true) {
        $h = $read(512);
        if (strlen($h) < 512 || trim($h, "\0") === '') {
            break;
        }
        $name = rtrim(substr($h, 0, 100), "\0");
        $prefix = rtrim(substr($h, 345, 155), "\0");
        $size = octdec(trim(substr($h, 124, 12), " \0"));
        $type = $h[156];
        $pad = (512 - $size % 512) % 512;
        if ($type === 'x' || $type === 'L') {
            $data = $read($size);
            $read($pad);
            if ($type === 'L') {
                $long = rtrim($data, "\0");
            } elseif (preg_match('/\d+ path=([^\n]*)\n/', $data, $m)) {
                $long = $m[1];
            }
            continue;
        }
        $full = $long !== null ? $long : ($prefix !== '' ? $prefix . '/' . $name : $name);
        $long = null;
        $rel = preg_replace('#^[^/]+/#', '', $full);
        $ok = ($type === '0' || $type === "\0") && $rel !== '' && strpos($rel, '\\') === false && strpos($rel, "\0") === false
            && !in_array('..', explode('/', $rel), true) && $rel[0] !== '/';
        if ($ok && $size <= $max_file) {
            $fn($rel, $read($size));
            $read($pad);
        } else {
            $n = $size + $pad;
            while ($n > 0) {
                $c = gzread($fp, min(1048576, $n));
                if ($c === false || $c === '') {
                    break;
                }
                $n -= strlen($c);
            }
        }
    }
    gzclose($fp);
}

function sh_upgrade_skip($rel)
{
    foreach (SH_UPGRADE_SKIP as $d) {
        if (strpos($rel, $d) === 0) {
            return true;
        }
    }
    return $rel === '.env' || $rel === SH_UPGRADE_RUNNER || $rel === 'self-harden.php' || strpos($rel, '.git/') === 0 || strpos($rel, 'self-harden-lab/') === 0;
}

function sh_upgrade_replaced($rel)
{
    foreach (SH_UPGRADE_REPLACED as $d) {
        if (strpos($rel, $d) === 0) {
            return true;
        }
    }
    return false;
}

// .env の値(窓口の中だけで使う。API には返さない)
function sh_env_value($key)
{
    $v = getenv($key);
    if (is_string($v) && $v !== '') {
        return $v;
    }
    foreach (preg_split("/\r\n|\n/", (string) @file_get_contents(sh_root() . '/.env')) as $line) {
        if (preg_match('/^\s*(?:export\s+)?' . preg_quote($key, '/') . '\s*=\s*(.*)$/', $line, $m)) {
            return trim(trim($m[1]), "\"'");
        }
    }
    return null;
}

// データベースの種類と場所。対応は SQLite と MySQL(MariaDB)。ほかは断る
function sh_upgrade_db()
{
    $url = sh_env_value('DATABASE_URL');
    if (!is_string($url) || $url === '') {
        throw new ShError('db_unknown', 'データベースの設定が読めません');
    }
    $url = str_replace('%kernel.project_dir%', sh_root(), $url);
    if (strpos($url, 'sqlite:') === 0) {
        $path = '/' . ltrim((string) preg_replace('#^sqlite:#', '', $url), '/');
        if ($path === '' || $path[0] !== '/' || !is_file($path)) {
            throw new ShError('db_unknown', 'SQLite のファイルが見つかりません');
        }
        return ['kind' => 'sqlite', 'path' => $path];
    }
    $u = parse_url($url);
    if (is_array($u) && isset($u['scheme']) && in_array($u['scheme'], ['mysql', 'mysql2', 'pdo-mysql', 'mariadb'], true)) {
        return ['kind' => 'mysql', 'host' => isset($u['host']) ? $u['host'] : 'localhost', 'port' => isset($u['port']) ? (int) $u['port'] : 3306,
            'user' => isset($u['user']) ? urldecode($u['user']) : '', 'pass' => isset($u['pass']) ? urldecode($u['pass']) : '',
            'name' => isset($u['path']) ? ltrim(urldecode($u['path']), '/') : ''];
    }
    throw new ShError('db_unsupported', 'このデータベースの種類(' . (is_array($u) && isset($u['scheme']) ? $u['scheme'] : '?') . ')は、まだ Shisa が控えを取れないので、版上げはしません');
}

function sh_upgrade_pdo(array $db)
{
    $pdo = new PDO('mysql:host=' . $db['host'] . ';port=' . $db['port'] . ';dbname=' . $db['name'] . ';charset=utf8mb4', $db['user'], $db['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    return $pdo;
}

function sh_rmtree($dir)
{
    if (!is_dir($dir) || is_link($dir)) {
        return;
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) {
        if ($f->isLink() || $f->isFile()) {
            @unlink($f->getPathname());
        } elseif ($f->isDir()) {
            @rmdir($f->getPathname());
        }
    }
    @rmdir($dir);
}

function sh_upgrade_copy($src, $dst)
{
    $d = dirname($dst);
    if (!is_dir($d) && !@mkdir($d, 0755, true)) {
        throw new ShError('io', 'フォルダを作れませんでした: ' . sh_rel($d));
    }
    if (is_link($dst)) {
        throw new ShError('io', 'シンボリックリンクには書きません: ' . sh_rel($dst));
    }
    $tmp = $d . '/.sh-tmp-' . bin2hex(random_bytes(6));
    if (!@copy($src, $tmp)) {
        @unlink($tmp);
        throw new ShError('io', '書けませんでした: ' . sh_rel($dst));
    }
    @chmod($tmp, 0644);
    if (!@rename($tmp, $dst)) {
        @unlink($tmp);
        throw new ShError('io', '置き換えられませんでした: ' . sh_rel($dst));
    }
}

function sh_upgrade_cache_clear()
{
    $c = sh_root() . '/var/cache/prod';
    if (is_dir($c) && !is_link($c)) {
        $old = sh_root() . '/var/cache/.sh-old-' . bin2hex(random_bytes(4));
        if (@rename($c, $old)) {
            sh_rmtree($old);
        }
    }
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }
}

function sh_upgrade_maintenance($on)
{
    $f = sh_root() . '/.maintenance';
    if ($on) {
        if (!file_exists($f)) {
            @file_put_contents($f, '');
        }
    } else {
        @unlink($f);
    }
}

// お店を開いて確かめる。キャッシュを消した直後は最初の 1 回が遅いので、先に 1 回開いて温める
function sh_upgrade_verify(array $cfg)
{
    $base = isset($cfg['self_base']) ? (string) $cfg['self_base'] : '';
    if (!preg_match('#^https?://[A-Za-z0-9.\-]+(:[0-9]+)?(/[A-Za-z0-9._~\-/]*)?$#', $base)) {
        throw new ShError('bad_config', 'self_base が正しくありません');
    }
    // キャッシュを消した直後は、最初の何回かが 500 になることがある(組み立て中)。開くまで最大 90 秒待ってから確かめる
    $t0 = microtime(true);
    do {
        $w = sh_fetch_status($base, '/', 60);
        if ($w['status'] > 0 && $w['status'] < 500) {
            break;
        }
        sleep(2);
    } while (microtime(true) - $t0 < 90);
    $out = [];
    foreach (array_merge(sh_map()['verify_paths'], ['/self-harden.php']) as $p) {
        for ($k = 0; $k < 3; $k++) {
            $r = sh_fetch_status($base, $p, 30);
            if ($r['status'] > 0 && $r['status'] < 500) {
                break;
            }
            sleep(2);
        }
        $out[] = $r;
    }
    return $out;
}

// 窓口から、プラグインが置いた入口(self-harden-upgrade.php)に、データベースの作り変えを頼む。合図は 1 回きり
function sh_upgrade_call_runner(array $cfg, array $st)
{
    $dir = sh_upgrade_dir($st['pid']);
    $token = bin2hex(random_bytes(32));
    if (@file_put_contents($dir . '/runner-token', $token) === false) {
        throw new ShError('io', '合図を書けませんでした');
    }
    @chmod($dir . '/runner-token', 0600);
    $base = rtrim((string) $cfg['self_base'], '/');
    $url = $base . '/' . sh_pub(SH_UPGRADE_RUNNER);
    $body = json_encode(['job' => $st['pid'], 'token' => $token]);
    $res = null;
    $status = 0;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_TIMEOUT => 170,
            CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_HTTPHEADER => ['Content-Type: application/json'], CURLOPT_FOLLOWLOCATION => false]);
        $res = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
    }
    @unlink($dir . '/runner-token');
    $j = is_string($res) ? json_decode($res, true) : null;
    if (!is_array($j)) {
        throw new ShError('runner_failed', 'データベースの作り変えの入口から返事がありません(HTTP ' . $status . ')');
    }
    return $j;
}

function op_upgrade(array $cfg, array $args)
{
    @set_time_limit(170);
    if (sh_map()['name'] !== 'eccube4') {
        throw new ShError('not_supported', '承認での版上げは、今は EC-CUBE 4 系だけです');
    }
    $key = sh_approve_key();
    if ($key === null) {
        throw new ShError('no_approval_key', 'このお店には承認の鍵がありません(プラグインを有効にし直してください)');
    }
    $a = isset($args['approval']) && is_array($args['approval']) ? $args['approval'] : null;
    if ($a === null) {
        throw new ShError('not_approved', '店主の承認の印がありません');
    }
    foreach (['proposal_id', 'from', 'to', 'expires_at', 'shop_id', 'sig', 'fp', 'keep'] as $k) {
        if (!isset($a[$k]) || !is_scalar($a[$k])) {
            throw new ShError('not_approved', '承認の印の形が正しくありません');
        }
    }
    $fp = (string) $a['fp'];
    $keepStr = (string) $a['keep'];
    if (!preg_match('/^[0-9a-f]{64}$/', $fp) || strlen($keepStr) > 4000) {
        throw new ShError('not_approved', '承認の印の形が正しくありません');
    }
    $keep = sh_upgrade_keep_list($keepStr);
    $fpPaths = isset($args['fp_paths']) && is_array($args['fp_paths']) ? array_values($args['fp_paths']) : [];
    if (count($fpPaths) > 5000) {
        throw new ShError('bad_args', '指紋の場所が多すぎます');
    }
    $pid = (string) $a['proposal_id'];
    $from = (string) $a['from'];
    $to = (string) $a['to'];
    $exp = (int) $a['expires_at'];
    $sid = (string) $a['shop_id'];
    $sig = (string) $a['sig'];
    if (!preg_match('/^prp_[0-9a-f]{16}$/', $pid) || !preg_match('/^[0-9a-f]{64}$/', $sig) || !preg_match('/^[0-9][0-9A-Za-z.\-]{0,30}$/', $from)
        || !preg_match(sh_map()['tag_re'], $to)) {
        throw new ShError('not_approved', '承認の印の形が正しくありません');
    }
    if (!hash_equals((string) $cfg['shop_id'], $sid)) {
        throw new ShError('not_approved', '別のお店の承認です');
    }
    if (!hash_equals(hash_hmac('sha256', sh_upgrade_string($sid, $pid, $from, $to, $exp, $fp, $keepStr), $key), $sig)) {
        throw new ShError('not_approved', '承認の印が合いません');
    }
    $lock = @fopen(sh_var('lock-upgrade'), 'c');
    if ($lock) {
        flock($lock, LOCK_EX);
    }
    $st = sh_upgrade_state($pid);
    if ($st === null) {
        // 始める: 期限・1 回きり・今の版・上げ先を確かめる
        $now = time();
        if ($exp < $now || $exp > $now + SH_APPROVE_MAX_TTL) {
            throw new ShError('approval_expired', '承認の期限が切れています。管理画面でもう一度承認してください');
        }
        $installed = sh_eccube_version();
        if ($installed === null || $installed !== $from) {
            throw new ShError('conflict', '承認したときの版(' . $from . ')と、今の版(' . $installed . ')が違います');
        }
        if (!preg_match(sh_map()['line_re'], sh_tagver($to), $rm) || !preg_match(sh_map()['line_re'], $installed, $im) || $rm[1] !== $im[1]
            || version_compare(sh_tagver($to), $installed, '<=')) {
            throw new ShError('bad_ref', '上げ先は、今の版と同じ系列の新しい公式の版だけです');
        }
        $used_dir = sh_var('approvals');
        if (!is_dir($used_dir)) {
            @mkdir($used_dir, 0700, true);
        }
        if (file_exists($used_dir . '/' . $sig)) {
            throw new ShError('approval_used', 'この承認はもう使われています');
        }
        // 調べたとき(提案のとき)から、版上げが触る場所のファイルが変わっていれば、何も書かずに止める(調べ直して提案し直す)
        if (!hash_equals($fp, sh_upgrade_fingerprint($fpPaths))) {
            throw new ShError('stale', '調べたときから、お店のファイルが変わっています。もう一度調べてから、提案し直します');
        }
        @file_put_contents($used_dir . '/' . $sig, json_encode(['proposal_id' => $pid, 'upgrade' => [$from, $to], 'at' => $now]));
        $dir = sh_upgrade_dir($pid);
        if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
            throw new ShError('io', '作業の置き場を作れませんでした');
        }
        $st = ['pid' => $pid, 'sig' => $sig, 'from' => $from, 'to' => $to, 'fp' => $fp, 'fp_paths' => $fpPaths, 'keep' => $keep, 'status' => 'running', 'step' => 'fetch', 'i' => 0,
            'started_at' => $now, 'log' => [], 'maintenance_before' => file_exists(sh_root() . '/.maintenance'), 'db' => null, 'error' => null];
        sh_upgrade_log($st, sh_eccube_version() . ' から ' . $to . ' へ上げます(店主の承認あり)');
        sh_upgrade_save($st);
        // 始めたことだけを、すぐ返す(管理画面を待たせない)。段は次の呼び出しから進める
        return sh_upgrade_out($st);
    } elseif (!hash_equals((string) $st['sig'], $sig)) {
        throw new ShError('not_approved', 'この作業の承認と、印が違います');
    }
    if (in_array($st['status'], ['done', 'rolled_back', 'stuck', 'refused'], true)) {
        return sh_upgrade_out($st);
    }
    $t0 = microtime(true);
    try {
        // 1 回の呼び出しで、時間の許す範囲だけ段を進める
        do {
            sh_upgrade_step($cfg, $st);
            sh_upgrade_save($st);
        } while ($st['status'] === 'running' && microtime(true) - $t0 < 15 && !in_array($st['step'], ['db', 'verify'], true));
    } catch (Throwable $e) {
        $msg = $e instanceof ShError ? $e->getMessage() : '窓口の中で失敗しました';
        $st['error'] = ['step' => $st['step'], 'code' => $e instanceof ShError ? $e->code_str : 'internal', 'detail' => $msg];
        sh_upgrade_log($st, '失敗: ' . $msg);
        if ($st['status'] === 'running' && in_array($st['step'], ['fetch', 'stage', 'fetch_from', 'plan'], true)) {
            // まだお店に何も書いていない段なら、断って終わる
            $st['status'] = 'refused';
            sh_upgrade_log($st, 'お店には何も書いていないので、このまま止めます');
        } elseif ($st['status'] === 'running') {
            $st['status'] = 'rolling_back';
            $st['step'] = 'rb_maint_on';
            $st['i'] = 0;
            sh_upgrade_log($st, '控えから元に戻します');
        } else {
            $st['status'] = 'stuck';
            sh_upgrade_log($st, '元に戻す途中で失敗しました。メンテナンスのまま止めています');
        }
        sh_upgrade_save($st);
    }
    return sh_upgrade_out($st);
}

function sh_upgrade_out(array $st)
{
    $o = $st;
    unset($o['sig'], $o['db'], $o['fp_paths']);
    $o['plan'] = isset($st['plan_counts']) ? $st['plan_counts'] : null;
    return $o;
}

function sh_upgrade_step(array $cfg, array &$st)
{
    $dir = sh_upgrade_dir($st['pid']);
    $stage = $dir . '/stage';
    switch ($st['step']) {
        case 'fetch':
            sh_upgrade_test_fail('fetch');
            sh_release_tarball($st['to'], [$st['from']]);
            sh_upgrade_log($st, '公式の配布物(' . $st['to'] . ')を取り、チェックサムで確かめました');
            $st['step'] = 'stage';
            return;
        case 'stage':
            // 上げ先の配布物を、作業の置き場に広げる(お店にはまだ書かない)
            sh_rmtree($stage);
            @mkdir($stage, 0700, true);
            $gz = sh_var('release/eccube-' . $st['to'] . '.tar.gz');
            $n = 0;
            sh_tar_each($gz, function ($rel, $data) use ($stage, &$n) {
                $d = dirname($stage . '/' . $rel);
                if (!is_dir($d)) {
                    @mkdir($d, 0700, true);
                }
                file_put_contents($stage . '/' . $rel, $data);
                $n++;
            });
            // データベースの作り変えで、お店のプラグインとカスタマイズも見えるように、お店のものを指す
            foreach (['app/Plugin', 'app/Customize', 'app/proxy'] as $d) {
                if (is_dir(sh_root() . '/' . $d)) {
                    sh_rmtree($stage . '/' . $d);
                    @symlink(sh_root() . '/' . $d, $stage . '/' . $d);
                }
            }
            $st['stage_files'] = $n;
            sh_upgrade_log($st, '上げ先の版を作業の置き場に広げました(' . $n . ' ファイル)');
            $st['step'] = 'fetch_from';
            return;
        case 'fetch_from':
            sh_release_tarball($st['from'], [$st['to']]);
            sh_upgrade_log($st, '今の版(' . $st['from'] . ')の公式の配布物も取りました(カスタマイズを見分けるため)');
            $st['step'] = 'plan';
            return;
        case 'plan':
            sh_upgrade_test_fail('plan');
            // メンテナンスに入る直前にもう一度: 配布物を取っているあいだに、別の作業がファイルを変えていないか
            if (!hash_equals((string) $st['fp'], sh_upgrade_fingerprint(isset($st['fp_paths']) ? (array) $st['fp_paths'] : []))) {
                throw new ShError('stale', '調べたときから、お店のファイルが変わっています。もう一度調べてから、提案し直します');
            }
            $keep = isset($st['keep']) && is_array($st['keep']) ? $st['keep'] : [];
            $kept = function ($rel) use ($keep) {
                foreach ($keep as $name => $v) {
                    if (strpos($rel, 'vendor/' . $name . '/') === 0) {
                        return true;
                    }
                }
                return false;
            };
            $from = [];
            sh_tar_each(sh_var('release/eccube-' . $st['from'] . '.tar.gz'), function ($rel, $data) use (&$from) {
                $from[$rel] = hash('sha256', $data);
            });
            $write = [];
            $delete = [];
            $blocked = [];
            $to = [];
            $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($stage, FilesystemIterator::SKIP_DOTS));
            foreach ($it as $f) {
                if ($f->isLink() || !$f->isFile()) {
                    continue;
                }
                $rel = substr($f->getPathname(), strlen($stage) + 1);
                if (sh_upgrade_skip($rel)) {
                    continue;
                }
                $to[$rel] = hash_file('sha256', $f->getPathname());
            }
            foreach ($to as $rel => $tsha) {
                $fsha = isset($from[$rel]) ? $from[$rel] : null;
                if ($fsha === $tsha) {
                    continue; // 版のあいだで変わっていないファイルは、お店のものをそのまま
                }
                if ($kept($rel)) {
                    continue; // 点検で当てた部品の修正版のほうが新しい部品は、上書きしない(新しいほうを残す)
                }
                $abs = sh_root() . '/' . $rel;
                $cur = is_file($abs) && !is_link($abs) ? hash_file('sha256', $abs) : null;
                if ($cur === $tsha) {
                    continue;
                }
                // 部品(vendor/)は、公式の手順どおり上げ先の版で上書きする(当てた修正版のほうが新しい部品は、上で外している)
                if ($cur === null || $cur === $fsha || strpos($rel, 'vendor/') === 0) {
                    $write[] = $rel;
                } else {
                    $blocked[] = $rel;
                }
            }
            foreach ($from as $rel => $fsha) {
                if (isset($to[$rel]) || sh_upgrade_skip($rel) || !sh_upgrade_replaced($rel) || $kept($rel)) {
                    continue;
                }
                $abs = sh_root() . '/' . $rel;
                if (is_file($abs) && !is_link($abs) && hash_file('sha256', $abs) === $fsha) {
                    $delete[] = $rel;
                }
            }
            $st['plan_counts'] = ['write' => count($write), 'delete' => count($delete), 'blocked' => count($blocked)];
            if ($blocked) {
                $st['blocked'] = array_slice($blocked, 0, 50);
                throw new ShError('customized_files', 'カスタマイズされたファイルを上書きしてしまうので、版上げはしません(' . count($blocked) . ' 件。例: ' . implode('、', array_slice($blocked, 0, 5)) . ')');
            }
            if (is_dir(sh_root() . '/app/proxy/entity') && count((array) glob(sh_root() . '/app/proxy/entity/*.php')) > 0) {
                throw new ShError('needs_proxies', 'カスタマイズでデータベースの作りを足している(プロキシがある)お店は、まだ承認での版上げをしません');
            }
            $db = sh_upgrade_db();
            $st['db_kind'] = $db['kind'];
            file_put_contents($dir . '/plan.json', json_encode(['write' => $write, 'delete' => $delete]));
            sh_upgrade_log($st, '置き換えるファイル ' . count($write) . ' 件、消す古いファイル ' . count($delete) . ' 件。カスタマイズの上書きはありません');
            if ($keep) {
                $names = [];
                foreach ($keep as $name => $v) {
                    $names[] = $name . ' ' . $v;
                }
                sh_upgrade_log($st, '点検で当てた新しい修正版のまま残す部品: ' . implode('、', $names));
            }
            $st['step'] = 'maint_on';
            return;
        case 'maint_on':
            sh_upgrade_maintenance(true);
            sh_upgrade_log($st, 'メンテナンスに入れました(管理画面は使えます)');
            $st['step'] = 'db_backup';
            return;
        case 'db_backup':
            sh_upgrade_test_fail('db_backup');
            $db = sh_upgrade_db();
            if ($db['kind'] === 'sqlite') {
                if (filesize($db['path']) > SH_UPGRADE_MAX_DB) {
                    throw new ShError('db_too_large', 'データベースが大きすぎるので、控えを取れません');
                }
                if (!@copy($db['path'], $dir . '/db.sqlite')) {
                    throw new ShError('io', 'データベースの控えを取れませんでした');
                }
                $st['db_backup'] = ['kind' => 'sqlite', 'bytes' => filesize($dir . '/db.sqlite')];
            } else {
                $pdo = sh_upgrade_pdo($db);
                $size = (int) $pdo->query('SELECT COALESCE(SUM(data_length),0) FROM information_schema.tables WHERE table_schema = DATABASE()')->fetchColumn();
                if ($size > SH_UPGRADE_MAX_DB) {
                    throw new ShError('db_too_large', 'データベースが大きすぎるので、控えを取れません');
                }
                @mkdir($dir . '/db', 0700, true);
                $tables = [];
                foreach ($pdo->query('SHOW FULL TABLES WHERE Table_type = \'BASE TABLE\'')->fetchAll(PDO::FETCH_NUM) as $row) {
                    $t = $row[0];
                    $ddl = $pdo->query('SHOW CREATE TABLE `' . str_replace('`', '``', $t) . '`')->fetch(PDO::FETCH_NUM)[1];
                    $fp = fopen($dir . '/db/' . md5($t) . '.jsonl', 'w');
                    $q = $pdo->query('SELECT * FROM `' . str_replace('`', '``', $t) . '`');
                    $rows = 0;
                    while ($r = $q->fetch(PDO::FETCH_ASSOC)) {
                        fwrite($fp, json_encode($r, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
                        $rows++;
                    }
                    fclose($fp);
                    $tables[$t] = ['ddl' => $ddl, 'rows' => $rows];
                }
                file_put_contents($dir . '/db/tables.json', json_encode($tables));
                $st['db_backup'] = ['kind' => 'mysql', 'tables' => count($tables)];
            }
            sh_upgrade_log($st, 'データベースの控えを取りました');
            $st['step'] = 'db';
            return;
        case 'db':
            sh_upgrade_test_fail('db');
            $r = sh_upgrade_call_runner($cfg, $st);
            if (empty($r['ok'])) {
                throw new ShError(isset($r['error']) ? (string) $r['error'] : 'runner_failed', 'データベースの作り変え: ' . (isset($r['detail']) ? (string) $r['detail'] : '失敗しました'));
            }
            $st['db_result'] = ['schema_sql' => isset($r['schema_sql']) ? array_slice((array) $r['schema_sql'], 0, 20) : [], 'migrated' => isset($r['migrated']) ? $r['migrated'] : null];
            sh_upgrade_log($st, 'データベースを作り変えました(作りの差 ' . count((array) ($r['schema_sql'] ?? [])) . ' 件、マイグレーション ' . (int) ($r['migrated'] ?? 0) . ' 件)');
            $st['step'] = 'files';
            $st['i'] = 0;
            return;
        case 'files':
            sh_upgrade_test_fail('files');
            $plan = json_decode((string) file_get_contents($dir . '/plan.json'), true);
            $slice = array_slice($plan['write'], $st['i'], SH_UPGRADE_BATCH);
            foreach ($slice as $rel) {
                $abs = sh_root() . '/' . $rel;
                if (is_file($abs)) {
                    $b = $dir . '/files/' . $rel;
                    if (!is_dir(dirname($b))) {
                        @mkdir(dirname($b), 0700, true);
                    }
                    if (!@copy($abs, $b)) {
                        throw new ShError('io', '控えを取れませんでした: ' . $rel);
                    }
                } else {
                    file_put_contents($dir . '/created.txt', $rel . "\n", FILE_APPEND);
                }
                sh_upgrade_copy($stage . '/' . $rel, $abs);
            }
            $st['i'] += count($slice);
            sh_upgrade_log($st, 'ファイルを置き換えています(' . $st['i'] . ' / ' . count($plan['write']) . ')');
            if ($st['i'] >= count($plan['write'])) {
                foreach ($plan['delete'] as $rel) {
                    $abs = sh_root() . '/' . $rel;
                    $b = $dir . '/deleted/' . $rel;
                    if (!is_dir(dirname($b))) {
                        @mkdir(dirname($b), 0700, true);
                    }
                    if (is_file($abs) && @rename($abs, $b)) {
                        file_put_contents($dir . '/deleted.txt', $rel . "\n", FILE_APPEND);
                    }
                }
                sh_upgrade_log($st, '新しい版に無い古いファイル ' . count($plan['delete']) . ' 件を片付けました');
                $st['step'] = 'cache';
            }
            return;
        case 'cache':
            sh_upgrade_cache_clear();
            sh_upgrade_log($st, 'キャッシュを消しました');
            $st['step'] = 'maint_off';
            return;
        case 'maint_off':
            if (!$st['maintenance_before']) {
                sh_upgrade_maintenance(false);
            }
            sh_upgrade_log($st, 'メンテナンスを外しました');
            $st['step'] = 'verify';
            return;
        case 'verify':
            sh_upgrade_test_fail('verify');
            $v = sh_upgrade_verify($cfg);
            $st['verify'] = $v;
            $ver = sh_eccube_version();
            if (sh_verify_failed($v) || $ver !== sh_tagver($st['to'])) {
                throw new ShError('verify_failed', '上げたあと、お店が開けないか版が合いません(' . $ver . ')');
            }
            sh_upgrade_log($st, 'お店を開いて確かめました。' . $ver . ' になりました');
            $st['status'] = 'done';
            $st['step'] = 'done';
            $st['finished_at'] = time();
            sh_rmtree($stage);
            return;
        // ---- 戻す ----
        case 'rb_maint_on':
            sh_upgrade_maintenance(true);
            $st['step'] = 'rb_files';
            return;
        case 'rb_files':
            if (is_dir($dir . '/files')) {
                $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir . '/files', FilesystemIterator::SKIP_DOTS));
                foreach ($it as $f) {
                    if ($f->isFile()) {
                        sh_upgrade_copy($f->getPathname(), sh_root() . '/' . substr($f->getPathname(), strlen($dir . '/files') + 1));
                    }
                }
            }
            foreach (is_file($dir . '/created.txt') ? file($dir . '/created.txt', FILE_IGNORE_NEW_LINES) : [] as $rel) {
                if ($rel !== '' && !sh_upgrade_skip($rel)) {
                    @unlink(sh_root() . '/' . $rel);
                }
            }
            foreach (is_file($dir . '/deleted.txt') ? file($dir . '/deleted.txt', FILE_IGNORE_NEW_LINES) : [] as $rel) {
                if ($rel !== '' && is_file($dir . '/deleted/' . $rel)) {
                    @rename($dir . '/deleted/' . $rel, sh_root() . '/' . $rel);
                }
            }
            sh_upgrade_log($st, 'ファイルを控えから戻しました');
            $st['step'] = 'rb_db';
            return;
        case 'rb_db':
            if (isset($st['db_backup']['kind']) && $st['db_backup']['kind'] === 'sqlite') {
                $db = sh_upgrade_db();
                sh_upgrade_copy($dir . '/db.sqlite', $db['path']);
                sh_upgrade_log($st, 'データベースを控えから戻しました');
            } elseif (isset($st['db_backup']['kind']) && $st['db_backup']['kind'] === 'mysql') {
                $db = sh_upgrade_db();
                $pdo = sh_upgrade_pdo($db);
                $tables = json_decode((string) file_get_contents($dir . '/db/tables.json'), true);
                $pdo->exec('SET FOREIGN_KEY_CHECKS=0');
                foreach ($pdo->query('SHOW FULL TABLES WHERE Table_type = \'BASE TABLE\'')->fetchAll(PDO::FETCH_NUM) as $row) {
                    if (!isset($tables[$row[0]])) {
                        $pdo->exec('DROP TABLE `' . str_replace('`', '``', $row[0]) . '`');
                    }
                }
                foreach ($tables as $t => $info) {
                    $qt = '`' . str_replace('`', '``', $t) . '`';
                    $pdo->exec('DROP TABLE IF EXISTS ' . $qt);
                    $pdo->exec($info['ddl']);
                    $fp = fopen($dir . '/db/' . md5($t) . '.jsonl', 'r');
                    while (($line = fgets($fp)) !== false) {
                        $r = json_decode($line, true);
                        if (!is_array($r)) {
                            continue;
                        }
                        $cols = array_map(function ($c) { return '`' . str_replace('`', '``', $c) . '`'; }, array_keys($r));
                        $stmt = $pdo->prepare('INSERT INTO ' . $qt . ' (' . implode(',', $cols) . ') VALUES (' . implode(',', array_fill(0, count($r), '?')) . ')');
                        $stmt->execute(array_values($r));
                    }
                    fclose($fp);
                }
                $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
                sh_upgrade_log($st, 'データベースを控えから戻しました');
            } else {
                sh_upgrade_log($st, 'データベースはまだ作り変えていませんでした');
            }
            $st['step'] = 'rb_cache';
            return;
        case 'rb_cache':
            sh_upgrade_cache_clear();
            $st['step'] = 'rb_maint_off';
            return;
        case 'rb_maint_off':
            if (!$st['maintenance_before']) {
                sh_upgrade_maintenance(false);
            }
            $st['step'] = 'rb_verify';
            return;
        case 'rb_verify':
            $v = sh_upgrade_verify($cfg);
            $st['verify'] = $v;
            if (sh_verify_failed($v) || sh_eccube_version() !== $st['from']) {
                sh_upgrade_maintenance(true);
                $st['status'] = 'stuck';
                sh_upgrade_log($st, '元に戻したあとも、お店が開けません。メンテナンスのまま止めています。'
                    . '控えは ' . SH_VAR_DIR . '/upgrade/' . $st['pid'] . '/ にあります(files・db)。制作会社かサーバー会社に、この控えから戻すよう頼んでください');
                return;
            }
            sh_upgrade_log($st, '元の ' . $st['from'] . ' に戻し、お店が開くことを確かめました');
            $st['status'] = 'rolled_back';
            $st['step'] = 'rolled_back';
            $st['finished_at'] = time();
            return;
    }
    throw new ShError('bad_state', '作業の段がわかりません: ' . $st['step']);
}

// 2 つの中身で、先頭と末尾の同じ行を除いた「変わる範囲」の行数(多い方)。差分の大きさの上限を、軽く・確実に測る
function sh_changed_span($old, $new)
{
    $a = preg_split("/\r\n|\n|\r/", (string) $old);
    $b = preg_split("/\r\n|\n|\r/", (string) $new);
    $i = 0;
    $na = count($a);
    $nb = count($b);
    while ($i < $na && $i < $nb && $a[$i] === $b[$i]) {
        $i++;
    }
    $j = 0;
    while ($j < $na - $i && $j < $nb - $i && $a[$na - 1 - $j] === $b[$nb - 1 - $j]) {
        $j++;
    }
    return max($na - $i - $j, $nb - $i - $j);
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

// カスタマイズの点検: カスタマイズしたコード(公式に無い・公式と違うファイル)を窓口の手元で調べ、一般的な危ない形がある行だけを返す。読むだけ。
// 返すのは「ファイル、行、理由の種類、その 1 行(長い文字列は伏せる)」まで。ファイルの中身を丸ごとは返さない
const SH_SCAN_MAX_FILES = 400;
const SH_SCAN_MAX_HITS = 300;
const SH_SCAN_MAX_PER_FILE = 20;
const SH_SCAN_EXCERPT = 160;
const SH_SCAN_EXT = '/\.(php|phtml|php[0-9]|inc|tpl|twig)$/i';

function op_scan_custom(array $args)
{
    $max = isset($args['max_files']) ? max(1, min(SH_SCAN_MAX_FILES, (int) $args['max_files'])) : SH_SCAN_MAX_FILES;
    $skipped = ['not_allowed' => 0, 'missing' => 0, 'too_large' => 0, 'not_code' => 0];
    $cands = [];
    if (isset($args['paths']) && is_array($args['paths'])) {
        foreach (array_slice($args['paths'], 0, SH_SCAN_MAX_FILES * 2) as $rel) {
            if (!is_string($rel)) {
                continue;
            }
            $cands[] = $rel;
        }
    } else {
        // 渡されなければ、本体の場所を歩く(部品の置き場・.git・作った画面の置き場は除く)
        $walk = [];
        sh_scan_walk(sh_root(), '', $walk, 0);
        $cands = $walk;
    }
    $files = [];
    foreach ($cands as $rel) {
        if (count($files) >= $max) {
            break;
        }
        try {
            $abs = sh_safe_path($rel, false);
        } catch (ShError $e) {
            $skipped['not_allowed']++;
            continue;
        }
        $r = sh_rel($abs);
        $top = strpos($r, '/') === false ? '' : substr($r, 0, strpos($r, '/'));
        if ($r === '' || !sh_code_top_ok($top) || sh_is_protected($r) || preg_match('/(^|\/)\.env/', $r)) {
            $skipped['not_allowed']++;
            continue;
        }
        if (!preg_match(SH_SCAN_EXT, $r)) {
            $skipped['not_code']++;
            continue;
        }
        if (!is_file($abs) || is_link($abs)) {
            $skipped['missing']++;
            continue;
        }
        if (filesize($abs) > SH_MAX_READ) {
            $skipped['too_large']++;
            continue;
        }
        $files[$r] = $abs;
    }
    $hits = [];
    $list = [];
    $truncated = false;
    foreach ($files as $r => $abs) {
        $n = 0;
        $place = sh_scan_place($r);
        if ($place !== null) {
            $hits[] = [$r, 0, $place, ''];
            $n++;
        }
        $lines = preg_split("/\r\n|\n|\r/", (string) @file_get_contents($abs));
        $tainted = sh_scan_tainted($lines);
        foreach ($lines as $i => $line) {
            if ($n >= SH_SCAN_MAX_PER_FILE || count($hits) >= SH_SCAN_MAX_HITS) {
                break;
            }
            foreach (sh_scan_line($line, $tainted, $r) as $kind) {
                $hits[] = [$r, $i + 1, $kind, sh_scan_excerpt($line)];
                $n++;
                break;
            }
        }
        if (count($hits) >= SH_SCAN_MAX_HITS) {
            $truncated = true;
        }
        $list[] = [$r, (int) @filemtime($abs), (int) @filesize($abs), $n];
        if ($truncated) {
            break;
        }
    }
    // 補助の手がかり: ほかのファイルと日時が大きく離れたもの(調べたファイルの中央より 180 日以上新しい)
    $times = array_column($list, 1);
    sort($times);
    $median = $times ? $times[(int) floor(count($times) / 2)] : 0;
    $late = [];
    foreach ($list as $f) {
        if ($median > 0 && $f[1] - $median > 180 * 86400) {
            $late[] = $f[0];
        }
    }
    // PHP が置かれるはずのない場所の PHP は、件数の上限で打ち切ったあとも、選んだファイル全部から拾う(中身は読まない)
    $misplaced = [];
    foreach (array_keys($files) as $r) {
        if (sh_scan_place($r) !== null && count($misplaced) < 100) {
            $misplaced[] = $r;
        }
    }
    return ['scanned' => count($list), 'skipped' => $skipped, 'hits' => $hits, 'files' => $list, 'misplaced' => $misplaced, 'newer_than_most' => array_slice($late, 0, 50),
        'truncated' => $truncated || count($cands) > count($files) + array_sum($skipped)];
}

function sh_scan_walk($abs, $rel, array &$out, $depth)
{
    if ($depth > 12 || count($out) >= SH_SCAN_MAX_FILES * 4) {
        return;
    }
    $vendor = sh_map()['vendor_dir'];
    foreach ((array) @scandir($abs) as $name) {
        if ($name === '.' || $name === '..' || $name === '.git' || $name === 'node_modules' || $name === 'templates_c') {
            continue;
        }
        $r = $rel === '' ? $name : $rel . '/' . $name;
        $p = $abs . '/' . $name;
        if (is_link($p) || sh_is_protected($r) || $r === $vendor || $r === 'vendor') {
            continue;
        }
        if (is_dir($p)) {
            $top = $rel === '' ? $name : substr($r, 0, strpos($r, '/'));
            if ($rel === '' && !sh_code_top_ok($top)) {
                continue;
            }
            sh_scan_walk($p, $r, $out, $depth + 1);
        } elseif (preg_match(SH_SCAN_EXT, $name)) {
            if ($rel === '' && !sh_code_top_ok('')) {
                continue;
            }
            $out[] = $r;
        }
    }
}

// PHP が置かれるはずのない場所(画像・アップロード・一時の置き場)にある PHP
// 画像・アップロードなど、PHP が置かれるはずのない場所を最後まで歩き、PHP を探す(一覧の上限に関係なく)
// 拡張子で見るほか、拡張子が違っても先頭に PHP の開始の印があるものも拾う。返すのは場所・大きさ・日時だけ(中身は返さない)
// 歩く数と時間に上限を付け、上限に達したら complete=false で返す
const SH_MISPLACED_EXT = '/\.(php[0-9]?|phtml|phar|pht|phps|inc)$/i';
function op_find_misplaced_php(array $args)
{
    $map = sh_map();
    $max_walk = isset($args['max_entries']) ? max(1000, min(300000, (int) $args['max_entries'])) : 200000;
    $deadline = microtime(true) + (isset($args['max_seconds']) ? max(2, min(20, (int) $args['max_seconds'])) : 15);
    $root = sh_root();
    $skip = array_merge($map['drop_skip'], [$map['var_dir'], sh_pub(SH_LAB_DIR), 'var/self-harden']);
    $dirs = [];
    foreach ($map['drop_dirs'] as $d) {
        // data/ を公開の場所に置いた 2 系では、公式の html/ の中身が一番上に並ぶ
        $dirs[] = !empty($map['flat']) && strpos($d, 'html/') === 0 ? substr($d, 5) : $d;
    }
    $found = [];
    $walked = 0;
    $sniffed = 0;
    $complete = true;
    $checked = [];
    $absent = [];
    foreach ($dirs as $d) {
        if (!is_dir($root . '/' . $d) || is_link($root . '/' . $d)) {
            $absent[] = $d;
            continue;
        }
        $checked[] = $d;
        $stack = [$d];
        while ($stack) {
            $rel = array_pop($stack);
            $dh = @opendir($root . '/' . $rel);
            if (!$dh) {
                continue;
            }
            while (($name = readdir($dh)) !== false) {
                if ($name === '.' || $name === '..') {
                    continue;
                }
                if (++$walked > $max_walk || microtime(true) > $deadline) {
                    $complete = false;
                    break 3;
                }
                $r = $rel . '/' . $name;
                $abs = $root . '/' . $r;
                $skipped = false;
                foreach ($skip as $sk) {
                    if ($sk !== '' && sh_is_inside($r, $sk)) {
                        $skipped = true;
                        break;
                    }
                }
                if ($skipped || is_link($abs)) {
                    continue;
                }
                if (is_dir($abs)) {
                    $stack[] = $r;
                    continue;
                }
                $why = null;
                if (preg_match(SH_MISPLACED_EXT, $name)) {
                    $why = 'php_extension';
                } elseif ($sniffed < 50000 && @filesize($abs) > 0) {
                    $sniffed++;
                    $fh = @fopen($abs, 'rb');
                    $head = $fh ? (string) fread($fh, 256) : '';
                    if ($fh) {
                        fclose($fh);
                    }
                    if (stripos($head, '<?php') !== false || strpos($head, '<?=') !== false) {
                        $why = 'php_code_in_other_extension';
                    }
                }
                if ($why !== null && count($found) < 200) {
                    $st = @stat($abs);
                    $found[] = ['path' => $r, 'why' => $why, 'size' => $st ? $st['size'] : null, 'mtime' => $st ? $st['mtime'] : null];
                }
            }
            closedir($dh);
        }
    }
    return ['dirs_checked' => $checked, 'dirs_absent' => $absent, 'walked' => min($walked, $max_walk), 'complete' => $complete,
        'found' => $found, 'found_truncated' => count($found) >= 200];
}

function sh_scan_place($rel)
{
    if (!preg_match('/\.(php|phtml|php[0-9])$/i', $rel)) {
        return null;
    }
    $dirs = explode('/', strtolower(dirname($rel)));
    foreach ($dirs as $d) {
        if (in_array($d, ['upload', 'uploads', 'save_image', 'temp_image', 'tmp', 'temp', 'images', 'image', 'img', 'photo', 'photos', 'media'], true)) {
            return 'php_in_data_dir';
        }
    }
    return null;
}

// 外から来る値を入れた変数(同じファイルの中だけ。代入の左側)
function sh_scan_tainted(array $lines)
{
    $vars = [];
    foreach ($lines as $line) {
        if (preg_match('/(\$[A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]\s*)?\.?=(?!=)\s*(.*)$/', $line, $m) && sh_scan_has_source($m[2], [])) {
            $vars[$m[1]] = true;
        }
        if (count($vars) > 200) {
            break;
        }
    }
    unset($vars['$this']);
    return array_keys($vars);
}

function sh_scan_has_source($s, array $tainted)
{
    if (preg_match('/\$_(GET|POST|REQUEST|COOKIE|FILES)\b|\$_SERVER\s*\[\s*[\'"](HTTP_[A-Z_]+|QUERY_STRING|REQUEST_URI|PHP_SELF|PATH_INFO)[\'"]|\$smarty\.(get|post|request|cookies)\./i', $s)) {
        return true;
    }
    foreach ($tainted as $v) {
        if (preg_match('/' . preg_quote($v, '/') . '(?![A-Za-z0-9_])/', $s)) {
            return true;
        }
    }
    return false;
}

// 1 行の危ない形。返すのは理由の種類だけ(当てはまる順に 1 つ使う)
function sh_scan_line($line, array $tainted, $rel)
{
    $t = trim($line);
    if ($t === '' || $t[0] === '*' || strpos($t, '//') === 0 || $t[0] === '#') {
        return [];
    }
    $kinds = [];
    $src = sh_scan_has_source($line, $tainted);
    // 難読化: とても長い文字列、16 進の続き、復元の関数の重ね掛け
    if (preg_match('/[A-Za-z0-9+\/=]{200,}/', $line) || preg_match('/(\\\\x[0-9a-fA-F]{2}){20,}/', $line)
        || preg_match('/\b(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin)\s*\(\s*(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin)\s*\(/i', $line)) {
        $kinds[] = 'obfuscated';
    }
    // 実行の関数・動的なコード(外の値が無くても、これ自体が珍しい)
    if (preg_match('/(?<![A-Za-z0-9_>:$])(eval|assert|create_function)\s*\(/i', $line) || preg_match('/preg_replace\s*\(\s*[\'"](.).*\1[a-zA-Z]*e[a-zA-Z]*[\'"]/', $line)) {
        $kinds[] = 'dynamic_code';
    }
    if ($src) {
        if (preg_match('/(?<![A-Za-z0-9_>:$])(system|exec|passthru|shell_exec|popen|proc_open|pcntl_exec|call_user_func|call_user_func_array)\s*\(|`/i', $line)
            || preg_match('/\$_(GET|POST|REQUEST|COOKIE)\s*\[[^\]]*\]\s*\(/', $line)) {
            $kinds[] = 'exec_with_input';
        }
        if (preg_match('/(?<![A-Za-z0-9_>:$])(include|include_once|require|require_once|fopen|file_get_contents|file_put_contents|readfile|unlink|copy|rename|move_uploaded_file|opendir|scandir)\b/i', $line)) {
            $kinds[] = 'file_with_input';
        }
        if (preg_match('/\b(SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER\s+BY|GROUP\s+BY|LIMIT|VALUES)\b/i', $line) && preg_match('/[\'"]\s*\.\s*\$|\$[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[\'"]|"[^"]*\$[A-Za-z_{]/', $line)) {
            $kinds[] = 'sql_with_input';
        }
        if (preg_match('/(?<![A-Za-z0-9_>:$])(echo|print|printf|die|exit)\b|<\?=/i', $line) && !preg_match('/htmlspecialchars|htmlentities|h\(|escape|json_encode|intval|\(int\)/i', $line)) {
            $kinds[] = 'output_with_input';
        }
        if (preg_match('/\{\$smarty\.(get|post|request|cookies)\.[^}]*\}/i', $line) && !preg_match('/\|\s*(h|escape|htmlspecialchars)\b/i', $line)) {
            $kinds[] = 'output_with_input';
        }
    }
    if (preg_match('/\.twig$/i', $rel) && preg_match('/\|\s*raw\b/', $line)) {
        $kinds[] = 'output_unescaped';
    }
    if (preg_match('/\.tpl$/i', $rel) && preg_match('/\{\$[^}|]+\|\s*(nofilter|smarty:nodefaults)\b/i', $line)) {
        $kinds[] = 'output_unescaped';
    }
    return $kinds;
}

// 返す 1 行: 長い文字列と、秘密らしい名前のそばの文字列は伏せる。長すぎれば切る
function sh_scan_excerpt($line)
{
    $t = trim($line);
    $t = preg_replace_callback('/([\'"])((?:\\\\.|(?!\1).){25,})\1/', function ($m) { return $m[1] . '<str:' . strlen($m[2]) . '>' . $m[1]; }, $t);
    $t = preg_replace('/((?:pass(?:word|wd)?|secret|token|api[_-]?key|auth[_-]?magic|private[_-]?key)[A-Za-z0-9_]*[\'"]?\s*(?:=>|=|,)\s*)([\'"])((?:\\\\.|(?!\2).)*)\2/i', '$1$2<redacted>$2', (string) $t);
    $t = preg_replace('/[A-Za-z0-9+\/=]{60,}/', '<long>', (string) $t);
    if (strlen($t) > SH_SCAN_EXCERPT) {
        $t = function_exists('mb_strcut') ? mb_strcut($t, 0, SH_SCAN_EXCERPT, 'UTF-8') . '…' : substr($t, 0, SH_SCAN_EXCERPT) . '…';
    }
    return function_exists('mb_convert_encoding') ? mb_convert_encoding($t, 'UTF-8', 'UTF-8') : $t;
}

// ファイルの一覧と SHA-256。読むだけ。件数と時間の上限があり、cursor から続きを取れる
function op_hash_tree(array $args)
{
    // 一番上のファイルと本体のフォルダ。2 系は data/ も。data/ を公開の場所の中に置いた 2 系は、一番上から全部('*')
    $default = sh_map()['name'] === 'eccube2' ? (empty(sh_map()['flat']) ? ['', 'html', 'data'] : ['*']) : ['', 'app', 'html', 'src', 'vendor'];
    $roots = isset($args['roots']) && is_array($args['roots']) ? $args['roots'] : $default;
    $limit = isset($args['limit']) ? max(1, min(5000, (int) $args['limit'])) : 3000;
    $cursor = isset($args['cursor']) && is_string($args['cursor']) ? $args['cursor'] : '';
    $paths = [];
    foreach ($roots as $root) {
        if (!in_array($root, ['', '*', 'app', 'html', 'src', 'vendor', 'data'], true)) {
            throw new ShError('bad_root', 'roots は "", *, app, html, src, vendor, data から選んでください');
        }
        if ($root === '*') {
            sh_collect(sh_root(), '', true, $paths);
            continue;
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
            if ($recursive && $name !== 'node_modules' && $name !== 'templates_c') {
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
    $extra = [];
    if ($op === 'apply_approved_fix' && isset($args['approval']) && is_array($args['approval'])) {
        // 承認で書いた記録: どの提案の、どのファイルに、どの中身(ハッシュ)を書いたか。印そのものは残さない
        foreach (['proposal_id', 'path', 'sha256_new'] as $k) {
            $extra[$k] = isset($args['approval'][$k]) && is_scalar($args['approval'][$k]) ? substr((string) $args['approval'][$k], 0, 300) : null;
        }
        $path = $extra['path'];
    }
    if ($path === null && isset($args['paths']) && is_array($args['paths'])) {
        $path = substr(implode(',', array_filter($args['paths'], 'is_string')), 0, 300);
    }
    $line = ['t' => gmdate('c'), 'op' => $op, 'path' => $path, 'ok' => $ok, 'code' => $code,
        'backup_id' => is_array($result) && isset($result['backup_id']) ? $result['backup_id'] : null,
        'rolled_back' => is_array($result) && !empty($result['rolled_back']) ? true : null] + $extra;
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
    sh_ensure_var();
    $secret = $cfg['secret'];
    $req = json_decode($body, true);
    if (!is_array($req) || !isset($req['op']) || !is_string($req['op'])) {
        sh_send(200, ['ok' => false, 'error' => 'bad_request', 'detail' => 'JSON の op がありません'], $nonce, $secret);
    }
    $args = isset($req['args']) && is_array($req['args']) ? $req['args'] : [];
    @set_time_limit(25);
    try {
        if (sh_map()['name'] === 'unknown' && !in_array($req['op'], ['ping', 'inspect'], true)) {
            throw new ShError('unknown_layout', 'この店の作り(EC-CUBE のどの系統か)を見分けられなかったので、読む以外の操作はしません');
        }
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
            case 'scan_custom': $r = op_scan_custom($args); break;
            case 'find_misplaced_php': $r = op_find_misplaced_php($args); break;
            case 'restore_official': $r = op_restore_official($cfg, $args); break;
            case 'apply_official_fix': $r = op_apply_official_fix($cfg, $args); break;
            case 'apply_official_release': $r = op_apply_official_release($cfg, $args); break;
            case 'quarantine': $r = op_quarantine($cfg, $args); break;
            case 'apply_approved_fix': $r = op_apply_approved_fix($cfg, $args); break;
            case 'upgrade': $r = op_upgrade($cfg, $args); break;
            case 'clear_cache': $r = op_clear_cache($cfg, $args); break;
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
