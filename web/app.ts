/**
 * office-casual WebGPU デモ (OOXML ドロップ + 因果グラフ可視化)。
 *
 * ブラウザ (Chrome/Edge, WebGPU) だけで office-casual の実コードを再利用:
 *   .xlsx/.pptx/.docx or テキスト
 *     → openPackage + buildStructuralGraph (構造/参照/依存)
 *     → TransformersEmbedder(webgpu) で weight・tag・候補選別        [役割①]
 *     → WebGpuGemmaAdjudicator(webgpu, Gemma 4 E2B) で向き/極性裁定  [役割②]
 *     → SVG で因果グラフ描画
 * API キー不要・データはブラウザ外に出ない。
 *
 * ビルド: npm run build && npm run build:web   配信: npm run serve:web
 */
import { openPackage } from "../dist/src/ooxml/opc.js";
import { buildStructuralGraph } from "../dist/src/graph/builder.js";
import { emptyGraph, upsertNode, addEdge } from "../dist/src/graph/model.js";
import { makeDataId } from "../dist/src/id/hash.js";
import { TransformersEmbedder } from "../dist/src/embed/model.js";
import { embedNodes, weightEdges, proposeEdges, dedupUndirected } from "../dist/src/embed/weight.js";
import { tagNodes } from "../dist/src/embed/tag.js";
import { WebGpuGemmaAdjudicator } from "../dist/src/llm/gemma-webgpu.js";
import { embedDataPart, readDataPart } from "../dist/src/ooxml/embed.js";
import { locate, deepLink } from "../dist/src/locate.js";
import { diagnose } from "../dist/src/analyze/diagnose.js";
import type { CausalGraph, DataId } from "../dist/src/types.js";
// @ts-ignore  importmap で解決 (CDN ESM)
import cytoscape from "cytoscape";

const EMBED_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const GEMMA_MODEL = "onnx-community/gemma-4-E2B-it-ONNX";
const THRESHOLD = 0.4;

const $ = (id: string) => document.getElementById(id)!;
const log = (m: string) => {
  ($("log") as HTMLPreElement).textContent += m + "\n";
  ($("log") as HTMLPreElement).scrollTop = 1e9;
};
// WebGPU は「API の有無」だけでなく「アダプタが取れるか」まで確認する。
let GPU = false;
async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    GPU = !!(gpu && (await gpu.requestAdapter()));
  } catch {
    GPU = false;
  }
  return GPU;
}
function showBanner() {
  const el = $("banner");
  if (!el) return;
  el.hidden = false;
  if (GPU) {
    el.className = "banner ok";
    el.innerHTML = "✅ <b>WebGPU 有効</b> — GPU で高速に実行します。";
  } else {
    el.className = "banner";
    el.innerHTML =
      "⚠ <b>WebGPU が無効です。</b>CPU(WASM) にフォールバックします。埋め込みは動きますが、" +
      "<b>Gemma 4 の因果裁定は非常に低速</b>（数十秒〜/件）で実用的ではありません。" +
      "<b>Chrome / Edge（最新, WebGPU 有効）</b>での実行を推奨します。";
  }
}

let droppedFile: { name: string; bytes: Uint8Array } | null = null;

function graphFromText(sentences: string[]): CausalGraph {
  const g = emptyGraph([{ path: "input.txt", app: "doc" }]);
  sentences.forEach((t, i) => {
    const id = makeDataId("text", `s${i}`, t);
    upsertNode(g, id, { kind: "paragraph", part: "text", path: `s${i}`, text: t, label: `¶${i + 1}: ${t.slice(0, 30)}`, provenance: ["input"] });
  });
  return g;
}

/** (j) 埋め込み済み payload から CausalGraph を復元 (再解析なし)。 */
function graphFromPayload(p: ReturnType<typeof readDataPart>): CausalGraph {
  const g = emptyGraph();
  for (const n of p!.nodes) {
    upsertNode(g, n.id as DataId, {
      kind: n.kind as any, part: n.part, path: n.path, provenance: ["embedded"],
      ...(n.label !== undefined ? { label: n.label } : {}),
      ...(n.text !== undefined ? { text: n.text } : {}),
      ...(n.value !== undefined ? { value: n.value } : {}),
      ...(n.tags !== undefined ? { tags: n.tags } : {}),
    });
  }
  for (const e of p!.edges) {
    addEdge(g, { kind: e.kind as any, from: e.from as DataId, to: e.to as DataId,
      ...(e.weight !== undefined ? { weight: e.weight } : {}),
      ...(e.causal !== undefined ? { causal: e.causal as any } : {}) });
  }
  return g;
}

