/**
 * CausalGraph を 4 階層の **tensor network** として表現する。
 *
 *   Document ─contains→ Page(slide/sheet/section) ─contains→ Object(shape/cell/paragraph)
 *            ─mentions→ Causal(entity/claim) ─causes→ Causal …
 *
 * tensor network の対応づけ:
 *  - 各ノード = テンソル。incident bond 数 = テンソルの rank。
 *  - 各エッジ = bond(仮想インデックス)。bond 次元 χ は種別で決める
 *    (構造 contains/references/derives-from/mentions = 1、causes = 極性 3 値を符号化して 3)。
 *  - 物理インデックス次元 physDim = ノード固有の特徴次元 (タグ数。無ければ 1)。
 *
 * これにより「文書→ページ→オブジェクト→因果」を 1 つの縮約可能なネットワークとして扱える。
 * 数値縮約はしない (構造表現のみ)。縮約順序のヒントだけ min-degree で算出する。
 */
import type { CausalGraph, DataId, EdgeKind, NodeKind } from "../types.js";

export type TensorLayer = "document" | "page" | "object" | "causal";
export const TENSOR_LAYERS: TensorLayer[] = ["document", "page", "object", "causal"];

/** bond 次元 χ: causes だけ極性(+/-/?)を符号化して 3、他の構造 bond は 1。 */
const BOND_DIM: Record<EdgeKind, number> = {
  contains: 1,
  references: 1,
  "derives-from": 1,
  mentions: 1,
  causes: 3,
};

const LAYER_OF: Record<NodeKind, TensorLayer> = {
  document: "document",
  slide: "page", sheet: "page", section: "page",
  shape: "object", cell: "object", paragraph: "object", range: "object", chart: "object", table: "object", image: "object",
  entity: "causal", claim: "causal",
};

export interface TensorNode {
  id: string;
  layer: TensorLayer;
  kind: NodeKind;
  label: string;
  /** 物理インデックス次元 (ノード固有の特徴次元)。 */
  physDim: number;
  /** incident bond の id。rank = bonds.length (+ physDim>1 なら物理脚 1)。 */
  bonds: string[];
  rank: number;
  /** 所属する上位ノード (document/page) の id。可視化・集約用。 */
  parent?: string;
}

export interface TensorBond {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /** bond 次元 χ。 */
  dim: number;
  /** causes の重み (極性つき強度)。 */
  weight?: number;
  /** from と to が別ドキュメントをまたぐか (間接因果の核)。 */
  crossDoc: boolean;
}

export interface TensorNetwork {
  nodes: TensorNode[];
  bonds: TensorBond[];
  stats: {
    nodeCount: number;
    bondCount: number;
    perLayer: Record<TensorLayer, number>;
    maxRank: number;
    /** Σ_node physDim · Π_(incident bond) χ。ナイーブな自由度(パラメータ)数。 */
    totalParams: number;
    /** causes/references bond による連結成分数 (ドキュメント横断の因果クラスタ数)。 */
    causalComponents: number;
    /** ドキュメントをまたぐ causes bond の数 (間接因果の本数)。 */
    crossDocCauses: number;
  };
  /** min-degree 消去による縮約順序のヒント (数値縮約はしない)。 */
  contractionOrder: string[];
}

/**
 * ノードがどのドキュメントに属するかを解決する。
 *  - 構造ノード: contains を遡って document へ。
 *  - 因果ノード(entity/claim): contains 連鎖に無いので、自身を mention する
 *    オブジェクト経由でそのドキュメントに帰属させる。
 */
function resolveDocOf(g: CausalGraph): Map<DataId, DataId> {
  const parentDoc = new Map<DataId, DataId>();
  const containsParent = new Map<DataId, DataId>(); // child -> immediate contains parent
  for (const e of g.edges) if (e.kind === "contains") containsParent.set(e.to, e.from);
  const docKind = (id: DataId) => g.nodes.get(id)?.meta.kind === "document";
  for (const id of g.nodes.keys()) {
    let cur: DataId | undefined = id;
    const seen = new Set<DataId>();
    while (cur && !docKind(cur) && !seen.has(cur)) { seen.add(cur); cur = containsParent.get(cur); }
    if (cur && docKind(cur)) parentDoc.set(id, cur);
  }
  // 因果ノードを mentions 元オブジェクトのドキュメントに帰属
  for (const e of g.edges) {
    if (e.kind !== "mentions") continue;
    if (!parentDoc.has(e.to) && parentDoc.has(e.from)) parentDoc.set(e.to, parentDoc.get(e.from)!);
  }
  return parentDoc;
}

