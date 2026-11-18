import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					CF_API_TOKEN: "test-token",
					DDNS_CLIENTS: JSON.stringify({
						"wan1-router": {
							password: "correct-horse-battery-staple",
							zone_id: "0123456789abcdef0123456789abcdef",
							hostnames: ["wan1.example.com"],
						},
						"wan2-router": {
							password: "another-long-random-password",
							zone_id: "0123456789abcdef0123456789abcdef",
							hostnames: ["wan2.example.com", "WAN2-alt.example.com."],
						},
					}),
				},
			},
		}),
	],
});
