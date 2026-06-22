/**
 * 因果グラフを「スクリーンショット風」の注釈付き SVG として描画する。
 *  - pptx: シェイプの bbox(EMU) を実配置（スライド版面の再現）
 *  - xlsx: Sheet!A1 をグリッド配置
 *  - docx/その他: causes による簡易 DAG レイアウト（トポロジカル層化 + 層内バリセンタ整列）
 * 診断 (diagnose) のカテゴリで色分け:
 *  isolated=灰 / 表記揺れ=橙 / それ以外=青、causes=緑実線・成立しない=赤破線・概念のとび=紫破線。
 */
import type { CausalGraph, DataId } from "../types.js";
import type { Diagnosis } from "../analyze/diagnose.js";
import type { ConsultResult } from "../analyze/consult.js";

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
  const schematic: DataId[] = [];
  for (const id of ids) {
    const m = g.nodes.get(id)!.meta;
    if (m.bbox && m.bbox.unit === "emu") {
      pos.set(id, { x: m.bbox.x * EMU_PX, y: m.bbox.y * EMU_PX, w: m.bbox.w * EMU_PX, h: m.bbox.h * EMU_PX });
    } else if (m.source?.app === "xls" && /!([A-Z]+)(\d+)/.test(m.label ?? "")) {
      const mm = (m.label ?? "").match(/!([A-Z]+)(\d+)/)!;
      pos.set(id, { x: 30 + colLetterToIndex(mm[1]!) * 130, y: 30 + (Number(mm[2]) - 1) * 46, w: 120, h: 38 });
    } else {
      schematic.push(id); // docx/段落/entity: まとめて DAG レイアウト
    }
  }
  if (schematic.length) layoutDag(g, schematic, pos);
  return pos;
}

/**
 * causes エッジから簡易 DAG レイアウトを組む（縦に因果が流れる層化図）。
 *  1) 各ノードの「層」= 始点からの最長距離（トポロジカル層化, 閉路は後退辺を無視）。
 *  2) 層内はバリセンタ（先行ノードの平均 x）で並べ替えて交差を減らす。
 *  3) 各層を水平に中央寄せで横展開。孤立ノードは最下段に別バンドで配置。
 */
