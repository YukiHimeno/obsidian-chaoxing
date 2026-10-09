import { md5Hex } from "./md5";

/**
 * 超星「字体加密」解码。
 *
 * 部分学校/课程的作业、章节测验页面会用 style#cxSecretStyle 内嵌一个动态生成的
 * woff/ttf 字体：页面文字被替换成私有区码点，这些码点在该字体里被映射到形状正确
 * 但编码错误的字形（视觉上正常，复制出来就是乱码）。
 *
 * 解码思路（与开源实现 Samueli924/chaoxing、xygodcyx/chaoxing 一致）：
 *   1. 加密字体是标准字体（汉仪/思源系）的子集，字形轮廓的字节表示与原字体逐字节相同；
 *   2. 因此可以按「字形原始字节的 MD5」去一张预生成的哈希表里查出这个字形真正的
 *      Unicode 码点（assets/font_map.txt，由 tools/build-font-map.mjs 生成）；
 *   3. 再结合加密字体自己的 cmap（私有区码点 -> 字形序号）反推出「乱码字符 -> 正确字符」。
 */

interface TableEntry {
	offset: number;
	length: number;
}

/** 康熙部首 -> 常见汉字，解码结果里可能混入部首码点，需要归一化 */
export const KX_RADICALS: readonly [string, string] = [
	"⼀⼁⼂⼃⼄⼅⼆⼇⼈⼉⼊⼋⼌⼍⼎⼏⼐⼑⼒⼓⼔⼕⼖⼗⼘⼙⼚⼛⼜⼝⼞⼟⼠⼡⼢⼣⼤⼥⼦⼧⼨⼩⼪⼫⼬⼭⼮⼯⼰⼱⼲⼳⼴⼵⼶⼷⼸⼹⼺⼻⼼⼽⼾⼿⽀⽁⽂⽃⽄⽅⽆⽇⽈⽉⽊⽋⽌⽍⽎⽏⽐⽑⽒⽓⽔⽕⽖⽗⽘⽙⽚⽛⽜⽝⽞⽟⽠⽡⽢⽣⽤⽥⽦⽧⽨⽩⽪⽫⽬⽭⽮⽯⽰⽱⽲⽳⽴⽵⽶⽷⽸⽹⽺⽻⽼⽽⽾⽿⾀⾁⾂⾃⾄⾅⾆⾇⾈⾉⾊⾋⾌⾍⾎⾏⾐⾑⾒⾓⾔⾕⾖⾗⾘⾙⾚⾛⾜⾝⾞⾟⾠⾡⾢⾣⾤⾥⾦⾧⾨⾩⾪⾫⾬⾭⾮⾯⾰⾱⾲⾳⾴⾵⾶⾷⾸⾹⾺⾻⾼髙⾽⾾⾿⿀⿁⿂⿃⿄⿅⿆⿇⿈⿉⿊⿋⿌⿍⿎⿏⿐⿑⿒⿓⿔⿕⺠⻬⻩⻢⻜⻅⺟⻓",
	"一丨丶丿乙亅二亠人儿入八冂冖冫几凵刀力勹匕匚匸十卜卩厂厶又口囗土士夂夊夕大女子宀寸小尢尸屮山巛工己巾干幺广廴廾弋弓彐彡彳心戈戶手支攴文斗斤方无日曰月木欠止歹殳毋比毛氏气水火爪父爻爿片牙牛犬玄玉瓜瓦甘生用田疋疒癶白皮皿目矛矢石示禸禾穴立竹米糸缶网羊羽老而耒耳聿肉臣自至臼舌舛舟艮色艸虍虫血行衣襾見角言谷豆豕豸貝赤走足身車辛辰辵邑酉采里金長門阜隶隹雨青非面革韋韭音頁風飛食首香馬骨高高髟鬥鬯鬲鬼魚鳥鹵鹿麥麻黃黍黑黹黽鼎鼓鼠鼻齊齒龍龜龠民齐黄马飞见母长",
];

const KX_MAP: Record<string, string> = (() => {
	const m: Record<string, string> = {};
	for (let i = 0; i < KX_RADICALS[0].length; i++) m[KX_RADICALS[0][i]] = KX_RADICALS[1][i];
	return m;
})();

export function translateRadicals(text: string): string {
	return Array.from(text)
		.map((c) => KX_MAP[c] ?? c)
		.join("");
}

