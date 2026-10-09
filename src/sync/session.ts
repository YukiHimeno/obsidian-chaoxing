import { App, Notice, TFile, normalizePath } from "obsidian";
import { ChaoxingApi } from "../api/chaoxing";
import { ChaoxingAuthError } from "../api/http";
import { base64ToBytes, buildDecoder, extractEncryptedFontBytes, FontDecoder, FontHashTable } from "../model/font";
import { md5Hex } from "../model/md5";
import { PaperPageError, detectQuestionTotal, extractPageTip, parsePaper } from "../model/html";
import { Course, EnterInfo, Paper, WorkListItem, QUESTION_TYPE_NAME } from "../model/types";
import { ChaoxingSettings, noteStyleOf } from "../settings";
import {
	buildSubmission,
	NoteMeta,
	parseNote,
	ParsedAnswer,
	renderWorkNote,
	sanitizeFileName,
} from "./note";
import { ConfirmModal, CoursePickerModal, SubmitPreviewModal, WorkPickerModal } from "../ui/modals";

export interface SessionHost {
	app: App;
	settings: ChaoxingSettings;
	api: ChaoxingApi;
	/** 惰性读取 assets/font_map.txt */
	loadFontTable(): Promise<FontHashTable | null>;
	/** 笔记内容有更新（拉取/刷新/提交完成）时通知外部（状态栏等） */
	onChanged?: () => void;
}