/** CausalGraph を tensor network に持ち上げる。 */
export function toTensorNetwork(g: CausalGraph): TensorNetwork {
  const docOf = resolveDocOf(g);
  const immediateParent = new Map<DataId, DataId>();
  for (const e of g.edges) if (e.kind === "contains") immediateParent.set(e.to, e.from);

  const nodes = new Map<string, TensorNode>();
  for (const n of g.nodes.values()) {
    const layer = LAYER_OF[n.meta.kind] ?? "object";
    nodes.set(n.id, {
      id: n.id,
      layer,
      kind: n.meta.kind,
      label: n.meta.label ?? n.meta.text ?? n.meta.kind,
      physDim: Math.max(1, n.meta.tags?.length ?? 1),
      bonds: [],
      rank: 0,
      ...(immediateParent.get(n.id) ? { parent: immediateParent.get(n.id)! } : {}),
    });
  }

  const bonds: TensorBond[] = [];
  let crossDocCauses = 0;
  for (const e of g.edges) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b) continue;
    const crossDoc = (docOf.get(e.from) ?? e.from) !== (docOf.get(e.to) ?? e.to);
    const bond: TensorBond = {
      id: e.id, kind: e.kind, from: e.from, to: e.to,
      dim: BOND_DIM[e.kind] ?? 1,
      ...(e.weight !== undefined ? { weight: e.weight } : {}),
      crossDoc,
    };
    bonds.push(bond);
    a.bonds.push(e.id); b.bonds.push(e.id);
    if (e.kind === "causes" && crossDoc) crossDocCauses++;
  }

  // rank と統計
  const perLayer: Record<TensorLayer, number> = { document: 0, page: 0, object: 0, causal: 0 };
  let maxRank = 0, totalParams = 0;
  const bondDimById = new Map(bonds.map((x) => [x.id, x.dim]));
  for (const node of nodes.values()) {
    node.rank = node.bonds.length + (node.physDim > 1 ? 1 : 0);
    perLayer[node.layer]++;
    maxRank = Math.max(maxRank, node.rank);
    let params = node.physDim;
    for (const bid of node.bonds) params *= bondDimById.get(bid) ?? 1;
    totalParams += params;
  }

  return {
    nodes: [...nodes.values()],
    bonds,
    stats: {
      nodeCount: nodes.size,
      bondCount: bonds.length,
      perLayer,
      maxRank,
      totalParams,
      causalComponents: countComponents(nodes, bonds, (k) => k === "causes" || k === "references"),
      crossDocCauses,
    },
    contractionOrder: minDegreeOrder(nodes, bonds),
  };
}

/** 指定種別の bond だけで連結成分数を数える (union-find)。 */
function countComponents(nodes: Map<string, TensorNode>, bonds: TensorBond[], pick: (k: EdgeKind) => boolean): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  const touched = new Set<string>();
  for (const b of bonds) if (pick(b.kind)) { for (const id of [b.from, b.to]) if (!parent.has(id)) parent.set(id, id); touched.add(b.from); touched.add(b.to); }
  for (const b of bonds) if (pick(b.kind)) { const ra = find(b.from), rb = find(b.to); if (ra !== rb) parent.set(ra, rb); }
  const roots = new Set<string>();
  for (const id of touched) roots.add(find(id));
  return roots.size;
}

/** min-degree(= 最小 rank) 消去順。数値縮約はせず順序ヒントのみ。 */
function minDegreeOrder(nodes: Map<string, TensorNode>, bonds: TensorBond[]): string[] {
  const deg = new Map<string, number>();
  for (const n of nodes.values()) deg.set(n.id, 0);
  for (const b of bonds) { deg.set(b.from, (deg.get(b.from) ?? 0) + 1); deg.set(b.to, (deg.get(b.to) ?? 0) + 1); }
  return [...deg.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** tensor network を可搬な JSON へ。 */
export function tensorNetworkToJson(tn: TensorNetwork): string {
  return JSON.stringify(tn, null, 2);
}
