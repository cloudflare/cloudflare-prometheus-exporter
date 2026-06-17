import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:workers": new URL(
				"./src/test/cloudflare-workers.ts",
				import.meta.url,
			).pathname,
		},
	},
});
