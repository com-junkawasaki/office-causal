/**
 * LangGraph ノード実装。クラウド非依存 — 生成・裁定・検証はすべてローカル Gemma 4。
 * - ingest / identify / structural / analyze: 純関数 (LLM 不使用)
 * - causal / verify: ローカル Gemma 4 (transformers.js / WebGPU・WASM・CPU)
 */
import type { AgentStateType, CausalCandidate } from "./state.js";
import { openPackage } from "../ooxml/opc.js";
import { buildStructuralGraph } from "../graph/builder.js";
import { addEdge, emptyGraph, stats, upsertNode } from "../graph/model.js";
import { getEmbedder } from "../embed/model.js";
import { embedNodes, weightEdges, proposeEdges, applyProposals, dedupUndirected } from "../embed/weight.js";
import { tagNodes, DEFAULT_TAXONOMY } from "../embed/tag.js";
import type { CausalGraph, DataId } from "../types.js";
import type { GemmaOptions } from "../llm/gemma-webgpu.js";

/** llm オプションから Gemma 4 アダプタ生成用の設定を組む。 */
function gemmaOpts(s: AgentStateType): GemmaOptions {
  const llm = s.options.llm;
  const o: GemmaOptions = {};
  if (llm?.localModel) o.model = llm.localModel;
  // GemmaOptions.device は webgpu|wasm|cpu。"coreml" は対象外なので渡さない。
  if (llm?.device && llm.device !== "coreml") o.device = llm.device;
  return o;
}

/** 1) ingest: zip 展開して OpcPackage に。 */
export function ingest(s: AgentStateType): Partial<AgentStateType> {
  const pkgs = s.files.map((f) => openPackage(f.bytes));
  return { pkgs, log: [`ingest: ${pkgs.length} package(s)`] };
}

/** 2) identify + 3) structural: data-id 付与 + 構造/参照/依存グラフ。 */
export function structural(s: AgentStateType): Partial<AgentStateType> {
  const merged = emptyGraph(
    s.files.map((f, i) => ({ path: f.path, app: s.pkgs[i]!.app })),
  );
  for (const pkg of s.pkgs) {
    const g = buildStructuralGraph(pkg);
    for (const n of g.nodes.values()) upsertNode(merged, n.id, n.meta);
    for (const e of g.edges) addEdge(merged, e);
  }
  return { graph: merged, log: [`structural: ${JSON.stringify(stats(merged))}`] };
}

/**
 * 3.5) embed: transformers.js ローカル小型モデルで
 *   - 全エッジに weight を付与 (「edge の小さい LLM weight」)
 *   - data-id にタグを付与
 *   - 埋め込み類似で「無向の」候補ペアを一次選別 (causal 段へ供給)
 *   - (opt) proposeKind 指定時は候補をグラフに直接コミット (LLM レス用途)
 * API キー不要。モデル DL 不可ならハッシュ埋め込みに自動フォールバック。
 */
export async function embed(s: AgentStateType): Promise<Partial<AgentStateType>> {
  const g = s.graph!;
  const opt = s.options.embeddings ?? {};
  if (opt.enabled === false) return { log: ["embed: disabled"], embedCandidates: [] };

  const { embedder, fallback } = await getEmbedder(opt.model);
  const vecs = await embedNodes(g, embedder);
  weightEdges(g, vecs);

  const taxonomy = opt.tagTaxonomy ?? DEFAULT_TAXONOMY;
  const { tags } = await tagNodes(g, vecs, embedder, taxonomy, opt.tagThreshold ?? 0.3);

  // 無向候補ペアを一次選別 (O(n^2) を高親和ペアだけに絞る)。
  const pairs = dedupUndirected(
    proposeEdges(g, vecs, {
      kind: "causes",
      threshold: opt.proposeThreshold ?? 0.45,
      max: 200,
    }),
  );

  // LLM レス用途: proposeKind 指定時は向き不定のまま直接コミット。
  let proposed = 0;
  if (opt.proposeKind) {
    proposed = applyProposals(g, opt.proposeKind, pairs);
  }

  return {
    graph: g,
    embedCandidates: pairs,
    log: [
      `embed: model=${embedder.name}${fallback ? " (fallback)" : ""} ` +
        `weighted=${g.edges.filter((e) => e.weight !== undefined).length} ` +
        `tagged=${tags.size} candidates=${pairs.length}${proposed ? ` committed=${proposed}` : ""}`,
    ],
  };
}

/**
 * 4) semantic: ローカル Gemma 4 構成では entity 抽出を行わない。
 * causal 段が text ノード間で直接因果を裁定するため、別途の entity ノードは不要。
 */
