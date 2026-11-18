import type { ClientMap, DdnsClient } from "./config";

export interface Credentials {
	username: string;
	password: string;
}

/**
 * Routers that take `https://user:pass@host/...` URLs normally send the login as an
 * HTTP Basic Authorization header. Some send it as query parameters instead.
 */
export function readCredentials(request: Request, params: URLSearchParams): Credentials | null {
	const header = request.headers.get("Authorization");
	if (header?.toLowerCase().startsWith("basic ")) {
		let decoded: string;
		try {
			const bytes = Uint8Array.from(atob(header.slice(6).trim()), (c) => c.charCodeAt(0));
			decoded = new TextDecoder().decode(bytes);
		} catch {
			return null;
		}
		const sep = decoded.indexOf(":");
		if (sep === -1) return null;
		return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
	}

	const username = params.get("username") ?? params.get("user");
	const password = params.get("password") ?? params.get("pass");
	if (username && password) return { username, password };
	return null;
}

export async function authenticate(clients: ClientMap, creds: Credentials): Promise<DdnsClient | null> {
	const client = clients.get(creds.username);
	// Compare against a placeholder for unknown users so timing doesn't reveal which usernames exist.
	const expected = client?.password ?? "\u0000unknown-user\u0000";
	const ok = await timingSafeStringEqual(creds.password, expected);
	return ok && client ? client : null;
}

async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}
