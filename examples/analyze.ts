/**
 * デモ: 単一 Office ファイル → CausalGraph。
 *
 *   # 構造グラフのみ (LLM 不要・API キー不要)
 *   node --import tsx examples/analyze.ts ./sample.xlsx
 *
 *   # 因果グラフまで (ANTHROPIC_API_KEY 必要)
 *   node --import tsx examples/analyze.ts ./Q1.pptx causal
 */
import { analyze } from "../src/index.js";
import type { Depth } from "../src/types.js";

const file = process.argv[2] ?? "./sample.xlsx";
const depth = (process.argv[3] ?? "structural") as Depth;

const r = await analyze(file, { depth });

console.log("=== log ===");
r.log.forEach((l) => console.log("·", l));

console.log("\n=== nodes (先頭 15) — data-id + tags ===");
[...r.graph.nodes.values()].slice(0, 15).forEach((n) => {
  const tags = n.meta.tags?.length ? `  #${n.meta.tags.join(" #")}` : "";
  console.log(`${n.id}  [${n.meta.kind}] ${n.meta.label ?? n.meta.text ?? ""}${tags}`);
});

console.log("\n=== 依存/因果エッジ (weight 付き) ===");
r.graph.edges
  .filter((e) => e.kind === "derives-from" || e.kind === "causes")
  .slice(0, 20)
  .forEach((e) => {
    const w = e.weight !== undefined ? ` w=${e.weight.toFixed(3)}` : "";
    const extra = e.causal ? ` (${e.causal.polarity} ${e.causal.confidence})` : "";
    console.log(`${e.from} -[${e.kind}]-> ${e.to}${w}${extra}`);
  });

console.log("\n=== edge の小さい LLM weight 分析 ===");
console.log(JSON.stringify(r.weights(), null, 2));

console.log("\n=== report ===");
console.log(JSON.stringify(r.report(), null, 2));

console.log("\n=== DOT (graphviz) ===");
console.log(r.export("dot"));
