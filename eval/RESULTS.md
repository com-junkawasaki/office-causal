# edge-LLM 評価結果 — office-causal

> 評価・採点・ゴール作成: **Claude (本セッション)**。日付: 2026-06-20。
> 実測環境: Apple Silicon (arm64) / 34GB RAM / 10 cores。
> データ: `eval/gold.ts`（日本語業務文 8、ゴール因果エッジ 8、非因果 3。Claude 作成）。
>
> 注 (2026-06-22): この計測はゴール採点に Claude を用いた**履歴記録**。**現行アーキテクチャは
> クラウド非依存**で、生成・裁定・検証はすべてローカル Gemma 4 が担う（ADR-0003 更新版を参照）。

office-causal の edge-LLM は **2 つの別クラス**のモデルに分かれる。混同しないこと:

| 役割 | モデル種別 | トークン生成 | タスク |
|---|---|---|---|
| **①** | **エンコーダ（埋め込み）** | ✗ できない | エッジ weight / data-id タグ / **因果候補ペアの一次選別** |
| **②** | **デコーダ（生成）** | ✓ できる | 因果の **向き・極性の裁定** + 説明 |

> 注: **e5 / bge / MiniLM / Qwen3-Embedding はエンコーダ**で、文の内容理解はベクトル類似までで、
> 「どちらが原因か」の判定や文生成はできない。それは役割②（Gemma4 / Qwen / Llama）の仕事。

---

## 役割① 埋め込み（候補選別 + タグ） — `eval/embed-bench.ts`

28 ペア中 8 正例（真の因果隣接）を類似度で surface できるかの検索問題 + タグ 8 件。

| モデル | サイズ | dim | AUC | AP | P@8 | R@8 | tagAcc | 評価 |
|---|--:|--:|--:|--:|--:|--:|--:|---|
| **multilingual-e5-base** | 278M | 768 | **0.912** | **0.873** | **0.875** | **0.875** | **0.625** | ◎ 最良 |
| bge-m3 | 568M | 1024 | 0.850 | 0.832 | 0.750 | 0.750 | 0.375 | ○ 大きく遅い割に e5-base 未満 |
| Qwen3-Embedding-0.6B | 0.6B | 1024 | 0.781† | 0.725 | 0.750 | 0.750 | 0.375 | △ †mean-pool で過小評価 |
| paraphrase-multilingual-MiniLM-L12-v2（現行） | 118M | 384 | 0.813 | 0.716 | 0.500 | 0.500 | 0.375 | △ 最速だが候補選別が弱い |
| multilingual-e5-small | 118M | — | — | — | — | — | — | ✗ transformers.js でロード不可 |

† **Qwen3-Embedding は last-token pooling 前提**。transformers.js の feature-extraction は
mean-pool 固定のため本来の性能が出ていない（MTEB 多言語では 0.6B 級トップ）。正しく使うには
last-token pooling 実装が必要 → 伸びしろ大。

**判定（役割①）**: 現行 MiniLM から **`multilingual-e5-base` へ置換推奨**。候補選別 P@8 が
0.50→0.875 に向上。e5 は `"query: "` プレフィックス必須（本ベンチは付与済み）。
Qwen3-Embedding は last-token pooling を実装できるなら最有力候補。

---

## 役割② 生成裁定（向き・極性） — `eval/gen-bench.ts` / `eval/ollama-bench.ts`

向き 11 件（A→B/B→A/none、提示順は偶奇で反転しバイアス除去）、極性 8 件。
**自明ベースライン（常に A→B）= dir 0.36**。

| モデル | 実行系 | dirAcc | polAcc | jsonRate | ms/件 | 評価 |
|---|---|--:|--:|--:|--:|---|
| **Gemma 4 E4B** (8B raw, Q4) | Ollama/Metal | **0.727** | **0.75** | 1.00 | 1574 | ◎ 実用域 |
| **Gemma 4 E2B** (5B raw, Q4) | Ollama/Metal | 0.636 | **0.75** | 1.00 | 1792 | ◎ E4B に肉薄・省メモリ |
| Qwen3-0.6B | transformers.js q4 | 0.182 | 0.375 | 1.00 | 1173 | ✗ ベースライン以下 |
| Qwen2.5-0.5B-Instruct | transformers.js q4 | 0.273 | 0.250 | 0.727 | 4321 | ✗ ベースライン以下 |
| Gemma 4 E2B/E4B | transformers.js v3.8.1 | — | — | — | — | ✗ `gemma4` 未対応（v4.2.0 待ち） |
| **Claude（参照/上限）** | API | ≈ゴール作成者 | — | — | — | 基準（gold author） |

**判定（役割②）**:
- **サブ1B（Qwen 0.5–0.6B）は因果の向き判定に不十分**（自明ベースライン以下）。候補の一次選別止まり。
- **Gemma 4 E2B/E4B が on-device 実用ライン**。E4B が最良、E2B も極性は同等で向きのみ僅差 →
  メモリ制約が厳しければ **E2B が最良コスパ**。
- **実行系の現実**: Gemma 4 は transformers.js v3.8.1 では `Unsupported model type: gemma4`。
  **Ollama（Metal）経由なら即実行可**。純 JS で動かすなら transformers.js v4.2.0 を要検証。

---

## office-causal への反映方針

1. **役割①（embed 層）**: 既定を `multilingual-e5-base` に（`"query: "` プレフィックス対応を `TransformersEmbedder` に追加）。
2. **役割②（causal 裁定）**: クラウド非依存の 2 層に階層化 —
   - **ローカル小型（埋め込み）** = 候補選別（安価・広域）
   - **ローカル中型（Gemma 4 E2B/E4B, transformers.js WebGPU/CPU）** = 因果の向き・極性の裁定 + 敵対的 verify（ADR-0001 D5）
3. 機微データはローカル（embed + Gemma 4）で完結 — 端末外に一切出ない（API キー不要）。

## 再現

```bash
node --import tsx eval/embed-bench.ts                       # 役割① 埋め込み
node --import tsx eval/gen-bench.ts                         # 役割② transformers.js (Qwen等)
node --import tsx eval/ollama-bench.ts "gemma4:e2b,gemma4:e4b"  # 役割② Gemma 4 (Ollama)
```

## 限界（誠実な明記）

- データセットは 8 文・小規模（傾向の指標であり統計的確定ではない）。
- ゴールは Claude 作成 → Claude を「上限」と呼ぶのは構成上ほぼ自明（循環）。値は edge モデル間比較に使う。
- Qwen3-Embedding は不利な mean-pool 条件。bge-m3/MiniLM/e5 は同条件（mean-pool, q8）で公平。
- 量子化（q4/q8）・プロンプト・温度0 固定の条件下。プロンプト最適化で各モデルとも上振れ余地。
