/**
 * data-id / meta を OOXML に「非破壊で」埋め込む 2 方式 (ADR-0001 D4)。
 *
 *  (A) embedDataPart … 推奨・完全安全。既存パートは 1 バイトも変えず、zip 内に
 *      `ocz/casual.json` を追加 ([Content_Types].xml に json Default を追記するのみ)。
 *      Office は未参照パートを無視するため壊れない。データは readDataPart で取り出す。
 *
 *  (B) embedAttributes … opt-in・実験的。docx/pptx の要素に `ocz:id` 属性を注入し、
 *      ルートに `xmlns:ocz` と `mc:Ignorable="ocz"` を宣言 (markup-compatibility)。
 *      準拠アプリは未知の ignorable 属性を無視するので開ける。ただし Office の再保存で
 *      正規化・脱落しうる点に注意 (確実性が要るなら A を使う)。xlsx セルは合成パスのため
 *      A を推奨。
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import type { CausalGraph, DataId, NodeKind, EdgeKind, CausalAnnotation } from "../types.js";
import { makeDataId } from "../id/hash.js";
import { emptyGraph, upsertNode, addEdge } from "../graph/model.js";
import { bookmarkName } from "../locate.js";

export const OCZ_NS = "urn:com-junkawasaki:office-causal:1";
const PART = "ocz/causal.json";
const PART_JSONL = "ocz/causal.jsonl";
// 旧名 (office-casual 時代) の同梱パートも読めるよう後方互換。
const LEGACY = ["ocz/casual.jsonl", "ocz/casual.json"] as const;

export type EmbedFormat = "json" | "jsonl";
export const OCZ_VERSION = 1;

/** (o) 同梱 payload / analysis の整合チェック。問題があれば警告文の配列を返す (空=OK)。 */
export function validatePayload(p: EmbeddedPayload): string[] {
  const w: string[] = [];
  if (p.version !== OCZ_VERSION) w.push(`payload version ${p.version} が未知 (期待 ${OCZ_VERSION})`);
  const a = p.analysis as { diagnosis?: { isolated?: { id: string }[] }; consult?: unknown; mece?: unknown } | undefined;
  if (a) {
    const ids = new Set(p.nodes.map((n) => n.id));
    const iso = a.diagnosis?.isolated ?? [];
    const missing = iso.filter((x) => !ids.has(x.id)).length;
    if (missing > 0) w.push(`同梱 analysis が古い可能性: 診断の ${missing}/${iso.length} ノードが現グラフに不在 (再解析推奨)`);
  }
  return w;
}

export interface EmbeddedPayload {
  version: 1;
  generator: "office-causal";
  nodes: { id: string; kind: string; part: string; path: string; label?: string; text?: string; value?: string | number; tags?: string[]; bbox?: import("../types.js").BBox }[];
  edges: { id: string; kind: string; from: string; to: string; weight?: number; causal?: unknown }[];
  /** (m) 解析結果の同梱 (diagnose / consult / mece)。再ロードで即表示できる。 */
  analysis?: { diagnosis?: unknown; consult?: unknown; mece?: unknown };
}

function payloadOf(graph: CausalGraph): EmbeddedPayload {
  return {
    version: 1,
    generator: "office-causal",
    nodes: [...graph.nodes.values()].map((n) => ({
      id: n.id,
      kind: n.meta.kind,
      part: n.meta.part,
      path: n.meta.path,
      ...(n.meta.label !== undefined ? { label: n.meta.label } : {}),
      ...(n.meta.text !== undefined ? { text: n.meta.text } : {}),
      ...(n.meta.value !== undefined ? { value: n.meta.value } : {}),
      ...(n.meta.tags !== undefined ? { tags: n.meta.tags } : {}),
      ...(n.meta.bbox !== undefined ? { bbox: n.meta.bbox } : {}),
    })),
    edges: graph.edges.map((e) => ({
      id: e.id, kind: e.kind, from: e.from, to: e.to,
      ...(e.weight !== undefined ? { weight: e.weight } : {}),
      ...(e.causal !== undefined ? { causal: e.causal } : {}),
    })),
  };
}

