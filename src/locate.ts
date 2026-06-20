/**
 * (q) data-id → Office 上の該当要素の「位置」と deep-link 文字列。
 *
 * Office に汎用の要素 deep-link URL は無いが、形式ごとに実用的なロケータが作れる:
 *  - xlsx: セル参照 `Sheet1!B2` → Excel/LibreOffice はフラグメント `file.xlsx#Sheet1!B2`
 *          や名前ボックス入力でジャンプ可能。
 *  - pptx: スライド番号 N。
 *  - docx: 段落番号 ¶N。
 */
import type { Meta, AppKind } from "./types.js";

export interface Locator {
  app: AppKind | "?";
  /** 人間可読の位置 (例 "Sheet1!B2", "スライド 5", "本文 ¶12")。 */
  descriptor: string;
  /** Excel/LibreOffice 用フラグメント (例 "#Sheet1!B2")。xlsx セルのみ。 */
  excelFragment?: string;
  slide?: number;
  cell?: string;
  sheet?: string;
}

function quoteSheet(s: string): string {
  return /[^A-Za-z0-9_]/.test(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

/** source が無い (埋め込み payload 由来) 場合は part パスから app を推定。 */
function appOf(meta: Pick<Meta, "part" | "source">): AppKind | "?" {
  if (meta.source?.app) return meta.source.app;
  if (meta.part.startsWith("xl/")) return "xls";
  if (meta.part.startsWith("ppt/")) return "ppt";
  if (meta.part.startsWith("word/")) return "doc";
  return "?";
}

export function locate(meta: Pick<Meta, "part" | "path" | "label" | "source" | "kind">): Locator {
  const app = appOf(meta);
  if (app === "xls") {
    const m = (meta.label ?? "").match(/^([^!]+)!([A-Z]+\d+)/);
    if (m) {
      const [, sheet, cell] = m;
      return { app, descriptor: `${sheet}!${cell}`, excelFragment: `#${quoteSheet(sheet!)}!${cell}`, sheet: sheet!, cell: cell! };
    }
    return { app, descriptor: meta.label ?? meta.part };
  }
  if (app === "ppt") {
    const s = meta.part.match(/slide(\d+)/);
    const n = s ? Number(s[1]) : undefined;
    return { app, descriptor: n ? `スライド ${n}` : meta.part, ...(n ? { slide: n } : {}) };
  }
  if (app === "doc") {
    const pm = (meta.label ?? "").match(/¶(\d+)/);
    return { app, descriptor: pm ? `本文 ¶${pm[1]}` : meta.path };
  }
  return { app, descriptor: meta.part };
}

/** data-id → Word ブックマーク名 (英数字/アンダースコアのみ, ≤40字)。 */
export function bookmarkName(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "_").slice(0, 40);
}

/**
 * ファイル名込みの deep-link 文字列。
 *  - xlsx: `file.xlsx#Sheet1!B2`（Excel/LibreOffice でセルへジャンプ）
 *  - docx: `file.docx#<bookmark>`（embed --mode bookmark/both 適用時に有効）
 *  - pptx: スライド番号
 */
export function deepLink(node: Parameters<typeof locate>[0] & { id?: string }, fileName: string): string {
  const l = locate(node);
  if (l.excelFragment) return `${fileName}${l.excelFragment}`;
  if (l.app === "doc" && node.id) return `${fileName}#${bookmarkName(node.id)}`;
  if (l.slide) return `${fileName} → スライド ${l.slide}`;
  return `${fileName} → ${l.descriptor}`;
}
