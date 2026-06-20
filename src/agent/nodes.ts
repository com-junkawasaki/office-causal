/**
 * LangGraph ノード実装。
 * - ingest / identify / structural / analyze: 純関数 (LLM 不使用)
 * - semantic / causal / verify: ChatAnthropic
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import type { AgentStateType, CausalCandidate } from "./state.js";
import { openPackage } from "../ooxml/opc.js";
import { buildStructuralGraph } from "../graph/builder.js";
import { addEdge, emptyGraph, stats, upsertNode } from "../graph/model.js";
import { makeDataId } from "../id/hash.js";
import { getEmbedder } from "../embed/model.js";
import { embedNodes, weightEdges, proposeEdges, applyProposals, dedupUndirected } from "../embed/weight.js";
import { tagNodes, DEFAULT_TAXONOMY } from "../embed/tag.js";
import type { CausalGraph, DataId } from "../types.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEEP_MODEL = "claude-opus-4-8";

function llm(model: string) {
  return new ChatAnthropic({ model, temperature: 0 });
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

/** 4) semantic: テキストノードから entity を抽出し mentions エッジを張る (LLM)。 */
export async function semantic(s: AgentStateType): Promise<Partial<AgentStateType>> {
  const g = s.graph!;
  if (s.options.depth === "structural") return { log: ["semantic: skipped"] };
  // ローカル裁定は text ノード間で因果を見るため entity 抽出 (Claude) は不要。
  if (s.options.llm?.provider === "webgpu-gemma") return { log: ["semantic: skipped (local)"] };

  const textNodes = [...g.nodes.values()].filter((n) => n.meta.text);
  const schema = z.object({
    entities: z.array(
      z.object({
        name: z.string().describe("正規化した指標/主体名 (例: 売上, 競合, 原材料費)"),
        sourceId: z.string().describe("根拠ノードの data-id"),
      }),
    ),
  });
  const model = llm(s.options.llm?.model ?? DEFAULT_MODEL).withStructuredOutput(schema);

  const corpus = textNodes
    .map((n) => `[${n.id}] (${n.meta.kind}) ${n.meta.text}`)
    .join("\n")
    .slice(0, 24000); // map-reduce 化は v0.2 で

  const out = await model.invoke(
    `次の Office 文書の断片群から、因果分析に使える指標・主体エンティティを抽出せよ。\n${corpus}`,
  );

  for (const ent of out.entities) {
    const entId = makeDataId("derived", "entity", ent.name);
    upsertNode(g, entId, {
      kind: "entity",
      part: "derived",
      path: "entity",
      label: ent.name,
      provenance: ["semantic"],
    });
    if (g.nodes.has(ent.sourceId as DataId)) {
      addEdge(g, { kind: "mentions", from: ent.sourceId as DataId, to: entId });
    }
  }
  return { graph: g, log: [`semantic: +${out.entities.length} entities`] };
}

/**
 * 5) causal: 因果候補を確定して verify へ渡す (LLM)。
 *
 * 2 モード:
 *  (A) 裁定モード — embed 段が無向候補ペアを出していれば、Claude には
 *      「向き・極性・採否」だけを判定させる (生成させない)。O(n^2) を埋め込みで
 *      高親和ペアに絞り済みなので、トークン/呼び出しを大幅削減 (ADR-0002 D3)。
 *  (B) 生成モード — 埋め込み無効時のフォールバック。Claude が自由仮説。
 */
