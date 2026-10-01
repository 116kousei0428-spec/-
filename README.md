# 野球ハンデ精算 PWA v5 Shared

## この版の目的
Cloudflare Pages の同じURLを開いた全員が、同じ試合・同じ賭け・同じ結果・同じ精算画面を共有します。
利用者側でFirebase設定を入力する必要はありません。

## 共通データ構成
- アプリ本体: Cloudflare Pages
- 共通保存: Firebase Realtime Database
- 使用DB: BLOW2ndで使用しているRealtime Database
- 野球アプリ専用パス: `/blow2nd/baseball_handicap`
- 端末内localStorage: 表示用キャッシュのみ

POS用データとは別パスなので、野球アプリの操作で既存POSの保存領域を上書きしない構成です。

## 全員共通になるもの
- 試合登録
- リーグ / チーム / ハンデ
- 客名 / 賭けチーム / 金額
- 試合結果
- ハンデ判定
- 客別精算
- 履歴
- 追加チーム

誰かが更新するとFirebaseへ保存され、他端末は約2.5秒間隔で共通データを再読込します。

## ハンデ
- 0.3 / 0.5 / 0.7 / 1 / 1.3 / 1.5 / 1.7 / 1半 / 1半3 / 1半5 / 1半7 / 2
- `1.5` と `1半` は別ID・別ルール
- 丸=100%、7分=70%、5分=50%、3分=30%、勝負無し=0%
- 金額端数は1円単位で四捨五入

## PWA
- manifest
- Service Worker
- standalone表示
- アイコン
- オフライン時は最後に取得したキャッシュを表示

注意: オフライン中は全員共通更新はできません。クラウド書込み失敗時は画面上部にエラー表示します。

## Cloudflare Pages
ZIPを展開し、`index.html` がリポジトリのルートになるようGitHubへ置いてCloudflare Pagesと接続してください。
静的サイトなのでビルドコマンドは不要です。

## Firebase側の前提
Realtime DatabaseのSecurity Rulesが、この野球アプリ専用パスへの読み書きを許可している必要があります。
既存POSと同じ公開読み書き方式が許可されていれば追加設定なしで動作します。拒否された場合は画面上部が「共通データ接続エラー / クラウド保存エラー」になります。


## v4 修正
- 現行POSと同じ Firebase Realtime Database URL (`blow-pos-default-rtdb...`) に修正。
- 保存先は POS の `blow2nd/tanegashima` と分離し、`blow2nd/baseball_handicap` を使用。
- 同期方式を現行POSに合わせて約2.5秒ポーリングへ変更。
- 接続失敗時に HTTP ステータス/エラー本文を画面上部へ表示。


## v4 ハンデ打ち込み式
- ハンデ欄を選択式から直接入力式へ変更。
- 0.1刻み: 0.1〜0.9 / 1.1〜1.9 を計算可能。
- 1半 / 1半1〜1半9 / 2 に対応。
- 旧データの 1H / 1H3 / 1H5 / 1H7 は自動互換。
- 入力中に「引分 / 1点差 / 2点差 / 3点差」の判定プレビューを表示。
- 1.5 と 1半は別ルールのまま。

現在の計算規則は、従来のハンデ表を0.1刻みに拡張したものです。私設の取り決めは運用元によって異なる場合があるため、実際の取り決めが異なる場合は計算マスターを合わせて変更してください。


## v5 ハンデ上限4.0対応
- 数値ハンデを `0.1`〜`4.0` の0.1刻みで直接入力できます。
- `2.3 / 2.5 / 3.7 / 4.0` などを自動計算します。
- 半系も `1半〜3半9` に拡張しています（例: `2半`, `2半3`, `3半7`）。
- `1.5` と `1半` は引き続き別ルールです。
- 2を超えるハンデは、既存の0〜2の表と同じ規則が繰り返されるという前提で一般化しています。実運用の取り決めが異なる場合は、そのルールに合わせて変更してください。

### 一般化した例
- `2.3`: 2点差勝ち=3分負け、3点差以上=丸勝ち
- `2.5`: 2点差勝ち=5分負け、3点差以上=丸勝ち
- `3.7`: 3点差勝ち=7分負け、4点差以上=丸勝ち
- `4.0`: 4点差勝ち=勝負無し、5点差以上=丸勝ち
- `2半3`: 2点差までは丸負け、3点差=7分勝ち、4点差以上=丸勝ち


## v6 input-sync fix
- Firebase polling no longer re-renders the app while an input/select/textarea or modal is being edited.
- Prevents typed handicap/bettor/amount/score values from disappearing during the 2.5-second shared-data poll.
- PWA cache key and app.js query version bumped to v6 so deployed clients receive the fix.
