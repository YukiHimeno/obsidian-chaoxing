import { FontDecoder } from "./font";
import {
	EnterInfo,
	Paper,
	Question,
	QuestionKind,
	QuestionOption,
	QUESTION_KIND_BY_CODE,
	QUESTION_TYPE_NAME,
} from "./types";

/**
 * 作业页面解析：把手机版/桌面版作业页的 DOM 转成 Question 列表，
 * 同时把题干转成适合写进笔记的 Markdown。
 *
 * 页面结构（以手机版为例，桌面版是同类结构、类名略有不同）：
 *   <div class="Py-mian1 singleQuesId" data="题目ID">
 *     <div class="Py-m1-title">1.<span class="quesType">[单选题]</span>题干…</div>
 *     <ul class="answerList"><li><em class="choose-opt">A</em><div class="choose-desc">选项</div></li>…</ul>
 *     <input type="hidden" name="answer题目ID" value=""/>
 *     <input type="hidden" name="answertype题目ID" value="0"/>
 *   </div>
 */

export function parseHtml(html: string): Document {
	const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
	if (!Parser) throw new Error("当前环境没有 DOMParser");
	return new Parser().parseFromString(html, "text/html");
}

const INLINE_KEEP = new Set(["sub", "sup", "u", "span", "font", "code", "big", "small", "mark"]);
const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "table"]);

/**
 * 题目块里混着答题编辑器的 UI（工具栏图标、拍照识别面板等），
 * 它们平时是隐藏的，不能当题干内容。
 */
const NOISE_SELECTOR = [
	"script",
	"style",
	"input",
	"textarea",
	"button",
	"select",
	"ul",
	".quesType",
	".TiMu",
	".answerList",
	".Briefanswer",
	".BanswerIcon",
	".ananas-editor-answer",
	".jdt",
	"[class*='ocr']",
	"[class*='OCR']",
	"[id*='ocr']",
	"[id*='OCR']",
	"[class*='editor']",
	"[id*='editor']",
	"[class*='camera']",
	"[class*='录音']",
	"[class*='photo']",
	"[class*='voice']",
].join(", ");

/** 元素是否被隐藏（内联样式或 hidden 属性） */
export function isHiddenElement(el: Element): boolean {
	if (el.hasAttribute("hidden")) return true;
	const style = el.getAttribute("style") ?? "";
	return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

export function stripNoiseElements(root: Element): void {
	for (const junk of Array.from(root.querySelectorAll(NOISE_SELECTOR))) junk.remove();
}

export interface MarkdownOptions {
	decoder?: FontDecoder | null;
	/** 内嵌 base64 图片落盘，返回 vault 内的链接（如 "超星作业/attachments/xx.png"） */
	saveImage?: (dataUrl: string, hint: string) => Promise<string | null>;
}

function decodeText(text: string, decoder?: FontDecoder | null): string {
	const t = text.replace(/\u00a0/g, " ");
	return decoder ? decoder.decode(t) : t;
}

/** 取节点内的可见文本（含图片占位），已做字体解密 */
export function nodeText(node: Node, decoder?: FontDecoder | null): string {
	let out = "";
	const walk = (n: Node): void => {
		for (const child of Array.from(n.childNodes)) {
			if (child.nodeType === 3) out += decodeText(child.textContent ?? "", decoder);
			else if (child.nodeType === 1) {
				const el = child as Element;
				const tag = el.tagName.toLowerCase();
				if (isHiddenElement(el)) continue;
				if (tag === "br") out += "\n";
				else if (tag === "img") out += "[图片]";
				else if (tag === "script" || tag === "style") continue;
				else walk(child);
			}
		}
	};
	walk(node);
	return collapseWhitespace(out);
}

function collapseWhitespace(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line, idx, arr) => line.length > 0 || (idx > 0 && idx < arr.length - 1))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * 把 DOM 片段转 Markdown。行内保留少量 Obsidian 支持的 HTML 标签，
 * base64 图片交给 saveImage 落盘后以 ![[...]] 引用。
 */