async function buildGraph(): Promise<CausalGraph> {
  if (droppedFile) {
    log(`[parse] ${droppedFile.name} (OOXML) ...`);
    const pkg = openPackage(droppedFile.bytes);
    const g = buildStructuralGraph(pkg);
    log(`[parse] app=${pkg.app} nodes=${g.nodes.size} edges=${g.edges.length}`);
    return g;
  }
  const sentences = ($("input") as HTMLTextAreaElement).value.split("\n").map((s) => s.trim()).filter(Boolean);
  return graphFromText(sentences);
}

async function run() {
  ($("log") as HTMLPreElement).textContent = "";
  $("svg").innerHTML = "";
  await detectWebGPU();
  showBanner();
  const dev: "webgpu" | "wasm" = GPU ? "webgpu" : "wasm";

  // (j) .ocz 検出 → 埋め込み済みグラフを再解析せず即描画。
  if (droppedFile) {
    const payload = readDataPart(droppedFile.bytes);
    if (payload) {
      const g = graphFromPayload(payload);
      lastGraph = g;
      const causes = g.edges.filter((e) => e.kind === "causes").length;
      log(`✓ 埋め込み済み .ocz を検出 → 再解析せず描画 (nodes=${g.nodes.size}, causes=${causes})`);
      renderGraph(g);
      log("完了。");
      return;
    }
  }

  if (!GPU) log("⚠ WebGPU 無効 → wasm 動作 (低速)。Chrome/Edge 推奨。");
  const g = await buildGraph();
  const textNodes = [...g.nodes.values()].filter((n) => n.meta.text);
  if (textNodes.length < 2) return log("テキストを持つノードが2つ以上必要です。");

  // ① 埋め込み: weight + tag + 候補選別 (WebGPU)
  log(`[embed] ${EMBED_MODEL} (${dev}) ...`);
  const embedder = new TransformersEmbedder(EMBED_MODEL, dev, "q8");
  const vecs = await embedNodes(g, embedder);
  weightEdges(g, vecs);
  await tagNodes(g, vecs, embedder);
  // (e) WASM フォールバック: 低速なので候補数と生成長を絞る。WebGPU は通常設定。
  const maxPairs = dev === "wasm" ? 8 : 40;
  const maxNew = dev === "wasm" ? 48 : 256;
  if (dev === "wasm") log(`[fallback] wasm: Gemma=E2B 固定 / 候補上限=${maxPairs} / max_new_tokens=${maxNew} に制限`);
  const pairs = dedupUndirected(proposeEdges(g, vecs, { kind: "causes", threshold: THRESHOLD, max: maxPairs }));
  log(`[embed] 候補ペア ${pairs.length} 件 (閾値 ${THRESHOLD})`);

  // ② Gemma 4 E2B で向き・極性・根拠を裁定 (WebGPU / wasm)
  log(`[gemma] ${GEMMA_MODEL} (${dev}, q4f16) … 初回 DL`);
  const adj = new WebGpuGemmaAdjudicator({
    model: GEMMA_MODEL, // E2B 固定 (wasm でも何とか動く最小構成)
    device: dev,
    maxNewTokens: maxNew,
    onProgress: (i: any) => { if (i?.status === "progress" && i?.file && (i.progress ?? 0) % 25 < 1) log(`  ${i.file} ${Math.round(i.progress)}%`); },
  });
  const lbl = (id: string) => g.nodes.get(id as DataId)?.meta.text ?? id;
  let n = 0;
  for (const p of pairs) {
    const v = await adj.judgeOne(lbl(p.from), lbl(p.to));
    const dir = String(v.direction ?? "").replace(/→/g, "->");
    if (!dir || /none/i.test(dir)) { log(`  none: ${shorten(lbl(p.from))} ~ ${shorten(lbl(p.to))}`); continue; }
    const [from, to] = /A->B/.test(dir) ? [p.from, p.to] : [p.to, p.from];
    addEdge(g, { kind: "causes", from: from as DataId, to: to as DataId, weight: p.weight,
      causal: { polarity: (v.polarity as any) ?? "?", mechanism: v.mechanism ?? "", confidence: 0.5,
        evidence: [
          { nodeId: from as DataId, quote: lbl(from) },
          { nodeId: to as DataId, quote: lbl(to) },
        ], status: "hypothesis" } });
    n++;
    log(`  ✓ ${shorten(lbl(from))} -(${v.polarity ?? "?"})→ ${shorten(lbl(to))}`);
  }
  log(`[gemma] 因果エッジ ${n} 件`);
  renderGraph(g);
  log("完了。");
}

