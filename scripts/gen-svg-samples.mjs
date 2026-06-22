/**
 * Pages 用「出力例」SVG ジェネレータ。
 * docx/テキスト(簡易 DAG) / xlsx(グリッド) / pptx(bbox 版面) の 3 種を
 * dist のレンダラで生成し docs/site/examples/ に書き出す。
 *
 *   npm run build && node scripts/gen-svg-samples.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { emptyGraph, upsertNode, addEdge } from "../dist/src/graph/model.js";
import { diagnose } from "../dist/src/analyze/diagnose.js";
import { renderDiagnosisSvg } from "../dist/src/visual/svg.js";

const causal = (polarity, mechanism, confidence, status) => ({
  polarity, mechanism, confidence,
  evidence: [{ nodeId: "x", quote: "" }], status,
});

// ---------- 1) docx / テキスト: 簡易 DAG レイアウト ----------
async function docxSample() {
  const g = emptyGraph([{ path: "report.docx", app: "doc" }]);
  const S = {
    S1: "原材料価格が世界的に高騰した。",
    S2: "自社の製造コストが大幅に上昇した。",
    S3: "採算確保のため販売価格を引き上げた。",
    S4: "値上げの影響で販売数量が落ち込んだ。",
    S5: "売上高は前年同期を下回った。",
    S6: "競合が大規模な値下げを実施した。",
    S7: "当社の市場シェアが低下した。",
    S8: "四半期の営業利益は前年から悪化した。",
  };
  for (const [id, text] of Object.entries(S)) {
    upsertNode(g, id, { kind: "paragraph", part: "word/document.xml", path: `w:p[${id}]`, label: text, text, provenance: ["demo"] });
  }
  upsertNode(g, "ISO", { kind: "paragraph", part: "word/document.xml", path: "w:p[ISO]", label: "今期は新オフィスに移転した。", text: "今期は新オフィスに移転した。", provenance: ["demo"] });
  const E = [
    ["S1", "S2", "+", 0.85], ["S2", "S3", "+", 0.8], ["S3", "S4", "-", 0.82],
    ["S4", "S5", "+", 0.8], ["S5", "S8", "+", 0.78], ["S6", "S7", "-", 0.8],
    ["S7", "S5", "+", 0.7], ["S2", "S8", "-", 0.3], // S2→S8 は低 confidence = 成立しない(赤)
  ];
  for (const [f, t, pol, conf] of E) {
    addEdge(g, { kind: "causes", from: f, to: t, weight: 0.6, causal: causal(pol, `${f}→${t}`, conf, conf < 0.5 ? "refuted" : "supported") });
  }
  return renderDiagnosisSvg(g, await diagnose(g));
}

// ---------- 2) xlsx: Sheet!A1 グリッド配置 ----------
async function xlsxSample() {
  const g = emptyGraph([{ path: "pl.xlsx", app: "xls" }]);
  const cell = (ref, text) =>
    upsertNode(g, ref, { kind: "cell", part: "xl/worksheets/sheet1.xml", path: ref, label: `PL!${ref}`, text, source: { app: "xls", ooxmlTag: "c" }, provenance: ["demo"] });
  cell("B2", "売上 1200"); cell("B3", "原材料費 520"); cell("B4", "製造コスト 760");
  cell("B5", "販売価格 +8%"); cell("B6", "販売数量 -6%"); cell("B7", "営業利益 90");
  const E = [
    ["B3", "B4", "+", 0.85], ["B4", "B5", "+", 0.8], ["B5", "B6", "-", 0.82],
    ["B6", "B2", "+", 0.78], ["B2", "B7", "+", 0.8], ["B4", "B7", "-", 0.4],
  ];
  for (const [f, t, pol, conf] of E) {
    addEdge(g, { kind: "causes", from: f, to: t, weight: 0.6, causal: causal(pol, `${f}→${t}`, conf, conf < 0.5 ? "refuted" : "supported") });
  }
  return renderDiagnosisSvg(g, await diagnose(g));
}

// ---------- 3) pptx: シェイプ bbox(EMU) の版面再現 ----------
async function pptxSample() {
  const g = emptyGraph([{ path: "q1.pptx", app: "ppt" }]);
  const shape = (id, text, x, y, w, h) =>
    upsertNode(g, id, { kind: "shape", part: "ppt/slides/slide1.xml", path: `p:sp[${id}]`, label: text, text, bbox: { x, y, w, h, unit: "emu" }, source: { app: "ppt", ooxmlTag: "sp" }, provenance: ["demo"] });
  // EMU: 914400/inch。16:9 スライド ≈ 12192000 x 6858000。
  shape("title", "Q1 業績サマリ", 457200, 274320, 8229600, 731520);
  shape("A", "値上げで販売数量が減少", 457200, 1645920, 3657600, 1280160);
  shape("B", "競合の大規模値下げ", 4114800, 1645920, 3657600, 1280160);
  shape("mid", "市場シェアが低下", 4114800, 3383280, 3657600, 1097280);
  shape("concl", "営業利益が前年から悪化", 1828800, 5029200, 5486400, 1097280);
  const E = [
    ["A", "concl", "+", 0.8], ["B", "mid", "-", 0.82], ["mid", "concl", "+", 0.78],
    ["A", "mid", "+", 0.3], // 低 confidence = 成立しない(赤)
  ];
  for (const [f, t, pol, conf] of E) {
    addEdge(g, { kind: "causes", from: f, to: t, weight: 0.6, causal: causal(pol, `${f}→${t}`, conf, conf < 0.5 ? "refuted" : "supported") });
  }
  return renderDiagnosisSvg(g, await diagnose(g));
}

const outDir = "docs/site/examples";
await mkdir(outDir, { recursive: true });
const samples = { "diagnosis-docx": await docxSample(), "diagnosis-xlsx": await xlsxSample(), "diagnosis-pptx": await pptxSample() };
for (const [name, svg] of Object.entries(samples)) {
  await writeFile(`${outDir}/${name}.svg`, svg);
  console.log(`→ ${outDir}/${name}.svg (${svg.length} bytes)`);
}
