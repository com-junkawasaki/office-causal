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
  /** drawingml-svg の src ディレクトリ (PYTHONPATH)。既定: 兄弟 ../drawingml-svg/src。 */
  srcPath?: string;
  python?: string; // 既定 python3
}

/** スライド/DrawingML の XML を SVG 文字列に変換。 */
export function renderDrawingmlSvg(xml: string, opts: DrawingmlOptions = {}): string {
  const src = opts.srcPath ?? process.env["OCZ_DRAWINGML_SVG"] ?? "../drawingml-svg/src";
  const py = opts.python ?? "python3";
  const code = "import sys; from drawingml_svg.cli import main; sys.exit(main(['dml2svg']))";
  const r = spawnSync(py, ["-c", code], {
    input: xml,
    env: { ...process.env, PYTHONPATH: src },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`drawingml-svg dml2svg failed (PYTHONPATH=${src}): ${(r.stderr || r.error?.message || "").slice(0, 200)}`);
  }
  return r.stdout;
}

export function isDrawingmlAvailable(opts: DrawingmlOptions = {}): boolean {
  try {
    const src = opts.srcPath ?? process.env["OCZ_DRAWINGML_SVG"] ?? "../drawingml-svg/src";
    const r = spawnSync(opts.python ?? "python3", ["-c", "import drawingml_svg"], {
      env: { ...process.env, PYTHONPATH: src },
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 既定 (Node) レンダラ: Python drawingml-svg を子プロセス実行。 */
export function pythonDrawingmlRenderer(opts: DrawingmlOptions = {}): SlideRenderer {
  return (xml) => renderDrawingmlSvg(xml, opts);
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
