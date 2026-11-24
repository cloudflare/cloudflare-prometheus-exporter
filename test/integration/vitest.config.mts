import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath:
					process.env.COLO_TEST_CONFIG ??
					"./test/integration/wrangler.test.jsonc",
			},
		}),
	],
	test: {
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