export function semantic(s: AgentStateType): Partial<AgentStateType> {
  return { log: ["semantic: skipped (local Gemma; text ノード間で直接裁定)"] };
}

/**
 * 5) causal: ローカル Gemma 4 で因果候補を裁定して verify へ渡す。
 *
 * embed 段が埋め込み類似で「無向の」高親和ペアに絞り込み済み (O(n^2) 回避, ADR-0002 D3)。
 * Gemma 4 にはその各ペアの「向き・極性・採否」だけを判定させる (自由生成はしない)。
 * クラウド非依存 — API キー不要。
 */
export async function causal(s: AgentStateType): Promise<Partial<AgentStateType>> {
  const g = s.graph!;
  if (s.options.depth !== "causal") return { log: ["causal: skipped"], candidates: [] };
  if (s.embedCandidates.length === 0) return { candidates: [], log: ["causal[gemma]: no candidates"] };

  const lbl = (id: string) => g.nodes.get(id as DataId)?.meta.label ?? id;
  const txt = (id: string) => g.nodes.get(id as DataId)?.meta.text ?? lbl(id);

  const { WebGpuGemmaAdjudicator } = await import("../llm/gemma-webgpu.js");
  const adj = new WebGpuGemmaAdjudicator(gemmaOpts(s));
  const pairs = s.embedCandidates.map((p) => ({
    from: p.from,
    to: p.to,
    weight: p.weight,
    fromText: txt(p.from),
    toText: txt(p.to),
  }));
  const verdicts = await adj.judge(pairs);
  const candidates: CausalCandidate[] = verdicts
    .filter((v) => g.nodes.has(v.from as DataId) && g.nodes.has(v.to as DataId))
    .map((v) => ({
      from: v.from,
      to: v.to,
      polarity: v.polarity,
      mechanism: v.mechanism,
      evidence: [
        { nodeId: v.from, quote: txt(v.from) },
        { nodeId: v.to, quote: txt(v.to) },
      ],
    }));
  return {
    candidates,
    rounds: s.rounds + 1,
    log: [`causal[gemma:${adj.modelId.split("/").pop()}]: ${s.embedCandidates.length} pairs → ${candidates.length} directed`],
  };
}

/** 6) verify: 各候補を独立 N 票で敵対的に反証し confidence を付与 (ローカル Gemma 4)。 */
export async function verify(s: AgentStateType): Promise<Partial<AgentStateType>> {
  const g = s.graph!;
  // 候補が無い (structural 深度等) ならモデルを構築せず即返す。
  if (s.candidates.length === 0) return { graph: g, log: ["verify: skipped"] };

  // verify:false → 反証を省き、Gemma 4 の裁定をそのまま commit (高速・完全ローカル)。
  if (s.options.llm?.verify === false) {
    for (const c of s.candidates) {
      addEdge(g, {
        kind: "causes",
        from: c.from as DataId,
        to: c.to as DataId,
        causal: {
          polarity: c.polarity,
          mechanism: c.mechanism,
          confidence: 0.5, // 未検証 (裁定のみ)
          evidence: c.evidence.map((e) => ({ nodeId: e.nodeId as DataId, quote: e.quote })),
          status: "hypothesis",
        },
      });
    }
    return { graph: g, candidates: [], log: [`verify: committed ${s.candidates.length} (no-verify)`] };
  }

  const votes = s.options.llm?.verifyVotes ?? 3;
  const { WebGpuGemmaAdjudicator } = await import("../llm/gemma-webgpu.js");
  const adj = new WebGpuGemmaAdjudicator(gemmaOpts(s));

  for (const c of s.candidates) {
    const claim =
      `原因=${label(g, c.from)} → 結果=${label(g, c.to)} (${c.polarity})。` +
      `メカニズム: ${c.mechanism}。根拠: ${c.evidence.map((e) => e.quote).join(" / ")}`;
    let refutes = 0;
    for (let i = 0; i < votes; i++) {
      const v = await adj.refute(claim);
      if (v.refuted) refutes++;
    }
    const confidence = 1 - refutes / votes;
    const status = refutes > votes / 2 ? "refuted" : confidence >= 0.66 ? "supported" : "hypothesis";
    addEdge(g, {
      kind: "causes",
      from: c.from as DataId,
      to: c.to as DataId,
      causal: {
        polarity: c.polarity,
        mechanism: c.mechanism,
        confidence,
        evidence: c.evidence.map((e) => ({ nodeId: e.nodeId as DataId, quote: e.quote })),
        status,
      },
    });
  }
  return {
    graph: g,
    candidates: [],
    log: [`verify: ${s.candidates.length} edges scored (${votes} votes each)`],
  };
}

function label(g: CausalGraph, id: string): string {
  return g.nodes.get(id as DataId)?.meta.label ?? id;
}
