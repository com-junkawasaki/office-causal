/**
 * xlsx 抽出: sheet → cell (contains)、数式 `<f>` の参照を derives-from に。
 * 例: B2 = "=A2*1.1" → edge derives-from(B2 → A2)。これが「最も決定論的な因果の素」。
 */
import type { BuildCtx } from "../../graph/builder.js";
import type { OpcPart, OpcPackage } from "../opc.js";
import type { DataId } from "../../types.js";
import { parseXml, walk, textOf } from "../parse.js";

const SHEET_RE = /^xl\/worksheets\/sheet(\d+)\.xml$/;

/** (h) xl/sharedStrings.xml を index→文字列の配列に解決 (pkg ごとに memo)。 */
const sstCache = new WeakMap<OpcPackage, string[]>();
function sharedStrings(pkg: OpcPackage): string[] {
  const cached = sstCache.get(pkg);
  if (cached) return cached;
  const part = pkg.parts.get("xl/sharedStrings.xml");
  const out: string[] = [];
  if (part) {
    const root = parseXml(part.xml);
    // <sst><si>...<t>文字列</t>...</si> ...</sst> 順に textOf。
    for (const si of root.children) if (si.tag === "si") out.push(textOf(si));
  }
  sstCache.set(pkg, out);
  return out;
}

/** セル参照 (A1, $B$2, Sheet1!C3) を数式から粗く抽出。 */
function refsInFormula(f: string): string[] {
  const re = /(?:[A-Za-z0-9_]+!)?\$?[A-Z]{1,3}\$?\d+/g;
  return [...new Set(f.match(re) ?? [])].map((r) => r.replace(/\$/g, ""));
}

function cellId(ctx: BuildCtx, part: string, sheet: string, ref: string): DataId {
  // セルは「sheet 名 + A1 参照」を stableKey にする → 行挿入で xml index が変わっても安定。
  return ctx.node(part, `worksheet/sheetData/${ref}`, `${sheet}!${ref}`, {
    kind: "cell",
    label: `${sheet}!${ref}`,
    source: { app: "xls", ooxmlTag: "c" },
  });
}

export function extractXlsx(part: OpcPart, ctx: BuildCtx): void {
  const m = part.name.match(SHEET_RE);
  if (!m) return;
  const sheet = `Sheet${m[1]}`;
  const root = parseXml(part.xml);

  const sheetNode = ctx.node(part.name, "worksheet", sheet, {
    kind: "sheet",
    label: sheet,
    source: { app: "xls", ooxmlTag: "worksheet" },
  });
  const sst = sharedStrings(ctx.pkg);

  for (const { el } of walk(root)) {
    if (el.tag !== "c") continue; // <c r="B2" t="s"><v>0</v></c> 等
    const ref = el.attrs["r"];
    if (!ref) continue;
    const id = cellId(ctx, part.name, sheet, ref);
    ctx.edge("contains", sheetNode, id);
    const meta = ctx.g.nodes.get(id)!.meta;

    const t = el.attrs["t"]; // "s"=共有文字列, "inlineStr", "str", 既定=数値
    const f = el.children.find((c) => c.tag === "f");
    const v = el.children.find((c) => c.tag === "v");

    if (t === "s" && v) {
      // (h) 共有文字列を解決 → 因果対象のテキストに。
      const s = sst[Number(textOf(v))] ?? "";
      meta.value = s;
      meta.text = s;
      meta.label = `${sheet}!${ref}: ${s.slice(0, 24)}`;
    } else if (t === "inlineStr") {
      const is = el.children.find((c) => c.tag === "is");
      const s = is ? textOf(is) : "";
      meta.value = s;
      meta.text = s;
      meta.label = `${sheet}!${ref}: ${s.slice(0, 24)}`;
    } else if (v && !f) {
      const raw = textOf(v);
      const num = Number(raw);
      meta.value = Number.isFinite(num) && t !== "str" ? num : raw;
      if (t === "str") meta.text = raw; // 数式の文字列結果
    }

    if (f) {
      const formula = textOf(f);
      if (v) {
        const raw = textOf(v);
        const num = Number(raw);
        meta.value = Number.isFinite(num) ? num : raw;
      }
      meta.text = `=${formula}`;
      for (const ref2 of refsInFormula(formula)) {
        const dep = cellId(ctx, part.name, sheet, ref2);
        // B2 は A2 から「導出される」: derives-from(B2 → A2)。
        ctx.edge("derives-from", id, dep);
      }
    }
  }
}
