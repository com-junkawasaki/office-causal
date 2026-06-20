#!/usr/bin/env node
/**
 * office-casual CLI。
 *   office-casual analyze <file...> [--depth structural|semantic|causal] [--out f.json] [--format json|dot|graphml|cypher]
 *   office-casual graph  <f.casual.json> [--format dot]
 *   office-casual embed  <file.pptx|xlsx|docx> [--mode part|attrs|both] [--format jsonl|json] [--diff] [--out f]
 *   office-casual locate <file.ocz.*> <data-id>      data-id → Office 上の位置/deep-link
 */
import { writeFile, readFile } from "node:fs/promises";
import { analyze, exportGraph, embedFile, readDataPart, locate, deepLink } from "./index.js";
import type { CausalGraph, Depth, ExportFormat } from "./types.js";

function flag(args: string[], name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const positionals = rest.filter((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1]?.startsWith("--") === false);
  const format = (flag(rest, "format", "json") ?? "json") as ExportFormat;
  const out = flag(rest, "out");

  if (cmd === "analyze") {
    const files = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));
    const depth = (flag(rest, "depth", "causal") ?? "causal") as Depth;
    const result = await analyze(files, { depth });
    result.log.forEach((l) => console.error(`· ${l}`));
    const text = result.export(format);
    if (out) await writeFile(out, text);
    else console.log(text);
    console.error(`\n${JSON.stringify(result.report(), null, 2)}`);
    return;
  }

  if (cmd === "graph") {
    const file = positionals[0]!;
    const raw = JSON.parse(await readFile(file, "utf8"));
    const g: CausalGraph = {
      sources: raw.sources ?? [],
      nodes: new Map(raw.nodes.map((n: { id: string }) => [n.id, n])),
      edges: raw.edges,
    };
    console.log(exportGraph(g, format));
    return;
  }

  if (cmd === "embed") {
    const file = rest.find((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));
    if (!file) { console.error("usage: office-casual embed <file> [--mode part|attrs|both] [--out f]"); process.exit(1); }
    const mode = (flag(rest, "mode", "part") ?? "part") as "part" | "attrs" | "both";
    const efmt = (flag(rest, "format", "jsonl") ?? "jsonl") as "json" | "jsonl";
    const diff = rest.includes("--diff");
    const r = await embedFile(file, { mode, format: efmt, diff, ...(out ? { out } : {}) });
    console.error(`embedded (${r.mode}${diff ? ", diff" : ""}) → ${r.outPath}`);
    console.error(JSON.stringify(r.stats, null, 2));
    return;
  }

  if (cmd === "locate") {
    const bare = rest.filter((a) => !a.startsWith("--"));
    const file = bare[0]!;
    const payload = readDataPart(new Uint8Array(await readFile(file)));
    if (!payload) { console.error("埋め込みデータ (.ocz) がありません"); process.exit(1); }

    // (t) --all: 全 data-id の deep-link を CSV 出力
    if (rest.includes("--all")) {
      const csv = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      const out = ["id,kind,descriptor,deeplink"];
      for (const n of payload.nodes) {
        const node = n as Parameters<typeof locate>[0] & { id: string };
        out.push([n.id, n.kind, locate(node).descriptor, deepLink(node, file)].map((x) => csv(String(x))).join(","));
      }
      console.log(out.join("\n"));
      return;
    }

    const id = bare[1] ?? rest.find((a) => a.startsWith("ocz1:"));
    const node = payload.nodes.find((n) => n.id === id);
    if (!node) { console.error(`data-id ${id} が見つかりません`); process.exit(1); }
    const loc = locate(node as Parameters<typeof locate>[0]);
    console.log(JSON.stringify({ id, descriptor: loc.descriptor, deepLink: deepLink(node as Parameters<typeof locate>[0] & { id: string }, file), locator: loc }, null, 2));
    return;
  }

  console.error("usage: office-casual <analyze|graph|embed|locate> <file...> [--depth d] [--format f] [--mode m] [--diff] [--out f]");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
