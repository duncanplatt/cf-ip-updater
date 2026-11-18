export type ParsedIp =
	| { version: 4; parts: number[]; text: string }
	| { version: 6; parts: number[]; text: string };

export function parseIp(input: string): ParsedIp | null {
	const value = input.trim();
	if (value.includes(":")) {
		const parts = parseIPv6(value);
		return parts ? { version: 6, parts, text: formatIPv6(parts) } : null;
	}
	const parts = parseIPv4(value);
	return parts ? { version: 4, parts, text: parts.join(".") } : null;
}

export function sameIp(a: ParsedIp, b: ParsedIp): boolean {
	return a.version === b.version && a.parts.every((part, i) => part === b.parts[i]);
}

export function isPublicIp(ip: ParsedIp): boolean {
	return ip.version === 4 ? isPublicIPv4(ip.parts) : isPublicIPv6(ip.parts);
}

function parseIPv4(value: string): number[] | null {
	const octets = value.split(".");
	if (octets.length !== 4) return null;
	const parts: number[] = [];
	for (const octet of octets) {
		// Reject leading zeros: "010" is octal in some parsers and decimal in others.
		if (!/^(0|[1-9]\d{0,2})$/.test(octet)) return null;
		const n = Number(octet);
		if (n > 255) return null;
		parts.push(n);
	}
	return parts;
}

function parseIPv6(value: string): number[] | null {
	if (value.includes("%")) return null;

	const halves = value.split("::");
	if (halves.length > 2) return null;

	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

	// An embedded IPv4 address (e.g. ::ffff:192.0.2.1) may only be the final group.
	const lastList = halves.length === 2 ? tail : head;
	let embeddedV4: number[] | null = null;
	if (lastList[lastList.length - 1]?.includes(".")) {
		embeddedV4 = parseIPv4(lastList.pop() as string);
		if (!embeddedV4) return null;
	}

	const toHextets = (list: string[]): number[] | null => {
		const out: number[] = [];
		for (const group of list) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
			out.push(parseInt(group, 16));
		}
		return out;
	};

	const headHex = toHextets(head);
	const tailHex = toHextets(tail);
	if (!headHex || !tailHex) return null;
	if (embeddedV4) {
		(halves.length === 2 ? tailHex : headHex).push(
			(embeddedV4[0] << 8) | embeddedV4[1],
			(embeddedV4[2] << 8) | embeddedV4[3],
		);
	}

	const explicit = headHex.length + tailHex.length;
	if (halves.length === 1) {
		return explicit === 8 ? [...headHex, ...tailHex] : null;
	}
	if (explicit > 7) return null;
	return [...headHex, ...new Array<number>(8 - explicit).fill(0), ...tailHex];
}

function formatIPv6(parts: number[]): string {
	// RFC 5952: compress the longest run (length >= 2) of zero groups, leftmost on ties.
	let bestStart = -1;
	let bestLen = 0;
	for (let i = 0; i < 8; ) {
		if (parts[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < 8 && parts[j] === 0) j++;
		if (j - i > bestLen) {
			bestStart = i;
			bestLen = j - i;
		}
		i = j;
	}
	const hex = parts.map((p) => p.toString(16));
	if (bestLen < 2) return hex.join(":");
	return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

function inV4Range(parts: number[], base: [number, number, number, number], prefix: number): boolean {
	const addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
	const net = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (addr & mask) === (net & mask);
}

const NON_PUBLIC_V4: Array<[[number, number, number, number], number]> = [
	[[0, 0, 0, 0], 8],
	[[10, 0, 0, 0], 8],
	[[100, 64, 0, 0], 10],
	[[127, 0, 0, 0], 8],
	[[169, 254, 0, 0], 16],
	[[172, 16, 0, 0], 12],
	[[192, 0, 0, 0], 24],
	[[192, 0, 2, 0], 24],
	[[192, 168, 0, 0], 16],
	[[198, 18, 0, 0], 15],
	[[198, 51, 100, 0], 24],
	[[203, 0, 113, 0], 24],
	[[224, 0, 0, 0], 4],
	[[240, 0, 0, 0], 4],
];

function isPublicIPv4(parts: number[]): boolean {
	return !NON_PUBLIC_V4.some(([base, prefix]) => inV4Range(parts, base, prefix));
}

function isPublicIPv6(parts: number[]): boolean {
	// Only global unicast (2000::/3) is routable on the public internet.
	if ((parts[0] & 0xe000) !== 0x2000) return false;
	// Documentation prefix 2001:db8::/32.
	if (parts[0] === 0x2001 && parts[1] === 0x0db8) return false;
	return true;
}
