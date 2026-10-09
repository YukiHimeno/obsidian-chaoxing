import { MarkdownOptions, checkPaperPage, extractEnterInfo, parseHtml, parsePaper } from "../model/html";
import { buildPhoneSubmitForm, buildSubmitForm } from "../model/submit";
import { Answer, Course, EnterInfo, Paper, SubmitResult, WorkListItem } from "../model/types";
import { ChaoxingAuthError, ChaoxingHttp, ChaoxingHttpError } from "./http";

const HOST_MOOC1 = "https://mooc1.chaoxing.com";
const HOST_API = "https://mooc1-api.chaoxing.com";

/**
 * 超星（学习通 / 泛雅）作业相关接口。
 *
 * 采用学习通 App 的手机端链路，它对 Cookie 的要求和网页端一致，且题目页面
 * 没有桌面端那套字体加密（两侧都做了兼容）：
 *
 *   课程列表  GET  mooc1-api.chaoxing.com/mycourse/backclazzdata
 *   作业列表  GET  mooc1-api.chaoxing.com/work/task-list
 *   进入作业  GET  .../android/mtaskmsgspecial（列表里给出的 data 链接）
 *   试卷页面  GET  mooc1-api.chaoxing.com/mooc-ans/work/phone/doHomeWork
 *   提交作业  POST mooc1.chaoxing.com/mooc-ans/work/addStudentWorkNew
 */
/** 账号信息（来自 sso.chaoxing.com 的登录态接口） */
export interface AccountInfo {
	puid: string;
	name?: string;
	school?: string;
	stuId?: string;
}

export class ChaoxingApi {
	constructor(private http: ChaoxingHttp) {}

	private accountInfo?: AccountInfo | null;

	/**
	 * 课程列表（含 clazzId / cpi，后续接口都要用）。
	 *
	 * 注意课程名取 content.course.data[].name —— content.name 在不少账号里是
	 * 形如内部编号的字符串（不是给人看的课程名）。
	 */
	async getCourses(): Promise<Course[]> {
		const text = await this.http.text({
			url: `${HOST_API}/mycourse/backclazzdata?view=json&rss=1`,
			extraHeaders: { Accept: "application/json, text/plain, */*" },
		});
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			throw new ChaoxingHttpError("课程列表返回的不是 JSON（Cookie 可能失效）", 200, text.slice(0, 300));
		}
		const channels = (data as { channelList?: unknown[] })?.channelList;
		if (!Array.isArray(channels)) throw new ChaoxingHttpError("课程列表结构不认识", 200, text.slice(0, 300));

