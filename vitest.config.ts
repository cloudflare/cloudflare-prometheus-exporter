import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"cloudflare:workers": new URL(
				"./src/test/cloudflare-workers.ts",
				import.meta.url,
			).pathname,
		},
	},
});