function layoutDag(g: CausalGraph, ids: DataId[], pos: Map<DataId, Box>): void {
  const boxW = 190, boxH = 46, gapX = 26, rowPitch = 92, mTop = 30, mLeft = 40;
  const idset = new Set(ids);
  const incoming = new Map<DataId, DataId[]>();
  const outgoing = new Map<DataId, DataId[]>();
  for (const id of ids) { incoming.set(id, []); outgoing.set(id, []); }
  for (const e of g.edges) {
    if (e.kind !== "causes" || e.from === e.to) continue;
    if (!idset.has(e.from) || !idset.has(e.to)) continue;
    outgoing.get(e.from)!.push(e.to);
    incoming.get(e.to)!.push(e.from);
  }

  // 1) 最長距離による層付け（閉路は onstack 後退辺を無視して停止）
  const layer = new Map<DataId, number>();
  const state = new Map<DataId, 0 | 1 | 2>();
  const depth = (id: DataId): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    state.set(id, 1);
    let d = 0;
    for (const p of incoming.get(id)!) {
      if (state.get(p) === 1) continue; // 後退辺（閉路）は無視
      d = Math.max(d, depth(p) + 1);
    }
    state.set(id, 2);
    layer.set(id, d);
    return d;
  };
  const connected = ids.filter((id) => incoming.get(id)!.length || outgoing.get(id)!.length);
  const isolated = ids.filter((id) => !incoming.get(id)!.length && !outgoing.get(id)!.length);
  for (const id of connected) depth(id);

  // 層ごとに集約
  const byLayer = new Map<number, DataId[]>();
  let maxLayer = 0;
  for (const id of connected) {
    const L = layer.get(id)!;
    maxLayer = Math.max(maxLayer, L);
    (byLayer.get(L) ?? byLayer.set(L, []).get(L)!).push(id);
  }
  if (isolated.length) byLayer.set(maxLayer + 1, isolated); // 孤立は最下段バンド

  // 中央寄せ用に最大行幅を先に算出
  let maxRowW = 0;
  for (const [, row] of byLayer) maxRowW = Math.max(maxRowW, row.length * boxW + (row.length - 1) * gapX);

  // 2)(3) 層を上から順に: バリセンタ整列 → 横展開（先行層は配置済みなので参照可）
  const cx = (id: DataId) => { const b = pos.get(id); return b ? b.x + b.w / 2 : 0; };
  for (let L = 0; L <= maxLayer + (isolated.length ? 1 : 0); L++) {
    const row = byLayer.get(L);
    if (!row) continue;
    if (L > 0) {
      row.sort((a, b) => {
        const pa = incoming.get(a) ?? [], pb = incoming.get(b) ?? [];
        const ba = pa.length ? pa.reduce((s, p) => s + cx(p), 0) / pa.length : Infinity;
        const bb = pb.length ? pb.reduce((s, p) => s + cx(p), 0) / pb.length : Infinity;
        return ba - bb;
      });
    }
    const rowW = row.length * boxW + (row.length - 1) * gapX;
    const startX = mLeft + (maxRowW - rowW) / 2;
    row.forEach((id, i) => pos.set(id, { x: startX + i * (boxW + gapX), y: mTop + L * rowPitch, w: boxW, h: boxH }));
  }
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

  // causes エッジ。下向き（因果が下層へ流れる）なら箱の下端→上端で接続し、
  // 層を跨ぐ長いエッジは中間の箱を避けて横にふくらませる（簡易迂回ルーティング）。
  const W2 = W / 2;
  for (const e of g.edges) {
    if (e.kind !== "causes") continue;
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const ca = ctr(a), cb = ctr(b);
    const jump = jumpEdges.has(e.id), bad = notHoldingEdges.has(e.id);
    const color = jump ? "#83c" : bad ? "#d22" : "#2a8a2a";
    const marker = jump ? "aP" : bad ? "aR" : "aG";
    const dash = jump || bad ? ' stroke-dasharray="6 4"' : "";

    const down = cb.y - ca.y > a.h * 0.5;
    const sx = down ? ca.x : ca.x, sy = down ? a.y + a.h : ca.y; // 始点（下向きは下端中央）
    const tx = cb.x, ty = down ? b.y : cb.y;                      // 終点（下向きは上端中央）
    let labelX: number, labelY: number;
    if (down && ty - sy > 80) {
      // 層跨ぎ: 箱列の外側（広い方）へふくらむ 3 次ベジエで迂回
      const side = (sx + tx) / 2 <= W2 ? -1 : 1;
      const off = side * (44 + 14 * ((ty - sy) / 92));
      const cx1 = sx + off, cy1 = sy + (ty - sy) * 0.33;
      const cx2 = tx + off, cy2 = sy + (ty - sy) * 0.67;
      out.push(`<path d="M${sx.toFixed(1)},${sy.toFixed(1)} C${cx1.toFixed(1)},${cy1.toFixed(1)} ${cx2.toFixed(1)},${cy2.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}" fill="none" stroke="${color}" stroke-width="2"${dash} marker-end="url(#${marker})"/>`);
      labelX = (sx + tx) / 2 + off * 0.75;
      labelY = (sy + ty) / 2;
    } else {
      out.push(`<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${color}" stroke-width="2"${dash} marker-end="url(#${marker})"/>`);
      labelX = (sx + tx) / 2 + 6;
      labelY = (sy + ty) / 2;
    }
    out.push(`<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" font-size="12" fill="${color}" font-weight="bold">${esc(e.causal?.polarity ?? "")}${jump ? " ⚡" : ""}</text>`);
  }

  // ノード
  for (const id of ids) {
    const b = pos.get(id)!;
    const m = g.nodes.get(id)!.meta;
    const iso = isolated.has(id), variant = variantMembers.has(id);
    const fill = iso ? "#eee" : variant ? "#fff3e0" : "#e8f0ff";
    const stroke = iso ? "#999" : variant ? "#e89400" : "#3a6";
    out.push(`<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="${variant ? 2 : 1}"/>`);
    // 箱幅に合わせて切り詰め（約 11px/全角）。複数列レイアウトでもはみ出さない。
    const label = short(m.text ?? m.label ?? m.kind, Math.max(6, Math.floor((b.w - 12) / 11)));
    out.push(`<text x="${(b.x + 6).toFixed(1)}" y="${(b.y + b.h / 2 + 4).toFixed(1)}" font-size="11" fill="#222">${esc(label)}</text>`);
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

/** so-what(コンサル示唆) を因果連鎖ごとに並べた注記 SVG パネル。 */
export function renderConsultSvg(c: ConsultResult): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]!));
  const wrap = (s: string, n = 90) => (s.length > n ? s.slice(0, n) + "…" : s);
  const rowH = 64;
  const W = 900, H = Math.max(120, 40 + c.chains.length * rowH);
  const out: string[] = [`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif" style="background:#fff">`];
  out.push(`<text x="14" y="24" font-size="16" font-weight="bold">so-what (因果連鎖→示唆→打ち手)</text>`);
  c.chains.forEach((ch, i) => {
    const y = 44 + i * rowH;
    out.push(`<text x="14" y="${y}" font-size="12" fill="#345">${esc(wrap(ch.path.join(" → ")))}</text>`);
    out.push(`<text x="22" y="${y + 18}" font-size="12" fill="#b35">💡 ${esc(wrap(ch.soWhat))}</text>`);
    if (ch.action) out.push(`<text x="22" y="${y + 34}" font-size="12" fill="#286">▶ ${esc(wrap(ch.action))}</text>`);
  });
  out.push(`</svg>`);
  return out.join("\n");
}

