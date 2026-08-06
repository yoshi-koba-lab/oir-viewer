# OIR Viewer

オリンパス `.oir` の顕微鏡画像スタック（および `.oib` / `.oif` / `.tif` / `.nd2` /
`.lif` / `.czi`）を開くビューアです。マルチチャンネルの Z スタックを手早く見て、
そのまま図に使える画像を書き出すことを目的に作っています。

- **2D** — チャンネルごとの LUT とコントラスト。カーソル位置の画素座標と、
  表示中の全チャンネルの生強度を同時に表示します。
- **Z** — 左端の縦スライダー（上が最初のスライス）、矢印キー、MIP。
- **Split** — チャンネルごとに 1 パネル＋マージ。
- **Compare** — 複数ファイルを並べて表示。パン・ズームは全同期／パネル個別を
  切り替え可能。Z と MIP の選択は共有され、ファイルごとの深さに合わせて
  クランプされます。ドラッグで並べ替えできます。
- **3D** — レイマーチングによるボリューム表示。角度を数値入力でき、表示する
  Z 範囲を指定でき、XY / YZ / XZ 面のプリセット、そして「表示中の条件で保存」
  で PNG / TIFF に書き出せます（MERGE とチャンネル別の両方）。
- **書き出し** — チャンネル別・マージの TIFF / PNG / JPEG、Z 投影の OME-TIFF、
  ROI のラインプロファイルと面積計測。
- **Plate** — オリンパス MATL 撮影のフォルダを読み、`matl.omp2info` から
  プレート形状（未取得ウェルも含む）とウェルごとの Stitch 済みファイルを
  一覧します。ウェルを選んで開けます。ウェルの位置はラベルとステージ座標の
  独立した2つの情報から二重に検証します。
- **スケールバー** — どのビューでも画像の左下から始まり、パンとズームに追従
  します。ドラッグで好きな位置へ移動、ダブルクリックで左下に戻ります。長さ
  （または自動）・色・表示の有無は全ビュー共通の設定なので、図を揃えるときに
  1 本のバーで済みます。ラベルは Arial です。

## アップデート通知

起動時に GitHub の Releases を1回だけ確認し、新しいバージョンがあれば画面上部に
知らせます。**これがこのアプリで唯一の外部通信**です。送信するのは使用中の
バージョン番号だけで、画像・ファイル名・パスは一切送りません。

確認できないとき（オフライン、プロキシ、GitHub 側の障害）は**何も表示せず黙って
続行**します。結果は6時間キャッシュされます。通知は「×」で消せ、そのバージョンに
ついては二度と出ません。

通信させたくない場合は、`backend/main.py` の `update_check` が使う
`RELEASES_API` への接続をファイアウォールで塞いでください。動作に影響はありません。

## 不具合が起きたとき

バックエンドの出力は起動ごとに `~/.oir-viewer/logs/backend-<日時>.log` に保存され
ます（Windows なら `C:\\Users\\<ユーザー名>\\.oir-viewer\\logs\\`）。直近10件が残ります。
メニューの **ヘルプ → ログフォルダを開く** からも辿れます。

エラーを報告いただくときは、このログを添えていただけると原因が特定できます。

## 知っておいたほうがいい挙動

**コントラストは撮影時のまま開きます。** 顕微鏡が記録した表示レンジ（LUT の
shadow / highlight）をファイルから読み、データのビット深度に合わせて変換して
います。オートストレッチではなく、顕微鏡の画面で見たとおりに開くためです。
`Auto` / `Auto All` を押すとパーセンタイルによる自動コントラストに切り替わり
ます。

ただし、**LUT がビット深度の全域を占めているファイルは、定義上そのまま眠い
画像として開きます**。これは誰も LUT を触らずに撮ったときに記録される値です。
その場合は `Auto` が手っ取り早い解決です。

Min / Max のスライダーとヒストグラムは、宣言されたビット深度ではなく
**チャンネルごとの実データの尺度**に合わせて目盛りが決まります。12 bit と記録
されていても実データが 0〜600 程度なら、スライダーの大半が無効にはなりません。

**分割された `.oir` を検出します。** オリンパスは 1 GB を超えるデータセットを
`<名前>.oir` と、拡張子のない `<名前>_00001`, `_00002`, … に分割します。`.oir`
だけを開いても一見動きますが、**スタックの一部しか見えません**（例: 50 枚中
13 枚）。本ビューアはこれを検出して警告します。**Open** から元の保存場所の
ファイルを指定してください。付随ファイルが一緒に読み込まれます。ドラッグ＆
ドロップでは付随ファイルを持ち込めません。