export async function nodeToMarkdown(node: Node, opts: MarkdownOptions = {}): Promise<string> {
	const { decoder, saveImage } = opts;
	const parts: string[] = [];
	let imageIndex = 0;

	const walk = async (n: Node, context: { listDepth: number }): Promise<void> => {
		for (const child of Array.from(n.childNodes)) {
			if (child.nodeType === 3) {
				parts.push(decodeText(child.textContent ?? "", decoder));
				continue;
			}
			if (child.nodeType !== 1) continue;
			const el = child as Element;
			const tag = el.tagName.toLowerCase();
			if (tag === "script" || tag === "style" || tag === "button") continue;
			if (isHiddenElement(el)) continue;
			if (tag === "br") {
				parts.push("\n");
				continue;
			}
			if (tag === "img") {
				const src = el.getAttribute("src") ?? "";
				if (!src) continue;
				if (saveImage) {
					const link = await saveImage(src, `image${++imageIndex}`);
					parts.push(link ? `![[${link}]]` : `![图片](${src})`);
				} else {
					parts.push(`![图片](${src})`);
				}
				continue;
			}
			if (tag === "b" || tag === "strong") {
				parts.push("**");
				await walk(el, context);
				parts.push("**");
				continue;
			}
			if (tag === "i" || tag === "em") {
				parts.push("*");
				await walk(el, context);
				parts.push("*");
				continue;
			}
			if (INLINE_KEEP.has(tag) && tag !== "span" && tag !== "font") {
				parts.push(`<${tag}>`);
				await walk(el, context);
				parts.push(`</${tag}>`);
				continue;
			}
			if (tag === "li") {
				parts.push(`\n${"  ".repeat(context.listDepth)}- `);
				await walk(el, { listDepth: context.listDepth + 1 });
				parts.push("\n");
				continue;
			}
			if (tag === "ul" || tag === "ol") {
				await walk(el, { listDepth: context.listDepth + 1 });
				continue;
			}
			if (BLOCK_TAGS.has(tag)) {
				parts.push("\n");
				await walk(el, context);
				parts.push("\n");
				continue;
			}
			await walk(el, context);
		}
	};

	await walk(node, { listDepth: 0 });
	return normalizeMarkdown(parts.join(""));
}

function normalizeMarkdown(text: string): string {
	return text
		.replace(/\u00a0/g, " ")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").replace(/^\s+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+$/gm, "")
		.trim();
}

/** 收集表单隐藏字段（answer* / answertype* 这些答案字段不算；workAnswerId 要保留） */
export function extractFormFields(doc: Document): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const input of Array.from(doc.querySelectorAll("input[type='hidden'][name]"))) {
		const name = input.getAttribute("name") ?? "";
		if (!name || /^answer/i.test(name)) continue;
		fields[name] = input.getAttribute("value") ?? "";
	}
	return fields;
}

const TYPE_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
	Object.entries(QUESTION_TYPE_NAME).map(([code, name]) => [name, code]),
);

function detectTypeCode(block: Element, id: string): string {
	for (const selector of [`input[name="answertype${id}"]`, `input[name="type${id}"]`]) {
		const input = block.querySelector(selector);
		const v = input?.getAttribute("value");
		if (v) return v;
	}
	const tiMu = block.querySelector("div.TiMu[data]");
	if (tiMu) {
		const v = tiMu.getAttribute("data");
		if (v) return v;
	}
	const typeSpan = block.querySelector("span.quesType");
	if (typeSpan) {
		const name = (typeSpan.textContent ?? "").replace(/[[\]【】]/g, "").trim();
		if (TYPE_NAME_TO_CODE[name]) return TYPE_NAME_TO_CODE[name];
	}
	return "8";
}

