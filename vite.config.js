import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// Svelte + Vite demo。GitHub Pages の /office-causal/demo/ 配下で配信する。
// @huggingface/transformers のみ external (importmap 経由で CDN から実行時ロード; モデル DL も含む)。
export default defineConfig({
  root: "web",
  base: "/office-causal/demo/",
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { external: ["@huggingface/transformers"] },
  },
});
