# ADR-0003: edge-LLM の階層化（埋め込み → ローカル Gemma 4）— クラウド非依存

- Status: Accepted
- Date: 2026-06-20
- Updated: 2026-06-22 — クラウド Claude 階層を撤去し、生成・裁定・検証をローカル Gemma 4 に一本化（cloud-free）。
- Context: `com-junkawasaki/office-causal`

## 背景

因果裁定（向き・極性・採否）を全候補に対しクラウド LLM で行うとコスト・レイテンシ・
データ流出の懸念がある。本プロジェクトは**プライバシ最優先・完全ローカル**を方針とし、
クラウド依存を排してローカル Gemma 4 のみで生成系を構成する。「edge-LLM」（小型・ローカル
実行）の実力を測ると、役割で適性が大きく異なることが分かった（実測は `eval/RESULTS.md`）。

主要な実測（Claude が採点・ゴール作成）:
- **埋め込み（候補選別）**: `multilingual-e5-base` が最良（AUC 0.91 / P@8 0.875）。現行 MiniLM(0.81/0.50) を上回る。
- **生成裁定（向き・極性）**: サブ1B（Qwen2.5-0.5B / Qwen3-0.6B）は自明ベースライン以下で不適。
  **Gemma 4 E4B(dir 0.73) / E2B(0.64)** が on-device 実用ライン（極性は両者 0.75）。
- 実行系: Gemma 4 は transformers.js **v4** で `device:"webgpu"` 対応（v3.8.1 は未対応）。
  Node では `cpu`/`coreml`/`webgpu`、ブラウザでは `webgpu`/`wasm`。

## 決定

### D1. 役割で別クラスのモデルを使う（混同しない）

- **エンコーダ（埋め込み）** = エッジ weight / タグ / **候補ペアの一次選別**。生成不可。
- **デコーダ（生成）** = 因果の向き・極性・根拠の**裁定**。

埋め込みの類似度は「無向の意味的親和度」であって因果の向きではない（向きは生成 LLM が決める）。

### D2. 2 階層パイプライン（クラウド非依存）

1. **ローカル小型（埋め込み, transformers.js）**: O(n²) 候補を高親和ペアに絞る（安価・広域・APIキー不要）。
2. **ローカル中型（Gemma 4 E2B/E4B, transformers.js v4 + WebGPU）**: 候補に向き・極性・根拠を付与（裁定）し、
   さらに各候補を独立 N 票で敵対的に反証して confidence を確定（verify, ADR-0001 D5）。

causal/verify はつねにローカル Gemma 4。`llm.verify:false` で敵対検証を省き裁定のみ commit（高速）。
クラウド LLM は使用しない（API キー不要）。

### D3. WebGPU を既定実行系、wasm はフォールバック

Gemma 4 は WebGPU(`dtype:"q4f16"`) でないと実用速度が出ない（CPU/wasm は ~6 tok/s）。
`navigator.gpu` の有無で自動選択し、非対応時は警告バナー + wasm 縮退（E2B固定・候補/生成長を制限）。

### D4. 既定モデル

- 埋め込み: 多言語 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`（軽量・既定）。高精度が要れば e5-base に差し替え。
- 生成・裁定・検証: `onnx-community/gemma-4-E2B-it-ONNX`（E4B も選択可）。クラウド LLM は無し。

## 帰結

- ✅ **機微データが端末外に出ない** — 埋め込みも生成も裁定も検証もローカルで完結。API キー不要。
- ✅ 候補を埋め込みで絞ってから裁定 → 生成呼び出しを削減。
- ⚠ ブラウザ実行は WebGPU 必須級（wasm は実用外）。
- ⚠ 量子化小型モデルの精度限界 → verify も同じ Gemma 4 が担うため、重要判断は E4B + `verifyVotes` 増で補う。

## 参考

- `eval/RESULTS.md`（埋め込み/生成の実測）、`eval/embed-bench.ts` / `gen-bench.ts` / `ollama-bench.ts`
- transformers.js v4（WebGPU）、Gemma 4 E2B/E4B、Qwen3