const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export class Session {
	constructor(private host: SessionHost) {}

	private get app(): App {
		return this.host.app;
	}

	// ---------- 拉取流程 ----------

	/** 拉取作业列表：选课程 -> 选作业 -> 生成/更新笔记 */
	async pullWorksFlow(): Promise<void> {
		await this.guard("拉取作业失败", () => this.pullWorksFlowInner());
	}

	private async pullWorksFlowInner(): Promise<void> {
		const courses = await this.withErrors(() => this.host.api.getCourses(), "获取课程列表失败");
		if (!courses || courses.length === 0) {
			new Notice("没有拿到任何课程（可能是 Cookie 失效或该账号没有课程）");
			return;
		}
		const course = await new Promise<Course | null>((resolve) => {
			new CoursePickerModal(this.app, courses, resolve).open();
		});
		if (!course) return;

		const works = await this.withErrors(() => this.host.api.getWorkList(course), "获取作业列表失败");
		if (!works || works.length === 0) {
			new Notice(`《${course.name}》没有列出任何作业`);
			return;
		}
		const item = await new Promise<WorkListItem | null>((resolve) => {
			new WorkPickerModal(this.app, course, works, resolve).open();
		});
		if (!item) return;
		await this.pullWorkToNote(item);
	}

	/** 拉取一份作业到笔记（已存在则保留已填答案） */
	async pullWorkToNote(item: WorkListItem): Promise<void> {
		await this.guard(`拉取《${item.title}》失败`, () => this.pullWorkToNoteInner(item));
	}

	private async pullWorkToNoteInner(item: WorkListItem): Promise<void> {
		const paper = await this.withErrors(() => this.fetchPaperWithDecoder(item), "拉取作业失败");
		if (!paper) return;

		const path = this.notePath(item);
		const existingFile = this.app.vault.getAbstractFileByPath(path);
		let existing: Map<string, ParsedAnswer> | undefined;
		let status = item.status || "未提交";

		if (existingFile instanceof TFile) {
			const old = this.app.metadataCache.getFileCache(existingFile)?.frontmatter?.chaoxing as
				| Record<string, unknown>
				| undefined;
			if (old?.workId === item.taskrefId) {
				const content = await this.app.vault.read(existingFile);
				existing = parseNote(content).answers;
				if (typeof old?.status === "string") status = old.status;
			} else {
				const ok = await new Promise<boolean>((resolve) => {
					new ConfirmModal(
						this.app,
						"同名笔记已存在",
						[
							`${path}`,
							"",
							"已存在一份不属于该作业的笔记（workId 不同）。",
							"继续会覆盖它的内容，确定吗？",
						],
						resolve,
					).open();
				});
				if (!ok) return;
			}
		}

		const meta: NoteMeta = {
			courseName: item.courseName ?? "未知课程",
			courseId: item.courseId,
			clazzId: item.clazzId,
			cpi: item.cpi,
			workId: item.taskrefId,
			msgId: item.msgId,
			userId: item.userId,
			type: item.type,
			encTask: item.encTask,
			workName: item.title,
			status,
			remain: item.remain,
		};

		const content = renderWorkNote({ meta, paper, existing, style: noteStyleOf(this.host.settings) });
		await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
		const file = await this.writeNoteFile(path, content);
		new Notice(
			existing
				? `已刷新《${item.title}》，保留了 ${existing.size} 题已填答案`
				: `已拉取《${item.title}》(${paper.questions.length} 题)`,
		);
		this.host.onChanged?.();
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	/** 重新拉取当前笔记对应的题目（保留已填答案） */
	async refreshActiveNote(): Promise<void> {
		await this.guard("刷新作业失败", () => this.refreshActiveNoteInner());
	}

	private async refreshActiveNoteInner(): Promise<void> {
		const ctx = await this.activeNoteContext();
		if (!ctx) return;
		const { file, item, content, status } = ctx;

		const paper = await this.withErrors(() => this.fetchPaperWithDecoder(item), "刷新失败");
		if (!paper) return;

		const existing = parseNote(content).answers;
		const meta: NoteMeta = { ...this.metaFromItem(item), status };
		const updated = renderWorkNote({ meta, paper, existing, style: noteStyleOf(this.host.settings) });
		await this.app.vault.modify(file, updated);
		this.host.onChanged?.();
		new Notice(`已刷新《${item.title}》：${paper.questions.length} 题`);
	}

	// ---------- 提交流程 ----------

	/** 提交（或仅保存）当前笔记 */
	async submitActiveNote(draft: boolean): Promise<void> {
		await this.guard(draft ? "保存草稿失败" : "提交失败", () => this.submitActiveNoteInner(draft));
	}

	private async submitActiveNoteInner(draft: boolean): Promise<void> {
		const ctx = await this.activeNoteContext();
		if (!ctx) return;
		const { file, item, content } = ctx;

		const paper = await this.withErrors(() => this.fetchPaperWithDecoder(item), "提交前拉取试卷失败");
		if (!paper) return;

		const note = parseNote(content, noteStyleOf(this.host.settings));
		const { answers, problems } = buildSubmission(paper, note.answers);
		if (note.sectionsWithoutId > 0) {
			problems.unshift(
				`有 ${note.sectionsWithoutId} 个题目小节缺少 ^cx-… 块 ID（可能被误删），这些题会被当作未作答`,
			);
		}

		if (!draft) {
			const rows = answers.map((answer, index) => ({
				index: index + 1,
				typeName: QUESTION_TYPE_NAME[answer.typeCode] ?? answer.kind,
				display: answer.display,
				answered: answer.answered,
			}));
			const confirmed = await new Promise<boolean>((resolve) => {
				new SubmitPreviewModal(this.app, { workTitle: item.title, rows, problems }, resolve).open();
			});
			if (!confirmed) return;
		}

		// 手机端逐题提交会发很多请求，给个进度提示
		let progress: Notice | null = null;
		if (paper.submitMode === "phone" && answers.length > 3) {
			progress = new Notice(`正在逐题${draft ? "暂存" : "提交"} 0/${answers.length}…`, 0);
		}
		const result = await this.withErrors(
			() =>
				this.host.api.submitWork(paper, answers, {
					draft,
					onProgress: (done, total) =>
						progress?.setMessage(`正在逐题${draft ? "暂存" : "提交"} ${done}/${total}…`),
				}),
			"提交失败",
		);
		progress?.hide();
		if (!result) return;

		if (result.ok) {
			// 记录写进 frontmatter：写正文会在文件末尾（= 最后一题的作答小节）多加一行，
			// 那一行会被下次解析当成最后一题的答案内容
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const cx = (fm.chaoxing ?? {}) as Record<string, unknown>;
				const now = new Date();
				cx.status = draft ? "已保存（未提交）" : `已提交 ${now.toLocaleString()}`;
				cx.lastSubmitAt = now.toISOString();
				cx.lastSubmitMessage = result.msg;
				cx.lastSubmitDraft = draft;
				fm.chaoxing = cx;
			});
			const stamp = draft ? "保存草稿" : "交卷";
			this.host.onChanged?.();
			new Notice(`${stamp}成功：${result.msg}`);
		} else {
			new Notice(`服务器返回：${result.msg}`, 8000);
		}
	}

	// ---------- 内部工具 ----------

	private async activeNoteContext(): Promise<{
		file: TFile;
		item: WorkListItem;
		content: string;
		status: string;
	} | null> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("请先打开一份超星作业笔记");
			return null;
		}
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter?.chaoxing as
			| Record<string, unknown>
			| undefined;
		if (!fm?.workId) {
			new Notice("当前笔记不是超星作业笔记（缺少 chaoxing.workId）");
			return null;
		}
		const item: WorkListItem = {
			title: String(fm.workName ?? file.basename),
			status: String(fm.status ?? ""),
			remain: typeof fm.remain === "string" ? fm.remain : undefined,
			courseId: String(fm.courseId ?? ""),
			clazzId: String(fm.clazzId ?? ""),
			cpi: String(fm.cpi ?? ""),
			taskrefId: String(fm.workId),
			msgId: String(fm.msgId ?? "0"),
			userId: String(fm.userId ?? ""),
			type: String(fm.type ?? "work"),
			encTask: String(fm.encTask ?? ""),
			rawUrl: "",
			courseName: String(fm.courseName ?? ""),
		};
		if (!item.courseId || !item.clazzId || !item.taskrefId) {
			new Notice("笔记头部缺少 courseId/clazzId/workId，请重新拉取该作业");
			return null;
		}
		const content = await this.app.vault.read(file);
		return { file, item, content, status: item.status };
	}

	private metaFromItem(item: WorkListItem): NoteMeta {
		return {
			courseName: item.courseName ?? "未知课程",
			courseId: item.courseId,
			clazzId: item.clazzId,
			cpi: item.cpi,
			workId: item.taskrefId,
			msgId: item.msgId,
			userId: item.userId,
			type: item.type,
			encTask: item.encTask,
			workName: item.title,
			status: item.status,
			remain: item.remain,
		};
	}

	private async fetchPaperWithDecoder(item: WorkListItem): Promise<Paper> {
		const { info: enter, html: enterHtml, tried } = await this.host.api.enterWork(item);
		if (enter.captchaId) {
			throw new Error(
				"该作业要求滑块验证码，插件无法自动通过。请先在手机 App 或网页端打开一次该作业，完成验证后再回来重试。",
			);
		}
		if (!enter.cpi || !enter.enc) {
			const tip = extractPageTip(enterHtml);
			const dump = await this.dumpDebug(
				"enter-page",
				`<!-- 试过的入口:\n${tried.join("\n")}\n-->\n${enterHtml}`,
			);
			const reason = tip ? `超星返回「${tip}」` : "候选入口里都没解析出参数";
			throw new Error(
				`进入作业失败：${reason}（cpi=${enter.cpi || "空"}、enc=${enter.enc || "空"}、workAnswerId=${enter.workAnswerId || "空"}）` +
					(dump ? `；试过的入口与原始响应已存到 ${dump}` : ""),
			);
		}
		// 有时“进入作业”的落地页本身就是试卷（例如待重做入口），能省一次请求
		const enterIsPaper = enterHtml.includes("singleQuesId") || enterHtml.includes("Py-mian1");
		let firstHtml: string;
		try {
			firstHtml = enterIsPaper ? enterHtml : await this.host.api.fetchPaperHtml(item, enter);
		} catch (error) {
			if (error instanceof PaperPageError) {
				const dump = await this.dumpDebug("paper-page", error.html);
				throw new Error(`${error.message}${dump ? `（原始响应已存到 ${dump}）` : ""}`);
			}
			throw error;
		}
		const decoder = await this.decoderForPage(firstHtml);
		const markdownOpts = {
			decoder,
			saveImage: this.host.settings.saveImages
				? (dataUrl: string, hint: string) => this.saveImage(item, dataUrl, hint)
				: undefined,
		};
		const paper = await parsePaper(firstHtml, markdownOpts);
		if (paper.questions.length === 0) {
			const dump = await this.dumpDebug("paper-page", firstHtml);
			throw new Error(`页面里没有识别出题目${dump ? `，原始响应已存到 ${dump}` : ""}`);
		}

		// 手机端是一页一题：按 index 把后面的题补齐（整卷页会在第一轮就被去重规则挡下）
		await this.collectRemainingQuestions(item, enter, paper, firstHtml, markdownOpts);

		// 留一份最近一次成功解析的试卷页，出问题时便于对照排查（每次覆盖）
		await this.dumpDebug("paper", firstHtml, { overwrite: true });
		return paper;
	}

	/**
	/**
	 * 逐页补齐剩余题目。
	 *
	 * 手机端是「一页一题」：按能正常工作的客户端做法，用首屏页面里的字段
	 * （含 cpi / knowledgeid / encWork）拼出每一题的 URL 直接取，页码取自页面
	 * 自己渲染的 index；只有直接取不到新题时，才照页面 JS 的方式先
	 * `tempSave=true` 暂存（原样回传页面上的答案）再重取一次。
	 */
	private async collectRemainingQuestions(
		item: WorkListItem,
		enter: EnterInfo,
		paper: Paper,
		firstHtml: string,
		markdownOpts: {
			decoder: FontDecoder | null;
			saveImage?: (dataUrl: string, hint: string) => Promise<string | null>;
		},
	): Promise<void> {
		const MAX_QUESTIONS = 100;
		const expected = enter.questionTotal ?? detectQuestionTotal(firstHtml) ?? 0;
		const seen = new Set(paper.questions.map((q) => q.id));
		const log: Array<Record<string, unknown>> = [
			{ step: "first", questions: paper.questions.map((q) => q.id), expected },
		];
		if (expected > 0 && seen.size >= expected) return;

		const progress = new Notice(
			expected > 1 ? `这份作业共 ${expected} 道题，正在拉取 1/${expected}…` : "正在继续拉取题目…",
			0,
		);

		const sessionFields = paper.questions[0]?.submitFields ?? {};
		let answerId = sessionFields["workRelationAnswerId"] || enter.workAnswerId || "";
		let current = paper.questions[0];
		let savedCurrent = false;
		let index = (current?.index ?? 0) + 1;
		let misses = 0;

		while (index <= MAX_QUESTIONS) {
			if (expected > 0 && seen.size >= expected) break;

			const fetchAtIndex = async (
				withAnswerId: string,
			): Promise<{ html: string } | { error: unknown }> => {
				try {
					return {
						html: await this.host.api.fetchPaperHtml(item, enter, {
							index,
							answerId: withAnswerId,
							fields: sessionFields,
						}),
					};
				} catch (error) {
					return { error };
				}
			};

			// ① 直接按 index 取（客户端做法，不需要先暂存）
			let attempt = await fetchAtIndex(answerId);
			log.push({ step: "fetch", index, mode: "direct", ok: "html" in attempt });

			// ② 取不到就按页面 JS 的方式先暂存当前题，拿新的 answerId 再试一次
			if ("error" in attempt && current && !savedCurrent) {
				const echoForm: Record<string, string> = {
					...(current.submitFields ?? {}),
					...(current.rawAnswerFields ?? {}),
					tempSave: "true",
				};
				if (!current.rawAnswerFields) echoForm[`answer${current.id}`] = "";
				const saved = await this.host.api.submitPhoneQuestion(echoForm, true).catch((error: unknown) => ({
					ok: false,
					msg: String(error),
					answerId: undefined as string | undefined,
				}));
				savedCurrent = true;
				log.push({
					step: "tempSave",
					questionId: current.id,
					ok: saved.ok,
					answerId: saved.answerId,
					msg: saved.msg,
					echoAnswer: echoForm[`answer${current.id}`] ?? "(无)",
				});
				if (saved.answerId) answerId = saved.answerId;
				attempt = await fetchAtIndex(answerId);
				log.push({ step: "fetch", index, mode: "after-tempSave", ok: "html" in attempt });
			}

			if ("error" in attempt) {
				console.warn(`[chaoxing] 拉取第 ${index + 1} 题失败`, attempt.error);
				misses++;
				if (misses >= 2) break;
				index++;
				continue;
			}

			const html = attempt.html;
			const extra = await parsePaper(html, markdownOpts);
			const fresh = extra.questions.filter((q) => !seen.has(q.id));
			const pageIndex = extra.questions[0]?.index;
			log.push({
				step: "parsed",
				index,
				pageIndex,
				questions: extra.questions.map((q) => q.id),
				fresh: fresh.length,
			});
			if (fresh.length === 0) {
				await this.dumpDebug(`probe-${index}`, html);
				misses++;
				if (misses >= 2) break;
				index++;
				continue;
			}
			misses = 0;
			for (const question of fresh) {
				seen.add(question.id);
				paper.questions.push(question);
			}
			current = fresh[0];
			savedCurrent = false;
			progress.setMessage(
				expected > 0
					? `这份作业共 ${expected} 道题，已拉取 ${seen.size}/${expected}…`
					: `已拉取 ${seen.size} 道题…`,
			);
			// 页码用页面自己渲染的 index 推进，避免自我计数错位
			index = (pageIndex !== undefined && pageIndex >= index ? pageIndex : index) + 1;
		}
		progress.hide();

		// 逐题都拿不齐时，最后试一次客户端整卷接口
		if (expected > 0 && seen.size < expected) {
			const fullHtml = await this.host.api.fetchFullPaperHtml(item, enter, sessionFields);
			if (fullHtml) {
				await this.dumpDebug("mworkspecial", fullHtml, { overwrite: true });
				const fullPaper = await parsePaper(fullHtml, markdownOpts);
				const fresh = fullPaper.questions.filter((q) => !seen.has(q.id));
				log.push({
					step: "mworkspecial",
					questions: fullPaper.questions.map((q) => q.id),
					fresh: fresh.length,
				});
				for (const question of fresh) {
					seen.add(question.id);
					paper.questions.push(question);
				}
			}
		}

		await this.dumpDebug("collect", JSON.stringify(log, null, 2), { overwrite: true });
	}

	/**
	 * 把原始响应存到笔记目录的 _debug 下。
	 * overwrite=true 时写到固定的 `last-…` 文件名并覆盖，用于保留最近一次内容。
	 */
	async dumpDebug(label: string, content: string, opts: { overwrite?: boolean } = {}): Promise<string | null> {
		try {
			const dir = normalizePath(`${this.host.settings.noteFolder}/_debug`);
			await this.ensureFolder(dir);
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			if (opts.overwrite) {
				const path = normalizePath(`${dir}/last-${label}.html`);
				await this.app.vault.adapter.write(path, content);
				console.debug(`[chaoxing] 已更新调试文件：${path}`);
				return path;
			}
			const path = normalizePath(`${dir}/${stamp}-${label}.html`);
			if (!this.app.vault.getAbstractFileByPath(path)) {
				await this.app.vault.create(path, content);
			}
			console.warn(`[chaoxing] 已保存调试文件：${path}`);
			return path;
		} catch (error) {
			console.error("[chaoxing] 保存调试文件失败", error);
			return null;
		}
	}

	/** 从 assets/font_map.txt 建解码器（页面没加密时返回 null） */
	async decoderForPage(html: string): Promise<FontDecoder | null> {
		if (!html.includes("cxSecretStyle")) return null;
		const fontBytes = extractEncryptedFontBytes(html);
		if (!fontBytes) return null;
		const table = await this.host.loadFontTable();
		if (!table) return null;
		return buildDecoder(fontBytes, table);
	}

	/**
	 * 把题目图片存进 vault：支持内嵌 base64 与远程图片（远程图会带上 Cookie 拉取）。
	 * 失败时返回 null，调用方保留原始链接。
	 */
	async saveImage(item: WorkListItem, src: string, _hint?: string): Promise<string | null> {
		let bytes: Uint8Array | null = null;
		let ext = "png";

		const inline = src.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s);
		if (inline) {
			bytes = base64ToBytes(inline[2]);
			ext = inline[1];
		} else if (/^(https?:)?\/\//i.test(src)) {
			const url = src.startsWith("//") ? `https:${src}` : src;
			const res = await this.host.api.httpBinary(url).catch(() => null);
			if (!res) return null;
			bytes = res.bytes;
			const mime = res.contentType?.match(/^image\/([a-zA-Z0-9.+-]+)/)?.[1];
			const fromUrl = url.split("?")[0].match(/\.([a-zA-Z0-9]{2,4})$/)?.[1];
			ext = mime ?? fromUrl ?? "png";
		} else {
			return null;
		}

		if (!bytes || bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return null;
		ext = ext.toLowerCase() === "jpeg" ? "jpg" : ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";

		const folder = normalizePath(
			`${this.host.settings.noteFolder}/attachments/${sanitizeFileName(item.courseName ?? "未分类")}`,
		);
		await this.ensureFolder(folder);
		// 用图片内容的哈希命名：不同题目的不同图片不会撞名，同一张图也不会存两份
		const digest = md5Hex(bytes).slice(0, 10);
		const path = normalizePath(`${folder}/${sanitizeFileName(item.title)}-${digest}.${ext}`);
		if (this.app.vault.getAbstractFileByPath(path)) return path;
		const buffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(buffer).set(bytes);
		await this.app.vault.createBinary(path, buffer);
		return path;
	}

	private notePath(item: WorkListItem): string {
		const { noteFolder, folderPerCourse } = this.host.settings;
		const file = `${sanitizeFileName(item.title)}.md`;
		const path = folderPerCourse
			? `${noteFolder}/${sanitizeFileName(item.courseName ?? "未分类课程")}/${file}`
			: `${noteFolder}/${file}`;
		return normalizePath(path);
	}

	/** 逐级创建目录：索引里没有、文件系统里也没有才创建；已存在的报错直接忽略 */
	private async ensureFolder(dir: string): Promise<void> {
		if (!dir) return;
		let current = "";
		for (const part of normalizePath(dir).split("/")) {
			current = current ? `${current}/${part}` : part;
			if (this.app.vault.getAbstractFileByPath(current)) continue;
			try {
				if (await this.app.vault.adapter.exists(current)) continue;
				await this.app.vault.createFolder(current);
			} catch (error) {
				if (this.app.vault.getAbstractFileByPath(current)) continue;
				if (error instanceof Error && /already exists/i.test(error.message)) continue;
				throw error;
			}
		}
	}

	/** 写笔记：已存在就改写；create 撞上「已存在」也退回改写 */
	private async writeNoteFile(path: string, content: string): Promise<TFile> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return existing;
		}
		try {
			return await this.app.vault.create(path, content);
		} catch (error) {
			if (error instanceof Error && /already exists/i.test(error.message)) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					await this.app.vault.modify(file, content);
					return file;
				}
			}
			throw error;
		}
	}

	/**
	 * 工作流入口统一兜底：漏网的异常也要变成用户可见的提示（曾经有一步出错时
	 * 什么都弹不出来，很难排查）。
	 */
	private async guard(context: string, fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (error) {
			this.reportError(context, error);
		}
	}

	private reportError(context: string, error: unknown): void {
		if (error instanceof ChaoxingAuthError) {
			new Notice(`${context}：${error.message}`, 8000);
			return;
		}
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[chaoxing] ${context}`, error);
		new Notice(`${context}：${msg}`, 10000);
	}

	private async withErrors<T>(fn: () => Promise<T>, context: string): Promise<T | null> {
		try {
			return await fn();
		} catch (error) {
			this.reportError(context, error);
			return null;
		}
	}
}