const shorten = (s: string) => (s.length > 22 ? s.slice(0, 22) + "…" : s);

const COLOR: Record<string, string> = { contains: "#bbb", references: "#39f", "derives-from": "#2a2", mentions: "#f90", causes: "#e22" };

let cy: any = null;
let lastGraph: CausalGraph | null = null;

const escH = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** OOXML の出所を人間可読に (slideN / Sheet!cell / document)。 */
function sourceLabel(m: { source?: { app: string }; part: string; path: string; label?: string }): string {
  if (m.source?.app === "ppt") {
    const sl = m.part.match(/slide(\d+)/);
    return sl ? `スライド ${sl[1]}` : m.part;
  }
  if (m.source?.app === "xls") return m.label ?? m.part; // 例 "Sheet1!B2"
  if (m.source?.app === "doc") return `本文 ${m.path.replace(/^w:document\/?/, "")}`;
  return m.part;
}

/** クリックされたパートのノードを強調しグラフをフィット (ジャンプ表示)。 */
function focusPart(part: string) {
  if (!cy || !lastGraph) return;
  const ids = [...lastGraph.nodes.values()].filter((n) => n.meta.part === part).map((n) => n.id);
  cy.elements().removeClass("hl");
  let eles = cy.collection();
  for (const id of ids) {
    const el = cy.getElementById(id);
    if (el.length) eles = eles.union(el);
  }
  if (eles.length) {
    eles.addClass("hl");
    cy.animate({ fit: { eles, padding: 50 }, duration: 350 });
    log(`[focus] ${part}: ${eles.length} ノードを強調`);
  } else {
    log(`[focus] ${part}: グラフ上に該当ノードなし`);
  }
}

/** ノードクリック: 本文・タグ・data-id・接続する因果エッジを表示。 */
function showNode(id: DataId) {
  const g = lastGraph;
  if (!g) return;
  const nd = g.nodes.get(id);
  if (!nd) return;
  const m = nd.meta;
  const tags = (m.tags ?? []).map((t) => `<span class="tag">${escH(t)}</span>`).join("");
  const lbl = (x: DataId) => escH(g.nodes.get(x)?.meta.text ?? g.nodes.get(x)?.meta.label ?? x);

  // (f) 因果行: クリックで相手ノードへフォーカス移動。
  const causal = g.edges.filter((e) => e.kind === "causes" && (e.from === id || e.to === id));
  const rels = causal
    .map((e) => {
      const other = e.from === id ? e.to : e.from;
      const dir = e.from === id ? `→ <b>${lbl(other)}</b>` : `← <b>${lbl(other)}</b>`;
      return `<div class="mech" data-node="${escH(other)}">(${escH(e.causal?.polarity ?? "?")}) ${dir}<br><small>${escH(e.causal?.mechanism ?? "")}</small></div>`;
    })
    .join("");

  // (g) 依存 (derives-from): セルの数式依存。クリックで該当セルへ移動。
  const deriv = g.edges.filter((e) => e.kind === "derives-from" && (e.from === id || e.to === id));
  const up = deriv.filter((e) => e.from === id).map((e) => `<div class="ev" data-node="${escH(e.to)}">↑ 依存元: <b>${lbl(e.to)}</b></div>`).join("");
  const down = deriv.filter((e) => e.to === id).map((e) => `<div class="ev" data-node="${escH(e.from)}">↓ 利用先: <b>${lbl(e.from)}</b></div>`).join("");
  const derivSec = deriv.length
    ? `<h4>依存 (derives-from ${deriv.length})</h4>${up}${down}`
    : "";

  $("panel").innerHTML =
    `<h4>${escH(m.kind)}${m.value !== undefined ? ` = ${escH(String(m.value))}` : ""}</h4>` +
    `<div class="id">${escH(id)}</div>` +
    (tags ? `<div>${tags}</div>` : "") +
    (m.text ? `<p>${escH(m.text)}</p>` : `<p class="muted">${escH(m.label ?? "")}</p>`) +
    `<h4>出所 (OOXML)</h4>` +
    `<div><b>${escH(sourceLabel(m))}</b></div>` +
    `<div class="id">${escH(m.part)}<br>${escH(m.path)}</div>` +
    (() => {
      const loc = locate(m as any);
      const fname = droppedFile?.name ?? "file";
      const dl = deepLink(m as any, fname);
      return `<div>📍 <b>${escH(loc.descriptor)}</b>` +
        (loc.excelFragment ? ` <button data-copy="${escH(dl)}" title="Excel/LibreOffice 用リンクをコピー">📋 ${escH(dl)}</button>` : "") +
        `</div>`;
    })() +
    `<button data-part="${escH(m.part)}">▷ 同じパートのノードを強調</button>` +
    derivSec +
    (rels ? `<h4>因果 (${causal.length})</h4>${rels}` : `<p class="muted">接続する因果エッジなし</p>`);
}

