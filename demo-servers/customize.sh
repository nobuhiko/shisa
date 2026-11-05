#!/bin/sh
# デモのお店に、弱点ではない普通のカスタマイズを入れる(点検の前に)/ 点検のあとに上書きされていないかを確かめる
#   ./customize.sh server-d|server-f|server-g|server-h          カスタマイズを入れて、入れたファイルのハッシュを控える
#   ./customize.sh check server-d|server-f|server-g|server-h    控えと今のハッシュを比べ、入れたページが開くかを見る
# 入れるもの(どれも弱点ではない):
#   a. 公式のファイルの小さな書き換え: フッターのテンプレートの文言、PHP のクラスに説明のコメント
#   b. 次の公式の修正版が直すファイルの 1 つに、直しとは関係のないコメント行(修正版を当てるとき上書きせずに止まるかを見る)
#        server-d(4.0.6 → 4.0.6-p5): src/Eccube/Controller/Admin/Setting/Shop/PaymentController.php
#        server-f(4.3.0 → 4.3.1-p1): src/Eccube/Service/TwoFactorAuthService.php
#        server-g(3.0.18 → 3.0.18-p1): src/Eccube/Form/Type/Admin/ProductType.php
#        server-h(2.17.2 → 2.17.2-p2): data/class/pages/admin/contents/LC_Page_Admin_Contents_FileManager.php
#   c. 安全な独自のページ(外から来た値は escape して出し、DB にはパラメータで渡す)
#        4 系: app/Customize/Controller/ShopNoteController.php + app/template/default/ShopNote/index.twig(/shop_note)
#        3 系: html/shop_note.php(値は htmlspecialchars。DB は使わない)
#        2 系: html/user_data/shop_note.php(SC_Query のプレースホルダーと htmlspecialchars)
# 控えは .cache/customize-<server>.txt(ファイル<TAB>sha256)
set -eu
cd "$(dirname "$0")"
mkdir -p .cache
mode=put
[ "${1:-}" = check ] && { mode=check; shift; }
S="${1:?server-d|server-f|server-g|server-h}"
case "$S" in
  server-d) C=self-harden-demo-server-d-1; V=4; B=http://127.0.0.1:8084; FIX=src/Eccube/Controller/Admin/Setting/Shop/PaymentController.php;;
  server-f) C=self-harden-demo-server-f-1; V=4; B=http://127.0.0.1:8086; FIX=src/Eccube/Service/TwoFactorAuthService.php;;
  server-g) C=self-harden-demo-server-g-1; V=3; B=http://127.0.0.1:8087; FIX=src/Eccube/Form/Type/Admin/ProductType.php;;
  server-h) C=self-harden-demo-ec2-server-h-1; V=2; B=http://127.0.0.1:8088; FIX=data/class/pages/admin/contents/LC_Page_Admin_Contents_FileManager.php;;
  *) echo "server-d|server-f|server-g|server-h" >&2; exit 1;;
esac
R=/var/www/html
LOG=.cache/customize-$S.txt
case "$V" in
  4) FOOT=src/Eccube/Resource/template/default/Block/footer.twig; CLS=src/Eccube/Controller/TopController.php; PAGE=app/Customize/Controller/ShopNoteController.php; TPL=app/template/default/ShopNote/index.twig; URL=/shop_note;;
  3) FOOT=src/Eccube/Resource/template/default/Block/footer.twig; CLS=src/Eccube/Controller/TopController.php; PAGE=html/shop_note.php; TPL=; URL=/shop_note.php;;
  2) FOOT=data/Smarty/templates/default/footer.tpl; CLS=data/class/pages/LC_Page_Index.php; PAGE=html/user_data/shop_note.php; TPL=; URL=/user_data/shop_note.php;;
esac
FILES="$FOOT $CLS $FIX $PAGE $TPL"

if [ "$mode" = check ]; then
  bad=0
  while IFS="$(printf '\t')" read -r f h; do
    now=$(docker exec "$C" sh -c "sha256sum $R/$f 2>/dev/null | cut -d' ' -f1")
    if [ "$now" = "$h" ]; then echo "[$S] そのまま: $f"; else echo "[$S] 変わった: $f"; bad=1; fi
  done < "$LOG"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$B$URL?q=%3Cb%3Etest%3C%2Fb%3E")
  # 3 系は、点検でお店の名前以外の Host を断る守りが入ることがある。そのときはお店の名前で開き直す
  [ "$code" = 403 ] && [ "$V" = 3 ] && code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: server-g' "$B$URL?q=test")(Host: server-g)"
  echo "[$S] 独自のページ $URL: HTTP ${code}"
  exit $bad
fi

# a. フッターの文言(公式のファイルを書き換える)
if [ "$V" = 2 ]; then
  docker exec "$C" sed -i 's| All rights reserved\.| All rights reserved. (カスタマイズ: 送料のご案内はお問い合わせから)|' "$R/$FOOT"
else
  docker exec "$C" sed -i 's|all rights reserved\.|all rights reserved. (カスタマイズ: 送料のご案内はお問い合わせから)|' "$R/$FOOT"
fi
# a. PHP のクラスに説明のコメント(動きは変えない)
docker exec "$C" sed -i '1a // カスタマイズ: トップページの表示は店舗の運用に合わせて調整している(デモ用の説明コメント)' "$R/$CLS"
# b. 修正版が直すファイルに、直しとは関係のないコメント行
docker exec "$C" sed -i '1a // カスタマイズ: 管理画面の運用メモ(デモ用。修正版の直しとは関係のない行)' "$R/$FIX"

