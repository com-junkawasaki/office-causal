<script lang="ts">
  import { onMount } from "svelte";
  import { Engine, type Device } from "./engine";

  let graphEl = $state<HTMLDivElement>();
  let panelEl = $state<HTMLDivElement>();
  let rolesEl = $state<HTMLDivElement>();
  let engine: Engine;

  let status = $state("");
  let busy = $state(false);
  let device = $state<Device | null>(null);
  let fileName = $state<string | null>(null);
  let fileEmbedded = $state(false);
  let logLines = $state<string[]>([]);
  let tab = $state<"graph" | "roles">("graph");
  let over = $state(false);
  let logOpen = $state(false);
  let text = $state(
    `第1四半期は売上が大きく増加した。\n原材料価格が世界的に高騰した。\n自社の製造コストが大幅に上昇した。\n採算確保のため製品の販売価格を引き上げた。\n値上げの影響で販売数量が落ち込んだ。\n競合他社が大規模な値下げキャンペーンを実施した。\n当社の市場シェアが低下した。\n四半期の営業利益は前年から悪化した。`
  );

  onMount(() => {
    engine = new Engine({
      graphEl: graphEl!, panelEl: panelEl!,
      onLog: (m) => (logLines = [...logLines, m]),
      onStatus: (s, b) => { status = s; busy = b; },
      onDevice: (d) => (device = d),
      onFile: (name, emb) => { fileName = name; fileEmbedded = emb; },
    });
    engine.detect();
  });

  const guard = (p: Promise<unknown>) => p.catch((e: any) => (logLines = [...logLines, "ERROR: " + (e?.message ?? e)]));
  function run() { logLines = []; guard(engine.run(text)); }
  function pickFile(e: Event) { const f = (e.target as HTMLInputElement).files?.[0]; if (f) engine.setFile(f); }
  function onDrop(e: DragEvent) { e.preventDefault(); over = false; const f = e.dataTransfer?.files?.[0]; if (f) engine.setFile(f); }
  function clearFile() { engine.clearFile(); }
  function toGraph() { tab = "graph"; }
  function toRoles() { tab = "roles"; queueMicrotask(() => rolesEl && engine.renderRoles(rolesEl)); }
</script>

