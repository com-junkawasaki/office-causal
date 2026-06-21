/**
 * 対話的 svg-causal-graph ビューア (HTML)。
 * svg-causal-graph (drawingml-svg 描画 + 因果/文字 overlay, 各要素に data-ocz-id) を
 * HTML に埋め込み、クリックで「文字 → data-id → 因果ロール (原因/結果/依存元/利用先) + 診断」を
 * サイドパネルに表示する。
 */
import type { CausalGraph, DataId } from "../types.js";
import type { Diagnosis } from "../analyze/diagnose.js";
import type { ConsultResult } from "../analyze/consult.js";
import type { MeceResult } from "../analyze/mece.js";

export interface NodeInfo {
  label: string;
  text?: string;
  kind: string;
  tags?: string[];
  asCause: string[]; // この要素が原因 → これらの結果 (causes out)
  asEffect: string[]; // この要素は結果 ← これらの原因 (causes in)
  dependsOn: string[]; // 依存元 (derives-from out, 例: 数式参照先)
  usedBy: string[]; // 利用先 (derives-from in)
  flags: string[]; // 診断: isolated / 表記揺れ / 概念のとび端点 / 成立しない端点
}

/** (3) 単一ノードの data-id と因果ロールを集計 (任意ノードに使える)。 */
export function nodeRoles(g: CausalGraph, id: string, diag?: Diagnosis): NodeInfo {
  const lbl = (x: string) => g.nodes.get(x as DataId)?.meta.label ?? g.nodes.get(x as DataId)?.meta.text ?? x;
  const m = g.nodes.get(id as DataId)?.meta;
  const asCause: string[] = [], asEffect: string[] = [], dependsOn: string[] = [], usedBy: string[] = [];
  for (const e of g.edges) {
    if (e.kind === "causes") {
      if (e.from === id) asCause.push(lbl(e.to));
      if (e.to === id) asEffect.push(lbl(e.from));
    } else if (e.kind === "derives-from") {
      if (e.from === id) dependsOn.push(lbl(e.to));
      if (e.to === id) usedBy.push(lbl(e.from));
    }
  }
  const flags: string[] = [];
  if (diag?.isolated.some((x) => x.id === id)) flags.push("独立(因果なし)");
  if ((diag?.notationVariants ?? []).some((v) => v.members.some((mm) => mm.id === id))) flags.push("表記揺れ");
  return {
    label: m?.label ?? "", kind: m?.kind ?? "",
    ...(m?.text ? { text: m.text } : {}),
    ...(m?.tags?.length ? { tags: m.tags } : {}),
    asCause, asEffect, dependsOn, usedBy, flags,
  };
}

/** (3) 各ノードの data-id と因果ロールを集計 (描画対象=bbox ノード)。 */
export function buildNodeInfo(g: CausalGraph, diag?: Diagnosis): Record<string, NodeInfo> {
  const info: Record<string, NodeInfo> = {};
  for (const n of g.nodes.values()) if (n.meta.bbox) info[n.id] = nodeRoles(g, n.id, diag);
  return info;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** (c) コンサル分析 (so-what / MECE) を HTML 断片に。 */
function consultBlock(extra?: { soWhat?: ConsultResult; mece?: MeceResult }): string {
  if (!extra?.soWhat && !extra?.mece) return "";
  let h = `<div style="margin-bottom:10px;padding:8px;background:#fffaf0;border:1px solid #fde">`;
  if (extra.soWhat?.chains.length) {
    h += `<h3>💡 so-what</h3>`;
    for (const c of extra.soWhat.chains)
      h += `<div class="role"><b>${esc(c.path.join(" → "))}</b><br>💡 ${esc(c.soWhat)}${c.action ? "<br>▶ " + esc(c.action) : ""}</div>`;
  }
  if (extra.mece?.effects.length) {
    h += `<h3>MECE</h3>`;
    for (const e of extra.mece.effects)
      h += `<div class="role"><b>${esc(e.effect)}</b> ← ${e.factors.map(esc).join(" / ")}` +
        (e.overlaps.length ? `<br>⚠ 重複: ${e.overlaps.map((p) => p.join("≈")).join(", ")}` : "") +
        (e.exhaustive === false ? `<br>⚠ 網羅不足${e.missing?.length ? ": 欠落 " + e.missing.map(esc).join("、") : ""}` : "") + `</div>`;
  }
  return h + `</div>`;
}

/** (2)(c) svg-causal-graph を対話 HTML に包む。クリックで data-id/役割、so-what/MECE も表示。 */
export function renderInteractiveHtml(
  svgContent: string,
  g: CausalGraph,
  diag?: Diagnosis,
  extra?: { soWhat?: ConsultResult; mece?: MeceResult },
): string {
  const info = buildNodeInfo(g, diag);
  const consultHtml = consultBlock(extra);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>office-causal — svg-causal-graph viewer</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0}
 #ocz-wrap{display:flex;gap:8px;height:100vh}
 #ocz-svg{flex:1;overflow:auto;border-right:1px solid #ddd}
 #ocz-svg svg{width:100%;height:auto}
 #ocz-svg [data-ocz-id]{cursor:pointer}
 #ocz-svg [data-ocz-id]:hover{stroke:#06f!important;stroke-width:2!important}
 #ocz-panel{width:320px;padding:12px;overflow:auto;font-size:13px}
 #ocz-panel h3{margin:.2rem 0}.id{color:#888;font-size:11px;word-break:break-all}
 .role{margin:.3rem 0;padding:.3rem .5rem;border-left:3px solid #39f;background:#f6f8ff;border-radius:4px}
 .flag{display:inline-block;background:#fde;color:#a13;border-radius:10px;padding:1px 8px;margin:2px 2px 0 0;font-size:11px}
 .char{color:#06f;font-weight:bold}
</style></head><body>
<div id="ocz-wrap">
 <div id="ocz-svg">${svgContent}</div>
 <div id="ocz-panel">${consultHtml}<p style="color:#999">文字 / シェイプ / ノードをクリックすると、data-id と因果ロールを表示します。</p></div>
</div>
<script>
const INFO = ${JSON.stringify(info)};
const panel = document.getElementById('ocz-panel');
document.getElementById('ocz-svg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-ocz-id]'); if(!t) return;
  const id = t.getAttribute('data-ocz-id'); const ch = t.getAttribute('data-char');
  const d = INFO[id];
  if(!d){ panel.innerHTML = '<div class="id">'+id+'</div>'; return; }
  const list = (title,arr,arrow) => arr && arr.length ? '<div class="role"><b>'+title+'</b><br>'+arr.map(x=>arrow+' '+x).join('<br>')+'</div>' : '';
  panel.innerHTML =
    (ch ? '<p>文字 <span class="char">'+ch+'</span> →</p>' : '') +
    '<h3>'+(d.label||d.kind)+'</h3>' +
    '<div class="id">'+id+'</div>' +
    (d.text ? '<p>'+d.text+'</p>' : '') +
    (d.tags && d.tags.length ? d.tags.map(x=>'<span class="flag">#'+x+'</span>').join('') : '') +
    (d.flags && d.flags.length ? '<div>'+d.flags.map(x=>'<span class="flag">'+x+'</span>').join('')+'</div>' : '') +
    list('原因として → 結果', d.asCause, '→') +
    list('結果として ← 原因', d.asEffect, '←') +
    list('依存元 (derives-from)', d.dependsOn, '↑') +
    list('利用先', d.usedBy, '↓');
});
</script></body></html>`;
}
