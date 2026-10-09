/**
 * 纯 TypeScript 的 MD5 实现。
 *
 * 不能依赖 node:crypto —— Obsidian 移动端没有完整的 Node API，
 * 而字体解密需要 MD5 字形哈希，所以自带一份。
 */

const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11,
	16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = (() => {
	const k = new Uint32Array(64);
	for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
	return k;
})();

function hexLE(x: number): string {
	let s = "";
	for (let i = 0; i < 4; i++) s += (((x >>> (i * 8)) & 0xff) | 0).toString(16).padStart(2, "0");
	return s;
}

export function md5Hex(data: Uint8Array): string {
	const len = data.length;
	const bitLenLo = (len * 8) >>> 0;
	const bitLenHi = Math.floor((len * 8) / 4294967296);

	const total = (((len + 8) >> 6) + 1) << 6;
	const buf = new Uint8Array(total);
	buf.set(data);
	buf[len] = 0x80;
	const dv = new DataView(buf.buffer);
	dv.setUint32(total - 8, bitLenLo, true);
	dv.setUint32(total - 4, bitLenHi, true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const M = new Uint32Array(16);

	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
		let A = a0;
		let B = b0;
		let C = c0;
		let D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number;
			let g: number;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) % 16;
			}
			F = (F + A + K[i] + M[g]) >>> 0;
			A = D;
			D = C;
			C = B;
			B = (B + (((F << S[i]) | (F >>> (32 - S[i]))) >>> 0)) >>> 0;
		}
		a0 = (a0 + A) >>> 0;
		b0 = (b0 + B) >>> 0;
		c0 = (c0 + C) >>> 0;
		d0 = (d0 + D) >>> 0;
	}
	return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}
