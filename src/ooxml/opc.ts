/**
 * OPC (Open Packaging Conventions) パッケージ展開。
 * .xlsx/.pptx/.docx は zip。fflate で展開し part ごとの生 XML を返す。
 * `_rels/*.rels` を解析して r:id → ターゲット part の参照解決表も作る。
 */
import { unzipSync, strFromU8 } from "fflate";
import type { AppKind } from "../types.js";

export interface Relationship {
  id: string; // "rId3"
  type: string; // schemas.../slide, /chart, /worksheet ...
  target: string; // 相対パス
  targetMode?: "Internal" | "External";
}

export interface OpcPart {
  name: string; // "ppt/slides/slide1.xml"
  xml: string;
  /** この part に紐づくリレーション (`_rels/<base>.rels`)。 */
  rels: Relationship[];
}

export interface OpcPackage {
  app: AppKind;
  parts: Map<string, OpcPart>;
  /** content-types 等から判定したメイン part。 */
  mainParts: string[];
}

function detectApp(names: string[]): AppKind {
  if (names.some((n) => n.startsWith("ppt/"))) return "ppt";
  if (names.some((n) => n.startsWith("xl/"))) return "xls";
  if (names.some((n) => n.startsWith("word/"))) return "doc";
  throw new Error("Unsupported OOXML package (no ppt/xl/word part)");
}

function relsPathFor(partName: string): string {
  const slash = partName.lastIndexOf("/");
  const dir = slash >= 0 ? partName.slice(0, slash) : "";
  const base = slash >= 0 ? partName.slice(slash + 1) : partName;
  return dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
}

function parseRels(xml: string | undefined): Relationship[] {
  if (!xml) return [];
  const rels: Relationship[] = [];
  // 軽量正規表現抽出 (parse.ts の本格パーサに後で置換可)。
  const re = /<Relationship\b[^>]*\/?>/g;
  for (const m of xml.matchAll(re)) {
    const tag = m[0];
    const get = (a: string) => tag.match(new RegExp(`${a}="([^"]*)"`))?.[1];
    const id = get("Id");
    const type = get("Type");
    const target = get("Target");
    if (id && type && target) {
      rels.push({
        id,
        type,
        target,
        targetMode: (get("TargetMode") as Relationship["targetMode"]) ?? "Internal",
      });
    }
  }
  return rels;
}

export function openPackage(bytes: Uint8Array): OpcPackage {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);
  const app = detectApp(names);

  // 先に全 .rels を文字列化。
  const relsRaw = new Map<string, string>();
  for (const n of names) {
    if (n.endsWith(".rels")) relsRaw.set(n, strFromU8(entries[n]!));
  }

  const parts = new Map<string, OpcPart>();
  for (const n of names) {
    if (!n.endsWith(".xml") || n.endsWith(".rels")) continue;
    parts.set(n, {
      name: n,
      xml: strFromU8(entries[n]!),
      rels: parseRels(relsRaw.get(relsPathFor(n))),
    });
  }

  const mainParts = names.filter((n) =>
    /^(ppt\/slides\/slide\d+|xl\/worksheets\/sheet\d+|word\/document)\.xml$/.test(n),
  );

  return { app, parts, mainParts };
}
