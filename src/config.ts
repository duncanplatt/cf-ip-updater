export interface DdnsClient {
	password: string;
	zoneId: string;
	hostnames: Set<string>;
}

export type ClientMap = Map<string, DdnsClient>;

export class ConfigError extends Error {}

/**
 * Parses the DDNS_CLIENTS secret. Expected shape:
 *
 * {
 *   "<username>": {
 *     "password": "<long random string>",
 *     "zone_id": "<Cloudflare zone ID>",
 *     "hostnames": ["wan1.example.com"]
 *   }
 * }
 */
export function parseClients(raw: string | undefined): ClientMap {
	if (!raw) throw new ConfigError("DDNS_CLIENTS is not set");

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new ConfigError("DDNS_CLIENTS is not valid JSON");
	}
	if (!isRecord(data)) throw new ConfigError("DDNS_CLIENTS must be a JSON object");

	const clients: ClientMap = new Map();
	for (const [username, value] of Object.entries(data)) {
		if (!isRecord(value)) throw new ConfigError(`client "${username}" must be an object`);
		const { password, zone_id: zoneId, hostnames } = value;
		if (typeof password !== "string" || password.length < 16) {
			throw new ConfigError(`client "${username}" needs a password of at least 16 characters`);
		}
		if (typeof zoneId !== "string" || !/^[0-9a-f]{32}$/.test(zoneId)) {
			throw new ConfigError(`client "${username}" needs a 32-character hex zone_id`);
		}
		if (!Array.isArray(hostnames) || hostnames.length === 0 || !hostnames.every((h) => typeof h === "string")) {
			throw new ConfigError(`client "${username}" needs a non-empty hostnames array`);
		}
		clients.set(username, {
			password,
			zoneId,
			hostnames: new Set(hostnames.map(normalizeHostname)),
		});
	}
	if (clients.size === 0) throw new ConfigError("DDNS_CLIENTS has no clients");
	return clients;
}

export function normalizeHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
