<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 受け口の中の判断の関数を、HTTP を通さずに確かめる(tests/run.sh から docker の中で動かす)。
// 受け口を 4 系の置き方の仮のお店に写し、最後の sh_main() を外して読み込む
$here = dirname(__DIR__);
$work = $here . '/.work/tu-' . PHP_MAJOR_VERSION . PHP_MINOR_VERSION . '-' . getmypid();
@mkdir($work . '/src/Eccube', 0777, true);
@mkdir($work . '/var/self-harden', 0777, true);
file_put_contents($work . '/src/Eccube/Kernel.php', "<?php\n");
$src = file_get_contents($here . '/SelfHarden/Resource/receiver/self-harden.php');
$src = preg_replace('/\nsh_main\(\);\s*$/', "\n", $src);
file_put_contents($work . '/self-harden.php', $src);
register_shutdown_function(function () use ($work) {
    exec('rm -rf ' . escapeshellarg($work));
});
require $work . '/self-harden.php';

$pass = 0;
$fail = 0;
function check($name, $cond)
{
    global $pass, $fail;
    if ($cond) {
        $pass++;
        echo "  ok    $name\n";
    } else {
        $fail++;
        echo "  FAIL  $name\n";
    }
}

echo "公式のコミットか(compare の返事の読み方)\n";
$sha = str_repeat('a', 40);
$mk = function ($status, $base, $ahead = 0) {
    return json_encode(['status' => $status, 'ahead_by' => $ahead, 'behind_by' => 3, 'merge_base_commit' => ['sha' => $base]]);
};
check('behind で共通の祖先がその sha なら辿れる', sh_compare_reaches($mk('behind', $sha), $sha));
check('identical なら辿れる', sh_compare_reaches($mk('identical', $sha), $sha));
check('大文字の sha でも同じに読む', sh_compare_reaches($mk('behind', strtoupper($sha)), $sha));
check('ahead(フォークにだけあるコミット)は断る', !sh_compare_reaches($mk('ahead', str_repeat('b', 40), 2), $sha));
check('diverged は断る', !sh_compare_reaches($mk('diverged', str_repeat('b', 40), 2), $sha));
check('behind でも共通の祖先が別の sha なら断る', !sh_compare_reaches($mk('behind', str_repeat('c', 40)), $sha));
check('behind でも ahead_by が 0 でなければ断る', !sh_compare_reaches($mk('behind', $sha, 1), $sha));
check('404 の返事は断る', !sh_compare_reaches(json_encode(['message' => 'Not Found']), $sha));
check('壊れた返事は断る', !sh_compare_reaches('{"status":', $sha));
check('status が文字でなければ断る', !sh_compare_reaches(json_encode(['status' => ['behind'], 'merge_base_commit' => ['sha' => $sha]]), $sha));
check('空の返事は断る', !sh_compare_reaches('', $sha));

echo "変わる範囲の行数\n";
check('同じなら 0', sh_changed_span("a\nb\nc", "a\nb\nc") === 0);
check('1 行だけ変われば 1', sh_changed_span("a\nb\nc", "a\nX\nc") === 1);
check('足した行も数える', sh_changed_span("a\nc", "a\nb1\nb2\nc") === 2);
check('改行の種類が違っても同じ行', sh_changed_span("a\r\nb", "a\nb") === 0);

echo "守る場所は大文字小文字を区別しない\n";
check('var/self-harden/config.php は守る', (bool) sh_is_protected('var/self-harden/config.php'));
check('VAR/Self-Harden/config.php も守る', (bool) sh_is_protected('VAR/Self-Harden/config.php'));
check('Composer.Lock も守る', (bool) sh_is_protected('Composer.Lock'));
check('.ENV も守る', (bool) sh_is_protected('.ENV'));
check('ふつうの本体のファイルは守らない', !sh_is_protected('src/Eccube/Kernel.php'));

