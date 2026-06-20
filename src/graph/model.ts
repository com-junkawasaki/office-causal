/**
 * CausalGraph の生成・操作・問い合わせ。
 */
import type {
  CausalGraph,
  DataId,
  Edge,
  EdgeKind,
  Meta,
  OoxmlNode,
} from "../types.js";

export function emptyGraph(
  sources: CausalGraph["sources"] = [],
): CausalGraph {
  return { nodes: new Map(), edges: [], sources };
}

export function upsertNode(g: CausalGraph, id: DataId, meta: Meta): OoxmlNode {
  const existing = g.nodes.get(id);
  if (existing) {
    // 追記的マージ (LLM 段が text/label/value を補完できる)。
    existing.meta = { ...existing.meta, ...meta, provenance: [
      ...new Set([...existing.meta.provenance, ...meta.provenance]),
    ] };
    return existing;
  }
  const node: OoxmlNode = { id, meta };
  g.nodes.set(id, node);
  return node;
}

export function addEdge(g: CausalGraph, e: Omit<Edge, "id">): Edge {
  const id = `${e.kind}:${e.from}->${e.to}`;
  const dup = g.edges.find((x) => x.id === id);
  if (dup) return dup;
  const edge: Edge = { id, ...e };
  g.edges.push(edge);
  return edge;
}

export function edgesOf(
  g: CausalGraph,
  id: DataId,
  dir: "out" | "in" | "both" = "out",
  kind?: EdgeKind,
): Edge[] {
  return g.edges.filter(
    (e) =>
      (!kind || e.kind === kind) &&
      ((dir !== "in" && e.from === id) || (dir !== "out" && e.to === id)),
  );
}

export function stats(g: CausalGraph): Record<string, number> {
  const byKind: Record<string, number> = {};
  for (const e of g.edges) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return { nodes: g.nodes.size, edges: g.edges.length, ...byKind };
}
