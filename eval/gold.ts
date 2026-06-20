/**
 * office-casual edge-LLM 評価用ゴールデータセット (Claude 作成)。
 *
 * 日本語の業務文 8 件で小さな因果グラフを構成。office-casual の実タスクに対応:
 *  - 役割① 埋め込み: 「真の因果隣接ペアを高 affinity で surface できるか」(候補選別)
 *                    + 「data-id タグづけの正答」
 *  - 役割② 生成裁定: 「無向ペアに正しい向き・極性を付けられるか」
 *
 * ゴールは人手 (Claude) 定義。透明性のためここに固定する。
 */

export interface Sentence {
  id: string;
  text: string;
  /** ゴールタグ (taxonomy のいずれか)。 */
  tag: string;
}

export const TAXONOMY = [
  "売上・収益",
  "コスト・費用",
  "利益",
  "市場・競合",
  "価格・施策",
  "数量・需要",
];

export const SENTENCES: Sentence[] = [
  { id: "S1", text: "原材料価格が世界的に高騰した。", tag: "コスト・費用" },
  { id: "S2", text: "自社の製造コストが大幅に上昇した。", tag: "コスト・費用" },
  { id: "S3", text: "採算確保のため製品の販売価格を引き上げた。", tag: "価格・施策" },
  { id: "S4", text: "値上げの影響で販売数量が落ち込んだ。", tag: "数量・需要" },
  { id: "S5", text: "売上高は前年同期を下回った。", tag: "売上・収益" },
  { id: "S6", text: "競合他社が大規模な値下げキャンペーンを実施した。", tag: "市場・競合" },
  { id: "S7", text: "当社の市場シェアが低下した。", tag: "市場・競合" },
  { id: "S8", text: "四半期の営業利益は前年から悪化した。", tag: "利益" },
];

/**
 * ゴール因果エッジ (有向)。polarity: 同方向の変化なら "+", 逆方向なら "-"。
 *   例 S3(値上げ↑) → S4(数量↓) は逆方向なので "-"。
 */
export interface GoldEdge {
  from: string;
  to: string;
  polarity: "+" | "-";
}

export const GOLD_EDGES: GoldEdge[] = [
  { from: "S1", to: "S2", polarity: "+" }, // 原材料↑ → 製造コスト↑
  { from: "S2", to: "S3", polarity: "+" }, // コスト↑ → 値上げ
  { from: "S3", to: "S4", polarity: "-" }, // 値上げ↑ → 数量↓
  { from: "S4", to: "S5", polarity: "+" }, // 数量↓ → 売上↓ (同方向)
  { from: "S5", to: "S8", polarity: "+" }, // 売上↓ → 利益↓ (同方向)
  { from: "S6", to: "S7", polarity: "-" }, // 競合値下げ↑ → 自社シェア↓
  { from: "S7", to: "S5", polarity: "+" }, // シェア↓ → 売上↓ (同方向)
  { from: "S2", to: "S8", polarity: "-" }, // コスト↑ → 利益↓
];

/** 無向のゴールペア集合 (埋め込み候補選別の正解 = causal 隣接)。 */
export function goldUndirectedKeys(): Set<string> {
  const s = new Set<string>();
  for (const e of GOLD_EDGES) s.add(undirectedKey(e.from, e.to));
  return s;
}

export function undirectedKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 全 C(8,2)=28 無向ペア。 */
export function allPairs(): { a: string; b: string }[] {
  const out: { a: string; b: string }[] = [];
  for (let i = 0; i < SENTENCES.length; i++)
    for (let j = i + 1; j < SENTENCES.length; j++)
      out.push({ a: SENTENCES[i]!.id, b: SENTENCES[j]!.id });
  return out;
}

export const byId = new Map(SENTENCES.map((s) => [s.id, s]));
