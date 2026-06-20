/**
 * 役割① 埋め込みモデル比較。
 *
 * office-casual の embed→causal ハンドオフ＝「真の因果隣接ペアを高 affinity で
 * surface できるか」を、候補選別の検索問題として評価する:
 *   - ROC-AUC / AP (28 ペア中 8 正例)
 *   - precision@8 / recall@8
 *   - タグづけ正答率 (data-id タグ)
 *   - レイテンシ
 *
 * 実行: node --import tsx eval/embed-bench.ts
 */
import { TransformersEmbedder, cosine } from "../src/embed/model.js";
import { SENTENCES, TAXONOMY, allPairs, goldUndirectedKeys, undirectedKey, byId } from "./gold.js";

interface ModelCfg {
  id: string;
  /** e5 系は "query: " プレフィックス推奨。 */
  prefix?: string;
  note?: string;
}

const MODELS: ModelCfg[] = [
  { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", note: "現行 (118M)" },
  { id: "Xenova/multilingual-e5-small", prefix: "query: ", note: "118M" },
  { id: "Xenova/multilingual-e5-base", prefix: "query: ", note: "278M" },
  { id: "Xenova/bge-m3", note: "568M" },
  { id: "onnx-community/Qwen3-Embedding-0.6B-ONNX", note: "0.6B (mean-pool 近似)" },
];

function rocAuc(scored: { score: number; pos: boolean }[]): number {
  const pos = scored.filter((s) => s.pos).map((s) => s.score);
  const neg = scored.filter((s) => !s.pos).map((s) => s.score);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function averagePrecision(ranked: boolean[]): number {
  let hits = 0;
  let sum = 0;
  ranked.forEach((isPos, i) => {
    if (isPos) {
      hits++;
      sum += hits / (i + 1);
    }
  });
  const total = ranked.filter(Boolean).length;
  return total ? sum / total : 0;
}

async function evalModel(cfg: ModelCfg) {
  const t0 = Date.now();
  const emb = new TransformersEmbedder(cfg.id);
  const pre = (t: string) => (cfg.prefix ?? "") + t;

  const sentVecs = await emb.embed(SENTENCES.map((s) => pre(s.text)));
  const vmap = new Map(SENTENCES.map((s, i) => [s.id, sentVecs[i]!]));
  const loadMs = Date.now() - t0;

  // --- ペア affinity ---
  const gold = goldUndirectedKeys();
  const scored = allPairs().map(({ a, b }) => ({
    a,
    b,
    score: cosine(vmap.get(a)!, vmap.get(b)!),
    pos: gold.has(undirectedKey(a, b)),
  }));
  const ranked = [...scored].sort((x, y) => y.score - x.score);
  const auc = rocAuc(scored);
  const ap = averagePrecision(ranked.map((r) => r.pos));
  const top8 = ranked.slice(0, 8);
  const p8 = top8.filter((r) => r.pos).length / 8;
  const r8 = top8.filter((r) => r.pos).length / gold.size;

  // --- タグづけ ---
  const taxVecs = await emb.embed(TAXONOMY.map(pre));
  let correct = 0;
  for (const s of SENTENCES) {
    const v = vmap.get(s.id)!;
    let best = -1;
    let bestTag = "";
    TAXONOMY.forEach((tag, i) => {
      const c = cosine(v, taxVecs[i]!);
      if (c > best) {
        best = c;
        bestTag = tag;
      }
    });
    if (bestTag === byId.get(s.id)!.tag) correct++;
  }
  const tagAcc = correct / SENTENCES.length;

  return {
    model: cfg.id,
    note: cfg.note ?? "",
    dim: emb.dim,
    auc: +auc.toFixed(3),
    ap: +ap.toFixed(3),
    p8: +p8.toFixed(3),
    r8: +r8.toFixed(3),
    tagAcc: +tagAcc.toFixed(3),
    loadMs,
  };
}

const rows: any[] = [];
for (const cfg of MODELS) {
  try {
    console.error(`▶ ${cfg.id} ...`);
    rows.push(await evalModel(cfg));
  } catch (e) {
    console.error(`  ✗ skip (${(e as Error).message.slice(0, 80)})`);
    rows.push({ model: cfg.id, note: cfg.note, error: true });
  }
}

console.log("\n=== 役割① 埋め込みモデル比較 (28ペア中8正例 / タグ8件) ===");
console.table(
  rows.map((r) =>
    r.error
      ? { model: r.model, note: r.note, status: "LOAD FAILED" }
      : {
          model: r.model.split("/").pop(),
          note: r.note,
          dim: r.dim,
          AUC: r.auc,
          AP: r.ap,
          "P@8": r.p8,
          "R@8": r.r8,
          tagAcc: r.tagAcc,
          loadMs: r.loadMs,
        },
  ),
);
