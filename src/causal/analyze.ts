/**
 * CausalGraph 上の決定論的な因果分析 (LLM 不使用)。
 * derives-from / causes エッジを使い、経路・上流/下流・循環・中心性を計算する。
 */
import type { CausalGraph, DataId, EdgeKind } from "../types.js";

const CAUSAL_KINDS: EdgeKind[] = ["derives-from", "causes"];

function adjacency(g: CausalGraph, kinds: EdgeKind[]): Map<DataId, DataId[]> {
  const adj = new Map<DataId, DataId[]>();
  for (const e of g.edges) {
    if (!kinds.includes(e.kind)) continue;
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  }
  return adj;
}

/** node の上流 (= 原因側) を辿る。derives-from(B→A) は B の原因が A。 */
export function ancestors(
  g: CausalGraph,
  id: DataId,
  kinds: EdgeKind[] = CAUSAL_KINDS,
): Set<DataId> {
  const adj = adjacency(g, kinds);
  const out = new Set<DataId>();
  const stack = [...(adj.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    stack.push(...(adj.get(cur) ?? []));
  }
  return out;
}

/** すべての原因→結果の経路 (DFS, 単純路)。 */
export function paths(
  g: CausalGraph,
  from: DataId,
  to: DataId,
  kinds: EdgeKind[] = CAUSAL_KINDS,
): DataId[][] {
  const adj = adjacency(g, kinds);
  const result: DataId[][] = [];
  const dfs = (cur: DataId, trail: DataId[]) => {
    if (cur === to) {
      result.push([...trail, cur]);
      return;
    }
    for (const nxt of adj.get(cur) ?? []) {
      if (!trail.includes(nxt)) dfs(nxt, [...trail, cur]);
    }
  };
  dfs(from, []);
  return result;
}

/** 循環検出 (因果 DAG 違反 = レビュー要)。 */
export function cycles(
  g: CausalGraph,
  kinds: EdgeKind[] = CAUSAL_KINDS,
): DataId[][] {
  const adj = adjacency(g, kinds);
  const found: DataId[][] = [];
  const state = new Map<DataId, 0 | 1 | 2>(); // 0=white 1=gray 2=black
  const dfs = (n: DataId, trail: DataId[]) => {
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) found.push([...trail.slice(trail.indexOf(m)), n, m]);
      else if (!state.get(m)) dfs(m, [...trail, n]);
    }
    state.set(n, 2);
  };
  for (const n of g.nodes.keys()) if (!state.get(n)) dfs(n, []);
  return found;
}

/** out-degree ベースの簡易「原因影響度」中心性。 */
export function influence(
  g: CausalGraph,
  kinds: EdgeKind[] = CAUSAL_KINDS,
): { id: DataId; score: number }[] {
  const score = new Map<DataId, number>();
  for (const id of g.nodes.keys())
    score.set(id, ancestors(g, id, kinds).size); // 多くを原因に持つ = 結果ノード
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score);
}

export function report(g: CausalGraph) {
  return {
    cycles: cycles(g),
    topEffects: influence(g).slice(0, 10),
    causalEdges: g.edges.filter((e) => e.kind === "causes").length,
  };
}
