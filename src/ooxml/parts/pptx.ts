/**
 * pptx 抽出: slide → shape (contains)、シェイプ内テキスト、
 * グラフ/外部参照を r:id 経由で references に解決。
 */
import type { BuildCtx } from "../../graph/builder.js";
import type { OpcPart } from "../opc.js";
import { parseXml, walk, textOf } from "../parse.js";
import type { XmlEl } from "../parse.js";
import type { BBox } from "../../types.js";

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

/** 最初の子孫要素を tag で探す。 */
function findDesc(el: XmlEl, tag: string): XmlEl | undefined {
  for (const c of el.children) {
    if (c.tag === tag) return c;
    const f = findDesc(c, tag);
    if (f) return f;
  }
  return undefined;
}

/** シェイプの <a:xfrm><a:off x y/><a:ext cx cy/> を bbox(EMU) に。 */
function bboxOf(sp: XmlEl): BBox | undefined {
  const xfrm = findDesc(sp, "a:xfrm");
  if (!xfrm) return undefined;
  const off = xfrm.children.find((c) => c.tag === "a:off");
  const ext = xfrm.children.find((c) => c.tag === "a:ext");
  if (!off || !ext) return undefined;
  const n = (v?: string) => (v === undefined ? NaN : Number(v));
  const x = n(off.attrs["x"]), y = n(off.attrs["y"]), w = n(ext.attrs["cx"]), h = n(ext.attrs["cy"]);
  if ([x, y, w, h].some((v) => !Number.isFinite(v))) return undefined;
  return { x, y, w, h, unit: "emu" };
}

export function extractPptx(part: OpcPart, ctx: BuildCtx): void {
  const m = part.name.match(SLIDE_RE);
  if (!m) return;
  const slideNo = m[1];
  const root = parseXml(part.xml);

  const slideNode = ctx.node(part.name, "p:sld", `slide${slideNo}`, {
    kind: "slide",
    label: `Slide ${slideNo}`,
    source: { app: "ppt", ooxmlTag: "p:sld" },
  });

  for (const { el, path } of walk(root)) {
    // シェイプ (テキストボックス等)
    if (el.tag === "p:sp") {
      const text = textOf(el);
      const bbox = bboxOf(el);
      const shapeId = ctx.node(part.name, path, text || path, {
        kind: "shape",
        text,
        label: text.slice(0, 40),
        source: { app: "ppt", ooxmlTag: "p:sp" },
        ...(bbox ? { bbox } : {}),
      });
      ctx.edge("contains", slideNode, shapeId);
    }
    // グラフ/図など r:id を持つ参照 → rels で解決
    const rid = el.attrs["r:id"] || el.attrs["r:embed"];
    if (rid) {
      const rel = part.rels.find((r) => r.id === rid);
      if (rel) {
        const targetPart = normalizeTarget(part.name, rel.target);
        const isChart = /chart/i.test(rel.type);
        const refId = ctx.node(targetPart, "/", targetPart, {
          kind: isChart ? "chart" : "image",
          label: targetPart.split("/").pop() ?? targetPart,
          source: { app: "ppt", ooxmlTag: el.tag },
        });
        ctx.edge("references", slideNode, refId);
      }
    }
  }
}

/** "../charts/chart1.xml" → "ppt/charts/chart1.xml" を粗く解決。 */
function normalizeTarget(fromPart: string, target: string): string {
  const dir = fromPart.slice(0, fromPart.lastIndexOf("/"));
  const segs = `${dir}/${target}`.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (s === "..") out.pop();
    else if (s !== ".") out.push(s);
  }
  return out.join("/");
}