/**
 * (文字単位) drawingml-svg の描画 SVG 上の各文字に box + label を重ねる。
 * `<text>`/`<tspan x dy>` を解析し、文字送り幅を推定して 1 文字ずつ矩形を描く。
 * 各文字が属する office-causal シェイプ(data-id)を bbox 包含で対応づけ、ラベル表示。
 */
const isWide = (c: string) => {
  const code = c.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x3000 && code <= 0x30ff);
};
const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

export function overlayCharBoxes(baseSvg: string, g: CausalGraph, diag?: Diagnosis, maxChars = 3000): string {
  // シェイプ(bbox px) 一覧 → 点包含で data-id を引く
  const shapes: { id: DataId; x: number; y: number; w: number; h: number }[] = [];
  for (const n of g.nodes.values()) {
    const b = n.meta.bbox;
    if (b?.unit === "emu") shapes.push({ id: n.id, x: b.x * EMU_PX, y: b.y * EMU_PX, w: b.w * EMU_PX, h: b.h * EMU_PX });
  }
  const ownerOf = (x: number, y: number) => shapes.find((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
  const isolated = new Set(diag?.isolated.map((x) => x.id) ?? []);
  const variant = new Set((diag?.notationVariants ?? []).flatMap((v) => v.members.map((m) => m.id)));
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

  const o: string[] = [`<g id="ocz-char-boxes" fill="none" font-family="monospace">`];
  let drawn = 0;
  const seenOwner = new Set<string>();
  for (const tm of baseSvg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    if (drawn >= maxChars) break;
    const tAttrs = tm[1]!;
    const fs = Number(attr(tAttrs, "font-size") ?? "16");
    const ls = Number(attr(tAttrs, "letter-spacing") ?? "0");
    const anchor = attr(tAttrs, "text-anchor") ?? "start";
    const textY = Number(attr(tAttrs, "y") ?? "0");
    let baseline = textY;
    for (const sm of tm[2]!.matchAll(/<tspan\b([^>]*)>([^<]*)<\/tspan>/g)) {
      const sAttrs = sm[1]!;
      const content = sm[2]!;
      const tx = Number(attr(sAttrs, "x") ?? attr(tAttrs, "x") ?? "0");
      baseline += Number(attr(sAttrs, "dy") ?? "0");
      const chars = [...content];
      const adv = chars.map((c) => fs * (isWide(c) ? 1.0 : 0.55) + ls);
      const lineW = adv.reduce((a, b) => a + b, 0);
      let cx = anchor === "middle" ? tx - lineW / 2 : anchor === "end" ? tx - lineW : tx;
      const owner = ownerOf(tx, baseline);
      const stroke = owner && isolated.has(owner.id) ? "#999" : owner && variant.has(owner.id) ? "#e89400" : "#39f";
      // run 先頭に data-id ラベル (1 シェイプ 1 回)
      if (owner && !seenOwner.has(owner.id)) {
        seenOwner.add(owner.id);
        o.push(`<text x="${tx.toFixed(1)}" y="${(baseline - fs - 2).toFixed(1)}" font-size="8" fill="${stroke}" stroke="none" text-anchor="${anchor}">${esc(owner.id)}</text>`);
      }
      // (1) 1文字=1tspan (TS drawingml-svg の glyph 出力) なら tx が厳密。複数文字 tspan のみ送り幅で近似。
      chars.forEach((c, i) => {
        if (drawn >= maxChars) return;
        const w = adv[i]!;
        const oid = owner ? ` data-ocz-id="${esc(owner.id)}" data-char="${esc(c)}"` : "";
        o.push(`<rect x="${cx.toFixed(1)}" y="${(baseline - fs * 0.82).toFixed(1)}" width="${w.toFixed(1)}" height="${fs.toFixed(1)}" stroke="${stroke}" stroke-width="0.5" opacity="0.8"${oid}/>`);
        cx += w;
        drawn++;
      });
    }
  }
  o.push(`</g>`);
  if (drawn === 0) return baseSvg;
  return baseSvg.replace(/<\/svg>\s*$/i, o.join("\n") + "\n</svg>");
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
    o.push(`<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" stroke="${stroke}" stroke-width="2" ${v ? 'stroke-dasharray="3 3" ' : ""}rx="3" data-ocz-id="${id}"/>`);
  }
  o.push(`</g>`);
  return baseSvg.replace(/<\/svg>\s*$/i, o.join("\n") + "\n</svg>");
}