/** エッジクリック: 種別・極性・weight・メカニズム・根拠を表示。 */
function showEdge(id: string) {
  const g = lastGraph;
  if (!g) return;
  const e = g.edges.find((x) => x.id === id);
  if (!e) return;
  const lbl = (x: DataId) => escH(g.nodes.get(x)?.meta.text ?? g.nodes.get(x)?.meta.label ?? x);
  const ev = (e.causal?.evidence ?? []).map((x) => `<div class="ev">▸ ${escH(x.quote)}</div>`).join("");
  $("panel").innerHTML =
    `<h4 style="color:${COLOR[e.kind] ?? "#333"}">${escH(e.kind)}${e.causal ? ` (${escH(e.causal.polarity)})` : ""}</h4>` +
    `<p><b>原因</b> ${lbl(e.from)}<br><b>結果</b> ${lbl(e.to)}</p>` +
    (e.weight !== undefined ? `<div class="muted">weight ${e.weight.toFixed(3)}${e.causal ? ` / confidence ${e.causal.confidence}` : ""}</div>` : "") +
    (e.causal?.mechanism ? `<div class="mech">${escH(e.causal.mechanism)}</div>` : "") +
    (ev ? `<h4>根拠</h4>${ev}` : "");
}

/** (f)(g) 指定ノードへフォーカス移動: 強調 + 近傍にフィット + パネル更新。 */
function focusNode(id: DataId) {
  if (!cy || !lastGraph) return;
  const el = cy.getElementById(id);
  if (el.length) {
    cy.elements().removeClass("hl");
    el.addClass("hl");
    cy.animate({ fit: { eles: el.closedNeighborhood(), padding: 80 }, duration: 300 });
  }
  showNode(id);
}