## インストール

[Releases](../../releases) からお使いのプラットフォーム用のインストーラを
ダウンロードしてください。それ以外に必要なものはありません。Python と Java は
同梱されているので、別途の準備は不要です。

- macOS: `OIR Viewer-<version>-arm64.dmg`（Apple シリコン）または `-x64.dmg`（Intel）
- Windows: `OIR Viewer Setup <version>.exe`

### 初回起動時

コード署名をしていないため、OS が一度だけ「開発元が確認できない」旨の警告を
出します。想定どおりの動作で、アプリ自体の問題ではありません。

- **macOS** — ダブルクリックすると「開発元が未確認のため開けません」と出ます。
  代わりに**アプリを右クリック（または Control + クリック）→ 開く → 開く**を
  選んでください。必要なのは初回だけです。最近の macOS では、システム設定 →
  プライバシーとセキュリティ → *このまま開く* にボタンが出ることがあります。
- **Windows** — SmartScreen が「WindowsによってPCが保護されました」と表示
  します。**詳細情報 → 実行**を選んでください。

初回起動は 2 回目以降より数秒長くかかります。同梱の Java 実行環境をそのとき
初期化するためです。

## ソースから動かす

```bash
# バックエンド
python3 -m pip install -r backend/requirements.txt
python3 backend/main.py --no-webview        # 選ばれたポート番号が表示されます

# フロントエンド（別ターミナル）
cd frontend && npm install && npm run dev
```

バックエンドは空いているポート（8765 以降）を選び、`frontend/.backend-port` に
書き出します。Vite の開発用プロキシがそれを読むので、8765 が既に使われていても
設定を書き換える必要はありません。

一度ビルドしてバックエンドに配信させることもできます。配布版と同じ構成で、
プロセスもポートも 1 つ、プロキシなしです。

```bash
cd frontend && npm run build
python3 backend/main.py --no-webview        # 表示された URL を開く
```

## デスクトップアプリのビルド

`.oir` の読み込みには Java が必要（Bio-Formats）なので、JRE と Bio-Formats の
jar をビルドに同梱します。`stage_runtime.py` は通常の読み込み経路を一度実行し、
そこで解決されたものをコピーしてきます。

```bash
python3 scripts/stage_runtime.py            # → backend/runtime（約 155 MB）
(cd frontend && npm ci && npm run build)
pyinstaller backend/oir-viewer-backend.spec --noconfirm --distpath dist --workpath build
(cd desktop && npm install && npx electron-builder)
```

インストーラは `release/` に出力されます。`backend/runtime/` は生成物なので
git 管理外です。

Mac 用アプリを Windows で（またはその逆で）ビルドすることはできないため、
[`.github/workflows/build.yml`](.github/workflows/build.yml) が各プラット
フォームをそれぞれのランナーでビルドします。`v*` タグを push すると
インストーラが Release に添付されます。

## 構成

```
backend/     FastAPI: 画像を読み、スライスをバイナリで配信し、書き出しを行う
             main.py      API・静的配信・ポート選択
             reader.py    Bio-Formats / TIFF の読み込み、JVM 起動、メタデータ
             processor.py コントラスト、ヒストグラム
             roi.py       ラインプロファイル、ROI 統計
frontend/    React + Vite + Tailwind + zustand。Canvas2D、3D は three.js
desktop/     Electron シェル: バックエンドを起動し、ウィンドウを開く
scripts/     stage_runtime.py
```

アプリが書き出すデータは `~/.oir-viewer/` に置かれます（`session.json` が開いて
いたファイルを記憶し、`uploads/` にドロップされたファイルが入ります）。

## ライセンス

Copyright (c) 2026 yoshi-koba-lab. All Rights Reserved.

本ソフトウェアの再配布・ミラーリング・派生物の公開・第三者ホスティングは、
著作権者の書面による事前許可なく禁止します。詳細は [LICENSE](LICENSE) を
ご覧ください。個人での閲覧・ローカル実行・研究目的での利用は自由です。

Redistribution, mirroring, publishing derivative works, and third-party hosting
are prohibited without the copyright holder's prior written permission; see
[LICENSE](LICENSE). Viewing, running it locally, and research use are free.

同梱している第三者ソフトウェア（Bio-Formats、Azul Zulu JRE、Python および npm
の各依存パッケージ）は、それぞれのライセンスに従います。
