/**
 * 役割② 裁定タスクの共有定義 (gen-bench / ollama-bench で共用)。
 */
import { GOLD_EDGES, byId } from "./gold.js";

export interface Item {
  a: string;
  b: string;
  goldDir: "A->B" | "B->A" | "none";
  goldPol?: "+" | "-";
}

/** 因果8 (向きバイアス除去のため偶奇で反転提示) + 非因果3。 */
export const ITEMS: Item[] = [
  ...GOLD_EDGES.map((e, i) =>
    i % 2 === 0
      ? { a: e.from, b: e.to, goldDir: "A->B" as const, goldPol: e.polarity }
      : { a: e.to, b: e.from, goldDir: "B->A" as const, goldPol: e.polarity },
  ),
  { a: "S1", b: "S6", goldDir: "none" as const },
  { a: "S2", b: "S7", goldDir: "none" as const },
  { a: "S1", b: "S7", goldDir: "none" as const },
];

export function prompt(a: string, b: string): string {
  return (
    `次の2つの文の因果関係を判定せよ。\n` +
    `A: ${a}\n` +
    `B: ${b}\n\n` +
    `出力は JSON ひとつだけ: {"direction":"A->B"|"B->A"|"none","polarity":"+"|"-"}\n` +
    `direction: A が B の原因なら "A->B"、B が A の原因なら "B->A"、直接の因果が無ければ "none"。\n` +
    `polarity: 原因と結果が同方向の変化なら "+"、逆方向なら "-"。`
  );
}

export function normDir(s?: string): string | undefined {
  if (!s) return undefined;
  const n = s
    .replace(/[→⇒]/g, "->")
    .replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "")
    .toUpperCase();
  if (/A->B/.test(n)) return "A->B";
  if (/B->A/.test(n)) return "B->A";
  if (/NONE|なし|無/.test(n)) return "none";
  return undefined;
}

export function parse(text: string): { direction?: string; polarity?: string; jsonOK: boolean } {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "");
  const i = cleaned.indexOf("{");
  const j = cleaned.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(cleaned.slice(i, j + 1));
      return { direction: normDir(o.direction), polarity: o.polarity, jsonOK: true };
    } catch {
      /* lenient */
    }
  }
  const dir = normDir(cleaned.match(/[AB]\s*(?:->|→|⇒)\s*[AB]|none|なし/i)?.[0]);
  const pol = cleaned.match(/polarity["']?\s*[:=]\s*["']?([+\-])/)?.[1];
  return { direction: dir, polarity: pol, jsonOK: false };
}

/** モデルの run 関数を受け取り採点。run(content) => 生成テキスト。 */
export async function scoreModel(run: (content: string) => Promise<string>) {
  let dirOK = 0;
  let polOK = 0;
  let polTotal = 0;
  let jsonOK = 0;
  let totalMs = 0;
  for (const it of ITEMS) {
    const A = byId.get(it.a)!.text;
    const B = byId.get(it.b)!.text;
    const c0 = Date.now();
    const text = await run(prompt(A, B));
    totalMs += Date.now() - c0;
    const { direction, polarity, jsonOK: ok } = parse(text);
    if (ok) jsonOK++;
    if (direction === it.goldDir) dirOK++;
    if (it.goldPol) {
      polTotal++;
      if (polarity === it.goldPol) polOK++;
    }
  }
  return {
    dirAcc: +(dirOK / ITEMS.length).toFixed(3),
    polAcc: +(polOK / polTotal).toFixed(3),
    jsonRate: +(jsonOK / ITEMS.length).toFixed(3),
    msPerItem: Math.round(totalMs / ITEMS.length),
  };
}