		const courses: Course[] = [];
		const seen = new Set<string>();
		for (const ch of channels) {
			const content = (ch as { content?: Record<string, unknown> })?.content;
			if (!content) continue;
			const courseData = (content.course as { data?: Array<Record<string, unknown>> })?.data;
			if (!Array.isArray(courseData) || courseData.length === 0) continue;
			const clazzId = String(content.id ?? "");
			const cpi = String(content.cpi ?? (ch as { cpi?: unknown })?.cpi ?? "");
			const fallbackName = String(content.name ?? "").trim();
			for (const entry of courseData) {
				const courseId = String(entry?.id ?? "");
				if (!courseId || !clazzId) continue;
				const key = `${courseId}:${clazzId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const name = String(entry?.name ?? "").trim() || fallbackName || "未命名课程";
				courses.push({ courseId, clazzId, cpi, name });
			}
		}
		return courses;
	}

	/** 某门课程的作业列表 */
	async getWorkList(course: Course): Promise<WorkListItem[]> {
		let primary: WorkListItem[] = [];
		let primaryError: unknown = null;
		try {
			primary = await this.getWorkListFromTaskList(course);
		} catch (error) {
			primaryError = error;
		}
		if (primary.length > 0) return primary;

		// 个别课程/账号在 App 的作业页拿不到列表，退回「作业总列表」再按课程名筛一次
		try {
			const fallback = await this.getWorkListFromStuWork(course);
			if (fallback.length > 0) return fallback;
		} catch (error) {
			if (primaryError) throw primaryError;
			throw error;
		}
		if (primaryError) throw primaryError;
		return [];
	}

	private async getWorkListFromTaskList(course: Course): Promise<WorkListItem[]> {
		const url = `${HOST_API}/work/task-list?courseId=${encodeURIComponent(course.courseId)}&classId=${encodeURIComponent(course.clazzId)}&cpi=${encodeURIComponent(course.cpi)}`;
		const text = await this.http.text({ url, mobile: true });
		const doc = parseHtml(text);
		const items: WorkListItem[] = [];
		for (const li of Array.from(doc.querySelectorAll("ul.nav li"))) {
			const rawUrl = li.getAttribute("data") ?? "";
			if (!rawUrl) continue;
			const params = parseQuery(rawUrl);
			const title = (li.querySelector("div p")?.textContent ?? "").trim();
			const spans = Array.from(li.querySelectorAll("div span"));
			const status = (spans[0]?.textContent ?? "").trim();
			const remain = (spans[1]?.textContent ?? "").trim();
			items.push({
				title: title || "未命名作业",
				status,
				remain: remain || undefined,
				courseId: params["courseId"] ?? course.courseId,
				clazzId: params["clazzId"] ?? course.clazzId,
				cpi: course.cpi,
				taskrefId: params["taskrefId"] ?? "",
				msgId: params["msgId"] ?? "0",
				userId: params["userId"] ?? "",
				type: params["type"] ?? "work",
				encTask: params["enc_task"] ?? "",
				rawUrl,
				courseName: course.name,
			});
		}
		return items;
	}

	/** 兜底：/work/stu-work 列出所有课程的作业，按课程名筛出当前课程 */
	private async getWorkListFromStuWork(course: Course): Promise<WorkListItem[]> {
		const text = await this.http.text({ url: `${HOST_MOOC1}/work/stu-work?ut=s` });
		const doc = parseHtml(text);
		const items: WorkListItem[] = [];
		for (const li of Array.from(doc.querySelectorAll("li[data]"))) {
			const rawUrl = li.getAttribute("data") ?? "";
			if (!rawUrl.includes("taskrefId")) continue;
			const params = parseQuery(rawUrl);
			let courseName = "";
			for (const span of Array.from(li.querySelectorAll("span"))) {
				const match = (span.textContent ?? "").trim().match(/^《(.*)》$/);
				if (match) {
					courseName = match[1];
					break;
				}
			}
			items.push({
				title: (li.querySelector("p")?.textContent ?? "").trim() || "未命名作业",
				status: (li.querySelector("span.status")?.textContent ?? "").trim(),
				remain: (li.querySelector("span.fr")?.textContent ?? "").trim() || undefined,
				courseId: params["courseId"] ?? course.courseId,
				clazzId: params["clazzId"] ?? course.clazzId,
				cpi: course.cpi,
				taskrefId: params["taskrefId"] ?? "",
				msgId: params["msgId"] ?? "0",
				userId: params["userId"] ?? "",
				type: params["type"] ?? "work",
				encTask: params["enc_task"] ?? "",
				rawUrl,
				courseName: courseName || course.name,
			});
		}
		const norm = (s: string) => s.replace(/\s+/g, "");
		return items.filter((item) => {
			if (!item.courseName) return false;
			const a = norm(item.courseName);
			const b = norm(course.name);
			return a === b || a.includes(b) || b.includes(a);
		});
	}

	/**
	 * 账号信息（App 端要用的 puid 在这里拿）。
	 *
	 * `mtaskmsgspecial` 里的 userId 必须是账号的 puid；作业列表 URL 里带的
	 * userId 和它未必一致，用错了超星会回一个「无效的用户」错误页。
	 */
	async getAccountInfo(): Promise<AccountInfo | null> {
		if (this.accountInfo !== undefined) return this.accountInfo;
		this.accountInfo = null;
		try {
			const text = await this.http.text({
				url: "https://sso.chaoxing.com/apis/login/userLogin4Uname.do",
				extraHeaders: { Accept: "application/json, text/plain, */*" },
			});
			const data = JSON.parse(text) as { result?: unknown; msg?: Record<string, unknown> };
			if (Number(data?.result) !== 1 || !data.msg) return null;
			const msg = data.msg;
			const account: AccountInfo = {
				puid: String(msg.puid ?? ""),
				name: msg.name ? String(msg.name) : undefined,
				school: msg.schoolname ? String(msg.schoolname) : undefined,
				stuId: msg.uname ? String(msg.uname) : undefined,
			};
			this.accountInfo = account.puid ? account : null;
		} catch (error) {
			console.warn("[chaoxing] 获取账号信息失败（继续用列表里的 userId）", error);
		}
		return this.accountInfo;
	}

	/**
	 * 进入作业：拿到 cpi / workAnswerId / enc 等参数。
	 *
	 * 会依次尝试几个候选入口（列表里的原链接、按 puid 重建的 mtaskmsgspecial、
	 * task-work 页面），返回第一个能解析出参数的页面的内容；全部失败则返回最后一次
	 * 的页面（供调用方落盘排查）并在 tried 里给出试过的 URL。
	 */
	async enterWork(item: WorkListItem): Promise<{ info: EnterInfo; html: string; tried: string[] }> {
		const tried: string[] = [];
		let lastHtml = "";
		let lastInfo: EnterInfo = { cpi: "", workAnswerId: "", enc: "" };

		for (const url of await this.enterUrlCandidates(item)) {
			tried.push(url);
			let text: string;
			try {
				text = await this.http.text({ url, mobile: true });
			} catch (error) {
				console.warn("[chaoxing] 进入作业的候选入口失败", url, error);
				continue;
			}
			lastHtml = text;
			const info = extractEnterInfo(text);
			if (info.cpi && info.enc) return { info, html: text, tried };
			lastInfo = info;
		}
		return { info: lastInfo, html: lastHtml, tried };
	}

	private async enterUrlCandidates(item: WorkListItem): Promise<string[]> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(parseQuery(item.rawUrl))) {
			if (value) params.set(key, value);
		}
		for (const [key, value] of Object.entries({
			taskrefId: item.taskrefId,
			msgId: item.msgId,
			courseId: item.courseId,
			clazzId: item.clazzId,
			userId: item.userId,
			type: item.type,
			enc_task: item.encTask,
		})) {
			if (value && !params.get(key)) params.set(key, value);
		}

		// userId 优先用账号的 puid（App 用的就是它），其次列表里的值，最后 Cookie 里的 UID
		const account = await this.getAccountInfo();
		const userId = account?.puid || params.get("userId") || this.http.currentUid() || "";
		if (userId) params.set("userId", userId);

		const urls: string[] = [];
		const taskrefId = params.get("taskrefId") ?? "";
		if (params.toString()) {
			// 列表原链接（可能挂在 mooc1 或 mooc1-api 上，保持原样）
			const host = item.rawUrl.includes("mooc1.chaoxing.com") && !item.rawUrl.includes("mooc1-api.")
				? HOST_MOOC1
				: HOST_API;
			const path = item.rawUrl.includes("mworkspecial")
				? "/android/mworkspecial"
				: item.rawUrl.includes("/mooc-ans/android/")
					? "/mooc-ans/android/mtaskmsgspecial"
					: "/android/mtaskmsgspecial";
			urls.push(`${host}${path}?${params.toString()}`);
			if (host === HOST_MOOC1) urls.push(`${HOST_API}${path}?${params.toString()}`);
		}
		// task-work 页面：只需要 taskrefId/courseId/classId（第三方客户端就是这么进的）
		if (taskrefId && item.courseId && item.clazzId) {
			const q = new URLSearchParams({
				taskrefId,
				courseId: item.courseId,
				classId: item.clazzId,
				ut: "s",
			});
			if (params.get("enc_task")) q.set("enc_task", params.get("enc_task") ?? "");
			urls.push(`${HOST_API}/mooc-ans/work/phone/task-work?${q.toString()}`);
		}
		return Array.from(new Set(urls));
	}

	/**
	 * 拉取试卷页面原始 HTML（解析交给调用方，因为要不要字体解码取决于页面内容）。
	 *
	 * 参数形态对齐能正常工作的客户端（chaoxing-mcp）的取题 URL：
	 *   courseId / classId / workId / workAnswerId / cpi / knowledgeid / enc /
	 *   encWork / mooc=1 / source=0 / index=N
	 * 页面是「一页一题」；其中 workAnswerId 与 encWork 缺一不可，服务器靠它们定位这份作答记录。
	 */
	async fetchPaperHtml(
		item: WorkListItem,
		enter: EnterInfo,
		opts: { index?: number; answerId?: string; fields?: Record<string, string> } = {},
	): Promise<string> {
		const q = new URLSearchParams();
		const f = opts.fields ?? {};
		const withFallback = (key: string, fallback: string | undefined): string => f[key]?.trim() || fallback || "";
		q.set("courseId", withFallback("courseId", item.courseId));
		q.set("classId", withFallback("classId", item.clazzId));
		q.set("workId", withFallback("workRelationId", item.taskrefId));
		q.set("workAnswerId", opts.answerId || withFallback("workRelationAnswerId", enter.workAnswerId));
		q.set("cpi", withFallback("cpi", enter.cpi || item.cpi));
		q.set("knowledgeid", withFallback("knowledgeid", "0"));
		q.set("enc", withFallback("enc", enter.enc));
		const encWork = f["encWork"] ?? "";
		if (encWork) q.set("encWork", encWork);
		q.set("mooc", "1");
		q.set("source", withFallback("source", "0"));
		q.set("index", String(opts.index ?? 0));
		const text = await this.http.text({
			url: `${HOST_API}/mooc-ans/work/phone/doHomeWork?${q.toString()}`,
			mobile: true,
			referer: `${HOST_API}/mooc-ans/work/phone/task-work?taskrefId=${item.taskrefId}&courseId=${item.courseId}&classId=${item.clazzId}`,
		});
		return checkPaperPage(text);
	}

	/**
	 * 兜底：客户端「任务点测验」页面（据第三方实现它会一次给整卷）。
	 * 参数不全时服务器会回「无效的参数」，返回 null 让调用方走逐题。
	 */
	async fetchFullPaperHtml(
		item: WorkListItem,
		enter: EnterInfo,
		fields: Record<string, string> = {},
	): Promise<string | null> {
		try {
			const account = await this.getAccountInfo();
			const q = new URLSearchParams({
				courseid: fields["courseId"] ?? item.courseId,
				workid: fields["workRelationId"] ?? item.taskrefId,
				jobid: "",
				needRedirect: "true",
				knowledgeid: fields["knowledgeid"] ?? "0",
				userid: account?.puid ?? this.http.currentUid() ?? "",
				ut: "s",
				clazzId: fields["classId"] ?? item.clazzId,
				cpi: fields["cpi"] ?? enter.cpi ?? item.cpi,
				ktoken: "",
				enc: fields["enc"] ?? enter.enc,
			});
			const text = await this.http.text({ url: `${HOST_API}/android/mworkspecial?${q.toString()}`, mobile: true });
			// 错误页没有题目，视为不可用
			return checkPaperPage(text);
		} catch (error) {
			console.warn("[chaoxing] 整卷接口不可用", error);
			return null;
		}
	}

	/** 下载二进制内容（题目图片等），带 Cookie */
	async httpBinary(url: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
		const res = await this.http.request({ url });
		const buffer = res.arrayBuffer;
		if (!buffer || buffer.byteLength === 0) return null;
		const headers = (res.headers ?? {}) as Record<string, unknown>;
		const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
		return {
			bytes: new Uint8Array(buffer),
			contentType: typeof contentType === "string" ? contentType : undefined,
		};
	}

	/** 拉取并解析试卷（单页） */
	async fetchPaper(item: WorkListItem, enter: EnterInfo, opts: MarkdownOptions = {}): Promise<Paper> {
		const html = await this.fetchPaperHtml(item, enter);
		const paper = await parsePaper(html, opts);
		if (paper.questions.length === 0) {
			throw new Error("试卷页面里没有解析出题目，请到手机上核对后重试");
		}
		return paper;
	}

	/**
	 * 提交作业：按试卷页面的变体自动选择提交方式。
	 *   phone —— 手机端逐题页（#phoneSubmit），逐题 POST doNormalHomeWorkSubmit
	 *   web   —— 整卷页（answertype），一次 POST addStudentWorkNew
	 */
	async submitWork(
		paper: Paper,
		answers: Answer[],
		opts: { draft?: boolean; onProgress?: (done: number, total: number) => void } = {},
	): Promise<SubmitResult> {
		if (paper.submitMode === "phone") return this.submitPhoneQuestions(paper, answers, opts);
		return this.submit(paper, answers, opts);
	}

	/**
	 * 手机端逐题页的单次提交（doNormalHomeWorkSubmit）。
	 *
	 * 页面自己的逻辑就是靠它翻页：`tempSave=true` 暂存当前题并返回新的
	 * `answerId`（答题记录 id），下一页必须带上这个新 id 才能取到。
	 * tempSave=false 才是真正交卷。
	 */
	async submitPhoneQuestion(
		fields: Record<string, string>,
		draft: boolean,
	): Promise<{ ok: boolean; msg: string; answerId?: string }> {
		const form = { ...fields, tempSave: draft ? "true" : "false" };
		const res = await this.http.request({
			url: `${HOST_API}/mooc-ans/work/phone/doNormalHomeWorkSubmit?tempSave=${draft}`,
			method: "POST",
			body: new URLSearchParams(form).toString(),
			contentType: "application/x-www-form-urlencoded; charset=UTF-8",
			mobile: true,
			referer: `${HOST_API}/mooc-ans/work/phone/doHomeWork`,
			extraHeaders: {
				"X-Requested-With": "XMLHttpRequest",
				Origin: HOST_API,
				Accept: "application/json, text/javascript, */*; q=0.01",
			},
		});
		const text = res.text ?? "";
		if (looksLikeLogin(text)) throw new ChaoxingAuthError();
		try {
			const parsed = res.json as { status?: unknown; msg?: unknown; answerId?: unknown };
			const ok = parsed?.status === true || parsed?.status === "true";
			const answerId = parsed?.answerId !== undefined && parsed?.answerId !== null ? String(parsed.answerId) : undefined;
			return { ok, msg: String(parsed?.msg ?? (ok ? "成功" : "服务器未返回成功")), answerId };
		} catch {
			const ok = /"status"\s*:\s*true/i.test(text);
			return { ok, msg: text.replace(/\s+/g, " ").slice(0, 120) || "服务器未返回 JSON" };
		}
	}

	/** 手机端逐题提交：一道题一个请求 */
	private async submitPhoneQuestions(
		paper: Paper,
		answers: Answer[],
		opts: { draft?: boolean; onProgress?: (done: number, total: number) => void } = {},
	): Promise<SubmitResult> {
		const draft = Boolean(opts.draft);
		const failed: string[] = [];
		let succeeded = 0;
		let done = 0;

		for (const answer of answers) {
			const question = paper.questions.find((q) => q.id === answer.questionId);
			const form = buildPhoneSubmitForm(question, answer, draft);
			// 该题页面字段缺失时，用整页字段补齐关键项
			if (!question?.submitFields) {
				for (const [key, value] of Object.entries(paper.hiddenFields)) {
					if (!(key in form) && !/^(answer|type|score)/i.test(key)) form[key] = value;
				}
			}
			const result = await this.submitPhoneQuestion(form, draft);
			done++;
			opts.onProgress?.(done, answers.length);
			if (result.ok) succeeded++;
			else failed.push(`${question?.typeName ?? "题目"}#${answer.questionId}：${result.msg}`);
		}

		if (failed.length === 0) {
			return {
				ok: true,
				msg: draft ? `已暂存 ${succeeded}/${answers.length} 题` : `已提交 ${succeeded}/${answers.length} 题`,
			};
		}
		const detail = failed.slice(0, 3).join("；");
		return {
			ok: false,
			msg: `共 ${answers.length} 题，成功 ${succeeded} 题；失败：${detail}${failed.length > 3 ? ` 等 ${failed.length} 题` : ""}`,
		};
	}

