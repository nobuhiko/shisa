<?php
// テスト用の php -S の振り分け。root の .htaccess に「BREAK-ME」と書かれていたら、トップを 500 にする
// (本物の Apache で .htaccess が壊れたときの 500 の代わり)
$root = $_SERVER['DOCUMENT_ROOT'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/' && strpos((string) @file_get_contents($root . '/.htaccess'), 'BREAK-ME') !== false) {
    http_response_code(500);
    echo 'broken';
    return true;
}
// 目印 .break-when-app-config があり、app/config ができていたら、トップを 500 にする(公式の修正を当てて壊れた場合の代わり)
if ($path === '/' && file_exists($root . '/.break-when-app-config') && is_dir($root . '/app/config')) {
    http_response_code(500);
    echo 'broken';
    return true;
}
if ($path === '/') {
    echo 'shop top';
    return true;
}
return false;
