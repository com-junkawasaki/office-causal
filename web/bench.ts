/**
 * 実機ブラウザ・ベンチ: Gemma 4 E2B vs E4B を WebGPU で計測。
 *   - loadMs (DL+初期化), ms/item, tokens/sec, dir精度, pol精度, JSON率
 * eval/gold.ts と同じ裁定タスク (8因果 + 3非因果) をブラウザで実走。
 * 結果は端末・ブラウザ・WebGPU 実装に依存するため、各自の環境で測る前提。
 */
// @ts-ignore importmap で解決 (CDN ESM)。型は不完全なため any 経由で使う。
import * as T from "@huggingface/transformers";
const AutoProcessor: any = (T as any).AutoProcessor;
const Gemma4ForConditionalGeneration: any = (T as any).Gemma4ForConditionalGeneration;
const TextStreamer: any = (T as any).TextStreamer;

const $ = (id: string) => document.getElementById(id)!;
const log = (m: string) => { ($("log") as HTMLPreElement).textContent += m + "\n"; ($("log") as HTMLPreElement).scrollTop = 1e9; };
let GPU = false;
async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    GPU = !!(gpu && (await gpu.requestAdapter()));
  } catch {
    GPU = false;
  }
  return GPU;
}
function showBanner() {
  const el = $("banner");
  if (!el) return;
  el.hidden = false;
  if (GPU) {
    el.className = "banner ok";
    el.innerHTML = "✅ <b>WebGPU 有効</b> — このベンチは GPU で実行されます。";
  } else {
    el.className = "banner";
    el.innerHTML =
      "⚠ <b>WebGPU が無効です。</b>WASM(CPU) では Gemma 4 が極端に低速で、ベンチは現実的な時間で終わりません。" +
      "<b>Chrome / Edge（WebGPU 有効）</b>で開いてください。";
  }
}

// --- gold (eval/gold.ts のミラー) ---
const S: Record<string, string> = {
  S1: "原材料価格が世界的に高騰した。",
  S2: "自社の製造コストが大幅に上昇した。",
  S3: "採算確保のため製品の販売価格を引き上げた。",
  S4: "値上げの影響で販売数量が落ち込んだ。",
  S5: "売上高は前年同期を下回った。",
  S6: "競合他社が大規模な値下げキャンペーンを実施した。",
  S7: "当社の市場シェアが低下した。",
  S8: "四半期の営業利益は前年から悪化した。",
};
const GOLD: [string, string, "+" | "-"][] = [
  ["S1", "S2", "+"], ["S2", "S3", "+"], ["S3", "S4", "-"], ["S4", "S5", "+"],
  ["S5", "S8", "+"], ["S6", "S7", "-"], ["S7", "S5", "+"], ["S2", "S8", "-"],
];
interface Item { a: string; b: string; dir: "A->B" | "B->A" | "none"; pol?: "+" | "-"; }
const ITEMS: Item[] = [
  ...GOLD.map(([f, t, p], i): Item =>
    i % 2 === 0 ? { a: f, b: t, dir: "A->B", pol: p } : { a: t, b: f, dir: "B->A", pol: p }),
  { a: "S1", b: "S6", dir: "none" }, { a: "S2", b: "S7", dir: "none" }, { a: "S1", b: "S7", dir: "none" },
];

function prompt(a: string, b: string): string {
  return `次の2つの文の因果関係を判定せよ。\nA: ${a}\nB: ${b}\n\n` +
    `出力は JSON ひとつだけ: {"direction":"A->B"|"B->A"|"none","polarity":"+"|"-"}\n` +
    `direction: A が B の原因なら "A->B"、B が A の原因なら "B->A"、因果が無ければ "none"。\n` +
    `polarity: 同方向の変化なら "+"、逆方向なら "-"。`;
}
function normDir(s?: string) {
  if (!s) return undefined;
  const n = s.replace(/[→⇒]/g, "->").replace(/\s+/g, "").toUpperCase();
  return /A->B/.test(n) ? "A->B" : /B->A/.test(n) ? "B->A" : /NONE|なし/.test(n) ? "none" : undefined;
}
function parse(text: string) {
  const c = text.replace(/```json/gi, "").replace(/```/g, "");
  const i = c.indexOf("{"), j = c.lastIndexOf("}");
  if (i >= 0 && j > i) { try { const o = JSON.parse(c.slice(i, j + 1)); return { dir: normDir(o.direction), pol: o.polarity, json: true }; } catch {} }
  return { dir: normDir(c.match(/[AB]\s*(?:->|→)\s*[AB]|none/i)?.[0]), pol: c.match(/[+\-]/)?.[0], json: false };
}

