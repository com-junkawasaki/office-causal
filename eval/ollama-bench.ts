/**
 * 役割② 生成 edge-LLM 比較 (Ollama 経由)。
 * transformers.js が未対応の Gemma 4 (E2B/E4B) などを Apple Silicon の Metal で実走。
 *
 * 実行: node --import tsx eval/ollama-bench.ts "gemma4:e2b,gemma4:latest"
 */
import { scoreModel } from "./adjudicate.js";

const models = (process.argv[2] ?? "gemma4:latest").split(",").map((s) => s.trim());

async function chat(model: string, content: string): Promise<string> {
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      stream: false,
      think: false, // thinking を切る (対応モデルのみ)
      options: { temperature: 0, num_predict: 256 },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 80)}`);
  const j: any = await res.json();
  return j?.message?.content ?? "";
}

const rows: any[] = [];
for (const model of models) {
  try {
    console.error(`▶ ${model} ...`);
    const r = await scoreModel((content) => chat(model, content));
    rows.push({ model, ...r });
  } catch (e) {
    console.error(`  ✗ ${(e as Error).message.slice(0, 120)}`);
    rows.push({ model, status: "FAILED" });
  }
}

console.log("\n=== 役割② 生成 edge-LLM (Ollama / 向き11件・極性8件) ===");
console.table(rows);
