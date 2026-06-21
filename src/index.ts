/**
 * office-causal public API.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AnalyzeOptions, CausalGraph, ExportFormat } from "./types.js";
import { buildAgent } from "./agent/graph.js";
import { exportGraph } from "./graph/export.js";
import * as causalAnalysis from "./causal/analyze.js";
import { analyzeWeights } from "./embed/weight.js";
import { openPackage as openPkg } from "./ooxml/opc.js";
import { buildStructuralGraph as buildGraph } from "./graph/builder.js";
import { embedDataPart, embedDataPartDiff, embedAttributes, readDataPart, payloadToGraph, validatePayload as validatePayloadFn } from "./ooxml/embed.js";
import { stats } from "./graph/model.js";
import { diagnose as runDiagnose } from "./analyze/diagnose.js";
import { consult as runConsult } from "./analyze/consult.js";
import { mece as runMece } from "./analyze/mece.js";
import { getEmbedder } from "./embed/model.js";
import { WebGpuGemmaAdjudicator } from "./llm/gemma-webgpu.js";

export * from "./types.js";
export { exportGraph } from "./graph/export.js";
export { buildStructuralGraph } from "./graph/builder.js";
export { openPackage } from "./ooxml/opc.js";
export { embedDataPart, embedDataPartDiff, embedAttributes, readDataPart, payloadToGraph, validatePayload, OCZ_VERSION, type EmbeddedPayload } from "./ooxml/embed.js";
export { locate, deepLink, type Locator } from "./locate.js";
export { diagnose, type Diagnosis } from "./analyze/diagnose.js";
export { consult, type ConsultResult } from "./analyze/consult.js";
export { mece, type MeceResult } from "./analyze/mece.js";
export { similarPairs, lshCandidatePairs } from "./analyze/ann.js";
export { renderDiagnosisSvg, overlayCausal, overlayCharBoxes, renderConsultSvg } from "./visual/svg.js";
export { renderInteractiveHtml, buildNodeInfo, nodeRoles, type NodeInfo } from "./visual/interactive.js";
export {
  renderDrawingmlSvg, isDrawingmlAvailable, pythonDrawingmlRenderer, renderSlideCausalSvg, resolveSlideRenderer,
  type SlideRenderer,
} from "./visual/drawingml.js";
export * as causal from "./causal/analyze.js";
export * as embed from "./embed/weight.js";
export { getEmbedder, HashEmbedder, TransformersEmbedder } from "./embed/model.js";
export type { Device } from "./embed/model.js";
export {
  WebGpuGemmaAdjudicator,
  type GemmaOptions,
  type PairInput,
  type DirectedVerdict,
} from "./llm/gemma-webgpu.js";

export interface AnalyzeResult {
  graph: CausalGraph;
  log: string[];
  export(format: ExportFormat): string;
  report(): ReturnType<typeof causalAnalysis.report>;
  /** 「edge の小さい LLM weight」分析: 種別ごとの重み分布と強/弱エッジ。 */
  weights(): ReturnType<typeof analyzeWeights>;
}

/**
 * 単一/複数の Office ファイルを CausalGraph に変換する。
 *
 * @example
 *   const r = await analyze("Q1.pptx", { depth: "causal" });
 *   r.export("dot"); r.report();
 */
