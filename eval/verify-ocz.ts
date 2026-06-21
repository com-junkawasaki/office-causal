/**
 * (n) .ocz ファイルが「通常の OOXML として開けるはず」かを構造検証する。
 * Office を開く前のプリフライト用。
 *
 * 実行: node --import tsx eval/verify-ocz.ts <file.ocz.pptx|docx|xlsx>
 */
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { openPackage } from "../src/ooxml/opc.js";
import { readDataPart } from "../src/ooxml/embed.js";

const file = process.argv[2];
if (!file) { console.error("usage: verify-ocz.ts <file>"); process.exit(1); }

const bytes = new Uint8Array(readFileSync(file));
const entries = unzipSync(bytes);
const names = Object.keys(entries);
const parser = new XMLParser({ ignoreAttributes: false });

const checks: { name: string; ok: boolean; detail: string }[] = [];
const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

// 1) 全 XML/rels が parse 可能
let badXml: string[] = [];
for (const n of names) {
  if (!n.endsWith(".xml") && !n.endsWith(".rels")) continue;
  try { parser.parse(strFromU8(entries[n]!)); } catch { badXml.push(n); }
}
add("全 XML/rels が整形式", badXml.length === 0, badXml.join(", "));

// 2) OPC として再オープン可能
let app = "";
try { app = openPackage(bytes).app; add("openPackage 成功", true, `app=${app}`); }
catch (e) { add("openPackage 成功", false, (e as Error).message); }

// 3) ocz 同梱データが読める
const payload = readDataPart(bytes);
add("ocz 同梱データ読込", !!payload, payload ? `nodes=${payload.nodes.length} edges=${payload.edges.length}` : "なし");

// 4) Content_Types に拡張子登録
const ct = entries["[Content_Types].xml"] ? strFromU8(entries["[Content_Types].xml"]!) : "";
add("Content_Types 登録", /Extension="jsonl"|Extension="json"/.test(ct));

// 5) ルート rels に登録
const rels = entries["_rels/.rels"] ? strFromU8(entries["_rels/.rels"]!) : "";
add("ルート rels 登録", rels.includes("rIdOfficeCausal"));

// 6) 既存 OOXML 主要パートが存在
const hasMain = names.some((n) => /(document|presentation|workbook)\.xml$/.test(n));
add("OOXML 主要パート存在", hasMain);

console.log(`\n=== verify-ocz: ${file} ===`);
for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? " — " + c.detail : ""}`);
const allOk = checks.every((c) => c.ok);
console.log(`\n${allOk ? "→ ✅ 通常の Office アプリで開けるはずです。" : "→ ⚠ 問題あり (上記参照)。"}`);
process.exit(allOk ? 0 : 1);
