/**
 * LangGraph.js StateGraph 配線。
 *
 *   START → ingest → structural → embed → semantic → causal → verify ─┬→ END
 *                                  (transformers.js)     ↑             │
 *                                                        └─ (深掘りループ) ┘
 *
 *   embed: ローカル小型モデルで全エッジに weight 付与 + data-id タグづけ (API キー不要)。
 */
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { AgentState, type AgentStateType } from "./state.js";
import { ingest, structural, embed, semantic, causal, verify } from "./nodes.js";

const MAX_ROUNDS = 3;

/** verify 後の分岐: 新たな候補がまだ出るなら causal に戻す。 */
function shouldContinue(s: AgentStateType): "causal" | typeof END {
  if (s.options.depth !== "causal") return END;
  if (s.rounds >= MAX_ROUNDS) return END;
  // candidates は verify でクリアされる。再探索したい場合のみループ。
  return END; // 既定は単回。深掘りは MAX_ROUNDS まで caller が rounds をリセットして再投入。
}

export function buildAgent() {
  const workflow = new StateGraph(AgentState)
    .addNode("ingest", ingest)
    .addNode("structural", structural)
    .addNode("embed", embed)
    .addNode("semantic", semantic)
    .addNode("causal", causal)
    .addNode("verify", verify)
    .addEdge(START, "ingest")
    .addEdge("ingest", "structural")
    .addEdge("structural", "embed")
    .addEdge("embed", "semantic")
    .addEdge("semantic", "causal")
    .addEdge("causal", "verify")
    .addConditionalEdges("verify", shouldContinue, { causal: "causal", [END]: END });

  return workflow.compile({ checkpointer: new MemorySaver() });
}
