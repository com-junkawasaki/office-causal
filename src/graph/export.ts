/**
 * CausalGraph の各種シリアライズ。
 */
import type { CausalGraph, ExportFormat } from "../types.js";

export function exportGraph(g: CausalGraph, format: ExportFormat): string {
  switch (format) {
    case "json":
      return toJson(g);
    case "dot":
      return toDot(g);
    case "graphml":
      return toGraphml(g);
    case "cypher":
      return toCypher(g);
  }
}

function toJson(g: CausalGraph): string {
  return JSON.stringify(
    {
      sources: g.sources,
      nodes: [...g.nodes.values()],
      edges: g.edges,
    },
    null,
    2,
  );
}

const COLOR: Record<string, string> = {
  contains: "gray",
  references: "blue",
  "derives-from": "green",
  mentions: "orange",
  causes: "red",
};

function toDot(g: CausalGraph): string {
  const lines = ["digraph causal {", '  rankdir=LR; node [shape=box];'];
  for (const n of g.nodes.values()) {
    const lbl = (n.meta.label ?? n.meta.kind).replace(/"/g, "'");
    lines.push(`  "${n.id}" [label="${lbl}"];`);
  }
  for (const e of g.edges) {
    const c = COLOR[e.kind] ?? "black";
    const w = e.weight !== undefined ? ` ${e.weight.toFixed(2)}` : "";
    const lbl = e.kind === "causes" ? `${e.kind} ${e.causal?.polarity ?? ""}${w}` : `${e.kind}${w}`;
    // weight を線の太さ (penwidth) に反映。
    const pen = e.weight !== undefined ? `, penwidth=${(0.5 + e.weight * 3).toFixed(2)}` : "";
    lines.push(`  "${e.from}" -> "${e.to}" [color=${c}, label="${lbl}"${pen}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function toGraphml(g: CausalGraph): string {
  const nodes = [...g.nodes.values()]
    .map((n) => `    <node id="${n.id}"><data key="kind">${n.meta.kind}</data><data key="label">${esc(n.meta.label ?? "")}</data></node>`)
    .join("\n");
  const edges = g.edges
    .map((e, i) => `    <edge id="e${i}" source="${e.from}" target="${e.to}"><data key="kind">${e.kind}</data></edge>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="kind" for="all" attr.name="kind" attr.type="string"/>
  <key id="label" for="node" attr.name="label" attr.type="string"/>
  <graph edgedefault="directed">
${nodes}
${edges}
  </graph>
</graphml>`;
}

function toCypher(g: CausalGraph): string {
  const lines: string[] = [];
  for (const n of g.nodes.values()) {
    lines.push(
      `MERGE (n:${cap(n.meta.kind)} {id:'${n.id}'}) SET n.label=${q(n.meta.label ?? "")};`,
    );
  }
  for (const e of g.edges) {
    const rel = e.kind.toUpperCase().replace(/-/g, "_");
    const props = e.causal
      ? ` {confidence:${e.causal.confidence}, polarity:'${e.causal.polarity}'}`
      : "";
    lines.push(
      `MATCH (a {id:'${e.from}'}),(b {id:'${e.to}'}) MERGE (a)-[:${rel}${props}]->(b);`,
    );
  }
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
