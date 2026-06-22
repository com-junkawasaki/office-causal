/**
 * office-causal demo エンジン (フレームワーク非依存)。
 * office-causal の実コードを再利用し、OOXML/テキスト → 因果グラフ解析 → 描画/診断/so-what を行う。
 * WebGPU を自動検出し、無ければ wasm に透過フォールバック (ユーザーは意識不要)。
 * UI(Svelte) は要素参照とコールバックを渡すだけ。
 */
import { openPackage } from "../../dist/src/ooxml/opc.js";
import { buildStructuralGraph } from "../../dist/src/graph/builder.js";
import { emptyGraph, upsertNode, addEdge } from "../../dist/src/graph/model.js";
import { makeDataId } from "../../dist/src/id/hash.js";
import { TransformersEmbedder } from "../../dist/src/embed/model.js";
import { embedNodes, weightEdges, proposeEdges, dedupUndirected } from "../../dist/src/embed/weight.js";
import { tagNodes } from "../../dist/src/embed/tag.js";
import { WebGpuGemmaAdjudicator } from "../../dist/src/llm/gemma-webgpu.js";
import { embedDataPart, readDataPart, validatePayload } from "../../dist/src/ooxml/embed.js";
import { locate, deepLink } from "../../dist/src/locate.js";
import { diagnose, type Diagnosis } from "../../dist/src/analyze/diagnose.js";
import { consult } from "../../dist/src/analyze/consult.js";
import { mece } from "../../dist/src/analyze/mece.js";
import { nodeRoles } from "../../dist/src/visual/interactive.js";
import type { CausalGraph, DataId } from "../../dist/src/types.js";
// @ts-ignore  Vite が node_modules からバンドル
import cytoscape from "cytoscape";

const EMBED_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const GEMMA_MODEL = "onnx-community/gemma-4-E2B-it-ONNX";
const THRESHOLD = 0.4;

const shorten = (s: string, n = 22) => (s.length > n ? s.slice(0, n) + "…" : s);
const escH = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const COLOR: Record<string, string> = { contains: "#bbb", references: "#39f", "derives-from": "#2a2", mentions: "#f90", causes: "#e22" };

export type Device = "webgpu" | "wasm";
export interface EngineOpts {
  graphEl: HTMLElement;
  panelEl: HTMLElement;
  onLog: (m: string) => void;
  onStatus: (s: string, busy: boolean) => void;
  onDevice: (d: Device) => void;
  onFile: (name: string | null, embedded: boolean) => void;
}

export class Engine {
  private droppedFile: { name: string; bytes: Uint8Array } | null = null;
  private cy: any = null;
  private lastGraph: CausalGraph | null = null;
  private lastDiag: Diagnosis | null = null;
  private lastConsult: any = null;
  private lastMece: any = null;
  private GPU = false;
  private detected = false;

  constructor(private o: EngineOpts) {}
  private log = (m: string) => this.o.onLog(m);
  get hasGraph() { return !!this.lastGraph; }
  get hasFile() { return !!this.droppedFile; }
  get device(): Device { return this.GPU ? "webgpu" : "wasm"; }

  async detect(): Promise<Device> {
    if (this.detected) return this.device;
    try {
      const gpu = (navigator as any).gpu;
      this.GPU = !!(gpu && (await gpu.requestAdapter()));
    } catch { this.GPU = false; }
    this.detected = true;
    this.o.onDevice(this.device);
    return this.device;
  }

  async setFile(f: File) {
    this.droppedFile = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    const embedded = !!readDataPart(this.droppedFile.bytes);
    this.o.onFile(f.name, embedded);
  }
  clearFile() { this.droppedFile = null; this.o.onFile(null, false); }

