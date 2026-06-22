/**
 * サンプルデータ生成 + tensor network 構築。
 *  - 実 OOXML: 3 pptx(各10スライド) / 3 docx(各3ページ) / 3 xlsx(各3シート) を examples/sample-data/ に出力
 *  - fixture: 上記と同内容の CausalGraph(JSON) を examples/sample-data/corpus.graph.json に出力
 *  - tensor network: Document→Page→Object→Causal を接続した TN(JSON) + 可視化 SVG を出力
 *  - 生成した OOXML は自前パーサで round-trip 検証する
 *
 *   npm run build && node scripts/gen-sample-data.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { buildPptx, buildXlsx, buildDocx } from "./lib/ooxml-write.mjs";
import { emptyGraph, upsertNode, addEdge } from "../dist/src/graph/model.js";
import { openPackage } from "../dist/src/ooxml/opc.js";
import { buildStructuralGraph } from "../dist/src/graph/builder.js";
import { toTensorNetwork, tensorNetworkToJson } from "../dist/src/tensor/network.js";
import { renderTensorNetworkSvg } from "../dist/src/visual/tensor-svg.js";

// ---------- 概念とグローバル因果 DAG ----------
const C = {
  raw: "原材料費", cost: "製造コスト", price: "販売価格", qty: "販売数量", sales: "売上",
  share: "市場シェア", comp: "競合値下げ", profit: "営業利益", fx: "為替", inv: "在庫",
};
const CAUSAL = [
  ["fx", "raw", "+"], ["raw", "cost", "+"], ["inv", "cost", "+"], ["cost", "price", "+"],
  ["price", "qty", "-"], ["qty", "sales", "+"], ["comp", "share", "-"], ["share", "sales", "+"],
  ["sales", "profit", "+"], ["cost", "profit", "-"],
];
const SENT = {
  raw: "原材料費が前年から上昇した", cost: "製造コストが押し上げられた", price: "販売価格を改定した",
  qty: "販売数量が変動した", sales: "売上高が増減した", share: "市場シェアが動いた",
  comp: "競合が値下げを実施した", profit: "営業利益が変化した", fx: "為替が円安に振れた", inv: "在庫水準が変わった",
};

// ---------- ドキュメント定義 ----------
const DOCS = [
  { id: "q1-deck", app: "ppt", label: "Q1 決算デッキ", pages: 10, concepts: ["raw", "cost", "price", "qty", "sales", "profit"] },
  { id: "q2-deck", app: "ppt", label: "Q2 決算デッキ", pages: 10, concepts: ["comp", "share", "sales", "profit", "inv", "cost"] },
  { id: "strategy-deck", app: "ppt", label: "戦略デッキ", pages: 10, concepts: ["fx", "raw", "cost", "price", "sales", "profit"] },
  { id: "annual-report", app: "doc", label: "年次報告", pages: 3, concepts: ["sales", "profit", "cost", "share"] },
  { id: "risk-memo", app: "doc", label: "リスクメモ", pages: 3, concepts: ["fx", "raw", "comp", "inv"] },
  { id: "ops-review", app: "doc", label: "オペレビュー", pages: 3, concepts: ["inv", "cost", "qty", "price"] },
  { id: "pl-model", app: "xls", label: "PL モデル", pages: 3, concepts: ["sales", "cost", "profit"] },
  { id: "kpi-tracker", app: "xls", label: "KPI トラッカー", pages: 3, concepts: ["qty", "share", "sales"] },
  { id: "forecast", app: "xls", label: "需要予測", pages: 3, concepts: ["price", "qty", "sales"] },
];

// ドキュメント横断の causes (間接因果)
const CROSS = [
  ["q1-deck", "sales", "pl-model", "profit", "+"],
  ["risk-memo", "fx", "q1-deck", "raw", "+"],
  ["kpi-tracker", "share", "q2-deck", "sales", "+"],
  ["forecast", "qty", "annual-report", "sales", "+"],
  ["ops-review", "inv", "strategy-deck", "cost", "+"],
];

const g = emptyGraph(DOCS.map((d) => ({ path: `${d.id}.${d.app === "ppt" ? "pptx" : d.app === "xls" ? "xlsx" : "docx"}`, app: d.app })));
const N = (id, meta) => upsertNode(g, id, { provenance: ["sample"], ...meta });
const E = (kind, from, to, extra = {}) => addEdge(g, { kind, from, to, ...extra });
const entId = (doc, c) => `ent:${doc}:${c}`;
const polNum = (p) => (p === "-" ? -0.7 : 0.7);

// ---------- 各ドキュメント: ノード生成 + OOXML ----------
const files = {};
for (const d of DOCS) {
  N(`doc:${d.id}`, { kind: "document", label: d.label, part: "doc", path: d.id });
  // entity ノード (このドキュメントが扱う概念)
  for (const c of d.concepts) N(entId(d.id, c), { kind: "entity", label: C[c], part: "derived", path: `entity/${c}` });

  const pageKind = d.app === "ppt" ? "slide" : d.app === "xls" ? "sheet" : "section";
  const objKind = d.app === "ppt" ? "shape" : d.app === "xls" ? "cell" : "paragraph";

  // ページ × オブジェクトを計画 (fixture と OOXML を同じ計画から生成)
  const pagePlans = [];
  for (let pi = 0; pi < d.pages; pi++) {
    const objs = [];
    const k = d.app === "ppt" ? 2 : d.app === "xls" ? 3 : 3; // 1ページあたりの mention オブジェクト数
    for (let oi = 0; oi < k; oi++) {
      const c = d.concepts[(pi * k + oi) % d.concepts.length];
      objs.push({ concept: c, text: `${SENT[c]}（p${pi + 1}）` });
    }
    pagePlans.push(objs);
  }

  // fixture ノード/エッジ
  pagePlans.forEach((objs, pi) => {
    const pid = `pg:${d.id}:${pi}`;
    N(pid, { kind: pageKind, label: `${d.label} ${pageKind}${pi + 1}`, part: `${d.id}/p${pi + 1}`, path: `page/${pi + 1}` });
    E("contains", `doc:${d.id}`, pid);
    objs.forEach((o, oi) => {
      const oid = `ob:${d.id}:${pi}:${oi}`;
      N(oid, { kind: objKind, label: o.text, text: o.text, part: `${d.id}/p${pi + 1}`, path: `obj/${oi}` });
      E("contains", pid, oid);
      E("mentions", oid, entId(d.id, o.concept));
    });
  });

  // ドキュメント内 causes (両端の概念を含むグローバル因果のみ)
  const cset = new Set(d.concepts);
  for (const [f, t, pol] of CAUSAL) if (cset.has(f) && cset.has(t)) E("causes", entId(d.id, f), entId(d.id, t), { weight: polNum(pol), causal: { polarity: pol, mechanism: `${C[f]}→${C[t]}`, confidence: 0.7, evidence: [], status: "supported" } });

  // ---------- 実 OOXML 生成 ----------
  if (d.app === "ppt") {
    const slides = pagePlans.map((objs, pi) => {
      const shapes = [{ text: `${d.label} スライド${pi + 1}`, x: 457200, y: 274320, w: 11277600, h: 731520 }];
      objs.forEach((o, oi) => shapes.push({ text: o.text, x: 457200, y: 1645920 + oi * 1280160, w: 11277600, h: 1097280 }));
      return { shapes };
    });
    files[`${d.id}.pptx`] = buildPptx(slides);
  } else if (d.app === "doc") {
    const pages = pagePlans.map((objs, pi) => [`${d.label}｜第${pi + 1}節`, ...objs.map((o) => o.text)]);
    files[`${d.id}.docx`] = buildDocx(pages);
  } else {
    const sheets = pagePlans.map((objs, pi) => {
      const cells = [{ ref: "A1", text: "指標" }, { ref: "B1", text: "値" }];
      objs.forEach((o, oi) => { const r = oi + 2; cells.push({ ref: `A${r}`, text: o.text }); cells.push({ ref: `B${r}`, value: 100 + oi * 10 }); });
      const sumRow = objs.length + 2;
      cells.push({ ref: `A${sumRow}`, text: "合計" });
      cells.push({ ref: `B${sumRow}`, formula: `SUM(B2:B${sumRow - 1})`, value: 0 });
      return { name: `${d.label.slice(0, 6)}${pi + 1}`, cells };
    });
    files[`${d.id}.xlsx`] = buildXlsx(sheets);
  }
}

// ---------- ドキュメント横断 causes / references ----------
for (const [df, cf, dt, ct, pol] of CROSS) {
  E("causes", entId(df, cf), entId(dt, ct), { weight: polNum(pol), causal: { polarity: pol, mechanism: `${C[cf]}→${C[ct]} (cross-doc)`, confidence: 0.6, evidence: [], status: "supported" } });
}
// 同一概念を持つ entity をドキュメント横断で references で連結
const byConcept = new Map();
for (const d of DOCS) for (const c of d.concepts) (byConcept.get(c) ?? byConcept.set(c, []).get(c)).push(entId(d.id, c));
for (const [, ents] of byConcept) for (let i = 1; i < ents.length; i++) E("references", ents[i - 1], ents[i]);

// ---------- 出力 ----------
const outDir = "examples/sample-data";
await mkdir(outDir, { recursive: true });
for (const [name, bytes] of Object.entries(files)) await writeFile(`${outDir}/${name}`, bytes);

// fixture graph(JSON) — Map を配列化
const graphJson = {
  sources: g.sources,
  nodes: [...g.nodes.values()].map((n) => ({ id: n.id, ...n.meta })),
  edges: g.edges,
};
await writeFile(`${outDir}/corpus.graph.json`, JSON.stringify(graphJson, null, 2));

// tensor network
const tn = toTensorNetwork(g);
await writeFile(`${outDir}/tensor-network.json`, tensorNetworkToJson(tn));
await writeFile("docs/site/examples/tensor-network.svg", renderTensorNetworkSvg(tn));

// ---------- round-trip 検証 (実 OOXML を自前パーサで読む) ----------
let okCount = 0;
const report = [];
for (const [name, bytes] of Object.entries(files)) {
  try {
    const pkg = openPackage(new Uint8Array(bytes));
    const sg = buildStructuralGraph(pkg);
    const kinds = {};
    for (const n of sg.nodes.values()) kinds[n.meta.kind] = (kinds[n.meta.kind] ?? 0) + 1;
    report.push(`  ✓ ${name}: app=${pkg.app} nodes=${sg.nodes.size} edges=${sg.edges.length} ${JSON.stringify(kinds)}`);
    okCount++;
  } catch (e) {
    report.push(`  ✗ ${name}: ${e.message}`);
  }
}

console.log(`OOXML 出力: ${Object.keys(files).length} ファイル (pptx/docx/xlsx) → ${outDir}/`);
console.log(`round-trip 検証 (自前パーサ): ${okCount}/${Object.keys(files).length} OK`);
report.forEach((r) => console.log(r));
console.log(`\nfixture graph: nodes=${g.nodes.size} edges=${g.edges.length} → ${outDir}/corpus.graph.json`);
console.log(`tensor network: nodes=${tn.stats.nodeCount} bonds=${tn.stats.bondCount} maxRank=${tn.stats.maxRank}`);
console.log(`  perLayer=${JSON.stringify(tn.stats.perLayer)} causalComponents=${tn.stats.causalComponents} crossDocCauses=${tn.stats.crossDocCauses} χ-params=${tn.stats.totalParams}`);
console.log(`  → ${outDir}/tensor-network.json + docs/site/examples/tensor-network.svg`);