export async function causal(s: AgentStateType): Promise<Partial<AgentStateType>> {
  const g = s.graph!;
  if (s.options.depth !== "causal") return { log: ["causal: skipped"], candidates: [] };

  const evidence = [...g.nodes.values()]
    .filter((n) => n.meta.text)
    .map((n) => `[${n.id}] ${n.meta.text}`)
    .join("\n")
    .slice(0, 24000);

  const lbl = (id: string) => g.nodes.get(id as DataId)?.meta.label ?? id;
  const txt = (id: string) => g.nodes.get(id as DataId)?.meta.text ?? lbl(id);

  // (A0) ローカル裁定モード: WebGPU/ローカル Gemma 4 が向き・極性を判定 (Claude 不使用)。
  if (s.options.llm?.provider === "webgpu-gemma") {
    if (s.embedCandidates.length === 0) return { candidates: [], log: ["causal[gemma]: no candidates"] };
    const { WebGpuGemmaAdjudicator } = await import("../llm/gemma-webgpu.js");
    const adj = new WebGpuGemmaAdjudicator({
      ...(s.options.llm.localModel ? { model: s.options.llm.localModel } : {}),
      ...(s.options.llm.device ? { device: s.options.llm.device as any } : {}),
    });
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

  // (A) 裁定モード (Claude)
  if (s.embedCandidates.length > 0) {
    const schema = z.object({
      verdicts: z.array(
        z.object({
          a: z.string().describe("候補ペアの a (data-id)"),
          b: z.string().describe("候補ペアの b (data-id)"),
          direction: z.enum(["a->b", "b->a", "none"]).describe("因果の向き。無ければ none"),
          polarity: z.enum(["+", "-", "?"]),
          mechanism: z.string(),
          evidence: z.array(z.object({ nodeId: z.string(), quote: z.string() })),
        }),
      ),
    });
    const model = llm(s.options.llm?.model ?? DEFAULT_MODEL).withStructuredOutput(schema);

    const pairList = s.embedCandidates
      .map((p) => `a=[${p.from}] "${lbl(p.from)}"  ~  b=[${p.to}] "${lbl(p.to)}"  (親和度 ${p.weight.toFixed(2)})`)
      .join("\n");

    const out = await model.invoke(
      `次の候補ペア群は埋め込み類似で一次選別済み。各ペアについて、文書の根拠に基づき\n` +
        `因果の「向き」(a->b / b->a / none) と極性・メカニズムを判定せよ。生成・追加はするな。\n` +
        `根拠が無ければ direction=none とせよ。各因果に evidence(nodeId+quote) を必ず付けよ。\n\n` +
        `## 候補ペア\n${pairList}\n\n## 根拠テキスト\n${evidence}`,
    );

    const candidates: CausalCandidate[] = out.verdicts
      .filter((v) => v.direction !== "none")
      .map((v) => {
        const [from, to] = v.direction === "a->b" ? [v.a, v.b] : [v.b, v.a];
        return { from, to, polarity: v.polarity, mechanism: v.mechanism, evidence: v.evidence };
      })
      .filter((c) => g.nodes.has(c.from as DataId) && g.nodes.has(c.to as DataId));

    return {
      candidates,
      rounds: s.rounds + 1,
      log: [
        `causal[adjudicate]: ${s.embedCandidates.length} pairs → ${candidates.length} directed (round ${s.rounds + 1})`,
      ],
    };
  }

  // (B) 生成モード (フォールバック)
  const entities = [...g.nodes.values()].filter((n) => n.meta.kind === "entity");
  const schema = z.object({
    candidates: z.array(
      z.object({
        from: z.string().describe("原因 entity の data-id"),
        to: z.string().describe("結果 entity の data-id"),
        polarity: z.enum(["+", "-", "?"]),
        mechanism: z.string().describe("因果メカニズムの説明"),
        evidence: z.array(z.object({ nodeId: z.string(), quote: z.string() })),
      }),
    ),
  });
  const model = llm(s.options.llm?.model ?? DEFAULT_MODEL).withStructuredOutput(schema);

  const entList = entities.map((e) => `[${e.id}] ${e.meta.label}`).join("\n");
  const out = await model.invoke(
    `以下のエンティティ間の因果関係 (原因→結果) を、文書の根拠に基づいてのみ仮説せよ。\n` +
      `根拠なき推測は出すな。各候補に evidence(nodeId+quote) を必ず付けよ。\n\n` +
      `## エンティティ\n${entList}\n\n## 根拠テキスト\n${evidence}`,
  );

  const candidates: CausalCandidate[] = out.candidates.filter(
    (c) => g.nodes.has(c.from as DataId) && g.nodes.has(c.to as DataId),
  );
  return {
    candidates,
    rounds: s.rounds + 1,
    log: [`causal[generate]: ${candidates.length} hypotheses (round ${s.rounds + 1})`],
  };
}

/** 6) verify: 各候補を独立 N 票で敵対的に反証し confidence を付与 (LLM)。 */
export async function verify(s: AgentStateType): Promise<Partial<AgentStateType>> {
  const g = s.graph!;
  // 候補が無い (structural 深度等) なら LLM を構築せず即返す → API キー不要を保証。
  if (s.candidates.length === 0) return { graph: g, log: ["verify: skipped"] };

  // verify:false → Claude を使わず候補をそのまま commit (完全ローカル運用)。
  if (s.options.llm?.verify === false) {
    for (const c of s.candidates) {
      addEdge(g, {
        kind: "causes",
        from: c.from as DataId,
        to: c.to as DataId,
        causal: {
          polarity: c.polarity,
          mechanism: c.mechanism,
          confidence: 0.5, // 未検証 (ローカル裁定のみ)
          evidence: c.evidence.map((e) => ({ nodeId: e.nodeId as DataId, quote: e.quote })),
          status: "hypothesis",
        },
      });
    }
    return { graph: g, candidates: [], log: [`verify: committed ${s.candidates.length} (no-Claude)`] };
  }

  const votes = s.options.llm?.verifyVotes ?? 3;
  const model = llm(s.options.llm?.deepModel ?? DEEP_MODEL).withStructuredOutput(
    z.object({
      refuted: z.boolean().describe("根拠が不十分/論理が飛躍していれば true"),
      reason: z.string(),
    }),
  );

  for (const c of s.candidates) {
    let refutes = 0;
    for (let i = 0; i < votes; i++) {
      const v = await model.invoke(
        `次の因果主張を反証せよ。根拠が弱ければ refuted=true を既定とする (vote ${i + 1}).\n` +
          `原因=${label(g, c.from)} → 結果=${label(g, c.to)} (${c.polarity})\n` +
          `メカニズム: ${c.mechanism}\n根拠: ${c.evidence.map((e) => e.quote).join(" / ")}`,
      );
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
