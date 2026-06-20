/**
 * office-casual — core domain types.
 *
 * 単一の `CausalGraph` を IR とする (ADR-0001)。OOXML の全要素・派生エンティティが
 * `data-id` を持つノードになり、5 種の型付きエッジで結ばれる。
 */

/** `ocz1:` 名前空間を持つコンテンツアドレス指定の安定 ID。 */
export type DataId = `ocz1:${string}`;

export type AppKind = "ppt" | "xls" | "doc";

export type NodeKind =
  // 構造ノード (決定論的に確定)
  | "document"
  | "slide"
  | "shape"
  | "sheet"
  | "cell"
  | "range"
  | "chart"
  | "paragraph"
  | "table"
  | "image"
  // 派生ノード (LLM)
  | "entity" // KPI / 指標 / 主体 (「売上」「競合」)
  | "claim"; // 文書中の主張 (因果の発話元)

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** EMU(OOXML) か px かを示す。drawingml-svg と揃える。 */
  unit: "emu" | "px";
}

/** 全ノードが必ず持つメタ。 */
export interface Meta {
  kind: NodeKind;
  /** OPC part name, e.g. "ppt/slides/slide5.xml"。派生ノードは "derived"。 */
  part: string;
  /** ルートからの構造パス, e.g. "p:sld/p:cSld/p:spTree/p:sp[3]"。 */
  path: string;
  label?: string;
  /** 正規化済み抽出テキスト。 */
  text?: string;
  value?: string | number;
  bbox?: BBox;
  source?: { app: AppKind; ooxmlTag: string };
  /** transformers.js のローカル小型モデルで data-id に付与したタグ。 */
  tags?: string[];
  /** この meta を生成 / 更新したパイプライン段の列挙 (監査用)。 */
  provenance: string[];
}

export interface OoxmlNode {
  id: DataId;
  meta: Meta;
}

export type EdgeKind =
  | "contains" // 構造: slide → shape
  | "references" // 参照: chart → range, r:id, hyperlink
  | "derives-from" // 依存: cell B2 → A2 (数式 AST)
  | "mentions" // 意味: paragraph → entity (LLM)
  | "causes"; // 因果: entity → entity (LLM + verify)

export interface Evidence {
  /** 根拠となったノード。 */
  nodeId: DataId;
  /** 引用した実テキスト。 */
  quote: string;
}

export interface CausalAnnotation {
  polarity: "+" | "-" | "?";
  mechanism: string;
  /** verify 後の集計 confidence 0..1。 */
  confidence: number;
  evidence: Evidence[];
  lag?: string;
  status: "hypothesis" | "supported" | "refuted";
}

export interface Edge {
  id: string;
  kind: EdgeKind;
  from: DataId;
  to: DataId;
  /**
   * ローカル小型モデル (transformers.js 埋め込み) による意味的強度 0..1。
   * 「edge の小さい LLM weight」: Claude を呼ぶ前の安価な一次評価。
   */
  weight?: number;
  /** kind === "causes" のときのみ。 */
  causal?: CausalAnnotation;
}

export type ExportFormat = "json" | "graphml" | "cypher" | "dot";

export interface CausalGraph {
  nodes: Map<DataId, OoxmlNode>;
  edges: Edge[];
  /** 解析対象のソースファイル群。 */
  sources: { path: string; app: AppKind }[];
}

export type Depth = "structural" | "semantic" | "causal";

export interface EmbeddingOptions {
  enabled?: boolean; // 既定: true (ローカル, API キー不要)
  model?: string; // 既定: "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
  /** data-id タグづけ用の語彙。空ならタグづけしない。 */
  tagTaxonomy?: string[];
  /** タグ採用のコサイン閾値 (既定 0.3)。 */
  tagThreshold?: number;
  /** 埋め込み類似でローカルに張る候補エッジの閾値 (既定 0.45)。 */
  proposeThreshold?: number;
  proposeKind?: "mentions" | "causes";
}

export interface LlmOptions {
  /**
   * causal 段の裁定エンジン。
   *  - "claude" (既定): ChatAnthropic が裁定 (API キー必要)
   *  - "webgpu-gemma": ローカル Gemma 4 (transformers.js) が裁定。
   *    ブラウザは device:"webgpu"、Node は device:"cpu" 等。
   */
  provider?: "claude" | "webgpu-gemma";
  model?: string; // Claude モデル
  deepModel?: string; // verify 用 Claude モデル
  verifyVotes?: number;
  /** verify 段 (Claude 敵対的反証) を実行するか。既定 true。false で完全ローカル。 */
  verify?: boolean;
  /** webgpu-gemma 用: モデル / デバイス。 */
  localModel?: string; // 既定 onnx-community/gemma-4-E2B-it-ONNX
  device?: "webgpu" | "wasm" | "cpu" | "coreml";
}

export interface AnalyzeOptions {
  depth?: Depth; // 既定: "causal"
  embed?: boolean; // 既定: false (XML への data-id 往復書き戻し)
  embeddings?: EmbeddingOptions; // transformers.js ローカル分析
  link?: "none" | "cross-file"; // 複数ファイルの参照解決
  llm?: LlmOptions;
  /** .ocz (埋め込み済み) でも強制的に再解析する。既定 false (同梱グラフを使う)。 */
  reanalyze?: boolean;
}
