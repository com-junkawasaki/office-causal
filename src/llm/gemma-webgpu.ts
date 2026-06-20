/**
 * WebGPU 上で Gemma 4 (E2B/E4B) を動かす因果裁定アダプタ。
 *
 * transformers.js **v4** + WebGPU (Chrome/Edge) で、API キー無し・データ非送信のまま
 * 「埋め込みが絞った候補ペア」に因果の向き・極性・メカニズムを付ける (役割②)。
 * Ollama を介さず純ブラウザで動く版 (eval/RESULTS.md の Ollama 実測と同タスク)。
 *
 * API は公式モデルカード (onnx-community/gemma-4-E2B-it-ONNX) の transformers.js
 * サンプルに準拠: AutoProcessor + Gemma4ForConditionalGeneration, dtype "q4f16",
 * device "webgpu", apply_chat_template({ enable_thinking:false })。
 *
 * 注: WebGPU はブラウザ専用。Node からは device:"wasm" で代替可 (低速)。
 */

export type Device = "webgpu" | "wasm" | "cpu";

export interface GemmaOptions {
  /** 既定: onnx-community/gemma-4-E2B-it-ONNX。E4B も可。 */
  model?: string;
  dtype?: string; // 既定 "q4f16"
  device?: Device; // 既定 "webgpu"
  maxNewTokens?: number; // 既定 256
  /** モデル DL 進捗 (UI 表示用)。 */
  onProgress?: (info: unknown) => void;
}

export interface PairInput {
  from: string; // DataId
  to: string; // DataId
  fromText: string;
  toText: string;
  weight: number;
}

/** direction==="none" の候補は結果から除外される。 */
export interface DirectedVerdict {
  from: string;
  to: string;
  polarity: "+" | "-" | "?";
  mechanism: string;
}

const DEFAULT_MODEL = "onnx-community/gemma-4-E2B-it-ONNX";

function buildPrompt(a: string, b: string): string {
  return (
    `次の2つの文の因果関係を判定せよ。\n` +
    `A: ${a}\n` +
    `B: ${b}\n\n` +
    `出力は JSON ひとつだけ: {"direction":"A->B"|"B->A"|"none","polarity":"+"|"-","mechanism":"..."}\n` +
    `direction: A が B の原因なら "A->B"、B が A の原因なら "B->A"、直接の因果が無ければ "none"。\n` +
    `polarity: 原因と結果が同方向の変化なら "+"、逆方向なら "-"。\n` +
    `mechanism: 因果の根拠を一文で。`
  );
}

function normDir(s?: string): "A->B" | "B->A" | "none" | undefined {
  if (!s) return undefined;
  const n = s.replace(/[→⇒]/g, "->").replace(/\s+/g, "").toUpperCase();
  if (/A->B/.test(n)) return "A->B";
  if (/B->A/.test(n)) return "B->A";
  if (/NONE|なし|無/.test(n)) return "none";
  return undefined;
}

function parse(text: string): {
  direction?: string | undefined;
  polarity?: string | undefined;
  mechanism?: string | undefined;
} {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const i = cleaned.indexOf("{");
  const j = cleaned.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(cleaned.slice(i, j + 1));
      return { direction: normDir(o.direction), polarity: o.polarity, mechanism: o.mechanism };
    } catch {
      /* lenient */
    }
  }
  return { direction: normDir(cleaned.match(/[AB]\s*(?:->|→)\s*[AB]|none/i)?.[0]) };
}

export class WebGpuGemmaAdjudicator {
  private model: any = null;
  private processor: any = null;
  readonly modelId: string;

  constructor(private readonly opts: GemmaOptions = {}) {
    this.modelId = opts.model ?? DEFAULT_MODEL;
  }

  /** モデル/プロセッサをロード (初回のみ DL)。 */
  async load(): Promise<void> {
    if (this.model) return;
    const specifier = "@huggingface/transformers";
    const t: any = await import(specifier);
    this.processor = await t.AutoProcessor.from_pretrained(this.modelId);
    this.model = await t.Gemma4ForConditionalGeneration.from_pretrained(this.modelId, {
      dtype: this.opts.dtype ?? "q4f16",
      device: this.opts.device ?? "webgpu",
      progress_callback: this.opts.onProgress,
    });
  }

  /** 1 ペアを裁定 (テキストのみ)。 */
  async judgeOne(
    aText: string,
    bText: string,
  ): Promise<{ direction?: string | undefined; polarity?: string | undefined; mechanism?: string | undefined }> {
    await this.load();
    const messages = [{ role: "user", content: [{ type: "text", text: buildPrompt(aText, bText) }] }];
    const inputs = this.processor.apply_chat_template(messages, {
      enable_thinking: false,
      add_generation_prompt: true,
      tokenize: true,
      return_dict: true,
    });
    const outputs = await this.model.generate({
      ...inputs,
      max_new_tokens: this.opts.maxNewTokens ?? 256,
      do_sample: false,
    });
    const decoded: string[] = this.processor.batch_decode(
      outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
      { skip_special_tokens: true },
    );
    return parse(decoded[0] ?? "");
  }

  /** 候補ペア群を裁定し、向きを確定した DirectedVerdict を返す (none は除外)。 */
  async judge(pairs: PairInput[]): Promise<DirectedVerdict[]> {
    const out: DirectedVerdict[] = [];
    for (const p of pairs) {
      const v = await this.judgeOne(p.fromText, p.toText);
      const dir = normDir(v.direction);
      if (!dir || dir === "none") continue;
      const [from, to] = dir === "A->B" ? [p.from, p.to] : [p.to, p.from];
      out.push({
        from,
        to,
        polarity: (v.polarity as DirectedVerdict["polarity"]) ?? "?",
        mechanism: v.mechanism ?? "",
      });
    }
    return out;
  }
}
