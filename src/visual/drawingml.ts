/**
 * 兄弟プロジェクト drawingml-svg と連携してスライド XML を忠実 SVG に描画する。
 *
 * drawingml-svg は DrawingML/PresentationML → SVG を `EMU_PER_PX=9525` で描画し、
 * office-causal の bbox 換算 (px = EMU/9525, src/visual/svg.ts) と**座標系が一致**する。
 * よって描画 SVG を背景に、因果オーバレイ (overlayCausal) を同座標で重ねられる。
 *
 * レンダラは差し替え可能 (SlideRenderer):
 *  - 既定 (Node): Python の drawingml-svg を子プロセス実行 (pythonDrawingmlRenderer)。
 *  - **drawingml-svg の TS 移行が完了したら**、その TS `dml2svg(xml)=>svg` をそのまま注入でき、
 *    Python 不要・in-process・**ブラウザ(WebGPU デモ)でも背景描画**が可能になる。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { CausalGraph } from "../types.js";
import type { Diagnosis } from "../analyze/diagnose.js";
import { overlayCausal } from "./svg.js";

/**
 * スライド/DrawingML XML → SVG のレンダラ契約。
 * 入力: スライド XML 文字列 (ppt/slides/slideN.xml 等)。
 * 出力: SVG 文字列。viewBox は px (= EMU/9525) であること (overlay と座標一致)。
 * TS 版 drawingml-svg はこの形を満たせばそのまま差し込める。
 */
export type SlideRenderer = (xml: string) => string | Promise<string>;

export interface DrawingmlOptions {
  /** svgraph (旧 drawingml-svg) の src ディレクトリ (PYTHONPATH)。 */
  srcPath?: string;
  python?: string; // 既定 python3
}

// svgraph(新) を優先、drawingml_svg(旧名) にフォールバックして dml2svg を呼ぶ。
const DML2SVG = "import sys\ntry:\n from svgraph.cli import main\nexcept ImportError:\n from drawingml_svg.cli import main\nsys.exit(main(['dml2svg']))";

/** src ディレクトリを解決 (svgraph → 旧 drawingml-svg の順)。 */
function resolveSrc(opts: DrawingmlOptions): string {
  const cands = [opts.srcPath, process.env["OCZ_SVGRAPH"], process.env["OCZ_DRAWINGML_SVG"], "../svgraph/src", "../drawingml-svg/src"].filter(Boolean) as string[];
  return cands.find((p) => existsSync(p)) ?? "../svgraph/src";
}

/** スライド/DrawingML の XML を SVG 文字列に変換 (svgraph dml2svg)。 */
export function renderDrawingmlSvg(xml: string, opts: DrawingmlOptions = {}): string {
  const src = resolveSrc(opts);
  const py = opts.python ?? "python3";
  const r = spawnSync(py, ["-c", DML2SVG], {
    input: xml,
    env: { ...process.env, PYTHONPATH: src },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`svgraph dml2svg failed (PYTHONPATH=${src}): ${(r.stderr || r.error?.message || "").slice(0, 200)}`);
  }
  return r.stdout;
}

export function isDrawingmlAvailable(opts: DrawingmlOptions = {}): boolean {
  try {
    const src = resolveSrc(opts);
    const r = spawnSync(opts.python ?? "python3", ["-c", "import svgraph"], { env: { ...process.env, PYTHONPATH: src } });
    if (r.status === 0) return true;
    const r2 = spawnSync(opts.python ?? "python3", ["-c", "import drawingml_svg"], { env: { ...process.env, PYTHONPATH: src } });
    return r2.status === 0;
  } catch {
    return false;
  }
}

/** 既定 (Node) レンダラ: Python svgraph を子プロセス実行。 */
export function pythonDrawingmlRenderer(opts: DrawingmlOptions = {}): SlideRenderer {
  return (xml) => renderDrawingmlSvg(xml, opts);
}

/**
 * (d) svgraph の **TS 版 dml2svg** を自動検知して採用、無ければ Python にフォールバック。
 * TS 版は 1文字=1<tspan x> の glyph 出力をすれば overlayCharBoxes が**厳密 box** になる。
 * モジュールは opts.tsModule / 環境変数 OCZ_SVGRAPH_TS で指定（`dml2svg` を export していること）。
 */
export async function resolveSlideRenderer(
  opts: DrawingmlOptions & { tsModule?: string } = {},
): Promise<{ renderer: SlideRenderer; engine: "ts-svgraph" | "python" }> {
  const mod = opts.tsModule ?? process.env["OCZ_SVGRAPH_TS"];
  if (mod) {
    try {
      const spec = mod; // 変数化して未導入環境でも tsc を通す
      const m: any = await import(spec);
      const fn = m.dml2svg ?? m.default?.dml2svg;
      if (typeof fn === "function") return { renderer: (xml) => fn(xml), engine: "ts-svgraph" };
    } catch {
      /* TS 未提供 → Python へ */
    }
  }
  return { renderer: pythonDrawingmlRenderer(opts), engine: "python" };
}

/**
 * スライド XML を「忠実描画 + 因果オーバレイ」の svg-causal-graph に合成する。
 * renderer を差し替えれば Python でも TS(drawingml-svg) でも、ブラウザでも動く。
 */
export async function renderSlideCausalSvg(
  slideXml: string,
  graph: CausalGraph,
  diag: Diagnosis,
  renderer: SlideRenderer,
): Promise<string> {
  const base = await renderer(slideXml);
  return overlayCausal(base, graph, diag);
}
