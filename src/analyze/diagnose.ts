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

export interface Diagnosis {
  isolated: { id: string; label: string; kind: string }[];
  notHolding: { edge: string; from: string; to: string; reason: string }[];
  notationVariants: { concept: string; members: { id: string; label: string }[] }[];
  conceptJumps: { edge: string; from: string; to: string; similarity: number; missing?: string; reason?: string }[];
  summary: Record<string, number>;
}

/** Gemma 4 など生成 LLM による意味判断 (WebGpuGemmaAdjudicator が実装)。 */
export interface GemmaJudge {
  judgeSameConcept(a: string, b: string): Promise<{ same: boolean; canonical?: string }>;
  judgeJump(cause: string, effect: string): Promise<{ jump: boolean; missing?: string; reason?: string }>;
}

export interface DiagnoseOptions {
  /** 表記揺れと判定するコサイン下限 (既定 0.88)。 */
  variantThreshold?: number;
  /** 概念のとびと判定するコサイン上限 (既定 0.30)。 */
  jumpThreshold?: number;
  /** 指定すると、埋め込みで一次選別した候補を Gemma 4 が最終判定 (因果分析を Gemma で)。 */
  gemma?: GemmaJudge;
  /** 埋め込み対象ノードの上限 (既定 4000)。超過分は打切り、summary.truncated に件数。 */
  maxEmbed?: number;
}

export async function diagnose(
  g: CausalGraph,
  embedder?: Embedder,
  opts: DiagnoseOptions = {},
): Promise<Diagnosis> {
  const node = (id: string) => g.nodes.get(id as DataId);
  const lbl = (id: string) => node(id)?.meta.label ?? node(id)?.meta.text ?? id;
  const causeEdges = g.edges.filter((e) => e.kind === "causes");
  // 自然言語のみ (数式 "=...", 数値・記号のみ, 長すぎは除外) → 埋め込み対象を絞りスケールさせる。
  const isNL = (t?: string) =>
    !!t && !t.startsWith("=") && t.length <= 200 && !/^[\s\d.,%¥$+\-*/(),，．]+$/.test(t);

  // 1) isolated: causes / derives-from のどちらにも現れない「内容」ノード。
  //    (数式 DAG で繋がるセルは独立扱いしない → xlsx で大量誤検出を防ぐ)
  const conn = new Set<string>();
  for (const e of g.edges) if (e.kind === "causes" || e.kind === "derives-from") { conn.add(e.from); conn.add(e.to); }
  const isolated = [...g.nodes.values()]
    .filter((n) => (isNL(n.meta.text) || n.meta.kind === "entity") && !conn.has(n.id))
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
  let truncated = 0;

  if (embedder) {
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const vt = opts.variantThreshold ?? 0.9;
    const jt = opts.jumpThreshold ?? 0.3;
    const CAP = opts.maxEmbed ?? 4000; // 埋め込み対象の上限 (超過は要 ANN, ここでは打切り報告)

    // 埋め込みが必要なノード: NL 用語 (表記揺れ用) + causes 端点 (概念のとび用)。数式/数値は除外。
    const need = new Map<string, string>();
    const termIds: DataId[] = [];
    for (const n of g.nodes.values()) {
      const short = (n.meta.text ?? n.meta.label ?? "").length <= 16;
      if (n.meta.kind === "entity" || (isNL(n.meta.text) && short)) { termIds.push(n.id); need.set(n.id, lbl(n.id)); }
    }
    for (const e of causeEdges) { need.set(e.from, lbl(e.from)); need.set(e.to, lbl(e.to)); }

    const all = [...need.entries()];
    truncated = Math.max(0, all.length - CAP);
    const use = all.slice(0, CAP);
    const arr = await embedder.embed(use.map(([, t]) => t));
    const vmap = new Map<string, Float32Array>();
    use.forEach(([id], i) => vmap.set(id, arr[i]!));

    // 3) notationVariants: 上限内 NL 用語の全ペア (数式/数値を除いたので現実的サイズ)。
    const ids = termIds.filter((id) => vmap.has(id));
    const used = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      if (used.has(ids[i]!)) continue;
      const group = [ids[i]!];
      for (let j = i + 1; j < ids.length; j++) {
        if (used.has(ids[j]!)) continue;
        if (cosine(vmap.get(ids[i]!)!, vmap.get(ids[j]!)!) >= vt && norm(lbl(ids[i]!)) !== norm(lbl(ids[j]!))) {
          group.push(ids[j]!); used.add(ids[j]!);
        }
      }
      if (group.length > 1) {
        used.add(ids[i]!);
        let members = group;
        let concept = lbl(ids[i]!);
        if (opts.gemma) {
          const confirmed = [group[0]!];
          for (const m of group.slice(1)) {
            const r = await opts.gemma.judgeSameConcept(lbl(group[0]!), lbl(m));
            if (r.same) { confirmed.push(m); if (r.canonical) concept = r.canonical; }
          }
          members = confirmed;
        }
        if (members.length > 1) notationVariants.push({ concept, members: members.map((id) => ({ id, label: lbl(id) })) });
      }
    }

    // 4) conceptJumps: causes 端点の低類似を一次選別 → (任意) Gemma が論理飛躍を確定。
    for (const e of causeEdges) {
      const a = vmap.get(e.from), b = vmap.get(e.to);
      if (!a || !b) continue;
      const sim = cosine(a, b);
      if (sim >= jt) continue;
      if (opts.gemma) {
        const r = await opts.gemma.judgeJump(lbl(e.from), lbl(e.to));
        if (!r.jump) continue;
        conceptJumps.push({ edge: e.id, from: lbl(e.from), to: lbl(e.to), similarity: +sim.toFixed(3), ...(r.missing ? { missing: r.missing } : {}), ...(r.reason ? { reason: r.reason } : {}) });
      } else {
        conceptJumps.push({ edge: e.id, from: lbl(e.from), to: lbl(e.to), similarity: +sim.toFixed(3) });
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
      truncated,
    },
  };
}