function extractOptionLetter(li: Element, index: number): string {
	const em = li.querySelector("em.choose-opt");
	if (em) {
		const param = em.getAttribute("id-param");
		if (param && /^[A-Za-z]$/.test(param)) return param.toUpperCase();
		const text = (em.textContent ?? "").trim();
		if (/^[A-Za-z]$/.test(text)) return text.toUpperCase();
	}
	const aria = li.getAttribute("aria-label") ?? "";
	const m = aria.match(/^\s*([A-Za-z])[.、:：)）]/);
	if (m) return m[1].toUpperCase();
	return String.fromCharCode("A".charCodeAt(0) + index);
}

function stripLetterPrefix(text: string, letter: string): string {
	const trimmed = text.replace(/^\s+/, "");
	if (trimmed.charAt(0).toUpperCase() === letter.toUpperCase()) {
		return trimmed.slice(1).replace(/^[\s.、:：)）\]、]+/, "");
	}
	return trimmed;
}

function extractOptionText(li: Element, letter: string, decoder?: FontDecoder | null): string {
	const desc = li.querySelector(".choose-desc");
	if (desc) return nodeText(desc, decoder);
	const aria = li.getAttribute("aria-label");
	if (aria) return collapseWhitespace(stripLetterPrefix(aria, letter));
	const text = nodeText(li, decoder);
	return collapseWhitespace(stripLetterPrefix(text, letter));
}

function countBlanks(block: Element, id: string, title: string): number {
	const textareas = block.querySelectorAll(`textarea[name^="answer${id}"]`).length;
	if (textareas > 0) return textareas;
	const editors = block.querySelectorAll(`.editorBlank${id}, .editorBlank`).length;
	if (editors > 0) return editors;
	const inputs = Array.from(block.querySelectorAll("input")).filter(
		(inp) =>
			(inp.getAttribute("type") ?? "text") !== "hidden" &&
			(inp.getAttribute("name") ?? "").startsWith(`answer${id}`),
	).length;
	if (inputs > 0) return inputs;
	const marks = title.match(/_{2,}|（\s*）|\(\s*\)|【\s*】/g);
	return marks ? marks.length : 1;
}

/** 题目页上 answer* 字段的原始值（翻页时的 tempSave 要原样回传） */
export function extractRawAnswerFields(doc: Document): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const el of Array.from(doc.querySelectorAll("input[name^='answer'], textarea[name^='answer']"))) {
		const name = el.getAttribute("name") ?? "";
		if (!name) continue;
		fields[name] = el.getAttribute("value") ?? el.textContent ?? "";
	}
	return fields;
}