/** [Content_Types].xml に拡張子の Default を追記 (無ければ)。 */
function ensureContentType(xml: string, ext: string, ctype: string): string {
  if (new RegExp(`Extension="${ext}"`, "i").test(xml)) return xml;
  return xml.replace(/<\/Types>\s*$/i, `<Default Extension="${ext}" ContentType="${ctype}"/></Types>`);
}

/** JSONL 直列化: 1行目に meta、以降は 1 ノード/エッジ = 1 行 (追記・ストリーム・diff 向き)。 */
function toJsonl(p: EmbeddedPayload): string {
  const lines = [JSON.stringify({ t: "meta", version: p.version, generator: p.generator })];
  if (p.analysis) lines.push(JSON.stringify({ t: "analysis", analysis: p.analysis }));
  for (const n of p.nodes) lines.push(JSON.stringify({ t: "node", ...n }));
  for (const e of p.edges) lines.push(JSON.stringify({ t: "edge", ...e }));
  return lines.join("\n") + "\n";
}

/** last-wins + 墓標(node-del/edge-del) 対応 → 追記のみで更新できる。 */
function fromJsonl(text: string): EmbeddedPayload {
  const nodes = new Map<string, EmbeddedPayload["nodes"][number]>();
  const edges = new Map<string, EmbeddedPayload["edges"][number]>();
  let version: 1 = 1;
  let generator: "office-causal" = "office-causal";
  let analysis: EmbeddedPayload["analysis"];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    switch (o.t) {
      case "meta": version = o.version ?? 1; generator = o.generator ?? "office-causal"; break;
      case "analysis": analysis = o.analysis; break;
      case "node": { const { t, ...rest } = o; nodes.set(rest.id, rest); break; }
      case "node-del": nodes.delete(o.id); break;
      case "edge": { const { t, ...rest } = o; edges.set(rest.id, rest); break; }
      case "edge-del": edges.delete(o.id); break;
    }
  }
  return { version, generator, nodes: [...nodes.values()], edges: [...edges.values()], ...(analysis ? { analysis } : {}) };
}

/** (o) 埋め込み payload から CausalGraph を復元 (再解析なし)。 */
export function payloadToGraph(p: EmbeddedPayload): CausalGraph {
  const g = emptyGraph();
  for (const n of p.nodes) {
    upsertNode(g, n.id as DataId, {
      kind: n.kind as NodeKind, part: n.part, path: n.path, provenance: ["embedded"],
      ...(n.label !== undefined ? { label: n.label } : {}),
      ...(n.text !== undefined ? { text: n.text } : {}),
      ...(n.value !== undefined ? { value: n.value } : {}),
      ...(n.tags !== undefined ? { tags: n.tags } : {}),
      ...(n.bbox !== undefined ? { bbox: n.bbox } : {}),
    });
  }
  for (const e of p.edges) {
    addEdge(g, {
      kind: e.kind as EdgeKind, from: e.from as DataId, to: e.to as DataId,
      ...(e.weight !== undefined ? { weight: e.weight } : {}),
      ...(e.causal !== undefined ? { causal: e.causal as CausalAnnotation } : {}),
    });
  }
  return g;
}

const REL_TYPE = "https://com-junkawasaki.org/office-causal/relationship";
const REL_ID = "rIdOfficeCasual";

/** ルート _rels/.rels に同梱パートへのリレーションを追記 (OPC 準拠 → Office 互換性向上)。 */
function ensureRootRel(xml: string, target: string): string {
  if (xml.includes(REL_ID)) return xml;
  return xml.replace(
    /<\/Relationships>\s*$/i,
    `<Relationship Id="${REL_ID}" Type="${REL_TYPE}" Target="${target}"/></Relationships>`,
  );
}

