/**
 * 兄弟プロジェクト drawingml-svg と連携してスライド XML を忠実 SVG に描画する。
 *
 * drawingml-svg は DrawingML/PresentationML → SVG を `EMU_PER_PX=9525` で描画し、
 * office-causal の bbox 換算 (px = EMU/9525, src/visual/svg.ts) と**座標系が一致**する。
 * よって描画 SVG を背景に、因果オーバレイ (overlayCausal) を同座標で重ねられる。
 *
 * Python ツールを子プロセスで呼ぶ (opt-in)。src パスは引数 / 環境変数 OCZ_DRAWINGML_SVG /
 * 既定の兄弟相対パスで解決。未配置なら例外。
 */
import { spawnSync } from "node:child_process";

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