/** 读出页面上这道题已有的作答（手机端逐题页的 answer{id} 里存的是 HTML 片段） */
function existingAnswerOf(block: Element, id: string): string {
	const el = block.querySelector(`input[name="answer${id}"], textarea[name="answer${id}"]`);
	const raw = el?.getAttribute("value") ?? el?.textContent ?? "";
	return raw
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export interface ParseQuestionsResult {
	questions: Question[];
	/** 页面出现但无法识别的题型 */
	unknownTypes: string[];
}

/** 从 answertype 隐藏输入反推题目 ID（每题都有一个，可作为定位题目的锚点） */
function answerTypeIdOf(block: Element): string | null {
	const input = block.querySelector("input[id^='answertype'], input[name^='answertype']");
	const attr = input?.getAttribute("id") ?? input?.getAttribute("name") ?? "";
	const match = attr.match(/^answertype(.+)$/);
	return match ? match[1] : null;
}

/** 从 answertype 输入向上找题目容器 */
function questionContainerOf(input: Element): Element | null {
	const known = input.closest("div.singleQuesId, div.Py-mian1, li.singleQuesId");
	if (known) return known;
	// 类名变了时，逐级向上找最近的、看起来像「一道题」的祖先
	let node: Element | null = input.parentElement;
	for (let hops = 0; node && hops < 8; hops++) {
		if (node.querySelector("div.Py-m1-title, div.Zy_TItle, div.TiMu")) return node;
		node = node.parentElement;
	}
	return null;
}

/** 容器里应该只有一道题（一个 answertype 输入），否则说明没有按题分块 */
function isSingleQuestionContainer(container: Element): boolean {
	return container.querySelectorAll("input[id^='answertype'], input[name^='answertype']").length <= 1;
}

const KNOWN_TYPE_NAMES = new Set([
	"单选题",
	"多选题",
	"填空题",
	"判断题",
	"简答题",
	"名词解释",
	"论述题",
	"计算题",
	"其它",
	"分录题",
	"资料题",
	"连线题",
	"排序题",
	"完型填空",
	"阅读理解",
	"口语题",
	"听力题",
	"共用选项题",
]);

/** 找出页面上的题型标签（不同版本用的类名不一样） */
function findTypeLabel(block: Element): string {
	const el = block.querySelector(
		"span.quesType, [class*='quesType'], [class*='typeLabel'], .quesTypeName, h2.titType, span.focusSpan",
	);
	const text = (el?.textContent ?? "")
		.replace(/[[\]【】]/g, "")
		.trim();
	if (text && text.length <= 12) return text;
	return "";
}

/** 标题开头如果是「计算题」这类题型词（有些版本不带 [ ]），摘出来当标签 */
function splitLeadingTypeWord(title: string): { label: string; rest: string } {
	const lines = title.split("\n");
	const first = (lines[0] ?? "").trim().replace(/[[\]【】]/g, "");
	if (lines.length > 1 && first && KNOWN_TYPE_NAMES.has(first)) {
		return { label: first, rest: lines.slice(1).join("\n").trim() };
	}
	return { label: "", rest: title };
}

async function parseQuestionBlock(
	block: Element,
	knownId: string | null,
	opts: MarkdownOptions,
	unknownTypes: string[],
	pageFields: Record<string, string> = {},
	pageRawAnswers: Record<string, string> = {},
): Promise<Question | null> {
	const id = knownId ?? block.getAttribute("data") ?? answerTypeIdOf(block) ?? "";
	if (!id) return null;
	const typeCode = detectTypeCode(block, id);
	const kind: QuestionKind = QUESTION_KIND_BY_CODE[typeCode] ?? "unknown";
	if (kind === "unknown" && !unknownTypes.includes(typeCode)) unknownTypes.push(typeCode);

	const titleEl =
		block.querySelector("div.Py-m1-title") ??
		block.querySelector("div.Zy_TItle") ??
		block.querySelector("div.workWrap") ??
		block.querySelector("div.timuStyle") ??
		block.querySelector("div.TiMu") ??
		block;
	const titleClone = titleEl.cloneNode(true) as Element;
	stripNoiseElements(titleClone);
	let title = await nodeToMarkdown(titleClone, opts);
	title = title.replace(/^\s*\d+\s*[.、,，)]\s*/, "").trim();
	// 「计算题」这类题型词经常以标题首行的形式出现，摘出来当题型名
	const leading = splitLeadingTypeWord(title);
	if (leading.label) title = leading.rest;

	const options: QuestionOption[] = [];
	if (kind === "single" || kind === "multiple" || kind === "judgement") {
		const lis = Array.from(block.querySelectorAll("ul.answerList li, ul li"));
		lis.forEach((li, index) => {
			const letter = extractOptionLetter(li, index);
			const text = extractOptionText(li, letter, opts.decoder);
			if (text || letter) options.push({ letter, text });
		});
		if (kind === "judgement" && options.length === 0) {
			options.push({ letter: "A", text: "正确" }, { letter: "B", text: "错误" });
		}
	}

	const blankCount = kind === "completion" ? countBlanks(block, id, title) : 0;
	const score = block.querySelector(`input[name="score${id}"]`)?.getAttribute("value") ?? undefined;
	const indexRaw = block.querySelector(`input[name="index"]`)?.getAttribute("value") ?? "";
	const index = indexRaw !== "" && Number.isFinite(Number(indexRaw)) ? Number(indexRaw) : undefined;
	const existingAnswer = existingAnswerOf(block, id);

	// 题目自带的题型标签比代码映射更贴近页面显示（比如代码 8 的「计算题」）
	const pageLabel = findTypeLabel(block) || leading.label;
	const standardName = QUESTION_TYPE_NAME[typeCode];
	const typeName = kind === "unknown" && pageLabel ? pageLabel : (standardName ?? pageLabel ?? "未知题型");

	return {
		id,
		typeCode,
		kind,
		typeName,
		title,
		options,
		blankCount,
		score: score || undefined,
		index,
		existingAnswer: existingAnswer || undefined,
		submitFields: Object.keys(pageFields).length > 0 ? pageFields : undefined,
		rawAnswerFields: (() => {
			const raws: Record<string, string> = {};
			for (const [name, value] of Object.entries(pageRawAnswers)) {
				if (name.startsWith(`answer${id}`)) raws[name] = value;
			}
			return Object.keys(raws).length > 0 ? raws : undefined;
		})(),
	};
}