export async function analyze(
  input: string | string[],
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const paths = Array.isArray(input) ? input : [input];
  const files = await Promise.all(
    paths.map(async (p) => ({ path: p, bytes: new Uint8Array(await readFile(p)) })),
  );

  // (o) 単一の .ocz (埋め込み済み) は再解析せず、同梱グラフを即返す。
  if (files.length === 1 && options.reanalyze !== true) {
    const payload = readDataPart(files[0]!.bytes);
    if (payload) {
      const graph = payloadToGraph(payload);
      const log = [`embedded: ${basename(paths[0]!)} の同梱グラフを使用 (再解析スキップ, nodes=${graph.nodes.size})`];
      for (const w of validatePayloadFn(payload)) log.push(`⚠ ${w}`);
      return {
        graph, log,
        export: (fmt) => exportGraph(graph, fmt),
        report: () => causalAnalysis.report(graph),
        weights: () => analyzeWeights(graph),
      };
    }
  }

  const agent = buildAgent();
  const final = await agent.invoke(
    { files, options: { depth: "causal", embed: false, ...options } },
    { configurable: { thread_id: `oc:${basename(paths[0]!)}` } },
  );

  const graph = final.graph!;
  return {
    graph,
    log: final.log,
    export: (fmt) => exportGraph(graph, fmt),
    report: () => causalAnalysis.report(graph),
    weights: () => analyzeWeights(graph),
  };
}

export interface EmbedOptions {
  /**
   *  - "part" (既定): 完全安全。元 XML 不変、zip に ocz/casual.json 同梱。
   *  - "attrs": docx/pptx 要素に ocz:id を MCE Ignorable で注入 (実験的)。
   *  - "both": 両方。
   */
  mode?: "part" | "attrs" | "both";
  /** part 同梱データの形式。"jsonl"(既定, 大規模・追記・diff 向き) / "json"(原子的)。 */
  format?: "json" | "jsonl";
  /** (p) 既存 .ocz の jsonl を書換えず、変更分のみ追記する差分 embed。 */
  diff?: boolean;
  /** (n) diagnose を実行し analysis として同梱。 */
  analysis?: boolean;
  /** (n) analysis に so-what/MECE も含める (Gemma 使用)。 */
  gemma?: boolean;
  device?: "webgpu" | "wasm" | "cpu" | "coreml";
  /** 出力パス。既定は元名に .ocz を挿入 (report.pptx → report.ocz.pptx)。 */
  out?: string;
}

/**
 * 既存の .pptx/.xlsx/.docx を非破壊で data-id/meta 付きに書き出す。
 * 構造グラフ (LLM 不使用) を作り埋め込むだけなので API キー不要。
 */
export async function embedFile(path: string, options: EmbedOptions = {}) {
  const mode = options.mode ?? "part";
  const bytes = new Uint8Array(await readFile(path));
  const pkg = openPkg(bytes);
  // .ocz (causes 同梱) なら既存グラフを使い、無ければ構造グラフ。
  const existing = readDataPart(bytes);
  const graph = existing ? payloadToGraph(existing) : buildGraph(pkg);

  // (n) analysis: diagnose (+ --gemma で so-what/MECE) を実行して同梱
  let analysis: { version: number; generatedAt: string; models: Record<string, string>; diagnosis?: unknown; consult?: unknown; mece?: unknown } | undefined;
  if (options.analysis) {
    const embedder = (await getEmbedder().catch(() => ({ embedder: undefined }))).embedder;
    const diagnosis = await runDiagnose(graph, embedder);
    const models: Record<string, string> = { ...(embedder ? { embed: embedder.name } : {}) };
    analysis = { version: 1, generatedAt: new Date().toISOString(), models, diagnosis };
    if (options.gemma) {
      const gm = new WebGpuGemmaAdjudicator(options.device ? ({ device: options.device } as any) : {});
      models.gemma = gm.modelId;
      analysis.consult = await runConsult(graph, gm, { maxChains: 8 });
      analysis.mece = await runMece(graph, embedder, { gemma: gm });
    }
  }

  let out: Uint8Array = bytes;
  if (mode === "part" || mode === "both") {
    out = options.diff
      ? embedDataPartDiff(out, graph)
      : embedDataPart(out, graph, { format: options.format ?? "jsonl", ...(analysis ? { analysis } : {}) });
  }
  if (mode === "attrs" || mode === "both") out = embedAttributes(out);

  const outPath = options.out ?? path.replace(/(\.[^./\\]+)$/, ".ocz$1");
  await writeFile(outPath, out);
  return { outPath, mode, stats: stats(graph) };
}
