# ADR-0001: Office OOXML を単一の Causal Graph IR として扱う

- Status: Accepted
- Date: 2026-06-20
- Context: `com-junkawasaki/office-causal`

## 背景

`pptx` / `xlsx` / `docx` は OPC (Open Packaging Conventions) zip に格納された複数 XML part の集合である。これらに横断する「因果構造」（数式依存、参照、業務上の原因→結果の主張）を機械可読にしたい。要件:

1. 全 XML 要素に **安定 `data-id`** と **`meta`** を付与する。
2. 構造・参照・依存・意味・因果を **1 つの有向グラフ**で扱う。
3. LLM で因果仮説を抽出しつつ **再現性・監査性**を確保する。

## 決定

### D1. 中間表現 (IR) は単一の `CausalGraph`

ノード = Office 要素 / 派生エンティティ。エッジ = `contains` / `references` / `derives-from` / `mentions` / `causes` の 5 種を持つ**型付き有向グラフ**を唯一の IR とする。各層はこの IR を**追記的に**充足していく（破壊的変換をしない）。

理由: 形式ごとに別モデルを持つと横断分析（pptx→xlsx 参照、docx→図表）が困難。単一 IR なら同一アルゴリズム（経路・中心性・DAG 化）を全形式に適用できる。

### D2. 決定論層と LLM 層を厳密に分離

`contains` / `references` / `derives-from` は**純関数**（zip 展開・XML パース・数式 AST 解析・OPC リレーション解決）で確定。`mentions` / `causes` のみ LLM。

理由: 構造を LLM に推測させると非決定的でコストも高く検証不能。確定可能なものは確定させ、本質的に曖昧な意味・因果だけに LLM を使う。

### D3. data-id はコンテンツアドレス指定 (`ocz1:` 名前空間)

`blake3(partName + structuralPath + stableKey)` を base32 で短縮。Office の再保存による要素順変化に耐える安定 ID。衝突は part 内 index でディスアンビギュエート。

却下案: 連番 ID（再保存で総崩れ）/ ランダム UUID（同一要素の追跡不能）。

### D4. 非破壊で data-id/meta を持たせる（実装は ADR-0004 へ発展）

当初: 「sidecar 既定 / `--embed` で属性注入 opt-in」。
その後 **ADR-0004** で具体化し、**OPC 準拠のカスタムパート同梱（part 方式）を既定**、属性注入(attrs)/Word ブックマークを opt-in とした。
data-id は決定論的（D3）なので再 embed しても安定。詳細・トレードオフ・実測は **ADR-0004** を参照。

理由: 署名・互換性・差分の安全性。OOXML への未知属性注入は Office 再保存で脱落しうるため既定にはしない。

### D5. `causes` エッジは evidence 必須

すべての因果エッジは `evidence: { nodeId, quote }[]` と `mechanism` を持ち、`status: hypothesis|supported|refuted` を辿る。verify 段で独立 N 票の**敵対的反証**を行い confidence を付与。

理由: LLM の「もっともらしい捏造因果」を排除し、人間が根拠を辿れる監査可能なグラフにする。

## 帰結

- ✅ 全形式を 1 アルゴリズム群で分析可能。
- ✅ MVP は LLM 無しで（D2）構造/参照/依存グラフまで完結 → 早期に価値検証。
- ✅ 因果エッジが監査可能（D5）。
- ⚠️ stableKey の形式別設計（D3）に実装コスト。形式ごとに `parts/*.ts` で吸収する。
- ⚠️ クロスファイル参照解決（pptx→外部 xlsx）は別途リンク解決器が必要（v0.4）。

## 参考

- ECMA-376 (OOXML) / OPC
- 兄弟: `com-junkawasaki/drawingml-svg`（DrawingML→SVG、bbox/描画 meta を相互利用）
- LangGraph.js `StateGraph` / Anthropic Claude