/** (A) 安全な埋め込み。元パートは不変、ocz/casual.{json|jsonl} を同梱。 */
export function embedDataPart(
  bytes: Uint8Array,
  graph: CausalGraph,
  opts: { format?: EmbedFormat; analysis?: EmbeddedPayload["analysis"] } = {},
): Uint8Array {
  const fmt = opts.format ?? "jsonl"; // (k) 既定 jsonl (大規模・追記・diff 向き)
  const entries = unzipSync(bytes);
  const partName = fmt === "jsonl" ? PART_JSONL : PART;
  const ext = fmt === "jsonl" ? "jsonl" : "json";
  const ctype = fmt === "jsonl" ? "application/jsonl" : "application/json";

  // 1) Content_Types に拡張子を登録
  const ct = entries["[Content_Types].xml"];
  if (ct) entries["[Content_Types].xml"] = strToU8(ensureContentType(strFromU8(ct), ext, ctype));

  // 2) ルート rels にパートを登録 (未参照パートを避け、PowerPoint/Word でも確実に開ける)
  const rels = entries["_rels/.rels"];
  if (rels) entries["_rels/.rels"] = strToU8(ensureRootRel(strFromU8(rels), partName));

  // 3) データパート本体 (+ 解析結果の同梱)
  const payload = payloadOf(graph);
  if (opts.analysis) payload.analysis = opts.analysis;
  entries[partName] = strToU8(fmt === "jsonl" ? toJsonl(payload) : JSON.stringify(payload));
  return zipSync(entries);
}

/**
 * (p) 差分 embed: 既存 ocz/casual.jsonl は書き換えず、変更/新規/削除レコードだけ末尾に追記。
 * 既存行はそのまま prefix として残る → git 差分は追加行のみ・巨大ファイルでも安価。
 * 既存が無ければ通常の full embed にフォールバック。
 */
export function embedDataPartDiff(bytes: Uint8Array, graph: CausalGraph): Uint8Array {
  const entries = unzipSync(bytes);
  const existing = entries[PART_JSONL] ?? entries["ocz/casual.jsonl"]; // 旧名も追記対象に
  if (!existing) return embedDataPart(bytes, graph, { format: "jsonl" });
  const existingText = strFromU8(existing);

  const prev = fromJsonl(existingText);
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, JSON.stringify(n)]));
  const prevEdges = new Map(prev.edges.map((e) => [e.id, JSON.stringify(e)]));
  const cur = payloadOf(graph);

  const appended: string[] = [];
  const curNodeIds = new Set<string>();
  for (const n of cur.nodes) {
    curNodeIds.add(n.id);
    if (prevNodes.get(n.id) !== JSON.stringify(n)) appended.push(JSON.stringify({ t: "node", ...n }));
  }
  for (const id of prevNodes.keys()) if (!curNodeIds.has(id)) appended.push(JSON.stringify({ t: "node-del", id }));

  const curEdgeIds = new Set<string>();
  for (const e of cur.edges) {
    curEdgeIds.add(e.id);
    if (prevEdges.get(e.id) !== JSON.stringify(e)) appended.push(JSON.stringify({ t: "edge", ...e }));
  }
  for (const id of prevEdges.keys()) if (!curEdgeIds.has(id)) appended.push(JSON.stringify({ t: "edge-del", id }));

  if (appended.length === 0) return bytes; // 変更なし
  entries[PART_JSONL] = strToU8(existingText + appended.join("\n") + "\n");
  return zipSync(entries);
}

/** 埋め込んだ data-id/meta グラフを読み出す (json/jsonl・旧名 casual も)。 */
export function readDataPart(bytes: Uint8Array): EmbeddedPayload | null {
  const entries = unzipSync(bytes);
  if (entries[PART_JSONL]) return fromJsonl(strFromU8(entries[PART_JSONL]));
  if (entries[PART]) return JSON.parse(strFromU8(entries[PART])) as EmbeddedPayload;
  for (const legacy of LEGACY) {
    if (entries[legacy]) return legacy.endsWith(".jsonl")
      ? fromJsonl(strFromU8(entries[legacy]))
      : (JSON.parse(strFromU8(entries[legacy])) as EmbeddedPayload);
  }
  return null;
}

// ---------- (B) 属性直書き (docx/pptx, 実験的) ----------

