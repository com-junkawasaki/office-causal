/**
 * (k) JSON vs JSONL の実測ベンチ (大規模 xlsx の埋め込みデータ)。
 *   - サイズ (生 / gzip)
 *   - 全読み込み時間 (readDataPart)
 *   - 部分読み: 特定パートの node 行だけ取り出す (jsonl=行スキャン / json=全 parse)
 *   - 追記: ノード1件追加 (jsonl=1行 append / json=全 parse+stringify)
 *
 * 実行: node --import tsx eval/embed-format-bench.ts /tmp/big.xlsx
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { unzipSync, strFromU8 } from "fflate";
import { openPackage } from "../src/ooxml/opc.js";
import { buildStructuralGraph } from "../src/graph/builder.js";
import { embedDataPart, readDataPart } from "../src/ooxml/embed.js";

const file = process.argv[2] ?? "/tmp/big.xlsx";
const orig = new Uint8Array(readFileSync(file));
const graph = buildStructuralGraph(openPackage(orig));
console.log(`graph: nodes=${graph.nodes.size} edges=${graph.edges.length}`);

function timed<T>(fn: () => T): [T, number] {
  const t = process.hrtime.bigint();
  const r = fn();
  return [r, Number(process.hrtime.bigint() - t) / 1e6];
}

const rows: any[] = [];
for (const fmt of ["json", "jsonl"] as const) {
  const zip = embedDataPart(orig, graph, { format: fmt });
  const partName = `ocz/casual.${fmt}`;
  const part = unzipSync(zip)[partName]!;
  const text = strFromU8(part);

  // 全読み込み
  const [, readMs] = timed(() => readDataPart(zip));

  // 部分読み: あるパートの node だけ数える
  const target = "xl/worksheets/sheet1.xml";
  let partialCount = 0;
  const [, partialMs] = timed(() => {
    if (fmt === "jsonl") {
      // 行スキャン: JSON.parse は該当行だけ
      for (const line of text.split("\n")) {
        if (line.startsWith('{"t":"node"') && line.includes(`"part":"${target}"`)) {
          JSON.parse(line);
          partialCount++;
        }
      }
    } else {
      const p = JSON.parse(text); // 全 parse 必須
      partialCount = p.nodes.filter((n: any) => n.part === target).length;
    }
  });

  // 追記: ノード1件
  const newNode = JSON.stringify({ t: "node", id: "ocz1:appended", kind: "cell", part: target, path: "x", text: "追記" });
  const [, appendMs] = timed(() => {
    if (fmt === "jsonl") {
      // 末尾に1行足すだけ (全体を触らない)
      void (text + newNode + "\n");
    } else {
      const p = JSON.parse(text);
      p.nodes.push(JSON.parse(newNode));
      void JSON.stringify(p);
    }
  });

  rows.push({
    fmt,
    rawKB: +(part.length / 1024).toFixed(1),
    gzipKB: +(gzipSync(part).length / 1024).toFixed(1),
    readMs: +readMs.toFixed(1),
    partialMs: +partialMs.toFixed(2),
    appendMs: +appendMs.toFixed(2),
    partialCount,
  });
}

console.table(rows);
