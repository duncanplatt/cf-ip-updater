const API_BASE = "https://api.cloudflare.com/client/v4";

export type RecordType = "A" | "AAAA";

export interface DnsRecord {
	id: string;
	type: string;
	name: string;
	content: string;
}

interface ApiEnvelope<T> {
	success: boolean;
	errors?: Array<{ code: number; message: string }>;
	result: T;
}

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export class CloudflareDns {
	constructor(
		private readonly token: string,
		private readonly zoneId: string,
	) {}

	async findRecords(type: RecordType, name: string): Promise<DnsRecord[]> {
		const query = new URLSearchParams({ type, "name.exact": name, per_page: "5" });
		return this.call<DnsRecord[]>("GET", `/dns_records?${query}`);
	}

	async updateContent(recordId: string, content: string): Promise<DnsRecord> {
		return this.call<DnsRecord>("PATCH", `/dns_records/${encodeURIComponent(recordId)}`, { content });
	}

	async createRecord(type: RecordType, name: string, content: string): Promise<DnsRecord> {
		return this.call<DnsRecord>("POST", "/dns_records", {
			type,
			name,
			content,
			ttl: 60,
			proxied: false,
			comment: "Managed by cf-ip-updater",
		});
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${API_BASE}/zones/${encodeURIComponent(this.zoneId)}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		let payload: ApiEnvelope<T> | null = null;
		try {
			payload = await response.json<ApiEnvelope<T>>();
		} catch {
			// Non-JSON error page; reported below.
		}
		if (!response.ok || !payload?.success) {
			const detail = payload?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || response.statusText;
			throw new CloudflareApiError(`Cloudflare API ${method} failed (${response.status}): ${detail}`, response.status);
		}
		return payload.result;
	}
}
