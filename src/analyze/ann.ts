/**
 * 近傍探索 (LSH / SimHash) — 大規模 NL ノードの高類似ペアを O(n²) を避けて抽出する。
 *
 * 表記揺れ(同概念)は cosine が非常に高い(≥0.9)ので、ランダム超平面 LSH の同一バケットに
 * 高確率で入る。複数バンドで recall を上げ、候補のみ厳密 cosine で検証する。
 * 乱数は決定論シード (mulberry32) で再現性を担保。
 */
import { cosine } from "../embed/model.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LshOptions {
  bands?: number; // テーブル数 (recall)。既定 8
  bits?: number; // 1 テーブルの署名ビット数。既定 14
  seed?: number;
}

/** 同一バケットに入った候補ペア (index) を返す。 */
export function lshCandidatePairs(vecs: Float32Array[], opts: LshOptions = {}): Array<[number, number]> {
  const n = vecs.length;
  if (n < 2) return [];
  const bands = opts.bands ?? 8;
  const bits = opts.bits ?? 14;
  const dim = vecs[0]!.length;
  const rng = mulberry32(opts.seed ?? 1);
  // bands*bits 本のランダム超平面
  const planes: Float32Array[] = [];
  for (let p = 0; p < bands * bits; p++) {
    const h = new Float32Array(dim);
    for (let d = 0; d < dim; d++) h[d] = rng() * 2 - 1;
    planes.push(h);
  }
  const pairs = new Set<string>();
  for (let b = 0; b < bands; b++) {
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      let sig = "";
      for (let k = 0; k < bits; k++) {
        const h = planes[b * bits + k]!;
        let dot = 0;
        const v = vecs[i]!;
        for (let d = 0; d < dim; d++) dot += v[d]! * h[d]!;
        sig += dot >= 0 ? "1" : "0";
      }
      (buckets.get(sig) ?? buckets.set(sig, []).get(sig)!).push(i);
    }
    for (const ids of buckets.values()) {
      if (ids.length < 2 || ids.length > 200) continue; // 巨大バケットは無情報なのでスキップ
      for (let x = 0; x < ids.length; x++)
        for (let y = x + 1; y < ids.length; y++) pairs.add(`${ids[x]}_${ids[y]}`);
    }
  }
  return [...pairs].map((s) => s.split("_").map(Number) as [number, number]);
}

/** Union-Find (候補ペア → グループ)。 */
export function unionGroups(n: number, pairs: Array<[number, number]>): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (const [a, b] of pairs) parent[find(a)] = find(b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** 高類似ペア (cosine≥threshold)。小規模は厳密 all-pairs、大規模は LSH。 */
export function similarPairs(
  vecs: Float32Array[],
  threshold: number,
  exactLimit = 1500,
): Array<[number, number]> {
  const n = vecs.length;
  const out: Array<[number, number]> = [];
  if (n <= exactLimit) {
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (cosine(vecs[i]!, vecs[j]!) >= threshold) out.push([i, j]);
    return out;
  }
  for (const [i, j] of lshCandidatePairs(vecs)) if (cosine(vecs[i]!, vecs[j]!) >= threshold) out.push([i, j]);
  return out;
}