/** Cytoscape.js でインタラクティブ描画 (ズーム/パン/ドラッグ)。 */
function renderGraph(g: CausalGraph) {
  lastGraph = g;
  // 描画対象: causes/derives-from の端点 + text ノード (xlsx の大量セルを抑制)。
  const keep = new Set<DataId>();
  for (const e of g.edges) if (e.kind === "causes" || e.kind === "derives-from") { keep.add(e.from); keep.add(e.to); }
  for (const nd of g.nodes.values()) if (nd.meta.text && keep.size < 60) keep.add(nd.id);

  const elements: any[] = [];
  for (const id of keep) {
    const nd = g.nodes.get(id)!;
    const tag = nd.meta.tags?.[0] ? ` [${nd.meta.tags[0]}]` : "";
    elements.push({ data: { id, label: shorten(nd.meta.text ?? nd.meta.label ?? nd.meta.kind) + tag, kind: nd.meta.kind } });
  }
  for (const e of g.edges) {
    if (!keep.has(e.from) || !keep.has(e.to)) continue;
    elements.push({
      data: { id: e.id, source: e.from, target: e.to, kind: e.kind, w: e.weight ?? 0,
        label: e.kind === "causes" ? `${e.causal?.polarity ?? ""}` : "" },
    });
  }

  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("svg"),
    elements,
    style: [
      { selector: "node", style: { label: "data(label)", "font-size": 10, "background-color": "#345",
        width: 10, height: 10, color: "#222", "text-wrap": "wrap", "text-max-width": "140px", "text-valign": "center", "text-halign": "right" } },
      { selector: 'node[kind="entity"]', style: { "background-color": "#f90", width: 14, height: 14 } },
      { selector: "edge", style: { width: "mapData(w, 0, 1, 1, 6)", "line-color": "#bbb", "curve-style": "bezier", opacity: 0.45 } },
      { selector: 'edge[kind="derives-from"]', style: { "line-color": COLOR["derives-from"], "target-arrow-color": COLOR["derives-from"], "target-arrow-shape": "triangle", opacity: 0.6 } },
      { selector: 'edge[kind="references"]', style: { "line-color": COLOR["references"], opacity: 0.5 } },
      { selector: 'edge[kind="causes"]', style: { "line-color": COLOR["causes"], "target-arrow-color": COLOR["causes"],
        "target-arrow-shape": "triangle", opacity: 0.95, label: "data(label)", "font-size": 13, "font-weight": "bold", color: COLOR["causes"], "text-background-color": "#fff", "text-background-opacity": 1 } },
      { selector: "node.hl", style: { "background-color": "#e22", width: 18, height: 18, "border-width": 3, "border-color": "#900", "z-index": 99 } },
      // 診断 (diagnose) カテゴリ
      { selector: "node.iso", style: { "background-color": "#bbb" } },
      { selector: "node.variant", style: { "border-color": "#e89400", "border-width": 3, "border-style": "dotted" } },
      { selector: "edge.nothold", style: { "line-color": "#d22", "line-style": "dashed", "target-arrow-color": "#d22" } },
      { selector: "edge.jump", style: { "line-color": "#83c", "line-style": "dashed", "target-arrow-color": "#83c", label: "⚡" } },
    ],
    layout: { name: "cose", animate: false, padding: 20, nodeRepulsion: 8000, idealEdgeLength: 110 },
    wheelSensitivity: 0.3,
  });

  // クリックで詳細をサイドパネルへ。
  cy.on("tap", "node", (ev: any) => showNode(ev.target.id() as DataId));
  cy.on("tap", "edge", (ev: any) => showEdge(ev.target.id()));
  cy.on("tap", (ev: any) => {
    if (ev.target === cy) $("panel").innerHTML = `<span class="muted">ノード/エッジをクリックして詳細表示。</span>`;
  });
}

// --- ファイルドロップ ---
function wireDrop() {
  const dz = $("drop");
  const setFile = async (f: File) => {
    droppedFile = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    const embedded = !!readDataPart(droppedFile.bytes);
    dz.textContent = embedded
      ? `📄 ${f.name} ✓ 埋め込み済み (.ocz) — Run で再解析せず即描画`
      : `📄 ${f.name} (テキスト入力は無視されます)`;
  };
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("over");
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) setFile(f);
  });
  ($("file") as HTMLInputElement).addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) setFile(f);
  });
  $("clearFile").addEventListener("click", () => { droppedFile = null; dz.textContent = "ここに .xlsx / .pptx / .docx をドロップ"; });
}