async function benchModel(modelId: string) {
  const dev: "webgpu" | "wasm" = GPU ? "webgpu" : "wasm";
  log(`▶ ${modelId} : ロード中 (${dev}, q4f16) …`);
  const t0 = performance.now();
  const processor = await AutoProcessor.from_pretrained(modelId);
  const model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
    dtype: "q4f16", device: dev,
    progress_callback: (i: any) => { if (i?.status === "progress" && i?.file && (i.progress ?? 0) % 25 < 1.2) log(`  ${i.file} ${Math.round(i.progress)}%`); },
  });
  const loadMs = Math.round(performance.now() - t0);
  log(`  ロード完了 ${loadMs}ms`);

  let dirOK = 0, polOK = 0, polTot = 0, jsonOK = 0, totalMs = 0, totalTok = 0;
  for (const it of ITEMS) {
    let toks = 0;
    const streamer = new TextStreamer(processor.tokenizer, {
      skip_prompt: true, skip_special_tokens: true,
      token_callback_function: (ids: any) => { toks += ids?.length ?? 1; },
    });
    const messages = [{ role: "user", content: [{ type: "text", text: prompt(S[it.a]!, S[it.b]!) }] }];
    const inputs = processor.apply_chat_template(messages, { enable_thinking: false, add_generation_prompt: true, tokenize: true, return_dict: true });
    const c0 = performance.now();
    const out = await model.generate({ ...inputs, max_new_tokens: 96, do_sample: false, streamer });
    totalMs += performance.now() - c0;
    totalTok += toks;
    const decoded = processor.batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true });
    const { dir, pol, json } = parse(decoded[0] ?? "");
    if (json) jsonOK++;
    if (dir === it.dir) dirOK++;
    if (it.pol) { polTot++; if (pol === it.pol) polOK++; }
  }
  return {
    model: modelId.split("/").pop(), loadMs,
    dirAcc: +(dirOK / ITEMS.length).toFixed(3), polAcc: +(polOK / polTot).toFixed(3), jsonRate: +(jsonOK / ITEMS.length).toFixed(3),
    msPerItem: Math.round(totalMs / ITEMS.length), tokPerSec: +(totalTok / (totalMs / 1000)).toFixed(1),
  };
}

async function run() {
  ($("log") as HTMLPreElement).textContent = "";
  ($("table") as HTMLElement).innerHTML = "";
  await detectWebGPU();
  showBanner();
  if (!GPU) log("⚠ WebGPU 無効 → wasm (非常に低速)。Chrome/Edge 推奨。");
  const models = [...document.querySelectorAll<HTMLInputElement>("input[name=m]:checked")].map((c) => c.value);
  if (!models.length) return log("モデルを1つ以上選択してください。");

  const rows: any[] = [];
  for (const m of models) {
    try { rows.push(await benchModel(m)); } catch (e: any) { log(`  ✗ ${e?.message ?? e}`); rows.push({ model: m, error: true }); }
  }

  const cols = ["model", "loadMs", "msPerItem", "tokPerSec", "dirAcc", "polAcc", "jsonRate"];
  let html = "<table border=1 cellpadding=6 style='border-collapse:collapse'><tr>" + cols.map((c) => `<th>${c}</th>`).join("") + "</tr>";
  for (const r of rows) html += "<tr>" + cols.map((c) => `<td>${r.error && c !== "model" ? "—" : r[c] ?? ""}</td>`).join("") + "</tr>";
  $("table").innerHTML = html + "</table>";
  log("完了。");
}

($("runBtn") as HTMLButtonElement).addEventListener("click", () => run().catch((e) => log("ERROR: " + (e?.message ?? e))));
detectWebGPU().then(() => {
  showBanner();
  log(GPU ? "WebGPU 利用可。モデルを選んで Run。" : "⚠ WebGPU 非対応 (wasm)。ベンチは現実的時間で終わりません。");
});
