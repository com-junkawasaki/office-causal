# office-causal

**日本語** | [English](README.md)

[![CI](https://github.com/com-junkawasaki/office-causal/actions/workflows/ci.yml/badge.svg)](https://github.com/com-junkawasaki/office-causal/actions/workflows/ci.yml)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-%40com--junkawasaki%2Foffice--causal-2188ff?logo=github)](https://github.com/com-junkawasaki/office-causal/pkgs/npm/office-causal)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **MS Office (OOXML) の全 XML を TypeScript で「因果グラフ (causal graph)」として扱えるようにする**ライブラリ + LangGraph.js アプリ。各 XML 要素に安定した `data-id` / `meta` を付与し、構造 → 参照・依存 → **因果**グラフへ段階的に持ち上げる。

**▶ [ライブ WebGPU デモ & ドキュメントサイト](https://com-junkawasaki.github.io/office-causal/)** — `.xlsx/.pptx/.docx` をドロップするだけ。ブラウザ内で完結（API キー不要・データ外部送信なし）。

## クイックスタート

```bash
# 0) インストール不要で試す: Chrome/Edge でデモを開き、ファイルをドロップ → Run → 診断 → so-what
#    https://com-junkawasaki.github.io/office-causal/

# 1) CLI — 解析してグラフ + 解析結果をファイルに埋め込む
npx @com-junkawasaki/office-causal analyze  report.pptx            # → CausalGraph (JSON, 標準出力)
npx @com-junkawasaki/office-causal embed    report.pptx --analysis  # → report.ocz.pptx
npx @com-junkawasaki/office-causal diagnose report.ocz.pptx --gemma # 独立 / 成立しない / 表記揺れ / 概念のとび
npx @com-junkawasaki/office-causal consult  report.ocz.pptx --mece  # so-what + MECE
```
```ts
// 2) ライブラリ — Gemma 4 のみ・完全ローカル（クラウド非依存）。Node は device:"cpu"
import { analyze, embedFile, readDataPart, diagnose } from "@com-junkawasaki/office-causal";

const graph = await analyze("report.pptx", { llm: { device: "cpu", verify: false } });
const dx    = await diagnose(graph, { gemma: true });
await embedFile("report.xlsx", { mode: "part" });                 // → report.ocz.xlsx（正常な OOXML）
const data  = readDataPart(new Uint8Array(fs.readFileSync("report.ocz.xlsx")));
```

CLI サブコマンド: `analyze | graph | embed | locate | diagnose | consult`。

---

## インストール（GitHub Packages）

```bash
# プロジェクトの .npmrc にスコープのレジストリと認証を設定
echo "@com-junkawasaki:registry=https://npm.pkg.github.com" >> .npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc   # read:packages 権限の PAT

npm install @com-junkawasaki/office-causal
```
```ts
import { analyze, embedFile, readDataPart, WebGpuGemmaAdjudicator } from "@com-junkawasaki/office-causal";
```

> **MS Office (OOXML) の全 XML を TypeScript で「因果グラフ (causal graph)」として扱えるようにする**ライブラリ + LangGraph.js アプリ。
>
> `pptx` / `xlsx` / `docx` の各 XML 要素に **安定した `data-id`** と **`meta`** を付与し、構造グラフ → 参照・依存グラフ → **因果 (causal) グラフ** へと段階的に持ち上げ、LLM エージェント (LangGraph.js) で因果仮説の抽出・検証・分析を行う。

- org: `com-junkawasaki`
- 兄弟プロジェクト: **`svgraph`**（旧 drawingml-svg, DrawingML/PresentationML → SVG, EMU_PER_PX=9525）。スクショ描画(§7.6)に連携

---

## 1. 何を解くか

Office ドキュメントは「人間向けの最終成果物」だが、その中には膨大な**暗黙の因果構造**が埋もれている。

- xlsx: セル `B2` は数式 `=A2*1.1` で `A2` に**依存**する → さらに「売上が伸びた**から**利益が増えた」という業務上の因果。
- pptx: スライド 5 のグラフは xlsx のレンジを**参照**し、スライド 6 の結論テキストは「KPI 低下の**原因は**競合の値下げ」と**主張**する。
- docx: 段落 12 は図表 3 を**参照**し、「コスト増の**要因**は原材料高騰」と**述べる**。

これらを **1 つの有向グラフ**（ノード = Office 要素 / 派生エンティティ、エッジ = `contains` / `references` / `derives-from` / `mentions` / **`causes`**）として統一的に扱えるようにするのが本プロジェクトのゴール。

```
┌── ingest ──┐   ┌── identify ──┐   ┌── structural ──┐   ┌── semantic (LLM) ──┐   ┌── causal (LLM) ──┐
│ .xlsx/.pptx│ → │ data-id +    │ → │ contains /     │ → │ entity / KPI       │ → │ cause→effect     │
│ /.docx (zip)│  │ meta 付与    │   │ references /   │   │ extraction         │   │ hypothesis +     │
│            │   │ (決定論的)   │   │ derives-from   │   │ (mentions)         │   │ verify + score   │
└────────────┘   └──────────────┘   └────────────────┘   └────────────────────┘   └──────────────────┘
                                                                                          │
                                                                              CausalGraph (export: JSON / GraphML / Cypher)
```

---

## 2. アーキテクチャ

```
office-causal/
├── src/
│   ├── types.ts              # 全ドメイン型 (DataId, Meta, OoxmlNode, CausalGraph...)
│   ├── ooxml/
│   │   ├── opc.ts            # OPC(zip) パッケージ展開 + リレーション解決
│   │   ├── parse.ts          # XML → 汎用 AST (OoxmlNode tree)
│   │   └── parts/
│   │       ├── pptx.ts       # スライド/シェイプ/グラフ参照の抽出
│   │       ├── xlsx.ts       # シート/セル/数式依存の抽出
│   │       └── docx.ts       # 段落/テーブル/図表参照の抽出
│   ├── id/
│   │   ├── inject.ts         # data-id + meta の決定論的付与 (非破壊 sidecar)
│   │   └── hash.ts           # stable content hash
│   ├── graph/
│   │   ├── model.ts          # CausalGraph データ構造 + 操作
│   │   ├── builder.ts        # OoxmlNode → 構造/参照/依存エッジ
│   │   └── export.ts         # JSON / GraphML / Cypher / DOT 出力
│   ├── embed/                # ── transformers.js ローカル小型モデル ──
│   │   ├── model.ts          # 埋め込み (multilingual MiniLM) + ハッシュ fallback
│   │   ├── weight.ts         # エッジ weight 付与 / 候補生成 / weight 分析
│   │   └── tag.ts            # data-id への zero-shot タグづけ
│   ├── causal/
│   │   ├── analyze.ts        # DAG 化, 経路, 中心性, do-演算 lite
│   │   └── metrics.ts        # confidence 集計, 反例検出
│   ├── agent/                # ── LangGraph.js ──
│   │   ├── state.ts          # Annotation.Root による共有 state
│   │   ├── nodes.ts          # ingest/identify/structural/semantic/causal/verify
│   │   └── graph.ts          # StateGraph 配線 + checkpointer
│   └── index.ts
├── examples/analyze.ts       # 単一ファイル → CausalGraph のデモ
└── docs/adr/                     # 0001 IR / 0002 埋め込み / 0003 edge-LLM 階層 / 0004 OOXML 埋め込み
```

### レイヤ責務

| レイヤ | 入力 | 出力 | LLM |
|---|---|---|---|
| **OPC/parse** | `.xlsx/.pptx/.docx` (zip) | `OoxmlPackage` (part ごとの AST) | ✗ |
| **id/inject** | `OoxmlPackage` | `data-id` + `meta` 付き AST + sidecar `*.causal.json` | ✗ |
| **graph/builder** | identified AST | `CausalGraph`（構造/参照/依存エッジのみ） | ✗ |
| **embed** | グラフ + テキスト | エッジ `weight` + data-id `tags` + **無向の候補ペア** | ◍ ローカル小型 |
| **agent/semantic** | グラフ + テキスト | `Entity` ノード + `mentions` エッジ | ✓ |
| **agent/causal** | 候補ペア + 根拠 | `causes` 候補（向き・極性を**裁定**, evidence 付） | ✓ |
| **agent/verify** | causes 候補 | 採否 + confidence（敵対的検証） | ✓ |
| **causal/analyze** | `CausalGraph` | DAG / 経路 / 中心性 / 反例 | ✗ |

**設計原則**: 決定論的にできる層（構造・参照・依存）は LLM を使わず純関数で確定させ、**意味づけ・因果仮説のみ LLM** に任せる。これで再現性・コスト・検証可能性を担保する。

---

## 3. data-id と meta の付与

### 3.1 DataId — 決定論的で安定

ファイルを再保存しても（Office が要素順を変えても）同じ要素には同じ ID が付くように、**コンテンツアドレス指定**で生成する。

```
data-id = "ocz1:" + base32( blake3( partName + "/" + structuralPath + "|" + stableKey )[0..12] )
```

- `partName`: `ppt/slides/slide5.xml` など OPC 内パス
- `structuralPath`: ルートからの要素パス（名前空間 + ローカル名 + 同名兄弟 index）。例 `p:sld/p:cSld/p:spTree/p:sp[3]`
- `stableKey`: 要素固有の安定キー（`a:cell r:id`, `c:f` の数式文字列, `w:p` の正規化テキスト先頭 など）。順序変化に耐える。

→ 衝突は同 part 内で検出し index でディスアンビギュエート。ID は **`ocz1:` プレフィックス**で名前空間化（`office-causal zone 1`）。

### 3.2 Meta — 各ノードに必ず付く

```ts
interface Meta {
  kind: NodeKind;          // "slide" | "shape" | "cell" | "range" | "chart" | "paragraph" | "table" | "entity" ...
  part: string;            // OPC part name
  path: string;            // structuralPath
  label?: string;          // 人間可読ラベル（セル参照 "Sheet1!B2", スライドタイトル等）
  text?: string;           // 抽出テキスト（正規化済み）
  value?: string | number; // セル値など
  bbox?: BBox;             // pptx/docx の描画位置（drawingml-svg 連携）
  source: { app: "ppt"|"xls"|"doc"; ooxmlTag: string };
  provenance: string[];    // この meta を生成したパイプライン段（監査用）
}
```

### 3.3 非破壊で data-id/meta をファイルに埋め込む（実装済み）

元の `.xlsx/.pptx/.docx` を**壊さずに** data-id/meta を持たせる 2 方式（`src/ooxml/embed.ts`）。
data-id は決定論的なので、再埋め込みしても同じ要素には同じ id が付く（安定）。

| 方式 | 仕組み | 安全性 | 用途 |
|---|---|---|---|
| **part**（既定・推奨） | 既存パートを 1 バイトも変えず、zip 内に `ocz/causal.json`（id+meta+グラフ）を同梱。`[Content_Types].xml` に json Default を追記するのみ | ◎ Office は未参照パートを無視。**元パート byte 完全一致を検証済** | id/meta/因果グラフを「データ」としてファイルに同梱して持ち運ぶ |
| **attrs**（opt-in・実験的） | docx/pptx の要素に `ocz:id` を注入し、ルートに `xmlns:ocz` + `mc:Ignorable="ocz"` を宣言（markup-compatibility） | ○ 準拠アプリは ignorable 属性を無視し開ける。ただし Office 再保存で正規化・脱落しうる。xlsx セルは合成パスのため対象外（part を使う） | 各要素に inline で id を持たせたい場合 |

```bash
office-causal embed report.pptx --mode part          # → report.ocz.pptx (安全埋め込み)
office-causal embed report.docx --mode both          # part + 属性注入
```
```ts
import { embedFile, readDataPart } from "office-causal";
await embedFile("report.xlsx", { mode: "part" });    // → report.ocz.xlsx
const data = readDataPart(new Uint8Array(fs.readFileSync("report.ocz.xlsx"))); // 埋め込んだ id/meta/グラフを取得
```

**出力名**: 元の Office 拡張子を末尾に残す二重拡張子 → `report.pptx → report.ocz.pptx`、`.docx → .ocz.docx`、`.xlsx → .ocz.xlsx`。**実体は通常の OOXML** なので PowerPoint/Word/Excel でそのまま開ける。

**OPC 準拠で互換性最大化** (part 方式): 同梱パートを
(1) `[Content_Types].xml` に拡張子登録、(2) ルート `_rels/.rels` に正式なリレーションとして登録、(3) 既存データパートは無改変。未参照パートを作らないので Office でも確実に開く。

**実ファイルで検証済 (pptx / docx / xlsx すべて)**:
- xlsx: openpyxl 生成の**実 xlsx** に埋め込み → **openpyxl で再読込成功**（A2 数式・文字列セル取得）。既存データパートは byte 完全一致。
- pptx: **実 pptx**（drawingml-svg）に埋め込み → 全 XML パート整形式、再オープン可。
- docx: 正規 docx に埋め込み → 整形式・再オープン可。
- いずれも `readDataPart()` で同梱グラフを復元、`openPackage()` で再オープン可能を確認。
- attrs 方式（opt-in）: 実 pptx に `ocz:id`＋`mc:Ignorable`＋`xmlns:ocz` 注入（該当パートは再シリアライズ＝正規化リスクは残る）。

#### 同梱データの形式: JSON か JSONL か（既定 jsonl）

`embed --format jsonl|json` で選択。`readDataPart()` は両形式を自動判別。
**実測ベンチ**（`eval/embed-format-bench.ts`, 7201ノード/21242エッジの xlsx）:

| | JSON | JSONL（既定） |
|---|---|---|
| 構造 | 1ドキュメント `{meta,nodes,edges}` | 1行目 meta、以降 1ノード/エッジ=1行 |
| raw / gzip | 3914KB / **416KB** | 4219KB / 422KB（gzip後ほぼ同） |
| 全読込 | **22.8ms** | 33.6ms |
| 部分読み（1パートのnode） | 8.5ms | **6.5ms** |
| 追記（1ノード） | 12.9ms（全parse+stringify） | **~0ms（1行append）** |
| git 差分 | 無インデント=1行→**全体差分** | **1レコード=1行→局所差分** |

→ **既定は JSONL**（追記・部分読み・git 差分・監査/パイプライン志向に最適）。
**一発で全読みするだけ**なら JSON がやや速く小さい（gzip 後は同等）ので `--format json` も可。

#### data-id の安定性（差分更新）

data-id はコンテンツアドレス指定なので、**何度 embed しても不変要素には同じ id** が付く（`eval/verify-stability.ts` で実証）:
- 決定性: 同ファイル2回 embed → 同梱 jsonl 完全一致
- 冪等性: `.ocz` を再 embed → 内容一致・rel/CT 重複なし
- 差分更新: 1セル追加 → 既存 8 件の id 全保持・新規 1 件のみ追加（削除0）

#### 実 Office での確認

```bash
office-causal embed report.pptx                          # → report.ocz.pptx
node --import tsx eval/verify-ocz.ts report.ocz.pptx     # 構造プリフライト (全項目 ✅ を確認)
open report.ocz.pptx                                     # PowerPoint で通常どおり開く
unzip -p report.ocz.pptx ocz/causal.jsonl | head         # 同梱データを確認
```

#### `.ocz` を即描画 / 再解析スキップ（web も Node も）

- web デモに `.ocz.*` をドロップ → 同梱グラフを検出し **Gemma 再解析なしで即描画**（「✓ 埋め込み済み」表示）。
- Node/CLI も同様: `analyze("report.ocz.xlsx")` は埋め込みを検出して**即返す**（LLM 不使用）。強制再解析は `{ reanalyze: true }`。

#### 差分 embed（追記のみ・大規模/監査向き）

`embed --diff`（API `embedFile(f,{diff:true})` / `embedDataPartDiff`）は既存 `ocz/causal.jsonl` を**書き換えず、変更/新規/削除レコードだけ末尾に追記**（last-wins + 墓標）。既存行は prefix として保持 → **git 差分は追加行のみ**、巨大ファイルでも安価。検証: 既存 prefix 保持 ✓ / 1エッジ追加 → 1行のみ追記 / 読戻し last-wins ✓。

#### data-id → Office 上の位置 (deep-link)

`office-causal locate report.ocz.xlsx <data-id>`（API `locate(node)` / `deepLink(node,file)`）で要素の位置を取得:
- xlsx: `Sheet1!B1` + フラグメント `report.xlsx#Sheet1!B1`（Excel/LibreOffice でセルへジャンプ）
- pptx: `スライド N`
- docx: `embed --mode both`（attrs）で**Word ブックマーク**（名前 = `ocz1_<id>`）を段落に注入 → `report.docx#ocz1_…` で**段落ジャンプ**（検証: bookmark 名と deepLink 一致）
- **`locate --all` で全 data-id の deep-link を CSV 出力**（`id,kind,descriptor,deeplink`）

web パネルにも 📍 位置と（xlsx は）Excel 用リンクのコピーボタンを表示。`💾 .ocz` ボタンは
**File System Access API** で保存先を選んで書き込み（→ ダブルクリックで実アプリ起動）、非対応ブラウザはダウンロードにフォールバック。

---

## 4. CausalGraph データモデル

```ts
type EdgeKind =
  | "contains"      // 構造: slide → shape, sheet → cell（決定論的）
  | "references"    // 参照: chart → range, r:id 解決, hyperlink（決定論的）
  | "derives-from"  // 依存: cell B2 → A2（数式 AST 解析・決定論的）
  | "mentions"      // 意味: paragraph → entity（LLM）
  | "causes";       // 因果: entity/metric → entity/metric（LLM, 検証付き）

interface CausalEdge {
  id: string;
  kind: EdgeKind;
  from: DataId; to: DataId;
  // kind === "causes" のときのみ:
  causal?: {
    polarity: "+" | "-" | "?";      // 増加させる / 減少させる
    mechanism: string;               // 因果メカニズムの自然言語説明
    confidence: number;              // 0..1（verify 後の集計）
    evidence: Evidence[];            // 根拠となったノード(DataId)+引用
    lag?: string;                    // 時間差（"Q1→Q2" 等, 任意）
    status: "hypothesis" | "supported" | "refuted";
  };
}
```

→ `causes` エッジは必ず **evidence（どのノードのどの文言から導いたか）** を持つ。これにより「LLM がそれっぽく言っただけ」を排除し、**監査可能な因果グラフ**にする。

---

## 5. LangGraph.js パイプライン

`StateGraph` で以下を配線（`src/agent/graph.ts`）。**2 階層**（純関数 / ローカル Gemma 4）で構成し、**クラウド非依存・API キー不要**。`MemorySaver` checkpointer で再開可能にする。

```
START → ingest → structural → embed → semantic → causal → verify ─┬→ END
       └─ 純関数 ─┘      (transformers.js)  └── Gemma 4 ──┘     │
                                                  ↑              │
                                                  └─ (深掘りループ) ┘
```

- **ingest / structural**: 純関数（LLM 不使用）。zip 展開・data-id 付与・構造/参照/依存。
- **embed**: **transformers.js のローカル小型モデル**（§5.5）。API キー不要。weight・tags に加え、**因果候補ペアを一次選別**して causal 段へ供給。
- **semantic**: ローカル Gemma 4 構成では skip（causal 段が text ノード間で直接裁定するため entity 抽出は不要）。
- **causal / verify**: ローカル **Gemma 4**（`WebGpuGemmaAdjudicator`, transformers.js / WebGPU・WASM・CPU）。クラウド不使用。

### 5.6 ハイブリッド因果: 埋め込みで絞り、Gemma 4 が裁定

`causes` の候補空間は本来 O(n²)。全ペアを生成モデルに投げるとコストが爆発する。そこで:

1. **embed（ローカル小型）** が埋め込み類似で高親和ペアだけに絞り、対称ペアを**無向に dedup**（実測 8→4）。
2. **causal（Gemma 4）** は候補ペアごとに **「向き(a→b / b→a / none)・極性・メカニズム・evidence」だけを裁定**する。自由生成はしない → 呼び出しを大幅削減。
3. **verify（Gemma 4）** が各候補を独立 N 票で敵対的に反証し confidence を確定（`llm.verify:false` で省略可）。

役割分担は「埋め込み=広域スクリーニング / Gemma 4=精密裁定・検証」。すべてローカルで完結する。

### 5.7 ブラウザ WebGPU 実行（Gemma 4 E2B、API キー・サーバ不要）

役割②の裁定を **transformers.js v4 + WebGPU** でブラウザ内 Gemma 4 E2B として実行できる
（`src/llm/gemma-webgpu.ts` の `WebGpuGemmaAdjudicator`）。Ollama もクラウドも介さず、
**データがブラウザ外に出ない**ローカル因果分析。

- 公式 API 準拠: `AutoProcessor` + `Gemma4ForConditionalGeneration`、`dtype:"q4f16"`、`device:"webgpu"`、`apply_chat_template({ enable_thinking:false })`。
- 埋め込み（役割①）も `device:"webgpu"` 対応（`TransformersEmbedder(model, "webgpu")`）。
- **agent への配線**: causal/verify 段の裁定はつねにローカル Gemma 4 が担当（クラウド不使用）。
  `llm.verify:false` で敵対検証を省き裁定のみ commit（高速）。既定 `verify:true` では Gemma 4 が最終敵対検証も行う。
- **web デモ** (`web/index.html`): `.xlsx/.pptx/.docx` のドロップ or テキスト → OOXML 解析 → ①埋め込み選別 →
  ②Gemma 4 裁定 → **Cytoscape.js でインタラクティブ因果グラフ**（ズーム/パン/ドラッグ、causes=赤矢印+極性, derives-from=緑, 太さ=weight）。
  ノード/エッジをクリックすると**サイドパネルに本文・タグ・data-id・因果メカニズム・根拠**を表示。
  パネルの「▷ 同じパートのノードを強調」で **OOXML パート（スライドN / Sheet!セル / 本文）単位にグラフをジャンプ・ハイライト**。
  WebGPU 非対応時は警告バナーを出し、**wasm フォールバック**（E2B 固定・候補上限8・max_new_tokens=48）で最低限動作。office-causal の dist を import map 経由でそのまま再利用。
- **実機ベンチ** (`web/bench.html`): E2B vs E4B を WebGPU 実行し loadMs / ms・件 / tokens・秒 / 向き精度 / 極性精度 / JSON率 を計測（端末依存。各自の Chrome で実測）。

```bash
npm run build          # dist/ (web から再利用)
npm run build:web      # tsc -p tsconfig.web.json → web/app.js
npm run serve:web      # 静的配信。Chrome/Edge (WebGPU 有効) で開く
```

```ts
// 完全ローカル (API キー不要): 埋め込み選別 + Gemma 4 裁定。verify:false で敵対検証を省略
await analyze("Q1.pptx", {
  depth: "causal",
  llm: { device: "webgpu", verify: false }, // Node は device:"cpu"
});
```

```ts
import { WebGpuGemmaAdjudicator } from "office-causal";
const adj = new WebGpuGemmaAdjudicator({ model: "onnx-community/gemma-4-E2B-it-ONNX", device: "webgpu" });
await adj.judge(pairs); // [{from,to,polarity,mechanism}, ...] (none は除外)
```

**検証済み**: transformers.js v4 / Gemma 4 E2B (q4) で
`原材料価格が高騰 → 製造コストが上昇` を `{"direction":"A->B","polarity":"+","mechanism":"…直接引き起こした…"}`
と正しく裁定（ゴール一致）。WebGPU では同コードで数秒。

> 実行系メモ: transformers.js は **v4 から `gemma4` 対応**（v3.8.1 は `Unsupported model type: gemma4`）。
> Node では `device` は `cpu`/`coreml`/`webgpu`、ブラウザでは `webgpu`/`wasm`。
- **verify**: 各 `causes` 候補を独立 N 票で**反証**させ、多数が反証なら `refuted`。残りに confidence を付与（敵対的検証）。
- 大量ドキュメントは **map-reduce**（part/slide 単位で並列 semantic → 集約）。

> 生成系は単一構成: ローカル **Gemma 4**（既定 `onnx-community/gemma-4-E2B-it-ONNX`、E4B も可）。クラウド LLM は使用しない。

### 5.5 ローカル小型モデル層（transformers.js）— "edge の小さい LLM weight"

`embed` ノードは `@huggingface/transformers`（既定 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, q8 量子化, 多言語）で **API キー無し・ローカル完結**の分析を行う（ADR-0002）。

1. **エッジ重み付け** — 端点ノード埋め込みのコサイン類似度を `edge.weight`(0..1) に格納。構造/参照/依存/意味の全エッジに統一の「意味的強度」が乗る（DOT では penwidth に反映）。
2. **data-id タグづけ** — 語彙（既定: 売上/コスト/利益/リスク/施策/市場/時間/主体/KPI）とのローカル zero-shot で各ノードに `meta.tags` を付与し data-id に紐づける。
3. **ローカル候補生成** — 埋め込み類似で `mentions`/`causes` 候補を閾値抽出（Gemma 4 裁定の前の安価な一次選別）。

**役割分担**: 埋め込みは**無向の意味的親和度**を出す。**因果の向き・極性・採否はローカル Gemma 4** が裁定する（埋め込みだけでは A→B か B→A か決まらないため）。

**フォールバック**: モデル未導入/DL 失敗時は決定論ハッシュ埋め込みに自動で落ち、オフラインでもパイプラインが止まらない。`@huggingface/transformers` は optionalDependency。

```ts
const r = await analyze("report.docx", {
  embeddings: { model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
                tagTaxonomy: ["売上・収益", "コスト・費用", "市場・競合"],
                proposeKind: "causes", proposeThreshold: 0.4 },
});
r.weights();   // 種別ごとの weight 分布 + 強/弱エッジ上位
```

実測（日本語 docx）: ¶「売上が増加」→ `#売上・収益`、¶「原材料費の高騰でコスト上昇」→ `#コスト・費用`、候補 weight はコスト関連 ¶↔¶=0.545 と意味的に妥当（詳細 ADR-0002）。

---

## 6. 使い方（予定 API）

```ts
import { analyze } from "office-causal";

const graph = await analyze("./Q1-report.pptx", {
  llm: { device: "cpu" },  // ローカル Gemma 4 (ブラウザは "webgpu")
  embed: false,            // 既定: 非破壊 sidecar
  depth: "causal",         // "structural" | "semantic" | "causal"
});

graph.nodes;               // OoxmlNode[]（data-id + meta 付き）
graph.edges.filter(e => e.kind === "causes");
graph.export("graphml");   // | "json" | "cypher" | "dot"

// クロスファイル: pptx が参照する xlsx も束ねて 1 グラフに
await analyze(["deck.pptx", "model.xlsx"], { link: "cross-file" });
```

```bash
npx office-causal analyze Q1-report.pptx --depth causal --out q1.causal.json
npx office-causal graph q1.causal.json --format dot | dot -Tsvg > q1.svg
```

---

## 7. 段階的スコープ

- **v0.1 (MVP)**: OPC 展開 + 3 形式パース + data-id/meta 付与 + 構造/参照/依存グラフ + JSON export（**LLM なしで完結**）
- **v0.2**: LangGraph semantic（entity / mentions）+ causal 仮説
- **v0.3**: 敵対的 verify + causal/analyze（DAG・経路・中心性・反例）
- **v0.4**: クロスファイル連携 / `--embed` 往復 / GraphML・Cypher export / Web ビューア（`drawingml-svg` の web と統合）

---

## 7.5 因果の診断と可視化（diagnose / SVG）

pptx/xlsx/docx を解析し、因果を**視覚的に接続**しつつ次の 4 カテゴリを特定する（`src/analyze/diagnose.ts`）:

| カテゴリ | 意味 | 検出 |
|---|---|---|
| **独立 (isolated)** | 因果に一度も現れないノード | グラフ（causes 端点でない text/entity ノード） |
| **成立しない (notHolding)** | refuted / 低 confidence の因果 | causal.status / confidence<0.5 |
| **表記揺れ (notationVariants)** | 同概念・異表記（売上≈セールス 等） | 埋め込み高類似(≥0.9) かつ ラベル相違、用語粒度(entity/短ラベル)に限定 |
| **概念のとび (conceptJumps)** | 原因↔結果の意味的距離が大きい論理飛躍 | causes だが cosine(cause,effect)<0.3 |

**スクリーンショット風の可視化** (`src/visual/svg.ts`): 注釈付き SVG を生成。
- **pptx**: シェイプの `bbox`(EMU) を実配置し**スライド版面を再現**（検証: 実 pptx で 16 シェイプを実座標配置）
- **xlsx**: `Sheet!A1` をグリッド配置、**docx**: 段落を縦並び
- 因果=緑実線 / 成立しない=赤破線 / 概念のとび=紫破線⚡ / 表記揺れ=橙点線リンク / 独立=灰、で色分け＋凡例

```bash
office-causal diagnose report.ocz.pptx --svg report.diag.svg   # .ocz は causes 込みで診断
office-causal diagnose report.xlsx                              # 構造のみでも 独立/表記揺れ は出る
```

web デモの **🔍 診断** ボタンでも、Cytoscape グラフ上に 4 カテゴリを色分け表示＋一覧パネル。

### 7.5.1 コンサル分析（so-what / MECE）と大規模対応

- **so-what** (`consult()` / CLI `consult`): 因果連鎖 (root→…→sink) を辿り、**Gemma 4** で示唆と打ち手を生成。
  実測例: `原材料高騰→コスト上昇→値上げ→数量減` → 「コスト構造見直しと価格戦略再構築が急務」＋打ち手。
- **MECE** (`mece()`): ある結果の要因群について **ME(重複)=埋め込み高類似**、**CE(網羅)=Gemma 判定(欠落要因)**。
  実測: 要因「売上/セールス/コスト増」→ 重複[売上≈セールス] 検出、`exhaustive:false`。
- **大規模 (xlsx 数十万)**:
  - 決定論層（構造・数式依存DAG・isolated/notHolding）は **O(n)**（7,200セルで構造1.2s・診断2ms）。
  - 埋め込みは **数式/数値を除外**し NL のみ（7,200セルの意味診断 **49ms**）。
  - 表記揺れの全ペアは **LSH 近傍探索**で O(n²) 回避（3,000件→39ms, recall 5/5 実測）。`maxEmbed` 上限超過は `truncated` で明示。
  - so-what/MECE の生成は Gemma で**連鎖数・候補数を上限管理**。

```bash
office-causal consult report.ocz.pptx --mece --svg sowhat.svg   # so-what + MECE (+注記SVG)
```

### 7.6 svgraph（旧 drawingml-svg）連携 — svg-causal-graph

> 兄弟プロジェクトは **`svgraph`** に改名（Python モジュールも `svgraph`、CLI `dml2svg`・`EMU_PER_PX=9525` は不変）。
> 連携は `svgraph` を優先し旧 `drawingml_svg` にフォールバック。src パスは `--drawingml`/`OCZ_SVGRAPH`/`OCZ_DRAWINGML_SVG`/`../svgraph/src`/`../drawingml-svg/src` の順で解決。
> web デモは「グラフ / 因果ロール一覧」タブを持ち、ロール一覧は各 data-id の 原因→結果 / ←原因 / 依存元 / 利用先 / 診断を表で表示（行クリックで該当ノードへ、**🔍検索** と **CSV ⬇** 付き）。
>
> - **(c) so-what / MECE 合流**: 対話 HTML (`--html --consult`) のパネルに so-what 連鎖と MECE（重複/網羅不足/欠落）を併記。
> - **(d) glyph 厳密 box 自動化**: `resolveSlideRenderer` が **svgraph の TS `dml2svg`（環境変数 `OCZ_SVGRAPH_TS` で指定）を自動検知**し、あれば in-process（glyph 厳密 box）、無ければ Python に安全フォールバック（`renderer: ts-svgraph|python` をログ）。
> - **(e)(f)(h) ロール一覧**: 検索フィルタ + **列ソート**（ヘッダクリック ▲▼）+ **CSV ダウンロード（検索/ソート結果のみ）**。
> - **(g) web so-what/MECE ボタン**: 「💡 so-what / MECE（Gemma）」で WebGPU Gemma により so-what 連鎖 + MECE をその場算出しパネル表示。
> - **(i) so-what/MECE 書き出し**: パネルから **JSON / so-what CSV / MECE CSV** をダウンロード。
> - **(h)(k) 列ソート**: ラベル列は文字列順、役割/診断列は**項目数**順（▲▼）。
> - **(m) 解析結果の同梱**: `.ocz` 書き出し時に diagnose / so-what / mece を `analysis` として同梱（`embedDataPart(..,{analysis})`）。
>   `.ocz` を再ロードすると**再計算なしで診断色・so-what・MECE を即復元**（jsonl/json 両対応・往復検証済）。
> - **(n) CLI で解析同梱**: `embed --analysis [--gemma]` が diagnose（+so-what/MECE）を実行して `.ocz` に同梱（入力が .ocz なら同梱グラフの causes を使用）。
> - **(o) 整合チェック**: `validatePayload()` が version と **analysis の古さ**（診断ノードが現グラフに不在）を検出。CLI の analyze/diagnose/consult は `.ocz` 読込時に ⚠ 警告。
> - **(p) web 整合警告**: `.ocz` 再ロード時に `validatePayload` の警告をログ表示。
> - **(q) 解析メタ**: 同梱 analysis に `version` / `generatedAt`(ISO) / `models`(embed/gemma) を付与（再ロード時に表示）。


兄弟 [`drawingml-svg`](../drawingml-svg) が DrawingML/PresentationML → SVG を **`EMU_PER_PX=9525`** で描画し、
office-causal の bbox 換算（`px = EMU/9525`）と**座標系が完全一致**する。これを利用して、
**スライドを忠実描画した SVG（背景）に因果オーバレイ（ノード診断色＋causes エッジ）を同座標で重ねた
「svg-causal-graph」**を生成できる（`src/visual/drawingml.ts` + `overlayCausal`）。

```bash
# drawingml-svg を背景に、因果を重ねた合成 SVG を生成
office-causal diagnose report.ocz.pptx --svg out.svg --render --drawingml ../drawingml-svg/src
```
- `renderDrawingmlSvg(slideXml)` が drawingml-svg CLI(`dml2svg`) を子プロセス実行 → 忠実 SVG。
- `overlayCausal(baseSvg, graph, diag)` が `<g id="ocz-causal-overlay">` を同 viewBox に注入。
- **文字単位の box+label** (`--chars` / `overlayCharBoxes`): 描画 SVG の `<text>`/`<tspan>` を解析し、
  文字送り幅(CJK=1em/英=0.55em+letter-spacing)を推定して **1文字ずつ矩形**を描画。各文字が属する
  シェイプ(bbox 包含)の **data-id をラベル表示**＋診断色で着色（実測: "converts"→8文字boxを実座標配置）。
  `office-causal diagnose report.pptx --render --chars --drawingml ../drawingml-svg/src --svg out.svg`
  - **厳密 glyph box**: drawingml-svg(TS) が **1文字=1 `<tspan x>`** を出せば、その x を厳密採用（複数文字 tspan のみ送り幅近似）。移行後は描画器差し替えだけで精度向上。
- **対話ビューア** (`--html` / `renderInteractiveHtml`): 各要素に `data-ocz-id` を付与し、HTML に役割 JSON を埋込。
  **文字/シェイプ/ノードをクリック → サイドパネルに「文字 → data-id → 因果ロール（原因/結果/依存元 derives-from/利用先）＋診断（独立/表記揺れ/タグ）」**を表示（`buildNodeInfo`）。
  `office-causal diagnose report.pptx --render --chars --html --drawingml ../drawingml-svg/src --svg out.svg` → `out.html`
- `.ocz` は **bbox も同梱**するため、`.ocz` 単体から背景＋因果を再生成可能（再解析不要）。
- **検証**: 実 pptx で背景 viewBox `715.857×372` に実コンテンツ + overlay 16 ノードが同座標で重畳。

> 連携は opt-in（Python の drawingml-svg を子プロセス実行）。`--drawingml <src>` か環境変数 `OCZ_DRAWINGML_SVG` で
> src パスを指定。drawingml-svg の `svgraph`(SVG 内部依存グラフ) とは別レイヤ（こちらは業務因果）。

**レンダラは差し替え可能** (`type SlideRenderer = (xml) => string | Promise<string>`)。現状の既定は
`pythonDrawingmlRenderer`（Python 子プロセス, Node 専用）。**drawingml-svg の TS 移行が完了したら**、その
TS `dml2svg` を `renderSlideCausalSvg(xml, graph, diag, tsRenderer)` に注入するだけで Python 不要・in-process・
**ブラウザ(WebGPU デモ)でも背景描画**が可能になる（契約: 出力 SVG の viewBox は px = EMU/9525）。
※ drawingml-svg 側は現在 TS 移行中（まず SVGraph(SVG→IR) が TS 化、`dml2svg` 描画は移行待ち）。

## 8. 主要な設計判断（ADR）

- [ADR-0001](docs/adr/0001-causal-graph-ir.md) — 単一 CausalGraph IR / 決定論層と LLM 層の分離 / コンテンツアドレス data-id / evidence 必須の causal エッジ
- [ADR-0002](docs/adr/0002-local-embeddings.md) — transformers.js ローカル小型モデルでエッジ重み付け・data-id タグづけ
- [ADR-0003](docs/adr/0003-edge-llm-tiering.md) — edge-LLM の階層化（埋め込み → ローカル Gemma 4/WebGPU が裁定 + verify）。クラウド非依存、実測つき
- [ADR-0004](docs/adr/0004-ooxml-embedding.md) — data-id/meta の OOXML 非破壊埋め込み（OPC 準拠 part / attrs・bookmark / JSONL・差分 / deep-link）

要点:
1. **決定論層と LLM 層の分離** — 再現性・コスト・監査性。
2. **コンテンツアドレス指定の data-id** — 再保存・差分に強い安定 ID。
3. **非破壊埋め込み（OPC 準拠 part 既定）** — 通常の Office で開ける。
4. **evidence 必須の causal エッジ** — 幻覚因果の排除。
5. **単一 CausalGraph への統一** — 構造・参照・依存・意味・因果を 1 グラフで横断分析。
6. **edge-LLM の階層化（クラウド非依存）** — 埋め込みで絞り、ローカル Gemma 4 が裁定と最終 verify を担う。
