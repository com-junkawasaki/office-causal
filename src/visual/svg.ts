/**
 * 因果グラフを「スクリーンショット風」の注釈付き SVG として描画する。
 *  - pptx: シェイプの bbox(EMU) を実配置（スライド版面の再現）
 *  - xlsx: Sheet!A1 をグリッド配置
 *  - docx/その他: 段落を縦並び
 * 診断 (diagnose) のカテゴリで色分け:
 *  isolated=灰 / 表記揺れ=橙 / それ以外=青、causes=緑実線・成立しない=赤破線・概念のとび=紫破線。
 */
import type { CausalGraph, DataId } from "../types.js";
import type { Diagnosis } from "../analyze/diagnose.js";

const EMU_PX = 96 / 914400; // EMU → px
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n) + "…" : s);

interface Box { x: number; y: number; w: number; h: number }

function colLetterToIndex(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 描画対象ノードの座標を決める。 */
function layout(g: CausalGraph, ids: DataId[]): Map<DataId, Box> {
  const pos = new Map<DataId, Box>();
  let schematicRow = 0;
  for (const id of ids) {
    const m = g.nodes.get(id)!.meta;
    if (m.bbox && m.bbox.unit === "emu") {
      pos.set(id, { x: m.bbox.x * EMU_PX, y: m.bbox.y * EMU_PX, w: m.bbox.w * EMU_PX, h: m.bbox.h * EMU_PX });
    } else if (m.source?.app === "xls" && /!([A-Z]+)(\d+)/.test(m.label ?? "")) {
      const mm = (m.label ?? "").match(/!([A-Z]+)(\d+)/)!;
      pos.set(id, { x: 30 + colLetterToIndex(mm[1]!) * 130, y: 30 + (Number(mm[2]) - 1) * 46, w: 120, h: 38 });
    } else {
      pos.set(id, { x: 40, y: 30 + schematicRow * 52, w: 420, h: 42 });
      schematicRow++;
    }
  }
  return pos;
}

export function renderDiagnosisSvg(g: CausalGraph, diag: Diagnosis): string {
  // 描画対象: テキスト/entity/bbox ノード + causes 端点 (上限 120)。
  // bbox 付き (pptx シェイプ) はテキスト無しでも版面再現のため含める。
  const wanted = new Set<DataId>();
  for (const n of g.nodes.values()) if ((n.meta.text || n.meta.kind === "entity" || n.meta.bbox) && wanted.size < 120) wanted.add(n.id);
  for (const e of g.edges) if (e.kind === "causes") { wanted.add(e.from); wanted.add(e.to); }
  const ids = [...wanted];
  const pos = layout(g, ids);

  const isolated = new Set(diag.isolated.map((x) => x.id));
  const variantMembers = new Set(diag.notationVariants.flatMap((v) => v.members.map((m) => m.id)));
  const notHoldingEdges = new Set(diag.notHolding.map((x) => x.edge));
  const jumpEdges = new Set(diag.conceptJumps.map((x) => x.edge));

  // viewport
  let maxX = 0, maxY = 0;
  for (const b of pos.values()) { maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); }
  const W = Math.max(640, maxX + 40), H = Math.max(360, maxY + 60);
  const ctr = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

  const out: string[] = [];
  out.push(`<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif" style="background:#fff">`);
  out.push(`<defs>
    <marker id="aG" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0L8,3L0,6Z" fill="#2a8a2a"/></marker>
    <marker id="aR" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0L8,3L0,6Z" fill="#d22"/></marker>
    <marker id="aP" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0L8,3L0,6Z" fill="#83c"/></marker>
  </defs>`);

  // 表記揺れリンク (橙の点線, メンバー間)
  for (const v of diag.notationVariants) {
    const m = v.members.filter((x) => pos.has(x.id as DataId));
    for (let i = 1; i < m.length; i++) {
      const a = ctr(pos.get(m[0]!.id as DataId)!), b = ctr(pos.get(m[i]!.id as DataId)!);
      out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#e89400" stroke-width="2" stroke-dasharray="2 4"/>`);
    }
  }

  // causes エッジ
  for (const e of g.edges) {
    if (e.kind !== "causes") continue;
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const ca = ctr(a), cb = ctr(b);
    const jump = jumpEdges.has(e.id), bad = notHoldingEdges.has(e.id);
    const color = jump ? "#83c" : bad ? "#d22" : "#2a8a2a";
    const marker = jump ? "aP" : bad ? "aR" : "aG";
    const dash = jump || bad ? ' stroke-dasharray="6 4"' : "";
    out.push(`<line x1="${ca.x.toFixed(1)}" y1="${ca.y.toFixed(1)}" x2="${cb.x.toFixed(1)}" y2="${cb.y.toFixed(1)}" stroke="${color}" stroke-width="2"${dash} marker-end="url(#${marker})"/>`);
    const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
    out.push(`<text x="${mid.x.toFixed(1)}" y="${mid.y.toFixed(1)}" font-size="12" fill="${color}" font-weight="bold">${esc(e.causal?.polarity ?? "")}${jump ? " ⚡" : ""}</text>`);
  }

  // ノード
  for (const id of ids) {
    const b = pos.get(id)!;
    const m = g.nodes.get(id)!.meta;
    const iso = isolated.has(id), variant = variantMembers.has(id);
    const fill = iso ? "#eee" : variant ? "#fff3e0" : "#e8f0ff";
    const stroke = iso ? "#999" : variant ? "#e89400" : "#3a6";
    out.push(`<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="${variant ? 2 : 1}"/>`);
    const label = short(m.text ?? m.label ?? m.kind);
    out.push(`<text x="${(b.x + 5).toFixed(1)}" y="${(b.y + 16).toFixed(1)}" font-size="11" fill="#222">${esc(label)}</text>`);
  }

  // 凡例
  const ly = H - 8;
  out.push(`<g font-size="11">
    <text x="10" y="${ly}" fill="#2a8a2a">━ 因果(成立)</text>
    <text x="95" y="${ly}" fill="#d22">╌ 成立しない</text>
    <text x="185" y="${ly}" fill="#83c">╌⚡ 概念のとび</text>
    <text x="285" y="${ly}" fill="#e89400">╌ 表記揺れ</text>
    <text x="365" y="${ly}" fill="#999">▢ 独立</text>
  </g>`);
  out.push(`</svg>`);
  return out.join("\n");
}