const poOpts = { ignoreAttributes: false, attributeNamePrefix: "@_", preserveOrder: true, trimValues: false, suppressEmptyNode: true } as const;

type PONode = Record<string, any>;
const tagOf = (n: PONode) => Object.keys(n).find((k) => k !== ":@");

function textOfPO(n: PONode): string {
  const tag = tagOf(n);
  if (!tag) return "";
  if (tag === "#text") return String(n["#text"] ?? "");
  return (n[tag] as PONode[]).map(textOfPO).join("");
}

/** walk() と同じ path 規則で preserveOrder ツリーを巡回。 */
function walkPO(children: PONode[], parentPath: string, cb: (node: PONode, tag: string, path: string) => void) {
  const totals: Record<string, number> = {};
  for (const n of children) { const t = tagOf(n); if (t && t !== "#text") totals[t] = (totals[t] ?? 0) + 1; }
  const counts: Record<string, number> = {};
  for (const n of children) {
    const t = tagOf(n);
    if (!t || t === "#text") continue;
    counts[t] = (counts[t] ?? 0) + 1;
    const path = parentPath + ((totals[t] ?? 0) > 1 ? `/${t}[${counts[t]}]` : `/${t}`);
    cb(n, t, path);
    walkPO(n[t] as PONode[], path, cb);
  }
}

function setAttr(n: PONode, key: string, val: string) {
  n[":@"] = { ...(n[":@"] ?? {}), [`@_${key}`]: val };
}

/** 抽出器 (parts/pptx.ts, docx.ts) と同じ stableKey で id を再現する要素か判定。 */
function idForElement(part: string, tag: string, path: string, text: string): string | null {
  if (tag === "p:sp") return makeDataId(part, path, text || path);
  if (tag === "w:p") return text ? makeDataId(part, path, text) : null;
  if (tag === "w:tbl") return makeDataId(part, path, text.slice(0, 64) || path);
  return null;
}

const NS_MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/** (r) docx 段落に Word ブックマークを注入 → file.docx#<id> で段落ジャンプ可能に。 */
function injectBookmark(node: PONode, id: string, bmId: number) {
  const children = node["w:p"] as PONode[];
  children.unshift({ "w:bookmarkStart": [], ":@": { "@_w:id": String(bmId), "@_w:name": bookmarkName(id) } });
  children.push({ "w:bookmarkEnd": [], ":@": { "@_w:id": String(bmId) } });
}

/** (B) docx/pptx の対象パートに ocz:id を注入 (docx は (r) ブックマークも)。 */
export function embedAttributes(bytes: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes);
  const parser = new XMLParser(poOpts);
  const builder = new XMLBuilder(poOpts);

  for (const name of Object.keys(entries)) {
    const isSlide = /^ppt\/slides\/slide\d+\.xml$/.test(name);
    const isDoc = name === "word/document.xml";
    if (!isSlide && !isDoc) continue;

    const tree = parser.parse(strFromU8(entries[name]!)) as PONode[];
    const root = tree.find((n) => tagOf(n) && tagOf(n) !== "?xml");
    if (!root) continue;
    const rootTag = tagOf(root)!;

    let injected = 0;
    let bmId = 1000;
    walkPO(root[rootTag] as PONode[], rootTag, (node, tag, path) => {
      const id = idForElement(name, tag, path, textOfPO(node));
      if (!id) return;
      setAttr(node, "ocz:id", id);
      injected++;
      if (isDoc && tag === "w:p") injectBookmark(node, id, bmId++); // (r)
    });
    if (!injected) continue;

    // ルートに名前空間 + mc:Ignorable を宣言。
    const at = (root[":@"] ?? {}) as Record<string, string>;
    at["@_xmlns:ocz"] = OCZ_NS;
    if (!at["@_xmlns:mc"]) at["@_xmlns:mc"] = NS_MC;
    at["@_mc:Ignorable"] = (at["@_mc:Ignorable"] ? at["@_mc:Ignorable"] + " " : "") + "ocz";
    root[":@"] = at;

    entries[name] = strToU8(builder.build(tree));
  }
  return zipSync(entries);
}
