import { requestUrl, RequestUrlResponse } from "obsidian";
import { mergeSetCookie, normalizeCookie } from "./cookie";

/**
 * HTTP 层：统一走 Obsidian 的 requestUrl（Electron 主进程发请求，不受 CORS 限制），
 * 手动附带 Cookie，并识别超星常见的几种失效/拦截页面。
 */

const UA_DESKTOP =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_MOBILE =
	"Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ2A.230505.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";

export class ChaoxingAuthError extends Error {
	constructor(msg = "登录状态已失效，请重新从浏览器复制 Cookie") {
		super(msg);
		this.name = "ChaoxingAuthError";
	}
}

export class ChaoxingHttpError extends Error {
	constructor(
		msg: string,
		readonly status: number,
		readonly body: string,
	) {
		super(msg);
		this.name = "ChaoxingHttpError";
	}
}

export interface HttpRequest {
	url: string;
	method?: "GET" | "POST";
	body?: string;
	contentType?: string;
	/** 用手机端 UA + X-Requested-With: com.chaoxing.mobile（学习通 App 的调用方式） */
	mobile?: boolean;
	referer?: string;
	extraHeaders?: Record<string, string>;
}

/** 从常见失效页面里判断登录态 */
export function looksLikeAuthFailure(text: string): boolean {
	if (!text) return false;
	const head = text.slice(0, 4000);
	return (
		head.includes("passport2.chaoxing.com/login") ||
		/name=["']?pwd["']?/.test(head) ||
		head.includes("请输入手机号") ||
		/"result"\s*:\s*0[^}]*请登录/.test(text)
	);
}

/** 超星的通用错误页 */
export function detectBlockedPage(text: string): string | null {
	if (!text) return null;
	if (text.includes("您所浏览的页面暂时不能访问")) return "请求被超星暂时拦截（学生端 IP 限流或需要验证码），请稍后重试";
	if (text.includes("无效的权限,code=2")) return "无效的权限（code=2），请重新进入课程后再试";
	if (text.includes("无效的请求参数")) return "请求参数无效（通常是 enc 过期），请重试";
	if (text.includes("抱歉，您没有查看该页面的权限")) return "没有查看该页面的权限，Cookie 可能已过期";
	return null;
}

export class ChaoxingHttp {
	constructor(
		private getCookie: () => string,
		private saveCookie: (cookie: string) => Promise<void>,
	) {}

	/** 当前 Cookie 里的用户 id（同一个 Cookie 串里 UID/_uid 一般都在） */
	currentUid(): string | null {
		const match = /(?:^|;\s*)(?:UID|_uid)=([^;]+)/.exec(normalizeCookie(this.getCookie()));
		return match ? match[1].trim() : null;
	}

	async request(req: HttpRequest): Promise<RequestUrlResponse> {
		const cookie = normalizeCookie(this.getCookie());
		if (!cookie) throw new ChaoxingAuthError("尚未设置 Cookie，请先在插件设置中填写");

		const headers: Record<string, string> = {
			"User-Agent": req.mobile ? UA_MOBILE : UA_DESKTOP,
			Cookie: cookie,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			"Cache-Control": "no-cache",
			...req.extraHeaders,
		};
		if (req.mobile) {
			headers["X-Requested-With"] = "com.chaoxing.mobile";
			headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8";
			headers["Upgrade-Insecure-Requests"] = "1";
		}
		if (req.referer) headers["Referer"] = req.referer;
		if (req.contentType) headers["Content-Type"] = req.contentType;

		const res = await requestUrl({
			url: req.url,
			method: req.method ?? "GET",
			headers,
			body: req.body,
			throw: false,
		});

		this.mergeCookiesSafely(res);
		// 排障用：Obsidian 里 Ctrl+Shift+I 打开控制台就能看到每一步请求
		console.debug(
			`[chaoxing] ${req.method ?? "GET"} ${res.status} ${req.url.slice(0, 160)} (${(res.text ?? "").length} 字符)`,
		);
		return res;
	}

	/** Cookie 记账是尽力而为，绝不能因为它让正常请求失败 */
	private mergeCookiesSafely(res: RequestUrlResponse): void {
		try {
			this.mergeCookies(res);
		} catch (error) {
			console.warn("[chaoxing] 合并 Cookie 失败（已忽略本次）", error);
		}
	}

	private mergeCookies(res: RequestUrlResponse): void {
		const headers = (res.headers ?? {}) as Record<string, unknown>;
		let raw: unknown;
		for (const [k, v] of Object.entries(headers)) {
			if (k.toLowerCase() !== "set-cookie") continue;
			raw = raw === undefined ? v : `${raw}\n${v}`;
		}
		if (raw === undefined) return;
		const merged = mergeSetCookie(normalizeCookie(this.getCookie()), raw);
		if (merged !== this.getCookie()) void this.saveCookie(merged);
	}

	/** 发请求并做超星的通用错误检查，返回文本 */
	async text(req: HttpRequest): Promise<string> {
		const res = await this.request(req);
		const body = res.text ?? "";
		if (looksLikeAuthFailure(body)) throw new ChaoxingAuthError();
		const blocked = detectBlockedPage(body);
		if (blocked) throw new ChaoxingHttpError(blocked, res.status, body);
		if (res.status >= 400) {
			throw new ChaoxingHttpError(`HTTP ${res.status}：${body.slice(0, 200)}`, res.status, body);
		}
		return body;
	}
}
