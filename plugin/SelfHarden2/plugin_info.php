<?php
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * EC-CUBE 2 系(2.17 以降、PHP 7.x)向けの Shisa。4 系の plugin/SelfHarden と同じ仕事をする
 */
class plugin_info
{
    public static $PLUGIN_CODE       = 'SelfHarden2';
    public static $PLUGIN_NAME       = 'Shisa(シーサー) お店の守り神';
    public static $CLASS_NAME        = 'SelfHarden2';
    public static $PLUGIN_VERSION    = '0.1.0';
    public static $COMPLIANT_VERSION = '2.17.x';
    public static $AUTHOR            = 'self-harden';
    public static $DESCRIPTION       = 'お店のサーバーを自分で調べて、弱いところの守りを固めます。設定画面から API とつなぎます。';
    public static $PLUGIN_SITE_URL   = '';
    public static $AUTHOR_SITE_URL   = '';
    public static $HOOK_POINTS       = array();
    public static $LICENSE           = 'GPL-2.0-or-later';
}
