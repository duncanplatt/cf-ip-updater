import { describe, expect, it } from "vitest";
import { isPublicIp, parseIp, sameIp } from "../src/ip";

describe("parseIp", () => {
	it.each([
		["203.0.114.7", "203.0.114.7"],
		[" 8.8.8.8 ", "8.8.8.8"],
		["2606:4700:4700::1111", "2606:4700:4700::1111"],
		["2606:4700:4700:0:0:0:0:1111", "2606:4700:4700::1111"],
		["2001:0DB8:0000:0000:0001:0000:0000:0001", "2001:db8::1:0:0:1"],
		["::", "::"],
		["::1", "::1"],
		["1::", "1::"],
		["::ffff:192.0.2.1", "::ffff:c000:201"],
		["1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:102:304"],
	])("parses %s", (input, text) => {
		expect(parseIp(input)?.text).toBe(text);
	});

	it.each([
		"",
		"[IP]",
		"256.1.1.1",
		"1.2.3",
		"1.2.3.4.5",
		"01.2.3.4",
		"1.2.3.-4",
		"1::2::3",
		"1:2:3:4:5:6:7:8:9",
		"1:2:3:4:5:6:7",
		"12345::",
		":1::",
		"1.2.3.4::",
		"fe80::1%eth0",
		"::1.2.3.4:5",
	])("rejects %j", (input) => {
		expect(parseIp(input)).toBeNull();
	});
});

describe("isPublicIp", () => {
	it.each(["8.8.8.8", "203.0.114.1", "100.128.0.1", "2606:4700::1"])("treats %s as public", (ip) => {
		expect(isPublicIp(parseIp(ip)!)).toBe(true);
	});

	it.each([
		"10.0.0.1",
		"172.16.5.4",
		"172.31.255.255",
		"192.168.1.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.1.1",
		"0.0.0.0",
		"224.0.0.1",
		"255.255.255.255",
		"203.0.113.9",
		"::1",
		"fe80::1",
		"fd00::1",
		"2001:db8::1",
		"::ffff:8.8.8.8",
	])("treats %s as non-public", (ip) => {
		expect(isPublicIp(parseIp(ip)!)).toBe(false);
	});
});

describe("sameIp", () => {
	it("compares IPv6 regardless of notation", () => {
		expect(sameIp(parseIp("2606:4700::1")!, parseIp("2606:4700:0:0:0:0:0:0001")!)).toBe(true);
	});

	it("distinguishes versions", () => {
		expect(sameIp(parseIp("0.0.0.1")!, parseIp("::1")!)).toBe(false);
	});
});
