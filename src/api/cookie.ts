/**
 * Cookie 处理的纯函数部分（不依赖 obsidian，便于单测）。
 *
 * 背景：Obsidian 桌面端把 Electron 的响应头原样透传——出现「多个 Set-Cookie」
 * 时 `headers["set-cookie"]` 是字符串数组，只有一个时才是字符串；某些实现还会
 * 把同名头用 ", " 连成一个字符串。两种形态都必须能处理。
 */

/** 把用户从浏览器复制的 Cookie（可能带 "Cookie:" 前缀、换行）整理成一行 */
export function normalizeCookie(raw: string): string {
	return raw
		.replace(/^\s*cookie\s*:\s*/i, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** 合并响应里的 Set-Cookie，返回更新后的整条 Cookie */
export function mergeSetCookie(prev: string, rawSetCookie: unknown): string {
	if (rawSetCookie === undefined || rawSetCookie === null) return prev;
	const jar = new Map<string, string>();
	for (const part of String(prev ?? "").split(";")) {
		const idx = part.indexOf("=");
		if (idx > 0) jar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
	}
	const entries = Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
	for (const entry of entries) {
		for (const cookie of String(entry ?? "").split(/\n|,(?=[^;=]+=)/)) {
			const first = cookie.split(";")[0].trim();
			const idx = first.indexOf("=");
			if (idx > 0) jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
		}
	}
	return Array.from(jar.entries())
		.map(([k, v]) => `${k}=${v}`)
		.join("; ");
}
