/**
 * MECE 評価: ある結果に対する原因群が
 *  - ME (相互排他): 重複/被りが無いか → 原因ラベルの埋め込み高類似ペア = 重複違反
 *  - CE (網羅的):   漏れが無いか → Gemma が「この結果の要因として網羅的か/欠けは何か」を判定
 * 構造（原因群の抽出）は決定論 O(edges)。重複は埋め込み、網羅性のみ Gemma。
 */
import type { CausalGraph, DataId } from "../types.js";
import { cosine, type Embedder } from "../embed/model.js";

export interface MeceJudge {
  judgeExhaustive(effect: string, factors: string[]): Promise<{ exhaustive: boolean; missing?: string[] }>;
}

export interface MeceResult {
  effects: {
    effect: string;
    factors: string[];
    overlaps: [string, string][]; // ME 違反 (重複の疑い)
    exhaustive?: boolean; // CE
    missing?: string[]; // 欠けている要因
  }[];
}

export interface MeceOptions {
  /** 原因どうしの重複(ME違反)とみなすコサイン下限 (既定 0.85)。 */
  overlapThreshold?: number;
  gemma?: MeceJudge;
}

export async function mece(g: CausalGraph, embedder?: Embedder, opts: MeceOptions = {}): Promise<MeceResult> {
  const lbl = (id: string) => g.nodes.get(id as DataId)?.meta.label ?? g.nodes.get(id as DataId)?.meta.text ?? id;
  const ot = opts.overlapThreshold ?? 0.85;

  // 結果 → 原因群
  const byEffect = new Map<string, string[]>();
  for (const e of g.edges) if (e.kind === "causes") (byEffect.get(e.to) ?? byEffect.set(e.to, []).get(e.to)!).push(e.from);

  const effects: MeceResult["effects"] = [];
  for (const [effId, causeIds] of byEffect) {
    if (causeIds.length < 2) continue; // MECE 評価は 2 要因以上
    const factors = causeIds.map(lbl);

    // ME: 原因ラベルの埋め込み高類似 = 重複
    const overlaps: [string, string][] = [];
    if (embedder) {
      const vecs = await embedder.embed(factors);
      for (let i = 0; i < factors.length; i++)
        for (let j = i + 1; j < factors.length; j++)
          if (cosine(vecs[i]!, vecs[j]!) >= ot) overlaps.push([factors[i]!, factors[j]!]);
    }

    // CE: Gemma が網羅性 + 欠落を判定
    let exhaustive: boolean | undefined;
    let missing: string[] | undefined;
    if (opts.gemma) {
      const r = await opts.gemma.judgeExhaustive(lbl(effId), factors);
      exhaustive = r.exhaustive;
      if (r.missing?.length) missing = r.missing;
    }

    effects.push({
      effect: lbl(effId), factors, overlaps,
      ...(exhaustive !== undefined ? { exhaustive } : {}),
      ...(missing ? { missing } : {}),
    });
  }
  return { effects };
}
