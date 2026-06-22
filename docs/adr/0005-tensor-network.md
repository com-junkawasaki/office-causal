# ADR-0005: コーパスを 4 階層 tensor network として表現する

- Status: Accepted
- Date: 2026-06-22
- Context: `com-junkawasaki/office-causal`（ADR-0001 の CausalGraph IR を複数文書へ拡張）

## 背景

単一文書は ADR-0001 の `CausalGraph`（contains / references / derives-from / mentions / causes）で表せる。
しかし実務では **複数文書のコーパス**（デッキ・レポート・モデル）にまたがって因果が連鎖する
（例: KPI トラッカーの「市場シェア」→ デッキの「売上」→ PL モデルの「営業利益」）。
これを「文書 → ページ → オブジェクト → 因果」の階層と **文書横断の因果**を含めて
1 つの縮約可能な構造として扱いたい。tensor network のメタファ（ノード=テンソル、
エッジ=bond、bond 次元 χ）が、多層・多文書の依存をそのまま表現できる。

## 決定

### D1. 4 階層: Document → Page → Object → Causal

`NodeKind` を層へ写像する（`src/tensor/network.ts` の `LAYER_OF`）:
- document → **document**
- slide / sheet / section → **page**
- shape / cell / paragraph / range / chart / table / image → **object**
- entity / claim → **causal**

docx には構造上のページノードが無いため、論理ページ/節を表す `NodeKind` **"section"** を追加した
（実 OOXML パーサは段落フラットのままで、コーパス fixture が section を持つ）。

### D2. ノード = テンソル、エッジ = bond、bond 次元 χ

- ノードの **rank** = incident bond 数（物理脚があれば +1）。
- **物理インデックス次元** physDim = ノード固有の特徴次元（タグ数。無ければ 1）。
- **bond 次元 χ** は種別で決める: 構造 `contains`/`references`/`derives-from`/`mentions` = 1、
  **`causes` = 3**（極性 `+/-/?` を符号化）。
- 自由度の目安 **χ-params = Σ_node physDim · Π_(incident bond) χ**。

### D3. 因果ノードの文書帰属と cross-doc 判定

`entity`/`claim` は contains 連鎖に乗らないため、それを **mention するオブジェクトの所属文書**へ帰属させる
（`resolveDocOf` の mentions フォールバック）。`causes` / 同概念 `references` が別文書の entity 間を結べば
**crossDoc** と判定し、`causalComponents`（causes/references による連結成分数）と `crossDocCauses` を集計する。

### D4. 数値縮約はしない（構造表現のみ）

本 ADR では tensor network を **構造として** 扱い、数値テンソルの縮約は行わない。
代わりに min-degree（最小 rank）消去による **縮約順序ヒント** (`contractionOrder`) だけを提供する。
将来、埋め込みベクトルを物理脚に載せて実縮約する余地を残す。

### D5. 可視化と可搬出力

`renderTensorNetworkSvg(tn)` が 4 バンドの層状ノードリンク図を描く
（contains=灰 / references=青 / mentions=紫 / causes=緑(+)赤(−)、cross-doc causes は太破線）。
`tensorNetworkToJson(tn)` で JSON 出力。

## 帰結

- ✅ コーパス横断の因果を 1 つの多層グラフで俯瞰でき、文書間の間接因果が可視化される。
- ✅ サンプル（3 pptx×10 + 3 docx×3 + 3 xlsx×3 → `scripts/gen-sample-data.mjs`）で
  **210 nodes（doc 9 / page 48 / object 114 / causal 39）/ 339 bonds / 1 causal component /
  5 cross-doc causes** を確認。実 OOXML は自前パーサで round-trip 検証（9/9）。
- ⚠ object 層はノード数が多く図が横長になる（要約ビューは将来課題）。
- ⚠ docx の section は fixture 側の論理ノードで、実 OOXML パース結果とは粒度が異なる。

## 参考

- `src/tensor/network.ts`（`toTensorNetwork` / 統計 / 縮約順序）
- `src/visual/tensor-svg.ts`（`renderTensorNetworkSvg`）
- `scripts/gen-sample-data.mjs` + `scripts/lib/ooxml-write.mjs`、`examples/sample-data/`
