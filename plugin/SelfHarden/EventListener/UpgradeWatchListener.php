<?php
// SPDX-License-Identifier: GPL-2.0-or-later

namespace Plugin\SelfHarden\EventListener;

use Plugin\SelfHarden\Service\ApiClient;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\Event\TerminateEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * 店主の承認での版上げが途中で止まったまま(メンテナンス中のまま)にならないように、管理画面の呼び出しのたびに、
 * 返事を返したあとで、止まった作業が無いかを見る(あれば窓口に ping して着地させる)。
 * メンテナンス中でも管理画面は開けるので、店主が様子を見に来たときが回復の機会になる。止まっていなければ、ファイルを 1 つ見るだけ
 */
class UpgradeWatchListener implements EventSubscriberInterface
{
    /** @var ApiClient */
    private $api;

    public function __construct(ApiClient $api)
    {
        $this->api = $api;
    }

    public static function getSubscribedEvents()
    {
        return [KernelEvents::TERMINATE => 'onTerminate'];
    }

    public function onTerminate(TerminateEvent $event)
    {
        try {
            $path = $event->getRequest()->getPathInfo();
            // 管理画面の呼び出しだけ(お店の画面のお客さんの呼び出しでは見ない)
            if (strpos($path, '/self-harden') === 0 || !preg_match('#^/[^/]+/#', $path) || strpos($event->getRequest()->attributes->get('_route', ''), 'admin') === false) {
                return;
            }
            $this->api->pokeStalledUpgrade();
        } catch (\Throwable $e) {
            // 見張りの失敗で、管理画面を壊さない
        }
    }
}
