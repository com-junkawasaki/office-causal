/**
 * tensor network を 4 バンド (document / page / object / causal) の層状ノードリンク図で描画する。
 *  - contains = 細いグレー線 (階層 bond)
 *  - references = 青、mentions = 薄紫、causes = 緑(+)/赤(-)/灰(?)
 *  - ドキュメントをまたぐ causes は太破線で強調 (間接因果)
 *  - ノードはドキュメントごとに色分け
 */
import type { TensorNetwork, TensorLayer, TensorNode } from "../tensor/network.js";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

const BAND_Y: Record<TensorLayer, number> = { document: 60, page: 190, object: 330, causal: 490 };
const BAND_LABEL: Record<TensorLayer, string> = { document: "Document", page: "Page (slide/sheet/section)", object: "Object (shape/cell/paragraph)", causal: "Causal (entity/claim)" };
const PALETTE = ["#2a6", "#36c", "#b63", "#a3a", "#0aa", "#c63", "#693", "#36a", "#a55"];

export function renderTensorNetworkSvg(tn: TensorNetwork): string {
  // ドキュメント順を確定し、色を割り当てる
  const docIds = tn.nodes.filter((n) => n.layer === "document").map((n) => n.id);
  const docColor = new Map<string, string>();
  docIds.forEach((d, i) => docColor.set(d, PALETTE[i % PALETTE.length]!));

  // 各ノードの所属ドキュメントを parent 連鎖で解決
  const byId = new Map(tn.nodes.map((n) => [n.id, n]));
  const docOf = (n: TensorNode): string | undefined => {
    let cur: TensorNode | undefined = n;
    const seen = new Set<string>();
    while (cur && cur.layer !== "document" && !seen.has(cur.id)) { seen.add(cur.id); cur = cur.parent ? byId.get(cur.parent) : undefined; }
    return cur?.layer === "document" ? cur.id : undefined;
  };

  // 層ごとに [docIndex, 元の順] で安定ソートして横配置
  const docIndex = new Map(docIds.map((d, i) => [d, i]));
  const layers: TensorLayer[] = ["document", "page", "object", "causal"];
  const pos = new Map<string, { x: number; y: number; w: number }>();
  let maxX = 0;
  const M = 60; // 左マージン
  for (const L of layers) {
    const row = tn.nodes.filter((n) => n.layer === L);
    row.sort((a, b) => (docIndex.get(docOf(a) ?? "") ?? 99) - (docIndex.get(docOf(b) ?? "") ?? 99));
    const slot = L === "document" ? 200 : L === "page" ? 70 : L === "object" ? 26 : 120;
    const w = L === "document" ? 180 : L === "page" ? 58 : L === "object" ? 20 : 108;
    row.forEach((n, i) => { const x = M + i * slot; pos.set(n.id, { x, y: BAND_Y[L], w }); maxX = Math.max(maxX, x + w); });
  }
  const W = Math.max(960, maxX + M), H = BAND_Y.causal + 120;

  const out: string[] = [];
  out.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif" style="background:#fff">`);
  out.push(`<defs>
    <marker id="tC" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0L7,3L0,6Z" fill="#2a8a2a"/></marker>
    <marker id="tR" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0L7,3L0,6Z" fill="#d22"/></marker>
  </defs>`);

  // バンドのラベル
  for (const L of layers) {
    out.push(`<text x="8" y="${BAND_Y[L] - 14}" font-size="12" fill="#888" font-weight="bold">${BAND_LABEL[L]}</text>`);
  }

  // bonds (ノードの下/上の中央同士を結ぶ)
  const cx = (id: string) => { const p = pos.get(id); return p ? p.x + p.w / 2 : 0; };
  const cy = (id: string) => { const p = pos.get(id); return p ? p.y : 0; };
  const hy = (id: string) => { const n = byId.get(id); const p = pos.get(id); if (!n || !p) return 0; return p.y + (n.layer === "object" ? 14 : n.layer === "document" ? 30 : 22); };
  for (const b of tn.bonds) {
    const fa = byId.get(b.from), fb = byId.get(b.to);
    if (!fa || !fb || !pos.has(b.from) || !pos.has(b.to)) continue;
    // 上位→下位なら from の下端、to の上端で接続
    const fromUpper = (BAND_Y[fa.layer] ?? 0) <= (BAND_Y[fb.layer] ?? 0);
    const x1 = cx(b.from), y1 = fromUpper ? hy(b.from) : cy(b.from);
    const x2 = cx(b.to), y2 = fromUpper ? cy(b.to) : hy(b.to);
    if (b.kind === "contains") {
      out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ccc" stroke-width="0.8"/>`);
    } else if (b.kind === "references") {
      out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#39f" stroke-width="1" stroke-dasharray="3 3"/>`);
    } else if (b.kind === "mentions") {
      out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#b9c" stroke-width="0.9"/>`);
    } else if (b.kind === "causes") {
      const pol = (b.weight ?? 0) < 0 ? "-" : "+";
      const color = pol === "-" ? "#d22" : "#2a8a2a";
      const marker = pol === "-" ? "tR" : "tC";
      const sw = b.crossDoc ? 2.4 : 1.4;
      const dash = b.crossDoc ? ' stroke-dasharray="7 4"' : "";
      // causal は同バンド内: 弧を描いて重なりを避ける
      const midX = (x1 + x2) / 2, bow = Math.min(70, 18 + Math.abs(x2 - x1) * 0.12);
      out.push(`<path d="M${x1},${cy(b.from)} Q${midX},${cy(b.from) + bow + 30} ${x2},${cy(b.to)}" fill="none" stroke="${color}" stroke-width="${sw}"${dash} marker-end="url(#${marker})"/>`);
    }
  }

  // ノード
  for (const n of tn.nodes) {
    const p = pos.get(n.id)!;
    const col = docColor.get(docOf(n) ?? n.id) ?? "#789";
    const h = n.layer === "object" ? 14 : n.layer === "document" ? 30 : 22;
    const fill = n.layer === "causal" ? "#fff7f0" : n.layer === "document" ? col : "#f4f7ff";
    const txtFill = n.layer === "document" ? "#fff" : "#223";
    out.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${h}" rx="3" fill="${fill}" stroke="${col}" stroke-width="${n.layer === "document" ? 0 : 1}"/>`);
    if (n.layer !== "object") {
      const chars = Math.max(3, Math.floor((p.w - 6) / 6.5));
      out.push(`<text x="${p.x + 4}" y="${p.y + h / 2 + 4}" font-size="${n.layer === "document" ? 11 : 9}" fill="${txtFill}">${esc(short(n.label, chars))}</text>`);
    }
  }

  // 統計 + 凡例
  const s = tn.stats;
  const ly = H - 56;
  out.push(`<g font-size="11" fill="#444"><text x="10" y="${ly}">nodes ${s.nodeCount} (doc ${s.perLayer.document} / page ${s.perLayer.page} / object ${s.perLayer.object} / causal ${s.perLayer.causal}) · bonds ${s.bondCount} · maxRank ${s.maxRank} · χ-params ${s.totalParams} · causalComponents ${s.causalComponents} · cross-doc causes ${s.crossDocCauses}</text></g>`);
  const gy = H - 30;
  out.push(`<g font-size="11">
    <text x="10" y="${gy}" fill="#ccc">━ contains</text>
    <text x="90" y="${gy}" fill="#39f">╌ references</text>
    <text x="185" y="${gy}" fill="#b9c">━ mentions</text>
    <text x="270" y="${gy}" fill="#2a8a2a">━ causes(+)</text>
    <text x="365" y="${gy}" fill="#d22">━ causes(-)</text>
    <text x="455" y="${gy}" fill="#555">╍ cross-doc causes(太破線)</text>
  </g>`);
  out.push(`</svg>`);
  return out.join("\n");
}