export async function extractQuestions(
	doc: Document,
	opts: MarkdownOptions = {},
): Promise<ParseQuestionsResult> {
	const questions: Question[] = [];
	const unknownTypes: string[] = [];

	const pageFields = extractFormFields(doc);
	const pageRawAnswers = extractRawAnswerFields(doc);
	const blocks = Array.from(doc.querySelectorAll("div.singleQuesId"));
	if (blocks.length > 0) {
		for (const block of blocks) {
			const question = await parseQuestionBlock(block, null, opts, unknownTypes, pageFields, pageRawAnswers);
			if (question) questions.push(question);
		}
		return { questions, unknownTypes };
	}

	// 页面改版、容器类名变了时的兜底：用每题都带的 answertype 隐藏输入定位题目
	const inputs = Array.from(doc.querySelectorAll("input[id^='answertype'], input[name^='answertype']"));
	const seen = new Set<string>();
	for (const input of inputs) {
		const attr = input.getAttribute("id") ?? input.getAttribute("name") ?? "";
		const id = attr.replace(/^answertype/, "");
		if (!id || seen.has(id)) continue;
		const container = questionContainerOf(input);
		if (!container || !isSingleQuestionContainer(container)) continue;
		seen.add(id);
		const question = await parseQuestionBlock(container, id, opts, unknownTypes, pageFields, pageRawAnswers);
		if (question) questions.push(question);
	}

	return { questions, unknownTypes };
}

export function extractPaperTitle(doc: Document): string | undefined {
	const el =
		doc.querySelector("h3.py-Title") ??
		doc.querySelector("h3.chapter-title") ??
		doc.querySelector(".workTitle") ??
		doc.querySelector("title");
	const t = el?.textContent?.trim();
	return t || undefined;
}

/** 页面是否使用了字体加密（此时需要解密器） */
export function hasFontEncryption(doc: Document): boolean {
	return Boolean(doc.querySelector("style#cxSecretStyle"));
}

/** 超星错误页的提示语（p.blankTips），正常页面返回 null */
export function extractPageTip(text: string): string | null {
	if (!text || !text.includes("blankTips")) return null;
	const tip = parseHtml(text).querySelector("p.blankTips")?.textContent?.trim();
	return tip || null;
}

/** 在文本里按顺序试几个正则，返回第一个命中组的值 */
function firstMatch(text: string, patterns: RegExp[]): string | null {
	for (const re of patterns) {
		const m = text.match(re);
		if (m && m[1]) return m[1];
	}
	return null;
}

/** 页面/入口页里写明的题目数量（拿不到返回 0） */
export function detectQuestionTotal(text: string): number {
	const m = firstMatch(text, [
		/共包含\s*(\d+)\s*道题目/,
		/共\s*(\d+)\s*道题/,
		/共\s*(\d+)\s*题/,
		/"totalQuestion"\s*:\s*"?(\d+)/,
	]);
	if (!m) return 0;
	const n = parseInt(m, 10);
	return Number.isFinite(n) && n > 0 && n <= 500 ? n : 0;
}

