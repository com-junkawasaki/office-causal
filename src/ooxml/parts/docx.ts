/**
 * docx 抽出: document → paragraph / table (contains)、
 * 段落テキストを正規化して meta.text に。図表参照は references に。
 */
import type { BuildCtx } from "../../graph/builder.js";
import type { OpcPart } from "../opc.js";
import { parseXml, walk, textOf } from "../parse.js";

export function extractDocx(part: OpcPart, ctx: BuildCtx): void {
  if (part.name !== "word/document.xml") return;
  const root = parseXml(part.xml);

  const docNode = ctx.node(part.name, "w:document", "document", {
    kind: "document",
    label: "document.xml",
    source: { app: "doc", ooxmlTag: "w:document" },
  });

  let pIndex = 0;
  for (const { el, path } of walk(root)) {
    if (el.tag === "w:p") {
      const text = textOf(el);
      if (!text) continue;
      pIndex++;
      const pid = ctx.node(part.name, path, text, {
        kind: "paragraph",
        text,
        label: `¶${pIndex}: ${text.slice(0, 40)}`,
        source: { app: "doc", ooxmlTag: "w:p" },
      });
      ctx.edge("contains", docNode, pid);
    } else if (el.tag === "w:tbl") {
      const tid = ctx.node(part.name, path, textOf(el).slice(0, 64) || path, {
        kind: "table",
        label: "table",
        source: { app: "doc", ooxmlTag: "w:tbl" },
      });
      ctx.edge("contains", docNode, tid);
    }
  }
}
