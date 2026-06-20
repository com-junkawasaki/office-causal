/**
 * data-id でのタグづけ。
 * 語彙 (taxonomy) ラベルを埋め込み、各テキストノードの埋め込みと最も近いラベルを
 * 閾値以上だけ meta.tags に付与する (ローカル zero-shot 風分類)。
 */
import type { CausalGraph, DataId } from "../types.js";
import { cosine, type Embedder } from "./model.js";

/** 因果分析向けの既定語彙 (日本語の業務カテゴリ)。 */
export const DEFAULT_TAXONOMY = [
  "売上・収益",
  "コスト・費用",
  "利益",
  "リスク・課題",
  "施策・対策",
  "市場・競合",
  "時間・期間",
  "主体・組織",
  "指標・KPI",
];

export interface TagResult {
  /** data-id → 付与タグ。 */
  tags: Map<DataId, string[]>;
  taxonomy: string[];
}

export async function tagNodes(
  g: CausalGraph,
  vecs: Map<DataId, Float32Array>,
  embedder: Embedder,
  taxonomy: string[] = DEFAULT_TAXONOMY,
  threshold = 0.3,
): Promise<TagResult> {
  const tags = new Map<DataId, string[]>();
  if (taxonomy.length === 0) return { tags, taxonomy };

  const labelVecs = await embedder.embed(taxonomy);

  for (const [id, v] of vecs) {
    const scored = taxonomy
      .map((label, i) => ({ label, score: cosine(v, labelVecs[i]!) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((x) => x.label);

    if (scored.length) {
      tags.set(id, scored);
      const node = g.nodes.get(id);
      if (node) {
        node.meta.tags = scored;
        if (!node.meta.provenance.includes("embed-tag")) node.meta.provenance.push("embed-tag");
      }
    }
  }
  return { tags, taxonomy };
}
