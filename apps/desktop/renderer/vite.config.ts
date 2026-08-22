import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(import.meta.dirname),
	// The packaged Electron renderer is loaded from file://, so assets must be
	// relative to index.html instead of resolving from the filesystem root.
	base: "./",
	plugins: [react()],
	server: { port: 5173, strictPort: true },
	build: { outDir: resolve(import.meta.dirname, "../dist/renderer"), emptyOutDir: true },
});
