/**
 * 決定論的・コンテンツアドレス指定の DataId 生成 (ADR-0001 D3)。
 *
 * 実装メモ: ここでは依存を増やさないため簡易ハッシュを置く。本番では blake3
 * (`@noble/hashes/blake3`) に差し替える。出力は `ocz1:` + base32(12byte) で安定。
 */
import type { DataId } from "../types.js";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** FNV-1a 64bit (placeholder; replace with blake3 in production). */
function fnv1a(input: string): Uint8Array {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h = (h ^ BigInt(input.charCodeAt(i))) & mask;
    h = (h * prime) & mask;
  }
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(h & 0xffn);
    h >>= 8n;
  }
  return out;
}

/**
 * @param partName   OPC part name ("ppt/slides/slide5.xml")
 * @param structuralPath ルートからの構造パス ("p:sld/.../p:sp[3]")
 * @param stableKey  要素固有の安定キー (数式文字列, セル参照, 正規化テキスト等)
 */
export function makeDataId(
  partName: string,
  structuralPath: string,
  stableKey: string,
): DataId {
  const digest = fnv1a(`${partName}/${structuralPath}|${stableKey}`);
  return `ocz1:${base32(digest)}` as DataId;
}
