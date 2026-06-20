# ADR-0002: transformers.js ローカル小型モデルでエッジ重み付け・data-id タグづけ

- Status: Accepted
- Date: 2026-06-20
- Context: `com-junkawasaki/office-causal`

## 背景

ADR-0001 で因果エッジの裁定を Claude (verify) に委ねた。しかし全ノード対・全エッジに
クラウド LLM を呼ぶのはコスト・レイテンシ的に非現実的。一方、構造/参照/依存エッジには
「意味的にどれだけ強いか」の指標が無く、causal 候補生成も Claude 任せだった。

要件:
1. 各エッジに**意味的強度 (weight)** を安価に付けたい（"edge の小さい LLM weight"）。
2. data-id 単位で**タグ**を付け、分類・フィルタ・可視化に使いたい。
3. Claude を呼ぶ前に**候補エッジをローカルで一次選別**したい。
4. API キー無し・オフラインでも壊れないこと。

## 決定

### D1. ローカル小型モデルは transformers.js (`@huggingface/transformers`)

feature-extraction パイプライン（既定 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`,
量子化 q8）を**動的 import で遅延ロード**。日本語含む多言語に対応。ONNX 実行で
API キー不要・ローカル完結。これを「小さい LLM」と位置づけ、クラウド Claude と階層化する。

### D2. weight = 端点ノード埋め込みのコサイン類似度

エッジ両端がテキストを持つとき、埋め込みコサインを `edge.weight` (0..1) に格納。
構造・参照・依存・意味の全エッジに統一指標が乗り、DOT では penwidth に反映。

### D3. 埋め込みは「無向の意味的親和度」、向き・極性・採否は Claude

埋め込み類似は対称（A↔B 同値）なので、`proposeEdges` は候補と weight のみを出す。
**因果の向き (cause→effect)・極性 (+/-)・最終採否は Claude verify** が担う (ADR-0001 D5)。
役割分担: ローカル = 安価な広域スクリーニング / Claude = 高価で精密な裁定。

### D4. data-id タグづけは語彙とのローカル zero-shot

語彙ラベル（既定: 売上/コスト/利益/リスク/施策/市場/時間/主体/KPI）を埋め込み、
各ノード埋め込みと最近傍を閾値以上だけ `meta.tags` に付与し data-id に紐づける。

### D5. 決定論ハッシュ埋め込みへ自動フォールバック

モデル未導入/DL 失敗時は文字 trigram ハッシュ埋め込み (`HashEmbedder`) に落ちる。
CI・オフラインでもパイプラインが止まらない（weight は付くが意味的精度は出ない）。
`@huggingface/transformers` は **optionalDependency**。

## 帰結

- ✅ Claude 呼び出し前に候補を絞れる → コスト削減。
- ✅ 全エッジに意味的 weight、全ノードに data-id タグ。多言語対応。
- ✅ オフライン安全（フォールバック）。
- ⚠️ 対称類似ゆえ候補は双方向に出る → 向きは Claude が決める前提（D3）。
- ⚠️ 量子化小型モデルの精度限界。重要判断は必ず Claude verify を通す。

## 検証 (実測)

日本語 docx 4 段落で `Xenova/paraphrase-multilingual-MiniLM-L12-v2` を実行:
- タグ: ¶「売上が増加」→ `#売上・収益`、¶「原材料費の高騰でコスト上昇」→ `#コスト・費用`、
  ¶「競合の値下げ」→ `#市場・競合`（全段落で妥当）。
- 候補 weight: コスト関連 ¶↔¶ = 0.545、競合→利益 = 0.548 と意味的に妥当な順位。
