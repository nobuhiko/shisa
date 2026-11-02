# self-harden

レンタルサーバーで動く EC-CUBE のお店に入れる、**自分で考えて守りを固める Agent** です。

自分の置かれたサーバーを自分で調べ、何が弱いか(PHP や部品の版、設定、見えてはいけないもの)を自分で考え、そのサーバーで本当に効く手を選んで守りを固めます。特定の脆弱性や回避策の答えは、プロンプトにもコードにも書いていません。

## 形

- `api/` 頭。Claude を呼び、次の一手を決め、店の受け口を 1 歩ずつ呼びます。店に Claude の API キーは置きません
- `plugin/` EC-CUBE 4.2 のプラグイン。店に素の PHP 1 枚の受け口を置き、API と鍵を交換し、管理画面に「点検」と「通知の URL を貼る」を出します
- `demo-servers/` 手元だけで動かす、脆弱性のあるデモ用サーバー(KAGOYA 風 / ロリポップ風)

つなぎ目は [docs/api.md](docs/api.md)、受け口の守り方は [docs/security.md](docs/security.md)、設計は [docs/design.md](docs/design.md)、決めたことの理由は [docs/decisions.md](docs/decisions.md) にあります。

Built with Claude: Japan 2026 の応募作品です。

## 作者

うみうしラボ(https://umiushi-lab.com )

## ライセンス

GPL-2.0-or-later([LICENSE](LICENSE))。EC-CUBE のライセンスに合わせています。