/** 从页面 HTML 中提取 style#cxSecretStyle 内嵌字体的原始字节 */
export function extractEncryptedFontBytes(html: string): Uint8Array | null {
	const styleMatch = html.match(/<style[^>]*id=["']?cxSecretStyle["']?[^>]*>([\s\S]*?)<\/style>/i);
	if (!styleMatch) return null;
	const b64 = styleMatch[1].match(/base64,([A-Za-z0-9+/=]+)/);
	if (!b64) return null;
	try {
		return base64ToBytes(b64[1]);
	} catch {
		return null;
	}
}

export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64.replace(/\s+/g, ""));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function readTag(bytes: Uint8Array, off: number): string {
	return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

export function parseTables(bytes: Uint8Array): Record<string, TableEntry> | null {
	if (bytes.length < 12) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// 兼容 woff 包装（WOFF 头以 "wOFF" 开头，需要先解包）
	if (readTag(bytes, 0) === "wOFF") return null;
	const numTables = dv.getUint16(4);
	const tables: Record<string, TableEntry> = {};
	for (let i = 0; i < numTables; i++) {
		const off = 12 + i * 16;
		if (off + 16 > bytes.length) return null;
		tables[readTag(bytes, off)] = { offset: dv.getUint32(off + 8), length: dv.getUint32(off + 12) };
	}
	return tables;
}

/** 抽取每个字形的原始 glyf 字节（导出仅供测试使用） */
export function extractGlyfRawData(bytes: Uint8Array, tables: Record<string, TableEntry>): Uint8Array[] | null {
	const head = tables["head"];
	const loca = tables["loca"];
	const glyf = tables["glyf"];
	const maxp = tables["maxp"];
	if (!head || !loca || !glyf || !maxp) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const indexToLocFormat = dv.getUint16(head.offset + 50);
	const numGlyphs = dv.getUint16(maxp.offset + 4);

	const out: Uint8Array[] = [];
	for (let i = 0; i < numGlyphs; i++) {
		let start: number;
		let end: number;
		if (indexToLocFormat === 0) {
			start = dv.getUint16(loca.offset + i * 2) * 2;
			end = dv.getUint16(loca.offset + (i + 1) * 2) * 2;
		} else {
			start = dv.getUint32(loca.offset + i * 4);
			end = dv.getUint32(loca.offset + (i + 1) * 4);
		}
		if (end <= start || glyf.offset + end > bytes.length) out.push(new Uint8Array(0));
		else out.push(bytes.subarray(glyf.offset + start, glyf.offset + end));
	}
	return out;
}

/**
 * 解析 cmap，返回 码点 -> 字形序号（导出仅供测试使用）。
 *
 * allowSubtable 选择子表：参考实现优先 (3,1)（BMP），没有才用 (3,10)（format 12）。
 * 加密字体的私有区码点都在 BMP，所以这个偏好是安全的。
 */
export function parseCmap(
	bytes: Uint8Array,
	tables: Record<string, TableEntry>,
	prefer: "auto" | "3.1" | "3.10" = "auto",
): Map<number, number> | null {
	const cmap = tables["cmap"];
	if (!cmap) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const base = cmap.offset;
	const numTables = dv.getUint16(base + 2);

	interface Sub {
		platformID: number;
		encodingID: number;
		subOff: number;
		format: number;
	}
	const subs: Sub[] = [];
	for (let i = 0; i < numTables; i++) {
		const recOff = base + 4 + i * 8;
		const platformID = dv.getUint16(recOff);
		const encodingID = dv.getUint16(recOff + 2);
		const subOff = dv.getUint32(recOff + 4);
		const format = dv.getUint16(base + subOff);
		subs.push({ platformID, encodingID, subOff, format });
	}
	const pick = (): Sub | null => {
		if (prefer === "3.1") return subs.find((s) => s.platformID === 3 && s.encodingID === 1) ?? null;
		if (prefer === "3.10") return subs.find((s) => s.platformID === 3 && s.encodingID === 10) ?? null;
		return (
			subs.find((s) => s.platformID === 3 && s.encodingID === 1) ??
			subs.find((s) => s.platformID === 3 && s.encodingID === 10) ??
			subs[0] ??
			null
		);
	};
	const chosen = pick();
	if (!chosen) return null;

	const subBase = base + chosen.subOff;
	const format = chosen.format;
	const result = new Map<number, number>();

	if (format === 4) {
		const segCountX2 = dv.getUint16(subBase + 6);
		const segCount = segCountX2 / 2;
		const endCodeOff = subBase + 14;
		const startCodeOff = endCodeOff + 2 + segCountX2;
		const idDeltaOff = startCodeOff + segCountX2;
		const idRangeOffOff = idDeltaOff + segCountX2;
		for (let seg = 0; seg < segCount; seg++) {
			const endCode = dv.getUint16(endCodeOff + seg * 2);
			const startCode = dv.getUint16(startCodeOff + seg * 2);
			const idDelta = dv.getInt16(idDeltaOff + seg * 2);
			const idRangeOffset = dv.getUint16(idRangeOffOff + seg * 2);
			if (startCode === 0xffff) continue;
			for (let c = startCode; c <= endCode; c++) {
				let glyphIndex: number;
				if (idRangeOffset === 0) {
					glyphIndex = (c + idDelta) & 0xffff;
				} else {
					const rangeOff = idRangeOffOff + seg * 2 + idRangeOffset + (c - startCode) * 2;
					if (rangeOff + 2 > bytes.length) continue;
					glyphIndex = dv.getUint16(rangeOff);
					if (glyphIndex !== 0) glyphIndex = (glyphIndex + idDelta) & 0xffff;
				}
				if (glyphIndex !== 0) result.set(c, glyphIndex);
			}
		}
	} else if (format === 12) {
		const numGroups = dv.getUint32(subBase + 12);
		for (let g = 0; g < numGroups; g++) {
			const goff = subBase + 16 + g * 12;
			const startCode = dv.getUint32(goff);
			const endCode = dv.getUint32(goff + 4);
			const startGlyphID = dv.getUint32(goff + 8);
			for (let c = startCode; c <= endCode; c++) result.set(c, startGlyphID + (c - startCode));
		}
	} else if (format === 6) {
		const firstCode = dv.getUint16(subBase + 6);
		const entryCount = dv.getUint16(subBase + 8);
		for (let e = 0; e < entryCount; e++) {
			const glyphIndex = dv.getUint16(subBase + 10 + e * 2);
			if (glyphIndex !== 0) result.set(firstCode + e, glyphIndex);
		}
	} else {
		return null;
	}
	return result;
}

export interface FontHashTable {
	get(md5: string): number | undefined;
	size: number;
}

export function parseFontMap(text: string): FontHashTable {
	const map = new Map<string, number>();
	for (const line of text.split("\n")) {
		const sp = line.indexOf(" ");
		if (sp <= 0) continue;
		const hash = line.slice(0, sp);
		const cp = parseInt(line.slice(sp + 1), 16);
		if (hash.length === 32 && cp > 0) map.set(hash, cp);
	}
	return { get: (h) => map.get(h), size: map.size };
}

export interface FontDecoder {
	decode(text: string): string;
	knownMask: Map<string, string>;
}

/**
 * 用加密字体 + 哈希表构建「乱码字符 -> 正确字符」映射。
 * 返回 null 表示字体无法解析（wOFF 包装、缺表等情况），此时调用方应原样保留文本。
 */
export function buildDecoder(fontBytes: Uint8Array, table: FontHashTable): FontDecoder | null {
	const tables = parseTables(fontBytes);
	if (!tables) return null;
	const glyphData = extractGlyfRawData(fontBytes, tables);
	if (!glyphData) return null;
	const cmap = parseCmap(fontBytes, tables);
	if (!cmap) return null;

	const glyphToChar = new Map<number, string>();
	for (let i = 0; i < glyphData.length; i++) {
		const raw = glyphData[i];
		if (raw.length === 0) continue;
		const cp = table.get(md5Hex(raw));
		if (cp !== undefined) glyphToChar.set(i, String.fromCharCode(cp));
	}

	const knownMask = new Map<string, string>();
	for (const [code, glyphIndex] of cmap) {
		if (code <= 0x2000) continue;
		const real = glyphToChar.get(glyphIndex);
		if (real) {
			knownMask.set(String.fromCharCode(code), real);
		} else if (!glyphData[glyphIndex] || glyphData[glyphIndex].length === 0) {
			// 私有区里轮廓为空的字形是加密后的空白（空格），否则会在笔记里留下隐形乱码
			if (code >= 0xe000 && code <= 0xf8ff) knownMask.set(String.fromCharCode(code), " ");
		}
	}
	if (knownMask.size === 0) return null;

	const decode = (text: string): string => {
		let out = "";
		for (const ch of text) out += knownMask.get(ch) ?? ch;
		return translateRadicals(out);
	};
	return { decode, knownMask };
}