echo "版上げの残す部品の一覧\n";
check('空なら何も残さない', sh_upgrade_keep_list('') === []);
check('名前と版を読む', sh_upgrade_keep_list('symfony/http-foundation@v5.4.56,twig/twig@v2.16.1') === ['symfony/http-foundation' => 'v5.4.56', 'twig/twig' => 'v2.16.1']);
$threw = false;
try { sh_upgrade_keep_list('../x@v1.0.0'); } catch (ShError $e) { $threw = $e->code_str === 'not_approved'; }
check('形の違うものは断る', $threw);

echo "版上げの後片付け・データベースの場所・守る場所\n";
$R = sh_root();
check('sqlite:///var/eccube.db は、お店の root からの相対(DBAL と同じ)', sh_sqlite_path('sqlite:///var/eccube.db') === $R . '/var/eccube.db');
check('sqlite://// は絶対', sh_sqlite_path('sqlite:////srv/db/x.db') === '/srv/db/x.db');
check('%kernel.project_dir% は、お店の root', sh_sqlite_path('sqlite:///%kernel.project_dir%/var/eccube.db') === $R . '/var/eccube.db');
check('SQLite でなければ null', sh_sqlite_path('mysql://u:p@h/db') === null);
check('データベースの入口は守る場所', sh_is_protected('self-harden-upgrade.php') && sh_is_protected('Self-Harden-Upgrade.php'));
@mkdir($R . '/real-dir', 0777, true);
@symlink($R . '/real-dir', $R . '/link-dir');
$threw = false;
try { sh_upgrade_no_link($R . '/link-dir/sub/x.php'); } catch (ShError $e) { $threw = true; }
check('途中の階層のシンボリックリンクには書かない', $threw);
$threw = false;
try { sh_upgrade_no_link($R . '/real-dir/sub/x.php'); } catch (ShError $e) { $threw = true; }
check('ふつうのフォルダには書ける', !$threw);
putenv('SELF_HARDEN_TEST_FAIL_AT=files');
$threw = false;
try { sh_upgrade_test_fail('files'); } catch (ShError $e) { $threw = true; }
check('テスト用の目印ファイルが無ければ、環境変数を置かれてもわざと失敗しない', !$threw);
file_put_contents(sh_var('.test-mode'), '{}');
$threw = false;
try { sh_upgrade_test_fail('files'); } catch (ShError $e) { $threw = true; }
check('目印ファイルがあれば、テストのためにわざと失敗する', $threw);
@unlink(sh_var('.test-mode'));
putenv('SELF_HARDEN_TEST_FAIL_AT');
// ファイルの置き換えの段をやり直しても(途中で止まって呼び直されても)、控えを新しい中身で上書きしない
$pid = 'prp_00000000000000aa';
$d = sh_upgrade_dir($pid);
@mkdir($d . '/stage/src', 0700, true);
@mkdir($d . '/files/src', 0700, true);
@mkdir($R . '/src', 0777, true);
file_put_contents($d . '/stage/src/A.php', "<?php // new\n");
file_put_contents($d . '/files/src/A.php', "<?php // orig\n"); // 1 回目の呼び出しで取った控え
file_put_contents($R . '/src/A.php', "<?php // new\n");    // 1 回目の途中で、もう置き換わっていた
file_put_contents($d . '/plan.json', json_encode(['write' => ['src/A.php', 'src/B.php'], 'delete' => []]));
file_put_contents($d . '/stage/src/B.php', "<?php // b\n");
file_put_contents($d . '/created.txt', "src/B.php\n");
$st = ['pid' => $pid, 'status' => 'running', 'step' => 'files', 'i' => 0, 'log' => []];
sh_upgrade_step(['self_base' => 'http://127.0.0.1:9'], $st);
check('やり直しでも、控えは最初の中身のまま', file_get_contents($d . '/files/src/A.php') === "<?php // orig\n");
check('作ったファイルの記録を重ねない', substr_count(file_get_contents($d . '/created.txt'), 'src/B.php') === 1);

echo "\n$pass ok, $fail fail\n";
exit($fail ? 1 : 0);
