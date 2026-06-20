/**
 * ローカル小型モデルによる埋め込み (transformers.js)。
 *
 * - `TransformersEmbedder`: `@huggingface/transformers` の feature-extraction
 *   パイプライン (既定 Xenova/paraphrase-multilingual-MiniLM-L12-v2, 量子化) を動的 import で遅延ロード。
 *   API キー不要・オフライン (初回はモデル DL) で動く「小さい LLM」。
 * - `HashEmbedder`: モデルが無い/DL 失敗時の決定論フォールバック。文字 trigram を
 *   固定次元へハッシュ。CI やオフラインでもパイプラインを止めない。
 *
 * `getEmbedder()` は transformers を試し、失敗したら自動でハッシュに落ちる。
 */

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

/** 決定論ハッシュ埋め込み (オフライン安全フォールバック)。 */
export class HashEmbedder implements Embedder {
  readonly name = "hash-trigram";
  constructor(readonly dim = 256) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const s = ` ${text.toLowerCase()} `;
    for (let i = 0; i < s.length - 2; i++) {
      const tri = s.slice(i, i + 3);
      let h = 2166136261;
      for (let j = 0; j < tri.length; j++) {
        h = (h ^ tri.charCodeAt(j)) >>> 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
      const idx = h % this.dim;
      v[idx] = v[idx]! + 1;
    }
    return l2normalize(v);
  }
}

/** 実行デバイス。"webgpu" はブラウザ (Chrome/Edge) で GPU 実行。 */
export type Device = "webgpu" | "wasm" | "cpu" | "auto";

/** transformers.js (ONNX) ローカル埋め込み。Node でも WebGPU ブラウザでも動く。 */
export class TransformersEmbedder implements Embedder {
  readonly name: string;
  dim = 384; // MiniLM-L6 既定。初回 embed で実次元に補正。
  private pipe: ((texts: string[], opts: unknown) => Promise<{ tolist(): number[][] }>) | null = null;

  constructor(
    readonly model = "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    private readonly device: Device = "auto",
    /** WebGPU では "q4f16" 推奨。Node/wasm では "q8"。 */
    private readonly dtype?: string,
  ) {
    this.name = model;
  }

  private resolveDevice(): Exclude<Device, "auto"> {
    if (this.device !== "auto") return this.device;
    // WebGPU が使えれば webgpu。無ければブラウザは wasm、Node は cpu (v4 は node で wasm 不可)。
    const g = globalThis as { navigator?: { gpu?: unknown }; window?: unknown };
    if (g.navigator?.gpu) return "webgpu";
    return g.window !== undefined ? "wasm" : "cpu";
  }

  private async ensure() {
    if (this.pipe) return;
    // 動的 import: optionalDependency。specifier を変数化して型解決を回避
    // (未インストール環境でも tsc が通る)。実行時に未導入なら呼び出し側が catch。
    const specifier = "@huggingface/transformers";
    const t: any = await import(specifier);
    const device = this.resolveDevice();
    const dtype = this.dtype ?? (device === "webgpu" ? "q4f16" : "q8");
    const p = await t.pipeline("feature-extraction", this.model, { dtype, device });
    this.pipe = (texts, opts) => p(texts, opts);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ensure();
    const out = await this.pipe!(texts, { pooling: "mean", normalize: true });
    const rows = out.tolist();
    this.dim = rows[0]?.length ?? this.dim;
    return rows.map((r) => l2normalize(Float32Array.from(r)));
  }
}

/** transformers を試し、失敗時はハッシュへフォールバック。 */
export async function getEmbedder(
  model = "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
): Promise<{ embedder: Embedder; fallback: boolean }> {
  const tf = new TransformersEmbedder(model);
  try {
    await tf.embed(["__probe__"]); // ロード可否を確認
    return { embedder: tf, fallback: false };
  } catch {
    return { embedder: new HashEmbedder(), fallback: true };
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot; // 正規化済みなので内積 = コサイン
}
