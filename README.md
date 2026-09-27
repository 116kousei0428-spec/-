# 野球ハンデ精算 PWA v0.2 Shared

## この版の目的
Cloudflare Pages の同じURLを開いた全員が、同じ試合・同じ賭け・同じ結果・同じ精算画面を共有します。
利用者側でFirebase設定を入力する必要はありません。

## 共通データ構成
- アプリ本体: Cloudflare Pages
- 共通保存: Firebase Realtime Database
- 使用DB: BLOW2ndで使用しているRealtime Database
- 野球アプリ専用パス: `/baseball_handicap_shared_v1`
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

誰かが更新するとFirebaseへ保存され、他端末もRealtime Databaseの更新通知を受けて再読込します。

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
