/**
 * 対話的 svg-causal-graph ビューア (HTML)。
 * svg-causal-graph (drawingml-svg 描画 + 因果/文字 overlay, 各要素に data-ocz-id) を
 * HTML に埋め込み、クリックで「文字 → data-id → 因果ロール (原因/結果/依存元/利用先) + 診断」を
 * サイドパネルに表示する。
 */
import type { CausalGraph, DataId } from "../types.js";
import type { Diagnosis } from "../analyze/diagnose.js";

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

/** (3) 各ノードの data-id と因果ロールを集計。 */
export function buildNodeInfo(g: CausalGraph, diag?: Diagnosis): Record<string, NodeInfo> {
  const lbl = (id: string) => g.nodes.get(id as DataId)?.meta.label ?? g.nodes.get(id as DataId)?.meta.text ?? id;
  const iso = new Set(diag?.isolated.map((x) => x.id) ?? []);
  const variant = new Set((diag?.notationVariants ?? []).flatMap((v) => v.members.map((m) => m.id)));
  const jumpEnds = new Set((diag?.conceptJumps ?? []).flatMap((x) => [x.edge]));
  const info: Record<string, NodeInfo> = {};
  // ロール対象: bbox を持つシェイプ (描画上クリックされる要素)。
  const targets = [...g.nodes.values()].filter((n) => n.meta.bbox);
  for (const n of targets) {
    const id = n.id;
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
    if (iso.has(id)) flags.push("独立(因果なし)");
    if (variant.has(id)) flags.push("表記揺れ");
    info[id] = {
      label: n.meta.label ?? "", kind: n.meta.kind,
      ...(n.meta.text ? { text: n.meta.text } : {}),
      ...(n.meta.tags?.length ? { tags: n.meta.tags } : {}),
      asCause, asEffect, dependsOn, usedBy, flags,
    };
  }
  void jumpEnds;
  return info;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** (2) svg-causal-graph を対話 HTML に包む。クリックで data-id/役割パネル。 */
export function renderInteractiveHtml(svgContent: string, g: CausalGraph, diag?: Diagnosis): string {
  const info = buildNodeInfo(g, diag);
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
 <div id="ocz-panel"><p style="color:#999">文字 / シェイプ / ノードをクリックすると、data-id と因果ロールを表示します。</p></div>
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
