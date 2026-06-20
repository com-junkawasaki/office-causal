# ADR-0004: data-id/meta を OOXML へ非破壊に埋め込む

- Status: Accepted
- Date: 2026-06-20
- Context: `com-junkawasaki/office-casual`（ADR-0001 D4 を具体化）

## 背景

通常の `.pptx/.docx/.xlsx` を**壊さずに** data-id/meta（および因果グラフ）を持たせ、
「データとして」再利用したい。要件: Office で確実に開ける / 安定 id / 取り出せる / 位置参照できる。

## 決定

### D1. 既定は OPC 準拠の「カスタムパート同梱」（part 方式）

zip 内に `ocz/casual.jsonl` を追加し、
(1) `[Content_Types].xml` に拡張子登録、(2) ルート `_rels/.rels` に正式なリレーション登録、
(3) **既存データパートは 1 バイトも変えない**。未参照パートを作らないため PowerPoint/Word/Excel でも開ける。

**実測**: openpyxl 生成の実 xlsx に埋め込み → openpyxl で再オープン成功、変更は Content_Types のみ。
実 pptx / 正規 docx でも全 XML 整形式・再オープン可。出力名は `report.ocz.pptx` 等（実体は通常の OOXML）。

### D2. 属性注入(attrs)・Word ブックマークは opt-in

docx/pptx 要素へ `ocz:id` を注入し、ルートに `xmlns:ocz` + `mc:Ignorable="ocz"`（markup-compatibility）。
docx は段落に Word ブックマーク（`ocz1_<id>`）も注入し `file.docx#ocz1_…` で段落ジャンプ可能。
**トレードオフ**: 該当パートを再シリアライズするため Office 再保存で正規化・脱落しうる。確実性が要れば part 方式。

### D3. 同梱形式は JSONL を既定（json も選択可）

`ocz/casual.jsonl`（1行目 meta、以降 1 ノード/エッジ=1 行）。**追記・部分読み・git 局所差分**に強い。
実測（7201ノード/21242エッジ）: JSONL は append ~0ms / 部分読み 6.5ms、JSON は全読込 22.8ms と raw サイズで勝るが gzip 後は同等。`readDataPart()` は両形式を自動判別。

### D4. 差分 embed（追記のみ）

`embedDataPartDiff` は既存 jsonl を書き換えず、変更/新規/削除レコードだけ末尾追記（last-wins + 墓標 `node-del`/`edge-del`）。既存行は prefix として残り、git 差分は追加行のみ。

### D5. 安定 id・冪等・再解析スキップ

data-id は決定論的（ADR-0001 D3）。実測: 2回 embed で同梱一致、`.ocz` 再 embed で重複なし、
1セル追加で既存 id 全保持・新規のみ。`analyze("x.ocz.*")` / web ドロップは埋め込みを検出し**再解析せず即復元**。

### D6. deep-link（locate）

`locate(node)` / `deepLink(node,file)` で data-id → 位置参照:
xlsx `file.xlsx#Sheet1!B2`（セルジャンプ）、docx `file.docx#ocz1_…`（ブックマーク）、pptx スライド番号。
`locate --all` で全 deep-link を CSV 出力。

## 帰結

- ✅ 元ファイルを壊さず id/meta/グラフを同梱し、`readDataPart` で取り出せる。
- ✅ 通常の Office で開ける（OPC 準拠・実バリデータで確認）。
- ✅ 安定 id により差分更新・監査・deep-link が成立。
- ⚠ attrs/bookmark は再シリアライズ由来の正規化リスクあり（part 方式が安全）。
- ⚠ xlsx 文字列セルは sharedStrings 解決が前提（実装済み, ADR 別途不要）。

## 参考

- `src/ooxml/embed.ts` / `src/locate.ts`、`eval/verify-ocz.ts` / `verify-stability.ts` / `embed-format-bench.ts`
- ECMA-376 / OPC、markup-compatibility (mc:Ignorable)
