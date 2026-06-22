/**
 * LangGraph.js の共有 state 定義 (Annotation.Root)。
 * 各ノードは部分更新を返し、reducer がマージする。
 */
import { Annotation } from "@langchain/langgraph";
import type { CausalGraph, AnalyzeOptions } from "../types.js";
import type { OpcPackage } from "../ooxml/opc.js";

/** verify 前の因果候補。 */
export interface CausalCandidate {
  from: string; // DataId
  to: string; // DataId
  polarity: "+" | "-" | "?";
  mechanism: string;
  evidence: { nodeId: string; quote: string }[];
}

export const AgentState = Annotation.Root({
  /** 入力ファイル群の生バイト。 */
  files: Annotation<{ path: string; bytes: Uint8Array }[]>(),
  options: Annotation<AnalyzeOptions>(),

  pkgs: Annotation<OpcPackage[]>({
    reducer: (a, b) => b ?? a,
    default: () => [],
  }),
  /** 構築中のグラフ (各段が追記)。 */
  graph: Annotation<CausalGraph | null>({
    reducer: (a, b) => b ?? a,
    default: () => null,
  }),
  /**
   * embed 段が出す「無向の」候補ペア (埋め込み類似で一次選別済み)。
   * causal 段はこれをローカル Gemma 4 に渡し、向き・極性・採否を裁定させる (生成しない)。
   */
  embedCandidates: Annotation<{ from: string; to: string; weight: number }[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  /** causal 段が出し、verify 段が削る候補。 */
  candidates: Annotation<CausalCandidate[]>({
    reducer: (_a, b) => b, // 段ごとに置換
    default: () => [],
  }),
  /** ループ制御 (未検証候補が残る限り causal→verify を回す)。 */
  rounds: Annotation<number>({
    reducer: (_a, b) => b,
    default: () => 0,
  }),
  log: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type AgentStateType = typeof AgentState.State;