  // ---------- グラフ構築 ----------
  private graphFromText(sentences: string[]): CausalGraph {
    const g = emptyGraph([{ path: "input.txt", app: "doc" }]);
    sentences.forEach((t, i) => {
      const id = makeDataId("text", `s${i}`, t);
      upsertNode(g, id, { kind: "paragraph", part: "text", path: `s${i}`, text: t, label: `¶${i + 1}: ${t.slice(0, 30)}`, provenance: ["input"] });
    });
    return g;
  }
  private graphFromPayload(p: ReturnType<typeof readDataPart>): CausalGraph {
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

  // ---------- メイン解析 ----------
  async run(text: string): Promise<void> {
    this.panelMuted();
    this.o.onStatus("準備中…", true);
    await this.detect();
    const dev = this.device;

    // .ocz 検出 → 埋め込み済みグラフを再解析せず即描画。
    if (this.droppedFile) {
      const payload = readDataPart(this.droppedFile.bytes);
      if (payload) {
        const g = this.graphFromPayload(payload);
        this.lastGraph = g;
        const causes = g.edges.filter((e) => e.kind === "causes").length;
        this.log(`✓ 埋め込み済み .ocz を検出 → 再解析せず描画 (nodes=${g.nodes.size}, causes=${causes})`);
        for (const w of validatePayload(payload)) this.log(`⚠ ${w}`);
        this.renderGraph(g);
        const an = (payload as any).analysis;
        if (an) {
          if (an.diagnosis) { this.lastDiag = an.diagnosis; this.applyDiagClasses(an.diagnosis); }
          if (an.consult) this.lastConsult = an.consult;
          if (an.mece) this.lastMece = an.mece;
          if (an.consult || an.mece) this.showConsultPanel(an.consult, an.mece);
        }
        this.o.onStatus("完了", false);
        return;
      }
    }

    let g: CausalGraph;
    if (this.droppedFile) {
      this.log(`[解析] ${this.droppedFile.name} を読み込み中…`);
      const pkg = openPackage(this.droppedFile.bytes);
      g = buildStructuralGraph(pkg);
      this.log(`[解析] app=${pkg.app} nodes=${g.nodes.size} edges=${g.edges.length}`);
    } else {
      const sentences = text.split("\n").map((s) => s.trim()).filter(Boolean);
      g = this.graphFromText(sentences);
    }
    const textNodes = [...g.nodes.values()].filter((n) => n.meta.text);
    if (textNodes.length < 2) { this.o.onStatus("テキストノードが2つ以上必要", false); return this.log("テキストを持つノードが2つ以上必要です。"); }

    // ① 埋め込み: weight + tag + 候補選別
    this.o.onStatus("意味埋め込みを準備中…", true);
    this.log(`[埋め込み] モデル準備中…`);
    const embedder = new TransformersEmbedder(EMBED_MODEL, dev, "q8");
    const vecs = await embedNodes(g, embedder);
    weightEdges(g, vecs);
    await tagNodes(g, vecs, embedder);
    const maxPairs = dev === "wasm" ? 8 : 40;
    const maxNew = dev === "wasm" ? 48 : 256;
    const pairs = dedupUndirected(proposeEdges(g, vecs, { kind: "causes", threshold: THRESHOLD, max: maxPairs }));
    this.log(`[埋め込み] 因果候補 ${pairs.length} 件`);

    // ② Gemma 4 で向き・極性・根拠を裁定
    this.o.onStatus("因果モデルを準備中（初回はDL）…", true);
    this.log(`[因果裁定] Gemma 4 を準備中…`);
    const adj = new WebGpuGemmaAdjudicator({
      model: GEMMA_MODEL, device: dev, maxNewTokens: maxNew,
      onProgress: (i: any) => { if (i?.status === "progress" && i?.file && (i.progress ?? 0) % 25 < 1) this.log(`  ${i.file} ${Math.round(i.progress)}%`); },
    });
    const lbl = (id: string) => g.nodes.get(id as DataId)?.meta.text ?? id;
    let n = 0;
    for (let idx = 0; idx < pairs.length; idx++) {
      const p = pairs[idx]!;
      this.o.onStatus(`因果を裁定中… ${idx + 1}/${pairs.length}`, true);
      const v = await adj.judgeOne(lbl(p.from), lbl(p.to));
      const dir = String(v.direction ?? "").replace(/→/g, "->");
      if (!dir || /none/i.test(dir)) continue;
      const [from, to] = /A->B/.test(dir) ? [p.from, p.to] : [p.to, p.from];
      addEdge(g, { kind: "causes", from: from as DataId, to: to as DataId, weight: p.weight,
        causal: { polarity: (v.polarity as any) ?? "?", mechanism: v.mechanism ?? "", confidence: 0.5,
          evidence: [{ nodeId: from as DataId, quote: lbl(from) }, { nodeId: to as DataId, quote: lbl(to) }], status: "hypothesis" } });
      n++;
      this.log(`  ✓ ${shorten(lbl(from))} -(${v.polarity ?? "?"})→ ${shorten(lbl(to))}`);
    }
    this.log(`[因果裁定] 因果エッジ ${n} 件`);
    this.renderGraph(g);
    this.o.onStatus("完了", false);
  }

  // ---------- 描画 ----------
  private sourceLabel(m: { source?: { app: string }; part: string; path: string; label?: string }): string {
    if (m.source?.app === "ppt") { const sl = m.part.match(/slide(\d+)/); return sl ? `スライド ${sl[1]}` : m.part; }
    if (m.source?.app === "xls") return m.label ?? m.part;
    if (m.source?.app === "doc") return `本文 ${m.path.replace(/^w:document\/?/, "")}`;
    return m.part;
  }
  private panelMuted() { this.o.panelEl && (this.o.panelEl.innerHTML = `<span class="text-ink2 dark:text-zinc-400 text-sm">ノードやエッジをクリックすると詳細が表示されます。</span>`); }

  private focusPart(part: string) {
    if (!this.cy || !this.lastGraph) return;
    const ids = [...this.lastGraph.nodes.values()].filter((n) => n.meta.part === part).map((n) => n.id);
    this.cy.elements().removeClass("hl");
    let eles = this.cy.collection();
    for (const id of ids) { const el = this.cy.getElementById(id); if (el.length) eles = eles.union(el); }
    if (eles.length) { eles.addClass("hl"); this.cy.animate({ fit: { eles, padding: 50 }, duration: 350 }); }
  }
  private showNode(id: DataId) {
    const g = this.lastGraph; if (!g) return;
    const nd = g.nodes.get(id); if (!nd) return;
    const m = nd.meta;
    const tags = (m.tags ?? []).map((t) => `<span class="tag">${escH(t)}</span>`).join("");
    const lbl = (x: DataId) => escH(g.nodes.get(x)?.meta.text ?? g.nodes.get(x)?.meta.label ?? x);
    const causal = g.edges.filter((e) => e.kind === "causes" && (e.from === id || e.to === id));
    const rels = causal.map((e) => { const other = e.from === id ? e.to : e.from; const dir = e.from === id ? `→ <b>${lbl(other)}</b>` : `← <b>${lbl(other)}</b>`;
      return `<div class="mech" data-node="${escH(other)}">(${escH(e.causal?.polarity ?? "?")}) ${dir}<br><small>${escH(e.causal?.mechanism ?? "")}</small></div>`; }).join("");
    const deriv = g.edges.filter((e) => e.kind === "derives-from" && (e.from === id || e.to === id));
    const up = deriv.filter((e) => e.from === id).map((e) => `<div class="ev" data-node="${escH(e.to)}">↑ 依存元: <b>${lbl(e.to)}</b></div>`).join("");
    const down = deriv.filter((e) => e.to === id).map((e) => `<div class="ev" data-node="${escH(e.from)}">↓ 利用先: <b>${lbl(e.from)}</b></div>`).join("");
    const derivSec = deriv.length ? `<h4>依存 (derives-from ${deriv.length})</h4>${up}${down}` : "";
    this.o.panelEl.innerHTML =
      `<h4>${escH(m.kind)}${m.value !== undefined ? ` = ${escH(String(m.value))}` : ""}</h4>` +
      `<div class="id">${escH(id)}</div>` + (tags ? `<div>${tags}</div>` : "") +
      (m.text ? `<p>${escH(m.text)}</p>` : `<p class="muted">${escH(m.label ?? "")}</p>`) +
      `<h4>出所 (OOXML)</h4><div><b>${escH(this.sourceLabel(m))}</b></div><div class="id">${escH(m.part)}<br>${escH(m.path)}</div>` +
      (() => { const loc = locate(m as any); const dl = deepLink(m as any, this.droppedFile?.name ?? "file");
        return `<div>📍 <b>${escH(loc.descriptor)}</b>` + (loc.excelFragment ? ` <button data-copy="${escH(dl)}">📋 link</button>` : "") + `</div>`; })() +
      `<button data-part="${escH(m.part)}">▷ 同じパートを強調</button>` + derivSec +
      (rels ? `<h4>因果 (${causal.length})</h4>${rels}` : `<p class="muted">接続する因果エッジなし</p>`);
  }
  private showEdge(id: string) {
    const g = this.lastGraph; if (!g) return;
    const e = g.edges.find((x) => x.id === id); if (!e) return;
    const lbl = (x: DataId) => escH(g.nodes.get(x)?.meta.text ?? g.nodes.get(x)?.meta.label ?? x);
    const ev = (e.causal?.evidence ?? []).map((x) => `<div class="ev">▸ ${escH(x.quote)}</div>`).join("");
    this.o.panelEl.innerHTML =
      `<h4 style="color:${COLOR[e.kind] ?? "#333"}">${escH(e.kind)}${e.causal ? ` (${escH(e.causal.polarity)})` : ""}</h4>` +
      `<p><b>原因</b> ${lbl(e.from)}<br><b>結果</b> ${lbl(e.to)}</p>` +
      (e.weight !== undefined ? `<div class="muted">weight ${e.weight.toFixed(3)}${e.causal ? ` / confidence ${e.causal.confidence}` : ""}</div>` : "") +
      (e.causal?.mechanism ? `<div class="mech">${escH(e.causal.mechanism)}</div>` : "") + (ev ? `<h4>根拠</h4>${ev}` : "");
  }
  private focusNode(id: DataId) {
    if (!this.cy || !this.lastGraph) return;
    const el = this.cy.getElementById(id);
    if (el.length) { this.cy.elements().removeClass("hl"); el.addClass("hl"); this.cy.animate({ fit: { eles: el.closedNeighborhood(), padding: 80 }, duration: 300 }); }
    this.showNode(id);
  }
  private renderGraph(g: CausalGraph) {
    this.lastGraph = g;
    const keep = new Set<DataId>();
    for (const e of g.edges) if (e.kind === "causes" || e.kind === "derives-from") { keep.add(e.from); keep.add(e.to); }
    for (const nd of g.nodes.values()) if (nd.meta.text && keep.size < 60) keep.add(nd.id);
    const elements: any[] = [];
    for (const id of keep) { const nd = g.nodes.get(id)!; const tag = nd.meta.tags?.[0] ? ` [${nd.meta.tags[0]}]` : "";
      elements.push({ data: { id, label: shorten(nd.meta.text ?? nd.meta.label ?? nd.meta.kind) + tag, kind: nd.meta.kind } }); }
    for (const e of g.edges) { if (!keep.has(e.from) || !keep.has(e.to)) continue;
      elements.push({ data: { id: e.id, source: e.from, target: e.to, kind: e.kind, w: e.weight ?? 0, label: e.kind === "causes" ? `${e.causal?.polarity ?? ""}` : "" } }); }
    if (this.cy) this.cy.destroy();
    this.cy = cytoscape({
      container: this.o.graphEl, elements,
      style: [
        { selector: "node", style: { label: "data(label)", "font-size": 10, "background-color": "#345", width: 10, height: 10, color: "#888", "text-wrap": "wrap", "text-max-width": "140px", "text-valign": "center", "text-halign": "right" } },
        { selector: 'node[kind="entity"]', style: { "background-color": "#f90", width: 14, height: 14 } },
        { selector: "edge", style: { width: "mapData(w, 0, 1, 1, 6)", "line-color": "#bbb", "curve-style": "bezier", opacity: 0.45 } },
        { selector: 'edge[kind="derives-from"]', style: { "line-color": COLOR["derives-from"], "target-arrow-color": COLOR["derives-from"], "target-arrow-shape": "triangle", opacity: 0.6 } },
        { selector: 'edge[kind="references"]', style: { "line-color": COLOR["references"], opacity: 0.5 } },
        { selector: 'edge[kind="causes"]', style: { "line-color": COLOR["causes"], "target-arrow-color": COLOR["causes"], "target-arrow-shape": "triangle", opacity: 0.95, label: "data(label)", "font-size": 13, "font-weight": "bold", color: COLOR["causes"], "text-background-color": "#fff", "text-background-opacity": 1 } },
        { selector: "node.hl", style: { "background-color": "#e22", width: 18, height: 18, "border-width": 3, "border-color": "#900", "z-index": 99 } },
        { selector: "node.iso", style: { "background-color": "#bbb" } },
        { selector: "node.variant", style: { "border-color": "#e89400", "border-width": 3, "border-style": "dotted" } },
        { selector: "edge.nothold", style: { "line-color": "#d22", "line-style": "dashed", "target-arrow-color": "#d22" } },
        { selector: "edge.jump", style: { "line-color": "#83c", "line-style": "dashed", "target-arrow-color": "#83c", label: "⚡" } },
      ],
      layout: { name: "cose", animate: false, padding: 20, nodeRepulsion: 8000, idealEdgeLength: 110 },
      wheelSensitivity: 0.3,
    });
    this.cy.on("tap", "node", (ev: any) => this.showNode(ev.target.id() as DataId));
    this.cy.on("tap", "edge", (ev: any) => this.showEdge(ev.target.id()));
    this.cy.on("tap", (ev: any) => { if (ev.target === this.cy) this.panelMuted(); });
    // パネル内委譲クリック
    this.o.panelEl.onclick = (e) => {
      const el = e.target as HTMLElement;
      const cp = el.closest("[data-copy]"); if (cp) { const v = cp.getAttribute("data-copy")!; navigator.clipboard?.writeText(v); this.log(`📋 ${v}`); return; }
      const np = el.closest("[data-node]"); if (np) { this.focusNode(np.getAttribute("data-node")! as DataId); return; }
      const pp = el.closest("[data-part]"); if (pp) this.focusPart(pp.getAttribute("data-part")!);
    };
  }
  private applyDiagClasses(d: any) {
    if (!this.cy) return;
    this.cy.elements().removeClass("iso variant nothold jump");
    for (const x of d.isolated ?? []) this.cy.getElementById(x.id).addClass("iso");
    for (const v of d.notationVariants ?? []) for (const m of v.members) this.cy.getElementById(m.id).addClass("variant");
    for (const x of d.notHolding ?? []) this.cy.getElementById(x.edge).addClass("nothold");
    for (const x of d.conceptJumps ?? []) this.cy.getElementById(x.edge).addClass("jump");
  }
  private showConsultPanel(sw?: any, mc?: any) {
    this.o.panelEl.innerHTML =
      (sw ? `<h4>💡 so-what (${sw.chains.length})</h4>` + sw.chains.map((c: any) => `<div class="mech">${escH(c.path.join(" → "))}<br><small>💡 ${escH(c.soWhat)}${c.action ? "<br>▶ " + escH(c.action) : ""}</small></div>`).join("") : "") +
      (mc ? `<h4>MECE (${mc.effects.length})</h4>` + mc.effects.map((e: any) => `<div class="mech" style="border-color:#e89400"><b>${escH(e.effect)}</b> ← ${e.factors.map((f: string) => escH(f)).join(" / ")}` +
        (e.overlaps.length ? `<br>⚠ 重複: ${e.overlaps.map((p: string[]) => escH(p.join("≈"))).join(", ")}` : "") +
        (e.exhaustive === false ? `<br>⚠ 網羅不足${e.missing?.length ? ": " + e.missing.map((m: string) => escH(m)).join("、") : ""}` : "") + `</div>`).join("") : "");
  }

  async runDiagnose() {
    if (!this.lastGraph || !this.cy) return this.log("⚠ 先に Run してください。");
    this.o.onStatus("診断中…", true);
    const embedder = new TransformersEmbedder(EMBED_MODEL, this.device, "q8");
    const d = await diagnose(this.lastGraph, embedder);
    this.lastDiag = d; this.applyDiagClasses(d);
    this.log(`[診断] 独立=${d.summary.isolated} 成立しない=${d.summary.notHolding} 表記揺れ=${d.summary.notationVariants} 概念のとび=${d.summary.conceptJumps}`);
    this.o.panelEl.innerHTML =
      `<h4>🔍 診断</h4>` +
      `<div class="mech" style="border-color:#999">▢ 独立 (${d.summary.isolated}): ${d.isolated.slice(0, 8).map((x) => shorten(x.label)).join(", ")}</div>` +
      `<div class="mech">╌ 成立しない (${d.summary.notHolding}): ${d.notHolding.map((x) => `${shorten(x.from)}→${shorten(x.to)}`).join("; ")}</div>` +
      `<div class="mech" style="border-color:#e89400">表記揺れ (${d.summary.notationVariants}): ${d.notationVariants.map((v) => v.members.map((m) => m.label).join("≈")).join(" / ")}</div>` +
      `<div class="mech" style="border-color:#83c">⚡ 概念のとび (${d.summary.conceptJumps}): ${d.conceptJumps.map((x) => `${shorten(x.from)}→${shorten(x.to)}(${x.similarity})`).join("; ")}</div>`;
    this.o.onStatus("完了", false);
  }
  async runConsult() {
    if (!this.lastGraph) return this.log("⚠ 先に Run してください。");
    const causes = this.lastGraph.edges.filter((e) => e.kind === "causes").length;
    if (!causes) return this.log("⚠ causes エッジがありません（先に Run）。");
    this.o.onStatus("so-what / MECE を生成中…", true);
    const gemma = new WebGpuGemmaAdjudicator({ model: GEMMA_MODEL, device: this.device, maxNewTokens: 160 });
    const embedder = new TransformersEmbedder(EMBED_MODEL, this.device, "q8");
    const sw = await consult(this.lastGraph, gemma, { maxChains: 6 });
    const mc = await mece(this.lastGraph, embedder, { gemma });
    this.lastConsult = sw; this.lastMece = mc;
    this.showConsultPanel(sw, mc);
    this.log(`[so-what] ${sw.chains.length} 件 / MECE ${mc.effects.length} 件`);
    this.o.onStatus("完了", false);
  }

  async downloadOcz() {
    if (!this.droppedFile) return this.log("⚠ .ocz 書き出しは OOXML ファイル時のみ。");
    if (!this.lastGraph) return this.log("⚠ 先に Run してください。");
    const analysis: any = {};
    if (this.lastDiag) analysis.diagnosis = this.lastDiag;
    if (this.lastConsult) analysis.consult = this.lastConsult;
    if (this.lastMece) analysis.mece = this.lastMece;
    if (Object.keys(analysis).length) { analysis.version = 1; analysis.generatedAt = new Date().toISOString(); analysis.models = { embed: EMBED_MODEL, gemma: GEMMA_MODEL }; }
    const out = embedDataPart(this.droppedFile.bytes, this.lastGraph, { format: "jsonl", ...(Object.keys(analysis).length ? { analysis } : {}) });
    const name = this.droppedFile.name.replace(/(\.[^.]+)$/, ".ocz$1");
    const ext = name.split(".").pop()!;
    const blob = new Blob([out as BlobPart], { type: "application/octet-stream" });
    const w = window as any;
    if (w.showSaveFilePicker) {
      try {
        const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: "Office (OOXML)", accept: { "application/octet-stream": ["." + ext] } }] });
        const ws = await handle.createWritable(); await ws.write(blob); await ws.close();
        this.log(`💾 保存: ${name}`); return;
      } catch (e: any) { if (e?.name === "AbortError") return this.log("保存をキャンセル。"); }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
    this.log(`💾 ${name} をダウンロード。`);
  }

  // ---------- 因果ロール一覧 ----------
  renderRoles(container: HTMLElement) {
    if (!this.lastGraph) { container.innerHTML = '<span class="muted">先に Run してください。</span>'; return; }
    const nodes = [...this.lastGraph.nodes.values()].filter((n) => n.meta.text || n.meta.kind === "entity").slice(0, 2000);
    const j = (a: string[]) => a.join("; ");
    const cell = (s: string) => (s ? escH(s).replace(/; /g, "<br>") : "—");
    let rows = nodes.map((n) => { const r = nodeRoles(this.lastGraph!, n.id, this.lastDiag ?? undefined);
      return { id: n.id, label: r.label || r.text || r.kind, asCause: j(r.asCause), asEffect: j(r.asEffect), dependsOn: j(r.dependsOn), usedBy: j(r.usedBy), flags: j(r.flags),
        search: `${n.id} ${r.label} ${r.text ?? ""} ${j(r.asCause)} ${j(r.asEffect)}`.toLowerCase() }; });
    const paint = (q: string) => {
      const filtered = q ? rows.filter((r) => r.search.includes(q)) : rows;
      const body = container.querySelector("#roleBody")!;
      body.innerHTML = filtered.map((r) =>
        `<tr data-node="${escH(r.id)}" class="cursor-pointer border-t border-black/5 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/5">` +
        `<td class="p-1.5"><b>${escH(shorten(r.label, 24))}</b><br><span class="id">${escH(r.id)}</span></td>` +
        `<td class="p-1.5 text-rose-700">${cell(r.asCause)}</td><td class="p-1.5 text-blue-700">${cell(r.asEffect)}</td>` +
        `<td class="p-1.5 text-green-700">${cell(r.dependsOn)}</td><td class="p-1.5 text-zinc-500">${cell(r.usedBy)}</td>` +
        `<td class="p-1.5">${r.flags ? r.flags.split("; ").map((f) => `<span class="tag">${escH(f)}</span>`).join("") : ""}</td></tr>`).join("");
      (container.querySelector("#roleCount") as HTMLElement).textContent = `${filtered.length} 件`;
    };
    const head = ["data-id / ラベル", "原因→結果", "←結果の原因", "依存元", "利用先", "診断"];
    container.innerHTML =
      `<div class="mb-2 flex items-center gap-2"><input id="roleSearch" placeholder="🔍 検索" class="w-1/2 rounded-lg border border-black/10 dark:border-white/15 bg-transparent px-2 py-1 text-sm"> <span class="muted" id="roleCount"></span></div>` +
      `<table class="w-full border-collapse text-[12px]"><thead><tr class="text-left">${head.map((c) => `<th class="bg-black/[0.04] dark:bg-white/[0.06] p-1.5">${c}</th>`).join("")}</tr></thead><tbody id="roleBody"></tbody></table>`;
    (container.querySelector("#roleSearch") as HTMLInputElement).addEventListener("input", (e) => paint((e.target as HTMLInputElement).value.toLowerCase()));
    container.onclick = (e) => { const t = (e.target as HTMLElement).closest("[data-node]"); if (t) this.focusNode(t.getAttribute("data-node")! as DataId); };
    paint("");
  }
}
