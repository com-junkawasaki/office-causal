/**
 * (m) data-id の安定性検証:
 *   1. 決定性    : 同じファイルを2回 embed → 同梱 jsonl が完全一致
 *   2. 冪等性    : .ocz を再 embed → 同梱内容一致・rel/CT 重複なし
 *   3. 差分更新  : 元ファイルを変更 → 不変要素の data-id は保持、変更分のみ新規
 *
 * 実行: node --import tsx eval/verify-stability.ts /tmp/real.xlsx /tmp/real2.xlsx
 */
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { openPackage } from "../src/ooxml/opc.js";
import { buildStructuralGraph } from "../src/graph/builder.js";
import { embedDataPart, readDataPart } from "../src/ooxml/embed.js";

const fileA = process.argv[2] ?? "/tmp/real.xlsx";
const fileB = process.argv[3] ?? "/tmp/real2.xlsx";

function embed(bytes: Uint8Array): Uint8Array {
  return embedDataPart(bytes, buildStructuralGraph(openPackage(bytes)));
}
const oczPart = (zip: Uint8Array) => strFromU8(unzipSync(zip)["ocz/causal.jsonl"]!);
const idSet = (bytes: Uint8Array) => new Set(readDataPart(bytes)!.nodes.map((n) => n.id));
const count = (zip: Uint8Array, needle: string) => (strFromU8(unzipSync(zip)["_rels/.rels"]!).match(new RegExp(needle, "g")) || []).length;

const A = new Uint8Array(readFileSync(fileA));

// 1) 決定性
const e1 = embed(A), e2 = embed(A);
console.log("1) 決定性: 2回 embed の jsonl 一致 =", oczPart(e1) === oczPart(e2));

// 2) 冪等性 (.ocz を再 embed)
const e3 = embed(e1);
console.log("2) 冪等性: 再 embed で jsonl 一致 =", oczPart(e1) === oczPart(e3),
  "| rel 重複なし =", count(e3, "rIdOfficeCasual") === 1,
  "| CT 重複なし =", (strFromU8(unzipSync(e3)["[Content_Types].xml"]!).match(/Extension="jsonl"/g) || []).length === 1);

// 3) 差分更新
const B = new Uint8Array(readFileSync(fileB));
const idsA = idSet(embed(A)), idsB = idSet(embed(B));
const preserved = [...idsA].filter((id) => idsB.has(id));
const added = [...idsB].filter((id) => !idsA.has(id));
const removed = [...idsA].filter((id) => !idsB.has(id));
console.log(`3) 差分更新: 元${idsA.size}件中 保持=${preserved.length} 追加=${added.length} 削除=${removed.length}`);
console.log(`   → 不変要素の data-id 完全保持 = ${preserved.length === idsA.size}`);
const addedLabels = readDataPart(embed(B))!.nodes.filter((n) => added.includes(n.id)).map((n) => n.label);
console.log("   追加された要素:", addedLabels);
