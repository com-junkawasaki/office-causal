/**
 * OPC パッケージ → 決定論的グラフ (contains / references / derives-from)。
 * LLM は一切使わない (ADR-0001 D2)。形式固有処理は parts/*.ts に委譲。
 */
import type { CausalGraph, DataId, Meta, NodeKind } from "../types.js";
import { makeDataId } from "../id/hash.js";
import type { OpcPackage, OpcPart } from "../ooxml/opc.js";
import { addEdge, emptyGraph, upsertNode } from "./model.js";
import { extractPptx } from "./../ooxml/parts/pptx.js";
import { extractXlsx } from "./../ooxml/parts/xlsx.js";
import { extractDocx } from "./../ooxml/parts/docx.js";

/** part extractor に渡す書き込みコンテキスト。 */
export interface BuildCtx {
  pkg: OpcPackage;
  g: CausalGraph;
  /** ノード生成 (data-id は part/path/key から決定論的)。 */
  node(part: string, path: string, key: string, meta: Omit<Meta, "part" | "path" | "provenance">): DataId;
  edge(kind: "contains" | "references" | "derives-from", from: DataId, to: DataId): void;
}

export function buildStructuralGraph(pkg: OpcPackage): CausalGraph {
  const g = emptyGraph();
  const ctx: BuildCtx = {
    pkg,
    g,
    node(part, path, key, meta) {
      const id = makeDataId(part, path, key);
      upsertNode(g, id, { ...meta, part, path, provenance: ["structural"] });
      return id;
    },
    edge(kind, from, to) {
      addEdge(g, { kind, from, to });
    },
  };

  const dispatch: Record<string, (p: OpcPart, c: BuildCtx) => void> = {
    ppt: extractPptx,
    xls: extractXlsx,
    doc: extractDocx,
  };
  const extract = dispatch[pkg.app]!;
  for (const part of pkg.parts.values()) extract(part, ctx);
  return g;
}

/** parts/*.ts が共有する小道具。 */
export function leafKind(app: OpcPackage["app"]): NodeKind {
  return app === "ppt" ? "shape" : app === "xls" ? "cell" : "paragraph";
}
