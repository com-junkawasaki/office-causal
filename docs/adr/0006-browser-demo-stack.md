# ADR-0006: ブラウザデモを Svelte + Vite で構築し GitHub Pages に配信する

- Status: Accepted
- Date: 2026-06-22
- Context: `com-junkawasaki/office-causal`（ADR-0002/0003 のローカル実行方針をデモへ）

## 背景

デモは「OOXML ドロップ → その場で因果解析 → 対話描画」を **API キーなし・データ非送信**で行う。
解析は office-causal の実コード（`dist/`）を再利用し、UI だけを整える。
初期はビルドレスの importmap + vanilla TS（`web/app.ts`）だったが、UI を整理しつつ
**ユーザーに WebGPU/WASM を意識させない**透過実行にしたい。

## 決定

### D1. Svelte 5 + Vite 8 + Tailwind v4

解析ロジックは framework 非依存の `web/src/engine.ts` に集約（旧 `app.ts` から移植、機能不変:
OOXML/テキスト → 構造 → 埋め込み → Gemma 裁定 → Cytoscape 描画、診断 / so-what / MECE / `.ocz`）。
UI は `web/src/App.svelte`（Apple HIG）。状態は Svelte が、描画とパネルは engine が持つ。

### D2. 重いモデルだけ external（importmap / CDN）、他はバンドル

`@huggingface/transformers` のみ `rollupOptions.external` + index.html の **importmap** で CDN から実行時ロード
（巨大 + モデル DL を伴う + dist 内で動的 `import(specifier)`）。
`cytoscape` / `fflate` / `fast-xml-parser` と自前 `dist` は Vite がバンドルする。

### D3. WebGPU を自動検出し WASM へ透過フォールバック

`navigator.gpu.requestAdapter()` まで確認して判定し、無ければ `device:"wasm"` で実行
（候補数・`max_new_tokens` を自動で絞る）。UI は device を選ばせず、ヘッダに
「ローカル実行 · GPU/CPU」を控えめ表示、CPU 時のみ低速注記を出す。**ユーザーは WebGPU/WASM を意識しない。**

### D4. GitHub Pages 配信（base パス + 静的出力）

`base: "/office-causal/demo/"` で Pages 配下に出す。Pages workflow が `vite build` し
**`web/dist` を `_site/demo` へ**配置。モデルは実行時に CDN から fetch するため静的配信で完結する。
**制約**: COOP/COEP ヘッダは Pages で設定不可 → WASM は SharedArrayBuffer 無し（シングルスレッド）。
動作はするが遅い。WebGPU(HTTPS 必須＝Pages は HTTPS)では高速。

### D5. CI/Pages は `npm ci`（optional 必須）

Vite 8 は **rolldown**(Rust)を使い、プラットフォーム固有のネイティブ binding を
`optionalDependencies` として持つ。`npm ci --omit=optional` だと
`@rolldown/binding-linux-x64-gnu` が入らず `vite build` が失敗するため、`--omit=optional` は使わない
（lockfile に全プラットフォームの binding が記録され、`npm ci` が現環境向けを入れる）。

## 帰結

- ✅ ビルド済み静的アセット + 実行時 CDN モデルで、Pages 上で **アップロード→解析→出力**が完結。
- ✅ UI を Apple HIG に刷新、device 選択不要の透過実行。実機で text→埋め込み(13候補)→Gemma DL を確認。
- ⚠ WASM はシングルスレッドで低速、初回モデル DL が大きい（Chrome/Edge の WebGPU 推奨）。
- ⚠ ランディング（`docs/site`）は Tailwind Play CDN、デモは Vite ビルドと手段が分かれる。

## 参考

- `vite.config.js` / `web/svelte.config.js` / `web/src/{App.svelte,engine.ts,main.ts,app.css}`
- `.github/workflows/pages.yml`（vite build → `_site/demo`）、`.github/workflows/ci.yml`