// (i)(s) 解析済みグラフを元 OOXML に非破壊埋め込みし、File System Access API で保存
// (保存先を選んで書き込む → OS の関連付けでダブルクリック起動)。非対応ならダウンロード。
async function downloadOcz() {
  if (!droppedFile) return log("⚠ .ocz 書き出しは OOXML ファイルをドロップした場合のみ可能です。");
  if (!lastGraph) return log("⚠ 先に Run してください。");
  const out = embedDataPart(droppedFile.bytes, lastGraph, { format: "jsonl" });
  const name = droppedFile.name.replace(/(\.[^.]+)$/, ".ocz$1");
  const ext = name.split(".").pop()!;
  const blob = new Blob([out as BlobPart], { type: "application/octet-stream" });

  const w = window as any;
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "Office (OOXML)", accept: { "application/octet-stream": ["." + ext] } }],
      });
      const ws = await handle.createWritable();
      await ws.write(blob);
      await ws.close();
      log(`💾 保存: ${name} — ダブルクリックで ${ext} の実アプリが開きます (File System Access API)`);
      return;
    } catch (e: any) {
      if (e?.name === "AbortError") return log("保存をキャンセルしました。");
      // それ以外はダウンロードにフォールバック
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  log(`💾 ${name} をダウンロード (File System Access 非対応のため)。`);
}

// 🔍 診断: 独立 / 成立しない / 表記揺れ / 概念のとび をグラフ上に色分け表示。
async function runDiagnose() {
  if (!lastGraph || !cy) return log("⚠ 先に Run してください。");
  const dev = GPU ? "webgpu" : "wasm";
  const embedder = new TransformersEmbedder(EMBED_MODEL, dev, "q8");
  log("[diagnose] 解析中 …");
  const d = await diagnose(lastGraph, embedder);
  cy.elements().removeClass("iso variant nothold jump");
  for (const x of d.isolated) cy.getElementById(x.id).addClass("iso");
  for (const v of d.notationVariants) for (const m of v.members) cy.getElementById(m.id).addClass("variant");
  for (const x of d.notHolding) cy.getElementById(x.edge).addClass("nothold");
  for (const x of d.conceptJumps) cy.getElementById(x.edge).addClass("jump");
  log(`[diagnose] 独立=${d.summary.isolated} 成立しない=${d.summary.notHolding} 表記揺れ=${d.summary.notationVariants} 概念のとび=${d.summary.conceptJumps}`);
  $("panel").innerHTML =
    `<h4>🔍 診断</h4>` +
    `<div class="mech" style="border-color:#999">▢ 独立 (${d.summary.isolated}): ${d.isolated.slice(0, 8).map((x) => shorten(x.label)).join(", ")}</div>` +
    `<div class="mech">╌ 成立しない (${d.summary.notHolding}): ${d.notHolding.map((x) => `${shorten(x.from)}→${shorten(x.to)}`).join("; ")}</div>` +
    `<div class="mech" style="border-color:#e89400">表記揺れ (${d.summary.notationVariants}): ${d.notationVariants.map((v) => v.members.map((m) => m.label).join("≈")).join(" / ")}</div>` +
    `<div class="mech" style="border-color:#83c">⚡ 概念のとび (${d.summary.conceptJumps}): ${d.conceptJumps.map((x) => `${shorten(x.from)}→${shorten(x.to)}(${x.similarity})`).join("; ")}</div>`;
}

wireDrop();
($("dlBtn") as HTMLButtonElement).addEventListener("click", () => downloadOcz().catch((e) => log("ERROR: " + (e?.message ?? e))));
($("dxBtn") as HTMLButtonElement).addEventListener("click", () => runDiagnose().catch((e) => log("ERROR: " + (e?.message ?? e))));
// パネル内の [data-part] ボタン → 該当パートのノードを強調 (innerHTML 差し替えに強い委譲)。
$("panel").addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const cp = el.closest("[data-copy]");
  if (cp) { const v = cp.getAttribute("data-copy")!; navigator.clipboard?.writeText(v); log(`📋 コピー: ${v}`); return; }
  const np = el.closest("[data-node]");
  if (np) { focusNode(np.getAttribute("data-node")! as DataId); return; }
  const pp = el.closest("[data-part]");
  if (pp) focusPart(pp.getAttribute("data-part")!);
});
($("runBtn") as HTMLButtonElement).addEventListener("click", () => run().catch((e) => log("ERROR: " + (e?.message ?? e))));
detectWebGPU().then(() => {
  showBanner();
  log(GPU ? "WebGPU 利用可。テキスト or ファイルで Run。" : "⚠ WebGPU 非対応 (wasm 動作)。Gemma 4 は低速です。");
});