/** 从「进入作业」页面里抽取后续要用的参数（cpi / workAnswerId / enc） */
export function extractEnterInfo(text: string): EnterInfo {
	const doc = parseHtml(text);
	const hidden = new Map<string, string>();
	for (const input of Array.from(doc.querySelectorAll("input"))) {
		const id = input.getAttribute("id");
		const name = input.getAttribute("name");
		if (id) hidden.set(id, input.getAttribute("value") ?? "");
		if (name) hidden.set(name, input.getAttribute("value") ?? "");
	}

	const captchaId = hidden.get("captchaCaptchaId") ?? "";
	const cpi = hidden.get("cpi") ?? firstMatch(text, [/\bcpi["'\s:=]+(\d+)/]) ?? "";
	const workAnswerId =
		hidden.get("workAnswerId") ?? hidden.get("answerId") ?? firstMatch(text, [/workAnswerId["'\s:=]+(\d+)/]) ?? "";
	const enc = firstMatch(text, [/enc\s*[:=]\s*["']([a-fA-F0-9]{32})["']/, /[?&]enc=([a-fA-F0-9]{32})/]) ?? "";

	const questionTotal = detectQuestionTotal(text);

	return { cpi, workAnswerId, enc, questionTotal: questionTotal || undefined, captchaId: captchaId || undefined };
}

/** 页面不是答题页（带原始 HTML，方便调用方落盘排查） */
export class PaperPageError extends Error {
	constructor(
		msg: string,
		readonly html: string,
	) {
		super(msg);
		this.name = "PaperPageError";
	}
}

/**
 * 判断拿到的页面是不是答题页。超星的错误页会把提示放在 p.blankTips 里
 * （「无效的权限」「此作业已被老师删除！」等），原样报出来最好排查。
 */
export function checkPaperPage(text: string): string {
	if (text.includes("已过时效")) throw new PaperPageError("该作业已过截止时间，不能再作答/提交", text);
	const doc = parseHtml(text);
	const blankTips = doc.querySelector("p.blankTips")?.textContent?.trim() ?? "";
	if (blankTips) {
		const hint = blankTips.includes("无效的权限")
			? "：Cookie 可能已过期，或该作业需要先在手机端打开一次"
			: "";
		throw new PaperPageError(`超星返回「${blankTips}」${hint}`, text);
	}
	const hasQuestions = doc.querySelector(
		"input[id^='answertype'], input[name^='answertype'], div.singleQuesId, div.Py-mian1",
	);
	if (!hasQuestions) {
		const title = doc.querySelector("head title")?.textContent ?? "";
		if (title.includes("已批阅")) throw new PaperPageError("该作业已批阅，页面不再提供作答入口", text);
		if (text.includes("教师未创建完成该测验") || text.includes("作业未创建完成")) {
			throw new PaperPageError("老师还没有发布这份作业的题目", text);
		}
		throw new PaperPageError("作业页面里没有识别到答题区域（可能是新版页面结构，或该作业还没开始作答）", text);
	}
	return text;
}

/** 从 HTML 文本里抽取试卷信息（题目 + 表单字段） */
export async function parsePaper(html: string, opts: MarkdownOptions = {}): Promise<Paper> {
	const doc = parseHtml(html);
	const encrypted = hasFontEncryption(doc);
	const { questions } = await extractQuestions(doc, opts);
	const hiddenFields = extractFormFields(doc);
	// 手机端逐题变体带 #phoneSubmit / type{id}；网页端整卷变体带 answertype{id}
	const submitMode: "phone" | "web" = doc.querySelector("#phoneSubmit, #questionId, input[name^='type']")
		? "phone"
		: "web";
	return {
		title: extractPaperTitle(doc),
		questions,
		hiddenFields,
		fullScore: hiddenFields["fullScore"],
		encrypted,
		submitMode,
	};
}