/**
 * drawingml-svg が描いたスライド SVG (背景) に、因果オーバレイを同座標で重ねる。
 * 背景 px = EMU/9525、本オーバレイ bbox px = EMU*EMU_PX = EMU/9525 で一致。
 * bbox を持つノード (= 当該スライドのシェイプ) のみ対象。
 */
export function overlayCausal(baseSvg: string, g: CausalGraph, diag: Diagnosis): string {
  const pos = new Map<DataId, Box>();
  for (const n of g.nodes.values()) {
    const b = n.meta.bbox;
    if (b && b.unit === "emu") pos.set(n.id, { x: b.x * EMU_PX, y: b.y * EMU_PX, w: b.w * EMU_PX, h: b.h * EMU_PX });
  }
  if (pos.size === 0) return baseSvg; // 重ねる対象なし

  const isolated = new Set(diag.isolated.map((x) => x.id));
  const variant = new Set(diag.notationVariants.flatMap((v) => v.members.map((m) => m.id)));
  const notHold = new Set(diag.notHolding.map((x) => x.edge));
  const jump = new Set(diag.conceptJumps.map((x) => x.edge));
  const ctr = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

  const o: string[] = [`<g id="ocz-causal-overlay" fill="none">`];
  o.push(`<defs><marker id="ocaP" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0L8,3L0,6Z" fill="#83c"/></marker>
    <marker id="ocaR" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0L8,3L0,6Z" fill="#d22"/></marker>
    <marker id="ocaG" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0L8,3L0,6Z" fill="#2a8a2a"/></marker></defs>`);
  for (const e of g.edges) {
    if (e.kind !== "causes") continue;
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const ca = ctr(a), cb = ctr(b);
    const j = jump.has(e.id), bad = notHold.has(e.id);
    const c = j ? "#83c" : bad ? "#d22" : "#2a8a2a";
    const mk = j ? "ocaP" : bad ? "ocaR" : "ocaG";
    o.push(`<line x1="${ca.x.toFixed(1)}" y1="${ca.y.toFixed(1)}" x2="${cb.x.toFixed(1)}" y2="${cb.y.toFixed(1)}" stroke="${c}" stroke-width="2"${j || bad ? ' stroke-dasharray="6 4"' : ""} marker-end="url(#${mk})"/>`);
  }
  for (const [id, b] of pos) {
    const iso = isolated.has(id), v = variant.has(id);
    const stroke = iso ? "#999" : v ? "#e89400" : "#3a6";
    o.push(`<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" stroke="${stroke}" stroke-width="2" ${v ? 'stroke-dasharray="3 3" ' : ""}rx="3"/>`);
  }
  o.push(`</g>`);
  return baseSvg.replace(/<\/svg>\s*$/i, o.join("\n") + "\n</svg>");
}
