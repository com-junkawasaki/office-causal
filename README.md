# office-causal

**English** | [日本語](README.ja.md)

[![CI](https://github.com/com-junkawasaki/office-causal/actions/workflows/ci.yml/badge.svg)](https://github.com/com-junkawasaki/office-causal/actions/workflows/ci.yml)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-%40com--junkawasaki%2Foffice--causal-2188ff?logo=github)](https://github.com/com-junkawasaki/office-causal/pkgs/npm/office-causal)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Turn **all the XML inside MS Office (OOXML: pptx/xlsx/docx)** into a single **typed causal graph** in TypeScript — attach a stable **`data-id`** and **`meta`** to every element, lift it from structure → reference/dependency → **causal** graph, and run an LLM agent (LangGraph.js) to extract, verify and analyze causal hypotheses.

**▶ [Live WebGPU demo &amp; docs site](https://com-junkawasaki.github.io/office-causal/)** — drop a `.xlsx/.pptx/.docx`, runs entirely in the browser (no API key, no upload).

- org: `com-junkawasaki`
- sibling project: **`svgraph`** (formerly `drawingml-svg`) — DrawingML/PresentationML → SVG (`EMU_PER_PX=9525`); used for the screenshot rendering in §8.

## Quick start

```bash
# 0) try it with no install: open the live demo in Chrome/Edge, drop a file, Run → diagnose → so-what
#    https://com-junkawasaki.github.io/office-causal/

# 1) CLI — analyze a document and embed the graph + analysis back into the file
npx @com-junkawasaki/office-causal analyze  report.pptx           # → CausalGraph (JSON, stdout)
npx @com-junkawasaki/office-causal embed    report.pptx --analysis  # → report.ocz.pptx
npx @com-junkawasaki/office-causal diagnose report.ocz.pptx --gemma # isolated / not-holding / notation / concept-jumps
npx @com-junkawasaki/office-causal consult  report.ocz.pptx --mece  # so-what + MECE
```
```ts
// 2) library — fully local, Gemma 4 only (no cloud). Node: device "cpu"; browser: "webgpu".
import { analyze, embedFile, readDataPart, diagnose } from "@com-junkawasaki/office-causal";

const graph = await analyze("report.pptx", { llm: { device: "cpu", verify: false } });
const dx    = await diagnose(graph, { gemma: true });
await embedFile("report.xlsx", { mode: "part" });                 // → report.ocz.xlsx (valid OOXML)
const data  = readDataPart(new Uint8Array(fs.readFileSync("report.ocz.xlsx")));
```

CLI verbs: `analyze | graph | embed | locate | diagnose | consult`. See [§6](#6-diagnostics-consulting--scale) / [§8](#8-visualization--svg-causal-graph-svgraph-integration) for flags.

## Install (GitHub Packages)

```bash
# configure the scope registry + auth in your project .npmrc
echo "@com-junkawasaki:registry=https://npm.pkg.github.com" >> .npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc   # PAT with read:packages

npm install @com-junkawasaki/office-causal
```
```ts
import { analyze, embedFile, readDataPart, diagnose, consult, WebGpuGemmaAdjudicator } from "@com-junkawasaki/office-causal";
```

---

## 1. What it solves

An Office document is a finished artifact for humans, but it hides a large amount of **implicit causal structure**:

- **xlsx**: cell `B2 = A2*1.1` **depends on** `A2` → and beyond that, "revenue grew **so** profit rose" (business causality).
- **pptx**: a chart on slide 5 **references** an xlsx range; the conclusion on slide 6 **claims** "the share decline was **caused by** the competitor's price cut".
- **docx**: paragraph 12 **references** figure 3 and **states** "the cost increase was **driven by** raw-material prices".

office-causal unifies these into **one directed graph** — nodes = Office elements / derived entities, edges = `contains` / `references` / `derives-from` / `mentions` / **`causes`**.

```
ingest → identify (data-id+meta) → structural (contains/references/derives-from)
       → embed (local model: weight/tag/candidates) → semantic → causal (direction/polarity) → verify
```

The deterministic layers are pure functions (no LLM); only meaning and causal adjudication use a model. This keeps results reproducible, cheap and auditable.

---

## 2. Architecture

```
src/
  types.ts                 # domain types (DataId, Meta, CausalGraph, ...)
  ooxml/{opc,parse}.ts      # OPC(zip) unpack + relations, XML → AST
  ooxml/parts/{pptx,xlsx,docx}.ts  # per-format extraction (incl. xlsx sharedStrings, pptx bbox)
  id/hash.ts                # deterministic content-addressed data-id
  graph/{model,builder,export}.ts  # CausalGraph + JSON/GraphML/Cypher/DOT
  embed/{model,weight,tag}.ts      # transformers.js local model (embeddings)
  causal/analyze.ts         # DAG / paths / centrality / cycles
  analyze/{diagnose,consult,mece,ann}.ts  # diagnostics, so-what, MECE, LSH
  llm/gemma-webgpu.ts       # Gemma 4 adjudicator (transformers.js v4 / WebGPU)
  visual/{svg,drawingml,interactive}.ts   # svg-causal-graph + char boxes + viewer
  agent/{state,nodes,graph}.ts     # LangGraph.js pipeline
  ooxml/embed.ts            # non-destructive .ocz embedding
eval/                       # gold set + benchmarks + verifiers
docs/adr/                   # ADR 0001–0004
```

**Design principle**: lock down what is deterministic (structure / references / formula dependencies) with pure functions; use a model only for meaning and causal hypotheses.

---

## 3. data-id and meta

### 3.1 DataId — deterministic & stable
Content-addressed so the same element keeps the same id even if Office reorders elements on save:
```
data-id = "ocz1:" + base32(hash(partName + "/" + structuralPath + "|" + stableKey))
```

### 3.2 Meta
Each node carries `kind, part, path, label?, text?, value?, bbox?, tags?, source?, provenance`.

### 3.3 Non-destructive embedding into the file
Give a `.pptx/.xlsx/.docx` its data-id/meta (and the whole graph) **without breaking it** (`src/ooxml/embed.ts`):

| mode | how | safety |
|---|---|---|
| **part** (default) | add `ocz/causal.jsonl` (id+meta+graph) to the zip; register it in `[Content_Types].xml` + root `_rels/.rels`; **existing parts are byte-identical** | ◎ opens normally in Office (verified with openpyxl on real xlsx) |
| **attrs** (opt-in) | inject `ocz:id` on docx/pptx elements + `mc:Ignorable` (markup-compatibility); docx also gets Word bookmarks `ocz1_<id>` | ○ conformant apps ignore it; re-save may normalize |

Output keeps the real extension as a double extension: `report.pptx → report.ocz.pptx`. The result **is** ordinary OOXML.

```bash
office-causal embed report.pptx                 # → report.ocz.pptx (safe part embedding)
office-causal embed report.docx --mode both     # part + attrs + Word bookmarks
office-causal embed report.ocz.xlsx --diff       # append-only differential update (git-friendly)
```
```ts
await embedFile("report.xlsx", { mode: "part" });          // → report.ocz.xlsx
const data = readDataPart(new Uint8Array(fs.readFileSync("report.ocz.xlsx")));
```

- **JSONL by default** (1 record per line) — append/partial-read/git-diff friendly; `--format json` for an atomic single-doc form. `readDataPart()` reads both.
- **Stable / idempotent**: re-embedding keeps the same ids; differential embed appends only changed records.
- **`.ocz` is self-contained**: it also carries `bbox` and optional `analysis` (see §6), so a viewer can re-render without re-analysis.

---

## 4. CausalGraph model

```ts
type EdgeKind = "contains" | "references" | "derives-from" | "mentions" | "causes";
interface Edge { id; kind; from; to; weight?; causal?: { polarity:"+"|"-"|"?"; mechanism; confidence; evidence; status } }
```
Every `causes` edge must carry **evidence** (`{nodeId, quote}[]`) + a mechanism, and goes through `hypothesis → supported | refuted` — to keep the graph auditable and reject hallucinated causality.

Export: `exportGraph(g, "json"|"graphml"|"cypher"|"dot")`.

---

## 5. Edge-LLM tiering (2 layers, cloud-free)

| role | model class | does it generate? | job |
|---|---|---|---|
| ① embedding | encoder (transformers.js) | ✗ | edge weight / data-id tags / **causal candidate shortlisting** |
| ② generation | decoder (**Gemma 4 E2B/E4B**, local) | ✓ | adjudicate causal **direction / polarity / mechanism** + adversarial **verify** |

- **No cloud / no API key.** All generation, adjudication and verification run on the local **Gemma 4** (transformers.js); only meaning needs a model, and that model is on-device.
- Embedding similarity is **undirected affinity**, not direction — direction is decided by Gemma 4 (`causal` stage).
- `llm.verify:false` skips the Gemma-4 adversarial refutation and commits the adjudication directly (faster); the default runs `verifyVotes` (3) independent refutation votes.
- Gemma 4 runs via **transformers.js v4 + WebGPU** (`dtype:"q4f16"`); auto-falls back to wasm/cpu (slow). In Node pass `llm.device:"cpu"`. See `eval/RESULTS.md` for the measured comparison (e5-base best embedder; sub-1B decoders insufficient; Gemma 4 E2B/E4B is the practical on-device tier).

---

## 6. Diagnostics, consulting & scale

**`diagnose()`** finds, mechanically:
- **isolated** — nodes never touched by causes/derives-from
- **notHolding** — refuted / low-confidence causal edges
- **notationVariants** — same concept, different surface (e.g. 売上 ≈ セールス); embedding ≥0.9 + label differs, confirmed by Gemma
- **conceptJumps** — `causes` with a large cause↔effect semantic gap (logical leap); Gemma names the missing intermediate

**`consult()`** (so-what) walks causal chains and uses Gemma to produce implication + action. **`mece()`** checks Mutually-Exclusive (overlap via embeddings) / Collectively-Exhaustive (gaps via Gemma).

**Scale (xlsx with 100k+ elements)**:
- The deterministic layer (structure + formula `derives-from` DAG) is **O(n)** (≈1.2 s for 7,200 cells).
- Embedding excludes formula/numeric cells (NL only) → semantic diagnose ≈ 49 ms for 7,200 cells.
- Notation-variant search uses **LSH** to avoid O(n²) (3,000 items in 39 ms, recall 5/5); `maxEmbed` caps with a reported `truncated` count.
- Gemma generation is bounded by candidate/chain caps.

```bash
office-causal diagnose report.ocz.pptx --gemma          # 4 diagnostics (Gemma-refined)
office-causal consult  report.ocz.pptx --mece --svg sowhat.svg   # so-what + MECE
```

---

## 7. The `.ocz` carries its analysis

`embed --analysis [--gemma]` runs diagnose (+ so-what/MECE) and embeds the result as `analysis` (with `version`, `generatedAt`, `models`). Reloading the `.ocz` restores the diagnosis colors + so-what/MECE **without recomputation**. `validatePayload()` warns on version mismatch or stale analysis (diagnosed nodes missing from the current graph).

---

## 8. Visualization — svg-causal-graph (svgraph integration)

`svgraph` renders a slide to SVG at the same coordinate system (`EMU_PER_PX=9525`) office-causal uses for `bbox`, so the causal overlay aligns exactly on the rendered slide.

```bash
office-causal diagnose report.ocz.pptx --render --chars --html \
  --drawingml ../svgraph/src --svg out.svg
```
- `renderDrawingmlSvg` / `resolveSlideRenderer` — renders the slide via svgraph; auto-detects a **TS `dml2svg`** (`OCZ_SVGRAPH_TS`) for in-process / browser use, else falls back to the Python CLI.
- `overlayCausal` — injects the causal overlay (nodes colored by diagnosis, `causes` edges with direction/polarity) into the same viewBox.
- `--chars` (`overlayCharBoxes`) — **per-character boxes + labels**: parses `<text>/<tspan>`, estimates advance (CJK=1em / latin=0.55em + letter-spacing); a 1-char tspan from a TS renderer gives exact glyph boxes. Each char maps to its owning shape's data-id.
- `--html` (`renderInteractiveHtml`) — wraps it in an HTML viewer where **clicking a char/shape/node shows data-id + causal roles** (cause/effect/depends-on/used-by) + diagnosis, plus embedded so-what/MECE.

### Web demo (`web/`)
WebGPU, no API key, no data leaves the browser:
```bash
npm run build && npm run build:web && npm run serve:web   # Chrome/Edge → web/index.html
```
- Run → **🔍 diagnose** → **💡 so-what / MECE** (WebGPU Gemma) → interactive Cytoscape graph.
- "Causal roles" tab: per-node data-id + roles, with **search, column sort, CSV export**.
- 💾 .ocz download (File System Access API) embeds the analysis for instant reload.

---

## 9. Tensor network — Document → Page → Object → Causal

A whole corpus lifts into one 4-layer **tensor network** (`src/tensor/network.ts`):

```
Document ─contains→ Page (slide/sheet/section) ─contains→ Object (shape/cell/paragraph)
         ─mentions→ Causal (entity/claim) ─causes→ Causal …
```

- Each node = a tensor; **rank** = number of incident bonds. Each edge = a **bond** with dimension χ (structural `contains`/`references`/`derives-from`/`mentions` = 1; **`causes` = 3** to encode polarity `+/-/?`). Physical index dim = a node's tag count.
- `causes` and same-concept `references` bonds connect entities **across documents**, so the corpus forms a single causal cluster. `toTensorNetwork(graph)` reports `perLayer`, `maxRank`, `χ-params` (Σ physDim·Π χ), `causalComponents`, `crossDocCauses` and a min-degree contraction order (structure only — no numeric contraction).
- `renderTensorNetworkSvg(tn)` draws the 4 bands; cross-document `causes` are bold dashed.

```ts
import { analyze, toTensorNetwork, renderTensorNetworkSvg } from "@com-junkawasaki/office-causal";
const tn = toTensorNetwork(graph);          // CausalGraph → TensorNetwork
fs.writeFileSync("tn.svg", renderTensorNetworkSvg(tn));
```

**Sample corpus** — `npm run build && npm run gen:sample-data` writes real OOXML (round-trip-verified by the parser) + fixtures to [`examples/sample-data/`](examples/sample-data):

| files | pages each | objects | entities |
|---|---|---|---|
| 3 × `.pptx` | 10 slides | 30 shapes | — |
| 3 × `.docx` | 3 pages | paragraphs | — |
| 3 × `.xlsx` | 3 sheets | cells (+ formulas) | — |

→ tensor network of **210 nodes** (doc 9 / page 48 / object 114 / causal 39), 339 bonds, **1 causal component**, 5 cross-document causes. Live example: [tensor-network.svg](https://com-junkawasaki.github.io/office-causal/examples/tensor-network.svg).

---

## 10. Design decisions (ADR)

- [ADR-0001](docs/adr/0001-causal-graph-ir.md) — single CausalGraph IR / deterministic-vs-LLM split / content-addressed data-id / evidence-required causal edges
- [ADR-0002](docs/adr/0002-local-embeddings.md) — transformers.js local model for edge weights & tagging
- [ADR-0003](docs/adr/0003-edge-llm-tiering.md) — edge-LLM tiering (embedding → local Gemma 4/WebGPU adjudication + verify), cloud-free, with measurements
- [ADR-0004](docs/adr/0004-ooxml-embedding.md) — non-destructive OOXML embedding (OPC-compliant part / attrs / bookmarks / JSONL / diff / deep-link)
- [ADR-0005](docs/adr/0005-tensor-network.md) — corpus as a 4-layer tensor network (Document → Page → Object → Causal; bonds with χ; cross-document causes)
- [ADR-0006](docs/adr/0006-browser-demo-stack.md) — browser demo on Svelte + Vite, GitHub Pages, transparent WebGPU→WASM fallback, transformers external via importmap

---

## Scripts

```bash
npm run check      # tsc type-check
npm run build      # → dist/
npm run build:web  # → web/*.js
npm run eval:embed # embedding-model benchmark
npm run eval:gen   # generative edge-LLM benchmark
```

MIT License.
