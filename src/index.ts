import { authenticate, readCredentials } from "./auth";
import { CloudflareApiError, CloudflareDns } from "./cloudflare";
import { ConfigError, normalizeHostname, parseClients } from "./config";
import { isPublicIp, parseIp, sameIp, type ParsedIp } from "./ip";

// /nic/update is the DynDNS2 path, so generic DDNS clients (ddclient, inadyn) also work.
const ENDPOINTS = new Set(["/v1/ddns/heartbeat", "/nic/update"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (!ENDPOINTS.has(url.pathname)) return reply(404, "notfound");
		if (request.method !== "GET" && request.method !== "POST") return reply(405, "badmethod");
		if (url.protocol !== "https:" && !LOCAL_HOSTS.has(url.hostname)) {
			log("warn", { event: "insecure_request" });
			return reply(403, "httpsrequired");
		}

		try {
			return await handleUpdate(request, url.searchParams, env);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof ConfigError) {
				log("error", { event: "config_error", error: message });
			} else if (error instanceof CloudflareApiError) {
				log("error", { event: "cloudflare_api_error", status: error.status, error: message });
				return reply(502, "911");
			} else {
				log("error", { event: "unhandled_error", error: message });
			}
			return reply(500, "911");
		}
	},
} satisfies ExportedHandler<Env>;

async function handleUpdate(request: Request, params: URLSearchParams, env: Env): Promise<Response> {
	const clients = parseClients(env.DDNS_CLIENTS);

	const creds = readCredentials(request, params);
	const client = creds ? await authenticate(clients, creds) : null;
	if (!creds || !client) {
		log("warn", { event: "auth_failed", username: creds?.username ?? null });
		return reply(401, "badauth", { "WWW-Authenticate": 'Basic realm="ddns", charset="UTF-8"' });
	}

	const rawHostname = params.get("domain") ?? params.get("hostname");
	if (!rawHostname) return reply(400, "notfqdn");
	const hostname = normalizeHostname(rawHostname);
	if (!client.hostnames.has(hostname)) {
		log("warn", { event: "hostname_not_allowed", username: creds.username, hostname });
		return reply(403, "nohost");
	}

	const resolved = resolveIp(request, params);
	if (!resolved) {
		log("warn", { event: "bad_ip", username: creds.username, hostname, ip: params.get("ip") ?? params.get("myip") });
		return reply(400, "badip");
	}
	const { ip, source } = resolved;

	const dns = new CloudflareDns(env.CF_API_TOKEN, client.zoneId);
	const type = ip.version === 4 ? "A" : "AAAA";
	const records = await dns.findRecords(type, hostname);

	if (records.length > 1) {
		log("error", { event: "multiple_records", hostname, type, count: records.length });
		return reply(409, "dnserr");
	}

	const existing = records[0];
	if (existing) {
		const current = parseIp(existing.content);
		if (current && sameIp(current, ip)) {
			log("info", { event: "unchanged", username: creds.username, hostname, type, ip: ip.text, source });
			return reply(200, `nochg ${ip.text}`);
		}
		await dns.updateContent(existing.id, ip.text);
		log("info", { event: "updated", username: creds.username, hostname, type, from: existing.content, ip: ip.text, source });
	} else {
		await dns.createRecord(type, hostname, ip.text);
		log("info", { event: "created", username: creds.username, hostname, type, ip: ip.text, source });
	}
	return reply(200, `good ${ip.text}`);
}

/**
 * Prefers the IP the router reports. Falls back to the address the request arrived from
 * when the router omits it or reports a private one (e.g. a WAN behind a modem doing NAT).
 * A private IPv4 only falls back to an IPv4 source (and likewise for IPv6), so a request
 * that happens to arrive over the other protocol can't update the wrong record type.
 */
function resolveIp(
	request: Request,
	params: URLSearchParams,
): { ip: ParsedIp; source: "param" | "connection" } | null {
	const raw = params.get("ip") ?? params.get("myip");
	let requiredVersion: 4 | 6 | null = null;
	if (raw?.trim()) {
		const parsed = parseIp(raw);
		if (!parsed) return null;
		if (isPublicIp(parsed)) return { ip: parsed, source: "param" };
		requiredVersion = parsed.version;
	}

	const connecting = request.headers.get("CF-Connecting-IP");
	const parsed = connecting ? parseIp(connecting) : null;
	if (!parsed || !isPublicIp(parsed)) return null;
	if (requiredVersion && parsed.version !== requiredVersion) return null;
	return { ip: parsed, source: "connection" };
}

function reply(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(`${body}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
	});
}

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>): void {
	console[level](JSON.stringify(fields));
}
