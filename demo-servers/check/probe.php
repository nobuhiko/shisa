<?php
// 制約の確認用。check.sh が一時的に置いて、終わったら消す。店には残さない
header('Content-Type: application/json');
$fns = ['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen'];
$callable = [];
foreach ($fns as $f) {
    $callable[$f] = function_exists($f) && is_callable($f);
}
$ver = null;
$c = @file_get_contents(dirname(__DIR__, 2) . '/src/Eccube/Common/Constant.php')
   ?: @file_get_contents(dirname(__DIR__) . '/src/Eccube/Common/Constant.php');
if ($c && preg_match("/const VERSION = '([^']+)'/", $c, $m)) {
    $ver = $m[1];
}
echo json_encode([
    'sapi' => php_sapi_name(),
    'php_version' => PHP_VERSION,
    'eccube_version' => $ver,
    'disable_functions' => ini_get('disable_functions'),
    'callable' => $callable,
    'max_execution_time' => ini_get('max_execution_time'),
    'memory_limit' => ini_get('memory_limit'),
    'short_open_tag' => ini_get('short_open_tag'),
    'short_open_tag' => ini_get('short_open_tag'),
    'user_ini.filename' => ini_get('user_ini.filename'),
    'user_ini.cache_ttl' => ini_get('user_ini.cache_ttl'),
    'allow_url_fopen' => ini_get('allow_url_fopen'),
    'curl' => extension_loaded('curl'),
    'cron_binary' => file_exists('/usr/sbin/cron') || file_exists('/usr/bin/crontab'),
    'time' => time(),
]);
