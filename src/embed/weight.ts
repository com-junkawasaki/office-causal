/**
 * 埋め込みによるエッジ重み付け・ローカル候補生成・重み分析。
 * すべて transformers.js のローカル小型モデルで完結 (API キー不要)。
 */
import type { CausalGraph, DataId, Edge, EdgeKind } from "../types.js";
import { addEdge } from "../graph/model.js";
import { cosine, type Embedder } from "./model.js";

/** ノードの埋め込み対象テキスト (text 優先, なければ label)。 */
function nodeText(g: CausalGraph, id: DataId): string {
  const m = g.nodes.get(id)?.meta;
  return (m?.text ?? m?.label ?? "").trim();
}

/** text/label を持つ全ノードを埋め込み、id→ベクタの表を返す。 */
export async function embedNodes(
  g: CausalGraph,
  embedder: Embedder,
): Promise<Map<DataId, Float32Array>> {
  const ids: DataId[] = [];
  const texts: string[] = [];
  for (const [id] of g.nodes) {
    const t = nodeText(g, id);
    if (t) {
      ids.push(id);
      texts.push(t);
    }
  }
  const vecs = await embedder.embed(texts);
  const map = new Map<DataId, Float32Array>();
  ids.forEach((id, i) => map.set(id, vecs[i]!));
  return map;
}

/**
 * 既存エッジに weight を付与。端点が両方テキストを持つ場合のみコサインを計算。
 * これが「edge の小さい LLM weight」: 構造/参照/依存/意味エッジの意味的強度。
 */
export function weightEdges(g: CausalGraph, vecs: Map<DataId, Float32Array>): void {
  for (const e of g.edges) {
    const a = vecs.get(e.from);
    const b = vecs.get(e.to);
    if (a && b) e.weight = Math.max(0, cosine(a, b));
  }
}

/**
 * 埋め込み類似でローカルに候補エッジを提案 (Gemma 4 裁定の前の安価な一次選別)。
 * entity ノード優先、無ければテキストノード同士の総当たり。
 */
export function proposeEdges(
  g: CausalGraph,
  vecs: Map<DataId, Float32Array>,
  opts: { kind: EdgeKind; threshold: number; max?: number },
): { from: DataId; to: DataId; weight: number }[] {
  const entities = [...g.nodes.values()].filter((n) => n.meta.kind === "entity").map((n) => n.id);
  const pool = entities.length >= 2 ? entities : [...vecs.keys()];
  const out: { from: DataId; to: DataId; weight: number }[] = [];

  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const a = vecs.get(pool[i]!);
      const b = vecs.get(pool[j]!);
      if (!a || !b) continue;
      const w = cosine(a, b);
      if (w >= opts.threshold) out.push({ from: pool[i]!, to: pool[j]!, weight: w });
    }
  }
  out.sort((x, y) => y.weight - x.weight);
  return out.slice(0, opts.max ?? 100);
}

/**
 * proposeEdges は対称ペア (A→B と B→A) を出すので、無向に畳む。
 * 向きは埋め込みでは決まらない → Gemma 4 (causal 段) に委ねる前提 (ADR-0002 D3)。
 */
export function dedupUndirected(
  pairs: { from: DataId; to: DataId; weight: number }[],
): { from: DataId; to: DataId; weight: number }[] {
  const seen = new Map<string, { from: DataId; to: DataId; weight: number }>();
  for (const p of pairs) {
    const key = p.from < p.to ? `${p.from}|${p.to}` : `${p.to}|${p.from}`;
    const cur = seen.get(key);
    if (!cur || p.weight > cur.weight) seen.set(key, p);
  }
  return [...seen.values()].sort((a, b) => b.weight - a.weight);
}

/** 提案候補をグラフに追記 (weight 付き)。 */
export function applyProposals(
  g: CausalGraph,
  kind: EdgeKind,
  proposals: { from: DataId; to: DataId; weight: number }[],
): number {
  let n = 0;
  for (const p of proposals) {
    const before = g.edges.length;
    const e = addEdge(g, { kind, from: p.from, to: p.to, weight: p.weight } as Omit<Edge, "id">);
    e.weight = p.weight;
    if (g.edges.length > before) n++;
  }
  return n;
}

/** 「edge の小さい LLM weight」分析: 種別ごとの重み分布。 */
export function analyzeWeights(g: CausalGraph) {
  const byKind = new Map<string, number[]>();
  for (const e of g.edges) {
    if (e.weight === undefined) continue;
    (byKind.get(e.kind) ?? byKind.set(e.kind, []).get(e.kind)!).push(e.weight);
  }
  const summary: Record<string, { count: number; mean: number; min: number; max: number; p50: number }> = {};
  for (const [kind, ws] of byKind) {
    const sorted = [...ws].sort((a, b) => a - b);
    const sum = ws.reduce((a, b) => a + b, 0);
    summary[kind] = {
      count: ws.length,
      mean: round(sum / ws.length),
      min: round(sorted[0]!),
      max: round(sorted[sorted.length - 1]!),
      p50: round(sorted[Math.floor(sorted.length / 2)]!),
    };
  }
  // 最も意味的に強い/弱いエッジ上位
  const ranked = g.edges
    .filter((e) => e.weight !== undefined)
    .sort((a, b) => b.weight! - a.weight!);
  return {
    summary,
    strongest: ranked.slice(0, 5).map(fmt(g)),
    weakest: ranked.slice(-5).reverse().map(fmt(g)),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const fmt = (g: CausalGraph) => (e: Edge) => ({
  kind: e.kind,
  weight: round(e.weight!),
  from: g.nodes.get(e.from)?.meta.label ?? e.from,
  to: g.nodes.get(e.to)?.meta.label ?? e.to,
});
