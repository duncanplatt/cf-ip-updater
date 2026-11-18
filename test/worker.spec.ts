import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

interface FakeRecord {
	id: string;
	type: string;
	name: string;
	content: string;
}

let records: FakeRecord[];
let apiCalls: Array<{ method: string; url: string; body: unknown }>;

function fakeCloudflareApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : input.toString());
	const method = init?.method ?? "GET";
	const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
	apiCalls.push({ method, url: url.toString(), body });

	const ok = (result: unknown) => Promise.resolve(Response.json({ success: true, errors: [], result }));
	const match = url.pathname.match(/^\/client\/v4\/zones\/[^/]+\/dns_records(?:\/([^/]+))?$/);
	if (!match) return Promise.resolve(Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 }));

	if (method === "GET") {
		const type = url.searchParams.get("type");
		const name = url.searchParams.get("name.exact");
		return ok(records.filter((r) => r.type === type && r.name === name));
	}
	if (method === "PATCH") {
		const record = records.find((r) => r.id === match[1]);
		if (!record) return Promise.resolve(Response.json({ success: false, errors: [{ code: 81044, message: "not found" }] }, { status: 404 }));
		record.content = body.content;
		return ok(record);
	}
	if (method === "POST") {
		const record = { id: `rec-${records.length + 1}`, type: body.type, name: body.name, content: body.content };
		records.push(record);
		return ok(record);
	}
	return Promise.resolve(new Response("unexpected", { status: 500 }));
}

function basic(username: string, password: string): string {
	return `Basic ${btoa(`${username}:${password}`)}`;
}

function heartbeat(query: string, headers: Record<string, string> = {}): Promise<Response> {
	const request = new IncomingRequest(`https://ddns.example.com/v1/ddns/heartbeat?${query}`, { headers });
	return worker.fetch(request, env);
}

const WAN1_AUTH = { Authorization: basic("wan1-router", "correct-horse-battery-staple") };

beforeEach(() => {
	records = [{ id: "rec-a", type: "A", name: "wan1.example.com", content: "198.51.99.1" }];
	apiCalls = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(fakeCloudflareApi);
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("routing", () => {
	it("returns 404 for unknown paths", async () => {
		const response = await worker.fetch(new IncomingRequest("https://ddns.example.com/"), env);
		expect(response.status).toBe(404);
	});

	it("rejects other methods", async () => {
		const request = new IncomingRequest("https://ddns.example.com/v1/ddns/heartbeat", { method: "DELETE" });
		const response = await worker.fetch(request, env);
		expect(response.status).toBe(405);
	});

	it("refuses plain HTTP so passwords are never accepted in cleartext", async () => {
		const request = new IncomingRequest("http://ddns.example.com/v1/ddns/heartbeat?domain=wan1.example.com", {
			headers: WAN1_AUTH,
		});
		const response = await worker.fetch(request, env);
		expect(response.status).toBe(403);
		expect(apiCalls).toHaveLength(0);
	});
});

describe("authentication", () => {
	it("challenges requests without credentials", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=8.8.8.8");
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
		expect(apiCalls).toHaveLength(0);
	});

	it("rejects a wrong password", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=8.8.8.8", {
			Authorization: basic("wan1-router", "wrong-password-value"),
		});
		expect(response.status).toBe(401);
		expect(apiCalls).toHaveLength(0);
	});

	it("rejects an unknown user", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=8.8.8.8", {
			Authorization: basic("nobody", "correct-horse-battery-staple"),
		});
		expect(response.status).toBe(401);
	});

	it("accepts credentials as query parameters", async () => {
		const response = await heartbeat(
			"domain=wan1.example.com&ip=8.8.8.8&username=wan1-router&password=correct-horse-battery-staple",
		);
		expect(response.status).toBe(200);
	});
});

