/**
 * 生 XML → 汎用 AST (XmlEl) 変換。
 * fast-xml-parser を要素順・属性・名前空間を保持する設定で使う。
 * 形式固有の意味づけは parts/*.ts が XmlEl を歩いて行う。
 */
import { XMLParser } from "fast-xml-parser";

export interface XmlEl {
  /** 名前空間プレフィックス付きタグ名 ("p:sp", "a:t", "c:f")。 */
  tag: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  /** テキストノード内容 (リーフのみ)。 */
  text?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
  textNodeName: "#text",
});

type RawNode = Record<string, unknown> & { ":@"?: Record<string, string> };

function convert(raw: RawNode): XmlEl | null {
  const keys = Object.keys(raw).filter((k) => k !== ":@");
  const tag = keys[0];
  if (!tag) return null;

  if (tag === "#text") {
    const t = String((raw as Record<string, unknown>)["#text"] ?? "");
    return t.trim() ? { tag: "#text", attrs: {}, children: [], text: t } : null;
  }

  const attrsRaw = raw[":@"] ?? {};
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrsRaw)) {
    attrs[k.replace(/^@_/, "")] = String(v);
  }

  const childArr = (raw as Record<string, unknown>)[tag] as RawNode[] | undefined;
  const children: XmlEl[] = [];
  let text: string | undefined;
  for (const c of childArr ?? []) {
    const el = convert(c);
    if (!el) continue;
    if (el.tag === "#text") text = (text ?? "") + el.text;
    else children.push(el);
  }

  return { tag, attrs, children, ...(text !== undefined ? { text } : {}) };
}

export function parseXml(xml: string): XmlEl {
  const raw = parser.parse(xml) as RawNode[];
  for (const r of raw) {
    const el = convert(r);
    if (el && el.tag !== "?xml") return el;
  }
  throw new Error("Empty XML document");
}

/** 子孫を深さ優先で走査 (構造パス付き)。同名兄弟には [index] を付与。 */
export function* walk(
  el: XmlEl,
  path = el.tag,
): Generator<{ el: XmlEl; path: string }> {
  yield { el, path };
  const seen = new Map<string, number>();
  for (const child of el.children) {
    if (child.tag === "#text") continue;
    const n = (seen.get(child.tag) ?? 0) + 1;
    seen.set(child.tag, n);
    const total = el.children.filter((c) => c.tag === child.tag).length;
    const childPath = total > 1 ? `${path}/${child.tag}[${n}]` : `${path}/${child.tag}`;
    yield* walk(child, childPath);
  }
}

/** リーフのテキストを結合 (正規化)。 */
export function textOf(el: XmlEl): string {
  let out = el.text ?? "";
  for (const c of el.children) out += textOf(c);
  return out.replace(/\s+/g, " ").trim();
}