	/**
	 * 网页端一次交卷。字段拼装见 model/submit.ts。
	 */
	async submit(paper: Paper, answers: Answer[], opts: { draft?: boolean } = {}): Promise<SubmitResult> {
		const form = new URLSearchParams(buildSubmitForm(paper, answers, Boolean(opts.draft)));

		const res = await this.http.request({
			url: `${HOST_MOOC1}/mooc-ans/work/addStudentWorkNew`,
			method: "POST",
			body: form.toString(),
			contentType: "application/x-www-form-urlencoded; charset=UTF-8",
			referer: `${HOST_MOOC1}/mooc-ans/work/doHomeWorkNew`,
			extraHeaders: {
				"X-Requested-With": "XMLHttpRequest",
				Origin: HOST_MOOC1,
				Accept: "application/json, text/javascript, */*; q=0.01",
			},
		});

		if (looksLikeLogin(res.text)) throw new ChaoxingAuthError();
		let parsed: { status?: unknown; msg?: unknown; errorMsg?: unknown };
		try {
			parsed = res.json;
		} catch {
			throw new ChaoxingHttpError(
				`提交接口返回了非 JSON 内容（HTTP ${res.status}）`,
				res.status,
				(res.text ?? "").slice(0, 300),
			);
		}
		const ok = parsed?.status === true || parsed?.status === "true";
		const msg = String(parsed?.msg ?? parsed?.errorMsg ?? (ok ? "提交成功" : "提交失败"));
		return { ok, msg };
	}
}

function looksLikeLogin(text: string | undefined): boolean {
	if (!text) return false;
	const head = text.slice(0, 2000);
	return head.includes("passport2.chaoxing.com/login") || head.includes("请输入手机号");
}

function parseQuery(url: string): Record<string, string> {
	const out: Record<string, string> = {};
	const qIndex = url.indexOf("?");
	if (qIndex < 0) return out;
	const params = new URLSearchParams(url.slice(qIndex + 1));
	params.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}