<header class="sticky top-0 z-50 border-b border-black/[0.06] bg-[#fbfbfd]/80 backdrop-blur-xl dark:border-white/[0.08] dark:bg-black/70">
  <div class="mx-auto flex h-12 max-w-6xl items-center justify-between px-5">
    <div class="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
      office-causal <span class="rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent dark:text-accent-dark">demo</span>
    </div>
    <div class="flex items-center gap-3 text-[13px]">
      {#if device}
        <span class="hidden items-center gap-1.5 text-ink2 text-zinc-500 sm:flex dark:text-zinc-400">
          <span class="inline-block h-1.5 w-1.5 rounded-full {device === 'webgpu' ? 'bg-green-500' : 'bg-amber-500'}"></span>
          ローカル実行 · {device === "webgpu" ? "GPU" : "CPU"}
        </span>
      {/if}
      <a class="text-zinc-500 transition hover:text-ink dark:text-zinc-400 dark:hover:text-white" href="../">← Home</a>
    </div>
  </div>
</header>

<main class="mx-auto max-w-6xl px-5 py-10">
  <h1 class="text-[28px] font-semibold tracking-tight sm:text-[36px]">ブラウザ内で因果グラフ解析</h1>
  <p class="mt-2 max-w-2xl text-[16px] leading-relaxed text-zinc-500 dark:text-zinc-400">
    <code class="rounded bg-black/[0.06] px-1.5 py-0.5 text-[0.85em] dark:bg-white/10">.pptx / .xlsx / .docx</code> を入れて Run。OOXML 解析 → 意味埋め込み → 因果の向き・極性を裁定し、対話グラフで表示します。
    <b class="text-ink dark:text-white">すべて端末内で完結</b>（アップロードなし・APIキー不要）。
  </p>

  <!-- input card -->
  <div class="mt-7 rounded-3xl border border-black/[0.06] bg-white/70 p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.06)] backdrop-blur dark:border-white/[0.08] dark:bg-white/[0.04]">
    <div
      role="button" tabindex="0"
      class="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-7 text-center transition {over ? 'border-accent bg-accent/5' : 'border-black/10 bg-black/[0.02] dark:border-white/15 dark:bg-white/[0.03]'}"
      ondragover={(e) => { e.preventDefault(); over = true; }}
      ondragleave={() => (over = false)}
      ondrop={onDrop}
    >
      {#if fileName}
        <p class="text-[15px] font-medium">📄 {fileName}</p>
        <p class="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{fileEmbedded ? "✓ 埋め込み済み (.ocz) — Run で再解析せず即描画" : "Run で解析します（テキスト入力は無視）"}</p>
        <button class="mt-2 text-[13px] text-accent dark:text-accent-dark" onclick={clearFile}>ファイルを外す</button>
      {:else}
        <p class="text-[15px]">ここに <b>.pptx / .xlsx / .docx</b> をドロップ</p>
        <label class="mt-2 cursor-pointer rounded-full border border-black/10 bg-white px-4 py-1.5 text-[13px] font-medium transition hover:bg-black/[0.03] dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10">
          ファイルを選択<input type="file" accept=".xlsx,.pptx,.docx" class="hidden" onchange={pickFile} />
        </label>
      {/if}
    </div>

    <p class="mt-4 mb-1 text-[13px] text-zinc-500 dark:text-zinc-400">またはテキスト（1行 = 1文）</p>
    <textarea bind:value={text} rows="6" class="w-full resize-y rounded-2xl border border-black/10 bg-white/60 p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-accent dark:border-white/15 dark:bg-black/30"></textarea>

    <div class="mt-4 flex flex-wrap items-center gap-2.5">
      <button onclick={run} disabled={busy} class="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-white transition hover:bg-[#0077ed] active:scale-[0.97] disabled:opacity-50 dark:bg-accent-dark dark:text-black">
        {#if busy}<span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-black/40 dark:border-t-black"></span>{/if}
        Run（解析）
      </button>
      <button onclick={() => guard(engine.runDiagnose())} disabled={busy} class="rounded-full border border-black/10 bg-white/70 px-5 py-2.5 text-sm font-medium transition hover:bg-black/[0.03] active:scale-[0.97] disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10">🔍 診断</button>
      <button onclick={() => guard(engine.runConsult())} disabled={busy} class="rounded-full border border-black/10 bg-white/70 px-5 py-2.5 text-sm font-medium transition hover:bg-black/[0.03] active:scale-[0.97] disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10">💡 so-what / MECE</button>
      <button onclick={() => guard(engine.downloadOcz())} disabled={busy} class="rounded-full border border-black/10 bg-white/70 px-5 py-2.5 text-sm font-medium transition hover:bg-black/[0.03] active:scale-[0.97] disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10">💾 .ocz 書き出し</button>
      {#if status}
        <span class="ml-auto flex items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400">
          {#if busy}<span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-400/40 border-t-zinc-500"></span>{/if}{status}
        </span>
      {/if}
    </div>
    {#if device === "wasm"}
      <p class="mt-3 text-[12px] text-amber-700 dark:text-amber-400">この環境では CPU で実行します（WebGPU 非対応）。初回はモデル取得に時間がかかり、因果裁定はやや低速です。Chrome / Edge だと高速です。</p>
    {/if}
  </div>

  <!-- graph + panel -->
  <div class="mt-6 rounded-3xl border border-black/[0.06] bg-white/70 p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.06)] backdrop-blur dark:border-white/[0.08] dark:bg-white/[0.04]">
    <div class="mb-3 flex items-center gap-1.5 px-1">
      <button onclick={toGraph} class="rounded-full px-3.5 py-1.5 text-[13px] font-medium transition {tab === 'graph' ? 'bg-accent text-white dark:bg-accent-dark dark:text-black' : 'text-zinc-500 hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/10'}">因果グラフ</button>
      <button onclick={toRoles} class="rounded-full px-3.5 py-1.5 text-[13px] font-medium transition {tab === 'roles' ? 'bg-accent text-white dark:bg-accent-dark dark:text-black' : 'text-zinc-500 hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/10'}">因果ロール一覧</button>
      <span class="ml-2 hidden items-center gap-3 text-[11px] text-zinc-400 sm:flex">
        <span class="text-[#e22]">━ causes</span><span class="text-[#2a2]">━ derives-from</span><span class="text-[#39f]">━ references</span><span>線の太さ = weight</span>
      </span>
    </div>
    <div class="grid gap-3 lg:grid-cols-[1fr_320px]">
      <div class="relative h-[560px] overflow-hidden rounded-2xl border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-[#0d1117]">
        <div bind:this={graphEl} class="absolute inset-0 {tab === 'graph' ? '' : 'invisible'}"></div>
        <div bind:this={rolesEl} class="roles absolute inset-0 overflow-auto p-3 text-[12px] {tab === 'roles' ? '' : 'hidden'}"></div>
      </div>
      <div bind:this={panelEl} class="panel h-[560px] overflow-auto rounded-2xl border border-black/[0.06] bg-black/[0.015] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
        <span class="text-sm text-zinc-400">ノードやエッジをクリックすると詳細が表示されます。</span>
      </div>
    </div>
  </div>

  <!-- log -->
  <details bind:open={logOpen} class="mt-5 rounded-2xl border border-black/[0.06] bg-white/60 dark:border-white/[0.08] dark:bg-white/[0.03]">
    <summary class="cursor-pointer select-none px-4 py-2.5 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">ログ {logLines.length ? `(${logLines.length})` : ""}</summary>
    <pre class="max-h-64 overflow-auto rounded-b-2xl bg-[#0b0f17] p-4 text-[12px] leading-relaxed text-[#b9f]">{logLines.join("\n")}</pre>
  </details>
</main>
