/**
 * 因果グラフの診断: 4 カテゴリを特定する。
 *  1. isolated         — 因果的に独立（causes エッジが無いノード）
 *  2. notHolding       — 成立していない因果（refuted / 低 confidence）
 *  3. notationVariants — 表記揺れ（同概念だが表記が異なるノード群: 埋め込み高類似 + ラベル相違）
 *  4. conceptJumps     — 概念のとび（causes だが原因↔結果の意味的距離が大きい論理飛躍）
 *
 * 3,4 は埋め込み（transformers.js）を使う。embedder 省略時は 1,2 のみ。
 */
import type { CausalGraph, DataId } from "../types.js";
import { cosine, type Embedder } from "../embed/model.js";
import { embedNodes } from "../embed/weight.js";

export interface Diagnosis {
  isolated: { id: string; label: string; kind: string }[];
  notHolding: { edge: string; from: string; to: string; reason: string }[];
  notationVariants: { concept: string; members: { id: string; label: string }[] }[];
  conceptJumps: { edge: string; from: string; to: string; similarity: number }[];
  summary: Record<string, number>;
}

export interface DiagnoseOptions {
  /** 表記揺れと判定するコサイン下限 (既定 0.88)。 */
  variantThreshold?: number;
  /** 概念のとびと判定するコサイン上限 (既定 0.30)。 */
  jumpThreshold?: number;
}

export async function diagnose(
  g: CausalGraph,
  embedder?: Embedder,
  opts: DiagnoseOptions = {},
): Promise<Diagnosis> {
  const node = (id: string) => g.nodes.get(id as DataId);
  const lbl = (id: string) => node(id)?.meta.label ?? node(id)?.meta.text ?? id;
  const analyzable = [...g.nodes.values()].filter((n) => n.meta.text || n.meta.kind === "entity");
  const causeEdges = g.edges.filter((e) => e.kind === "causes");

  // 1) isolated: causes に一度も現れないノード
  const touched = new Set<string>();
  for (const e of causeEdges) { touched.add(e.from); touched.add(e.to); }
  const isolated = analyzable
    .filter((n) => !touched.has(n.id))
    .map((n) => ({ id: n.id, label: lbl(n.id), kind: n.meta.kind }));

  // 2) notHolding: refuted か confidence < 0.5
  const notHolding = causeEdges
    .filter((e) => e.causal && (e.causal.status === "refuted" || e.causal.confidence < 0.5))
    .map((e) => ({
      edge: e.id, from: lbl(e.from), to: lbl(e.to),
      reason: e.causal!.status === "refuted" ? "refuted" : `low confidence ${e.causal!.confidence}`,
    }));

  let notationVariants: Diagnosis["notationVariants"] = [];
  let conceptJumps: Diagnosis["conceptJumps"] = [];

  if (embedder) {
    const vecs = await embedNodes(g, embedder);
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const vt = opts.variantThreshold ?? 0.9;
    const jt = opts.jumpThreshold ?? 0.3;

    // 3) notationVariants: 「用語」粒度のみ対象 (entity か短ラベル) → 文の過剰グルーピングを防ぐ。
    //    高類似だが正規化ラベルが異なる = 同概念の表記揺れ。
    const ids = analyzable
      .filter((n) => n.meta.kind === "entity" || (n.meta.text ?? n.meta.label ?? "").length <= 16)
      .map((n) => n.id)
      .filter((id) => vecs.has(id));
    const used = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      if (used.has(ids[i]!)) continue;
      const group = [ids[i]!];
      for (let j = i + 1; j < ids.length; j++) {
        if (used.has(ids[j]!)) continue;
        const sim = cosine(vecs.get(ids[i]!)!, vecs.get(ids[j]!)!);
        if (sim >= vt && norm(lbl(ids[i]!)) !== norm(lbl(ids[j]!))) {
          group.push(ids[j]!);
          used.add(ids[j]!);
        }
      }
      if (group.length > 1) {
        used.add(ids[i]!);
        notationVariants.push({ concept: lbl(ids[i]!), members: group.map((id) => ({ id, label: lbl(id) })) });
      }
    }

    // 4) conceptJumps: causes だが原因↔結果の意味的距離が大きい
    for (const e of causeEdges) {
      const a = vecs.get(e.from), b = vecs.get(e.to);
      if (a && b) {
        const sim = cosine(a, b);
        if (sim < jt) conceptJumps.push({ edge: e.id, from: lbl(e.from), to: lbl(e.to), similarity: +sim.toFixed(3) });
      }
    }
  }

  return {
    isolated, notHolding, notationVariants, conceptJumps,
    summary: {
      isolated: isolated.length,
      notHolding: notHolding.length,
      notationVariants: notationVariants.length,
      conceptJumps: conceptJumps.length,
    },
  };
}
