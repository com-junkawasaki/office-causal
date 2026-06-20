/**
 * コンサルタント的「so-what」分析。
 * 因果連鎖 (root → … → sink) を辿り、各連鎖の示唆 (so-what) と打ち手を Gemma 4 で生成する。
 * 構造（連鎖抽出）は決定論 O(edges)、生成のみ Gemma。連鎖数は上限で制御。
 */
import type { CausalGraph, DataId } from "../types.js";

export interface SoWhatJudge {
  soWhat(chainText: string): Promise<{ soWhat: string; action?: string }>;
}

export interface ConsultResult {
  chains: { path: string[]; soWhat: string; action?: string }[];
  chainCount: number;
}

export interface ConsultOptions {
  /** so-what を生成する因果連鎖の上限 (既定 10)。 */
  maxChains?: number;
}

export async function consult(g: CausalGraph, gemma: SoWhatJudge, opts: ConsultOptions = {}): Promise<ConsultResult> {
  const lbl = (id: string) => g.nodes.get(id as DataId)?.meta.label ?? g.nodes.get(id as DataId)?.meta.text ?? id;
  const causes = g.edges.filter((e) => e.kind === "causes");
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const e of causes) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e.from);
  }
  // sink = 結果側で、それ以上の結果を持たないノード (最終効果)。
  const sinks = [...new Set(causes.map((e) => e.to))].filter((id) => !(out.get(id)?.length));

  const maxChains = opts.maxChains ?? 10;
  const chains: ConsultResult["chains"] = [];
  let count = 0;
  for (const sink of sinks) {
    if (count >= maxChains) break;
    // sink から原因側へ辿って連鎖 (root..sink) を作る (単純路, 循環防止)。
    const path: string[] = [sink];
    const seen = new Set<string>([sink]);
    let cur: string = sink;
    while (true) {
      const parent = (inc.get(cur) ?? []).find((p) => !seen.has(p));
      if (!parent) break;
      path.unshift(parent); seen.add(parent); cur = parent;
    }
    if (path.length < 2) continue; // 連鎖になっていない
    count++;
    const labels = path.map(lbl);
    const r = await gemma.soWhat(labels.join(" → "));
    chains.push({ path: labels, soWhat: r.soWhat, ...(r.action ? { action: r.action } : {}) });
  }
  return { chains, chainCount: chains.length };
}