describe("hostname allowlist", () => {
	it("refuses hostnames the client is not allowed to update", async () => {
		const response = await heartbeat("domain=wan2.example.com&ip=8.8.8.8", WAN1_AUTH);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("nohost\n");
		expect(apiCalls).toHaveLength(0);
	});

	it("refuses the apex or other records in the zone", async () => {
		const response = await heartbeat("domain=example.com&ip=8.8.8.8", WAN1_AUTH);
		expect(response.status).toBe(403);
	});

	it("matches case-insensitively and ignores a trailing dot", async () => {
		records.push({ id: "rec-b", type: "A", name: "wan2-alt.example.com", content: "8.8.4.4" });
		const response = await heartbeat("domain=WAN2-ALT.example.com.&ip=8.8.4.4", {
			Authorization: basic("wan2-router", "another-long-random-password"),
		});
		expect(await response.text()).toBe("nochg 8.8.4.4\n");
	});

	it("requires a hostname", async () => {
		const response = await heartbeat("ip=8.8.8.8", WAN1_AUTH);
		expect(response.status).toBe(400);
	});
});

describe("updates", () => {
	it("updates the A record when the IP changed", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=8.8.8.8", WAN1_AUTH);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("good 8.8.8.8\n");
		expect(records[0].content).toBe("8.8.8.8");
		expect(apiCalls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
		expect(apiCalls[1].body).toEqual({ content: "8.8.8.8" });
	});

	it("only reads when the IP is unchanged", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=198.51.99.1", WAN1_AUTH);
		expect(await response.text()).toBe("nochg 198.51.99.1\n");
		expect(apiCalls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("creates the record if it does not exist", async () => {
		records = [];
		const response = await heartbeat("domain=wan1.example.com&ip=8.8.8.8", WAN1_AUTH);
		expect(await response.text()).toBe("good 8.8.8.8\n");
		expect(apiCalls[1]).toMatchObject({ method: "POST", body: { type: "A", name: "wan1.example.com", proxied: false } });
	});

	it("uses an AAAA record for IPv6", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=2606:4700:0:0::1", WAN1_AUTH);
		expect(await response.text()).toBe("good 2606:4700::1\n");
		expect(records.find((r) => r.type === "AAAA")?.content).toBe("2606:4700::1");
	});

	it("accepts DynDNS2 parameter names on /nic/update", async () => {
		const request = new IncomingRequest("https://ddns.example.com/nic/update?hostname=wan1.example.com&myip=8.8.8.8", {
			headers: WAN1_AUTH,
		});
		const response = await worker.fetch(request, env);
		expect(await response.text()).toBe("good 8.8.8.8\n");
	});

	it("refuses to guess when several records match", async () => {
		records.push({ id: "rec-dup", type: "A", name: "wan1.example.com", content: "1.1.1.1" });
		const response = await heartbeat("domain=wan1.example.com&ip=8.8.8.8", WAN1_AUTH);
		expect(response.status).toBe(409);
		expect(apiCalls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("returns 502 when the Cloudflare API fails", async () => {
		vi.mocked(fetch).mockImplementation(() =>
			Promise.resolve(Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 })),
		);
		const response = await heartbeat("domain=wan1.example.com&ip=8.8.8.8", WAN1_AUTH);
		expect(response.status).toBe(502);
	});
});

describe("IP selection", () => {
	it("falls back to the connecting IP when the router reports a private address", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=192.168.0.2", {
			...WAN1_AUTH,
			"CF-Connecting-IP": "8.8.4.4",
		});
		expect(await response.text()).toBe("good 8.8.4.4\n");
	});

	it("does not switch IP version when falling back from a private address", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=192.168.0.2", {
			...WAN1_AUTH,
			"CF-Connecting-IP": "2606:4700::1",
		});
		expect(response.status).toBe(400);
		expect(apiCalls).toHaveLength(0);
	});

	it("falls back to the connecting IP when no IP is given", async () => {
		const response = await heartbeat("domain=wan1.example.com", { ...WAN1_AUTH, "CF-Connecting-IP": "8.8.4.4" });
		expect(await response.text()).toBe("good 8.8.4.4\n");
	});

	it("rejects malformed IPs", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=not-an-ip", {
			...WAN1_AUTH,
			"CF-Connecting-IP": "8.8.4.4",
		});
		expect(response.status).toBe(400);
		expect(apiCalls).toHaveLength(0);
	});

	it("rejects when no public IP is available", async () => {
		const response = await heartbeat("domain=wan1.example.com&ip=10.0.0.2", WAN1_AUTH);
		expect(response.status).toBe(400);
	});
});