# c. 安全な独自のページ
T=.cache/customize-$S
rm -rf "$T" && mkdir -p "$T"
case "$V" in
4)
  cat > "$T/page" <<'PHP'
<?php
// カスタマイズ: 商品名で数を数えるだけの小さなページ(外から来た値は Twig が escape、DB にはパラメータで渡す)
namespace Customize\Controller;

use Eccube\Controller\AbstractController;
use Eccube\Entity\Product;
use Eccube\Repository\BaseInfoRepository;
use Sensio\Bundle\FrameworkExtraBundle\Configuration\Template;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Annotation\Route;

class ShopNoteController extends AbstractController
{
    /** @var BaseInfoRepository */
    protected $baseInfoRepository;

    public function __construct(BaseInfoRepository $baseInfoRepository)
    {
        $this->baseInfoRepository = $baseInfoRepository;
    }

    /**
     * @Route("/shop_note", name="customize_shop_note", methods={"GET"})
     * @Template("ShopNote/index.twig")
     */
    public function index(Request $request)
    {
        $q = mb_substr((string) $request->query->get('q', ''), 0, 50);
        $count = $this->entityManager->createQueryBuilder()
            ->select('COUNT(p.id)')
            ->from(Product::class, 'p')
            ->where('p.name LIKE :q')
            ->setParameter('q', '%'.addcslashes($q, '%_\\').'%')
            ->getQuery()
            ->getSingleScalarResult();

        return ['q' => $q, 'count' => (int) $count, 'shop' => $this->baseInfoRepository->get()->getShopName()];
    }
}
PHP
  cat > "$T/tpl" <<'TWIG'
{# カスタマイズ: 商品名で数を数えるだけの小さなページ #}
{% extends 'default_frame.twig' %}
{% block main %}
<div class="ec-role">
  <h1>{{ shop }} のお知らせ</h1>
  <p>「{{ q }}」を名前に含む商品: {{ count }} 件</p>
</div>
{% endblock %}
TWIG
  docker exec "$C" mkdir -p "$R/app/Customize/Controller" "$R/app/template/default/ShopNote"
  docker cp "$T/page" "$C:$R/$PAGE"
  docker cp "$T/tpl" "$C:$R/$TPL"
  ;;
3)
  cat > "$T/page" <<'PHP'
<?php
// カスタマイズ: 店の営業日のお知らせを出すだけの小さなページ(外から来た値は htmlspecialchars で escape)
$q = isset($_GET['q']) && is_string($_GET['q']) ? mb_substr($_GET['q'], 0, 50) : '';
$h = function ($s) { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); };
header('Content-Type: text/html; charset=UTF-8');
?>
<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>営業日のお知らせ</title>
<h1>営業日のお知らせ</h1>
<p>土日祝はお休みです。お問い合わせの件名: <?php echo $h($q); ?></p>
</html>
PHP
  docker cp "$T/page" "$C:$R/$PAGE"
  ;;
2)
  cat > "$T/page" <<'PHP'
<?php
// カスタマイズ: 商品名で数を数えるだけの小さなページ(DB にはプレースホルダーで渡し、出すときは htmlspecialchars)
require_once '../require.php';
$q = isset($_GET['q']) && is_string($_GET['q']) ? mb_substr($_GET['q'], 0, 50) : '';
$objQuery = SC_Query_Ex::getSingletonInstance();
$like = '%' . addcslashes($q, '%_\\') . '%';
$count = $objQuery->count('dtb_products', 'del_flg = 0 AND name LIKE ?', array($like));
$shop = $objQuery->get('shop_name', 'dtb_baseinfo', 'id = ?', array(1));
$h = function ($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); };
header('Content-Type: text/html; charset=UTF-8');
?>
<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>お知らせ</title>
<h1><?php echo $h($shop); ?> のお知らせ</h1>
<p>「<?php echo $h($q); ?>」を名前に含む商品: <?php echo (int) $count; ?> 件</p>
</html>
PHP
  docker cp "$T/page" "$C:$R/$PAGE"
  ;;
esac
docker exec "$C" sh -c "chown www-data:www-data $R/$PAGE ${TPL:+$R/$TPL}; chown -R www-data:www-data $R/app/Customize $R/app/template 2>/dev/null || true"

# テンプレートとルートのキャッシュを捨てる
case "$V" in
  4) docker exec -u www-data "$C" sh -c "cd $R && php -d memory_limit=-1 bin/console cache:clear --no-warmup >/dev/null 2>&1 || rm -rf var/cache/prod";;
  3) docker exec -u www-data "$C" sh -c "cd $R && php -d memory_limit=-1 app/console cache:clear --all >/dev/null 2>&1 || true";;
  2) docker exec "$C" sh -c "rm -rf $R/data/Smarty/templates_c/default/* 2>/dev/null || true";;
esac
sleep 3

# 控え
: > "$LOG"
for f in $FILES; do
  h=$(docker exec "$C" sh -c "sha256sum $R/$f | cut -d' ' -f1")
  printf '%s\t%s\n' "$f" "$h" >> "$LOG"
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$B$URL?q=test")
top=$(curl -s -o /dev/null -w '%{http_code}' "$B/")
echo "[$S] カスタマイズを入れた(控え: $LOG)。独自のページ $URL: HTTP ${code}、トップ: HTTP ${top}"
