/**
 * 役割② 生成「edge LLM」比較: 因果の向き・極性の裁定。
 *
 * office-casual の causal[裁定モード]＝「埋め込みが絞った無向ペアに、向きと極性を
 * 付ける」タスクを、小型生成モデルで実行して採点する:
 *   - direction 精度 (A->B / B->A / none, 全11件)
 *   - polarity 精度  (+/-, 因果8件)
 *   - JSON 妥当率
 *   - レイテンシ (1件あたり ms)
 *
 * 採点基準(ゴール)・上限は Claude が定義 (eval/gold.ts)。
 * 実行: node --import tsx eval/gen-bench.ts [model1,model2,...]
 */
import { GOLD_EDGES, byId } from "./gold.js";

const DEFAULT_MODELS = [
  "onnx-community/Qwen2.5-0.5B-Instruct",
  "onnx-community/Qwen3-0.6B-ONNX",
  "onnx-community/Llama-3.2-1B-Instruct",
];

const models = (process.argv[2]?.split(",") ?? DEFAULT_MODELS).map((s) => s.trim());

/** テスト項目: 因果8 (gold) + 非因果3 (none)。A/B は提示順、gold は A/B 基準。 */
interface Item {
  a: string;
  b: string;
  goldDir: "A->B" | "B->A" | "none";
  goldPol?: "+" | "-";
}
const ITEMS: Item[] = [
  // 向きバイアスを消すため、偶数番は原文順(A->B)、奇数番は反転提示(B->A)。
  ...GOLD_EDGES.map((e, i) =>
    i % 2 === 0
      ? { a: e.from, b: e.to, goldDir: "A->B" as const, goldPol: e.polarity }
      : { a: e.to, b: e.from, goldDir: "B->A" as const, goldPol: e.polarity },
  ),
  { a: "S1", b: "S6", goldDir: "none" }, // 原材料高騰 と 競合値下げ
  { a: "S2", b: "S7", goldDir: "none" }, // 製造コスト と 自社シェア
  { a: "S1", b: "S7", goldDir: "none" }, // 原材料高騰 と 自社シェア
];

function prompt(a: string, b: string): string {
  return (
    `次の2つの文の因果関係を判定せよ。\n` +
    `A: ${a}\n` +
    `B: ${b}\n\n` +
    `出力は JSON ひとつだけ: {"direction":"A->B"|"B->A"|"none","polarity":"+"|"-"}\n` +
    `direction: A が B の原因なら "A->B"、B が A の原因なら "B->A"、直接の因果が無ければ "none"。\n` +
    `polarity: 原因と結果が同方向の変化なら "+"、逆方向なら "-"。`
  );
}

/** strict: 妥当な JSON が取れたか。lenient: 取れなくても本文から推定。 */
/** 矢印・空白・全角を正規化して向き表記を統一。 */
function normDir(s?: string): string | undefined {
  if (!s) return undefined;
  const n = s.replace(/[→⇒]/g, "->").replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\s+/g, "").toUpperCase();
  if (/A->B/.test(n)) return "A->B";
  if (/B->A/.test(n)) return "B->A";
  if (/NONE|なし|無/.test(n)) return "none";
  return undefined;
}

function parse(text: string): { direction?: string; polarity?: string; jsonOK: boolean } {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const i = cleaned.indexOf("{");
  const j = cleaned.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(cleaned.slice(i, j + 1));
      return { direction: normDir(o.direction), polarity: o.polarity, jsonOK: true };
    } catch {
      /* fall through to lenient */
    }
  }
  // lenient: 本文から direction/polarity を拾う (「判定できるか」を formatting と分離)
  const dir = normDir(cleaned.match(/[AB]\s*(?:->|→|⇒)\s*[AB]|none|なし/i)?.[0]);
  const pol = cleaned.match(/polarity["']?\s*[:=]\s*["']?([+\-])/)?.[1];
  return { direction: dir, polarity: pol, jsonOK: false };
}

function extractText(out: any): string {
  const g = out?.[0]?.generated_text;
  if (typeof g === "string") return g;
  if (Array.isArray(g)) return g[g.length - 1]?.content ?? "";
  return String(g ?? "");
}

async function evalModel(id: string) {
  const specifier = "@huggingface/transformers";
  const t: any = await import(specifier);
  const t0 = Date.now();
  const pipe = await t.pipeline("text-generation", id, { dtype: "q4" });
  const loadMs = Date.now() - t0;

  let dirOK = 0;
  let polOK = 0;
  let polTotal = 0;
  let jsonOK = 0;
  let totalMs = 0;

  // Qwen3 は thinking を切る (/no_think)。
  const noThink = /qwen3/i.test(id);

  for (const it of ITEMS) {
    const A = byId.get(it.a)!.text;
    const B = byId.get(it.b)!.text;
    const content = prompt(A, B) + (noThink ? "\n/no_think" : "");
    const c0 = Date.now();
    const out = await pipe([{ role: "user", content }], {
      max_new_tokens: 256,
      do_sample: false,
    });
    totalMs += Date.now() - c0;
    const { direction, polarity, jsonOK: ok } = parse(extractText(out));
    if (ok) jsonOK++;
    if (direction === it.goldDir) dirOK++;
    if (it.goldPol) {
      polTotal++;
      if (polarity === it.goldPol) polOK++;
    }
  }

  return {
    model: id.split("/").pop(),
    dirAcc: +(dirOK / ITEMS.length).toFixed(3),
    polAcc: +(polOK / polTotal).toFixed(3),
    jsonRate: +(jsonOK / ITEMS.length).toFixed(3),
    msPerItem: Math.round(totalMs / ITEMS.length),
    loadMs,
  };
}

const rows: any[] = [];
for (const id of models) {
  try {
    console.error(`▶ ${id} ...`);
    rows.push(await evalModel(id));
  } catch (e) {
    console.error(`  ✗ skip (${(e as Error).message.slice(0, 100)})`);
    rows.push({ model: id, status: "FAILED" });
  }
}

console.log("\n=== 役割② 生成 edge-LLM 比較 (裁定: 向き11件 / 極性8件) ===");
console.table(rows);
