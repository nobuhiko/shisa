<?php
// SPDX-License-Identifier: GPL-2.0-or-later
// 管理画面の「プラグイン設定」から開かれる(html/admin/load_plugin_config.php が、ログインを確かめてから読み込む)

require_once PLUGIN_UPLOAD_REALDIR . 'SelfHarden2/LC_Page_Plugin_SelfHarden2_Config.php';

$objPage = new LC_Page_Plugin_SelfHarden2_Config();
$objPage->init();
$objPage->process();
