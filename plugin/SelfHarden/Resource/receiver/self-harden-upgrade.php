<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// Shisa(self-harden): 店主が承認した版上げの途中で、データベースの作り変えだけを行う入口。
// 窓口(self-harden.php)は EC-CUBE を読み込まない決まりなので、EC-CUBE 自身を読み込むのはここだけ。
// 読み込むのは、窓口が公式の配布物(チェックサムで確かめたもの)から広げた「上げ先の版」の EC-CUBE で、行うのは決まった 2 つ
// (スキーマの差の反映と、公式のマイグレーション)だけ。外から何かを渡して動かすことはできない。
// 動くのは、窓口が承認された版上げの「データベースの段」で置いた 1 回きりの合図と一致したときだけ。それ以外は何もせず 404 を返す。

const SHU_VAR = 'var/self-harden';

function shu_send($status, array $data)
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function shu_nothing()
{
    shu_send(404, ['ok' => false]);
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    shu_nothing();
}
$root = __DIR__;
$body = (string) file_get_contents('php://input', false, null, 0, 4096);
$req = json_decode($body, true);
if (!is_array($req) || !isset($req['job'], $req['token']) || !is_string($req['job']) || !is_string($req['token'])
    || !preg_match('/^prp_[0-9a-f]{16}$/', $req['job']) || !preg_match('/^[0-9a-f]{64}$/', $req['token'])) {
    shu_nothing();
}
$dir = $root.'/'.SHU_VAR.'/upgrade/'.$req['job'];
$tokenFile = $dir.'/runner-token';
if (is_link($dir) || !is_file($tokenFile) || is_link($tokenFile)) {
    shu_nothing();
}
$token = (string) file_get_contents($tokenFile);
// 合図は 1 回きり。確かめる前に消す
@unlink($tokenFile);
if (!hash_equals($token, $req['token'])) {
    shu_nothing();
}
$st = json_decode((string) @file_get_contents($dir.'/state.json'), true);
if (!is_array($st) || ($st['status'] ?? '') !== 'running' || ($st['step'] ?? '') !== 'db') {
    shu_nothing();
}
$stage = $dir.'/stage';
if (!is_file($stage.'/vendor/autoload.php') || !is_file($stage.'/src/Eccube/Kernel.php')) {
    shu_send(200, ['ok' => false, 'error' => 'no_stage', 'detail' => '上げ先の版が作業の置き場にありません']);
}
@set_time_limit(170);
@ini_set('memory_limit', '1024M');
// 古い書き方の注意(Deprecated)などを返事に混ぜない(返事は JSON だけ)
@ini_set('display_errors', '0');
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED & ~E_NOTICE & ~E_STRICT);
ob_start();
try {
    require $stage.'/vendor/autoload.php';
    // お店の設定(.env)をそのまま使う。上げ先の版の EC-CUBE を、お店のデータベースにつなぐ
    if (is_file($root.'/.env')) {
        (\Dotenv\Dotenv::createUnsafeMutable($root))->load();
    }
    $_SERVER['APP_ENV'] = $_ENV['APP_ENV'] = 'prod';
    $_SERVER['APP_DEBUG'] = $_ENV['APP_DEBUG'] = '0';
    $kernel = new \Eccube\Kernel('prod', false);
    $app = new \Symfony\Bundle\FrameworkBundle\Console\Application($kernel);
    $app->setAutoExit(false);
    $app->setCatchExceptions(false);
    $run = function (array $input) use ($app) {
        $out = new \Symfony\Component\Console\Output\BufferedOutput();
        $in = new \Symfony\Component\Console\Input\ArrayInput($input);
        $in->setInteractive(false);
        $code = $app->run($in, $out);

        return [$code, $out->fetch()];
    };
    // 1. スキーマの差: まず SQL だけ出して、足すだけの変更か確かめる(消す・名前を変える変更があれば、何もしない)
    [$code, $dump] = $run(['command' => 'doctrine:schema:update', '--dump-sql' => true]);
    $dumpHead = mb_substr($dump, 0, 1500);
    // 出力には注意書き([WARNING] など)も混ざるので、SQL の文だけを拾う(行の頭が SQL の言葉で、; で終わるもの)
    $sql = [];
    if (preg_match_all('/^\s*((?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|RENAME|PRAGMA)\b[^;]*);/mi', $dump, $mm)) {
        foreach ($mm[1] as $s) {
            $sql[] = trim($s);
        }
    }
    foreach ($sql as $s) {
        if (preg_match('/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i', $s) && !preg_match('/^DROP\s+INDEX\b/i', $s) || preg_match('/\bRENAME\b/i', $s)) {
            // SQLite は列を足すときもテーブルを作り直す(一時テーブルに写して DROP)。その形は許す
            if (preg_match('/^DROP TABLE\s+[`"]?__temp__/i', $s) || preg_match('/^ALTER TABLE\s+[`"]?__temp__\w+[`"]?\s+RENAME TO/i', $s)) {
                continue;
            }
            shu_send(200, ['ok' => false, 'error' => 'schema_not_additive', 'detail' => 'データベースの作りから消す・名前を変える変更が入っているので、自動では上げません', 'schema_sql' => array_slice($sql, 0, 20)]);
        }
    }
    if ($sql) {
        [$code] = $run(['command' => 'doctrine:schema:update', '--force' => true]);
        if ($code !== 0) {
            shu_send(200, ['ok' => false, 'error' => 'schema_failed', 'detail' => 'スキーマの差の反映に失敗しました', 'schema_sql' => array_slice($sql, 0, 20)]);
        }
    }
    // 2. 公式のマイグレーション
    [$code, $mig] = $run(['command' => 'doctrine:migrations:migrate', '--no-interaction' => true, '--allow-no-migration' => true]);
    if ($code !== 0) {
        shu_send(200, ['ok' => false, 'error' => 'migrate_failed', 'detail' => 'マイグレーションに失敗しました', 'schema_sql' => array_slice($sql, 0, 20)]);
    }
    $migrated = preg_match('/(\d+) migrations? executed/i', $mig, $mm) ? (int) $mm[1] : (preg_match('/No migrations to execute|Already at the latest/i', $mig) ? 0 : null);
    shu_send(200, ['ok' => true, 'schema_sql' => array_slice($sql, 0, 20), 'schema_dump' => $dumpHead, 'migrated' => $migrated, 'migrate_out' => mb_substr($mig, 0, 2000)]);
} catch (\Throwable $e) {
    shu_send(200, ['ok' => false, 'error' => 'runner_failed', 'detail' => 'データベースの作り変えの途中で失敗しました: '.mb_substr($e->getMessage(), 0, 300)]);
}
