import { Answer, Paper, Question, QuestionKind } from "../model/types";

/**
 * 笔记格式约定（新版，尽量贴近原生 Markdown）：
 *
 *   ## 1. 计算题（5.2 分） ^cx-405691590
 *
 *   利用对角线法则计算下列三阶行列式：
 *   ![图片](https://…)
 *
 *   ### 作答
 *
 *   -4
 *
 *   - 题目标题以 Obsidian 原生**块 ID** `^cx-题目ID` 结尾：阅读模式下不可见，
 *     还能被引用（[[笔记#^cx-405691590]]）；提交时靠它把作答对回题目。
 *   - 选择题用任务列表勾选；填空/简答/其它写在「### 作答」小节里（填空题一行一个空）。
 *   - 旧版笔记里的 `%%cx:题目ID:题型:空数%%` 标记与 `%%cx-answer%%` 作答块仍然能解析，
 *     打开旧笔记直接提交不会丢答案。
 */

const LEGACY_MARKER_RE = /%%\s*cx:([A-Za-z0-9_-]+):(\d+):(\d+)\s*%%/;
const BLOCK_ID_RE = /\^cx-([A-Za-z0-9_-]+)/;
const LEGACY_ANSWER_START = /^%%\s*cx-answer\s*%%\s*$/;
const LEGACY_ANSWER_END = /^%%\/cx-answer\s*%%\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const CHECKBOX_RE = /^\s*[-*+]\s*\[( |x|X)\]\s*(.*)$/;
const DEFAULT_ANSWER_HEADING = "作答";

export interface NoteMeta {
	courseName: string;
	courseId: string;
	clazzId: string;
	cpi: string;
	workId: string;
	msgId: string;
	userId: string;
	type: string;
	encTask: string;
	workName: string;
	status: string;
	remain?: string;
}

/** 渲染笔记时可配置的样式 */
export interface NoteStyle {
	/** 作答小节标题文字（默认「作答」） */
	answerHeading: string;
	/** 标题里显示分值 */
	showScore: boolean;
	/** 标题里显示题型 */
	showTypeName: boolean;
	/** 生成顶部的信息 callout */
	showInfoCallout: boolean;
	/** 选择题用任务列表（勾选）；关闭则用普通列表 + 作答区写字母 */
	choiceAsTasks: boolean;
}

export const DEFAULT_NOTE_STYLE: NoteStyle = {
	answerHeading: DEFAULT_ANSWER_HEADING,
	showScore: true,
	showTypeName: true,
	showInfoCallout: true,
	choiceAsTasks: true,
};

/** 从笔记里读回来的答案（还没转成提交格式） */
export interface ParsedAnswer {
	questionId: string;
	typeCode: string;
	kind: QuestionKind;
	/** 选择题 / 判断题勾选或手写的字母 */
	letters: string[];
	/** 填空题逐空内容 */
	blanks: string[];
	/** 简答等自由文本（保留换行） */
	text: string;
	answered: boolean;
}

export interface ParsedNote {
	answers: Map<string, ParsedAnswer>;
	/** 笔记里出现却没解析出题目 ID 的小节数量（顺序匹配时用） */
	sectionsWithoutId: number;
	/** 小节数量（用于和试卷题目数比对） */
	sectionCount: number;
}

export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[\u0000-\u001f\u007f]/g, "") // 控制字符
		.replace(/[\u200b-\u200f\ufeff]/g, "") // 零宽字符
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/g, "");
	let out = (cleaned || "未命名作业").slice(0, 80).trim().replace(/[. ]+$/g, "");
	if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(out)) out = `${out}_`;
	return out || "未命名作业";
}

function yamlString(v: string): string {
	return JSON.stringify(v);
}

function flatten(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

function kindOf(typeCode: string): QuestionKind {
	switch (typeCode) {
		case "0":
			return "single";
		case "1":
			return "multiple";
		case "3":
			return "judgement";
		case "2":
			return "completion";
		case "4":
		case "5":
		case "6":
		case "7":
		case "9":
		case "10":
		case "20":
			return "subjective";
		default:
			return "unknown";
	}
}

function headingOf(q: Question, index: number, style: NoteStyle): string {
	let title = `${index + 1}.`;
	if (style.showTypeName && q.typeName) title += ` ${q.typeName}`;
	if (style.showScore && q.score) title += `（${q.score} 分）`;
	return `## ${title} ^cx-${q.id}`;
}

/** 题干里如果有 Markdown 标题，降级转义，避免打乱笔记的小节结构 */
function escapeHeadings(text: string): string {
	return text.replace(/^(#{1,6})\s/gm, (m, hashes: string) => `\\${hashes} `);
}

/** 页面上已有的作答（选择题取字母；判断题 true/false 映射成 A/B） */
function existingLetters(q: Question): string[] {
	const raw = (q.existingAnswer ?? "").trim();
	if (!raw) return [];
	if (q.kind === "judgement") {
		if (/true|对|正确|√|是/i.test(raw)) return ["A"];
		if (/false|错|×|否/i.test(raw)) return ["B"];
		return [];
	}
	const letters = raw.toUpperCase().replace(/[^A-Z]/g, "");
	return Array.from(new Set(letters.split(""))).sort();
}

function renderChoiceAnswer(q: Question, answer: ParsedAnswer | undefined, style: NoteStyle): string {
	const letters = answer ? answer.letters : existingLetters(q);
	return q.options
		.map((opt) => {
			const selected = letters.some((l) => l.toUpperCase() === opt.letter.toUpperCase());
			const text = flatten(opt.text);
			return style.choiceAsTasks
				? `- [${selected ? "x" : " "}] ${opt.letter}. ${text}`.trimEnd()
				: `- ${opt.letter}. ${text}`.trimEnd();
		})
		.join("\n");
}

function renderTextAnswer(q: Question, answer: ParsedAnswer | undefined, style: NoteStyle): string {
	let body = "";
	const existing = q.existingAnswer ?? "";
	if (q.kind === "completion") {
		const count = Math.max(q.blankCount, answer?.blanks.length ?? 0, 1);
		const synced = existing.split(/\n|\||\//).map((s) => s.trim());
		body = Array.from({ length: count }, (_, i) => answer?.blanks[i] ?? synced[i] ?? "").join("\n");
	} else if (answer) {
		body = answer.text;
	} else if (existing) {
		body = existing;
	}
	return `### ${style.answerHeading || DEFAULT_ANSWER_HEADING}\n\n${body}`;
}

export interface RenderOptions {
	meta: NoteMeta;
	paper: Paper;
	/** 已有的答案（刷新笔记时保留用户已填内容） */
	existing?: Map<string, ParsedAnswer>;
	style?: NoteStyle;
}

export function renderWorkNote(opts: RenderOptions): string {
	const { meta, paper, existing } = opts;
	const style = opts.style ?? DEFAULT_NOTE_STYLE;
	const fm = [
		"---",
		"chaoxing:",
		`  workId: ${yamlString(meta.workId)}`,
		`  workName: ${yamlString(meta.workName)}`,
		`  courseName: ${yamlString(meta.courseName)}`,
		`  courseId: ${yamlString(meta.courseId)}`,
		`  clazzId: ${yamlString(meta.clazzId)}`,
		`  cpi: ${yamlString(meta.cpi)}`,
		`  msgId: ${yamlString(meta.msgId)}`,
		`  userId: ${yamlString(meta.userId)}`,
		`  type: ${yamlString(meta.type)}`,
		`  encTask: ${yamlString(meta.encTask)}`,
		`  status: ${yamlString(meta.status)}`,
	];
	if (meta.remain) fm.push(`  remain: ${yamlString(meta.remain)}`);
	fm.push(`  totalQuestions: ${paper.questions.length}`);
	if (paper.fullScore) fm.push(`  fullScore: ${yamlString(paper.fullScore)}`);
	fm.push(`  pulledAt: ${yamlString(new Date().toISOString())}`);
	fm.push("---");

	const head = [`# ${meta.workName}`, ""];
	if (style.showInfoCallout) {
		const workUrl = `https://mooc1-api.chaoxing.com/mooc-ans/work/phone/task-work?taskrefId=${meta.workId}&courseId=${meta.courseId}&classId=${meta.clazzId}&ut=s`;
		head.push("> [!info] 超星作业");
		head.push(`> 课程：${meta.courseName} ｜ 状态：${meta.status}${meta.remain ? ` ｜ ${meta.remain}` : ""}`);
		head.push(
			`> 题目：${paper.questions.length} 题${paper.fullScore ? ` ｜ 满分：${paper.fullScore}` : ""} ｜ [在浏览器中打开作业](${workUrl})`,
		);
		head.push("> 作答完成后运行命令「超星学习通: 提交当前作业」交卷。");
		const syncedCount = paper.questions.filter((q) => q.existingAnswer).length;
		if (syncedCount > 0 && !existing) {
			head.push(`> 已同步页面上已有的作答：${syncedCount} 题（在这里修改后再提交，会覆盖线上答案）`);
		}
		if (paper.encrypted) {
			head.push("> [!warning] 该页面使用了字体加密，题干如有乱码属于解码失败，请在手机上核对题干。");
		}
	}
	const unsupported = paper.questions
		.map((q, index) => ({ q, index }))
		.filter(({ q }) => q.kind === "unknown" && q.typeCode !== "8");
	if (unsupported.length > 0) {
		head.push(
			`> [!warning] 第 ${unsupported.map(({ index }) => index + 1).join("、")} 题是插件不支持的题型` +
				`（${Array.from(new Set(unsupported.map(({ q }) => q.typeName))).join("、")}），会按自由文本提交，可能不被平台接受。`,
		);
	}
	head.push("");

	const blocks = paper.questions.map((q, index) => {
		const answer = existing?.get(q.id);
		const lines = [headingOf(q, index, style), ""];
		if (q.title) lines.push(escapeHeadings(q.title), "");
		const isChoice = q.kind === "single" || q.kind === "multiple" || q.kind === "judgement";
		if (isChoice && style.choiceAsTasks) {
			lines.push(renderChoiceAnswer(q, answer, style));
		} else if (isChoice) {
			lines.push(renderChoiceAnswer(q, answer, style), "", renderTextAnswer(q, answer, style));
		} else {
			lines.push(renderTextAnswer(q, answer, style));
		}
		return lines.join("\n");
	});

	return `${fm.join("\n")}\n\n${head.join("\n")}\n\n${blocks.join("\n\n")}\n`
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\n+$/, "\n");
}

export interface NoteSection {
	/** 小节编号（标题里的 "1." 等），拿不到为 null */
	displayNumber: number | null;
	questionId: string | null;
	typeCode: string | null;
	blankCount: number | null;
	lines: string[];
}

function parseHeadingNumber(headingText: string): number | null {
	const m = headingText.match(/^\s*(\d+)\s*[.、]/);
	return m ? parseInt(m[1], 10) : null;
}

/** 把笔记切成题目小节：按题目标题的标题级别分割（更深级别的标题算小节内容） */
export function splitNoteSections(content: string): NoteSection[] {
	const lines = content.split(/\r?\n/);
	let minHeadingLevel = 0;
	// 题目标题级别：取第一个带 ^cx- 或 %%cx: 标记的标题级别，缺省为 2
	for (const line of lines) {
		const m = line.match(HEADING_RE);
		if (m && (BLOCK_ID_RE.test(m[2]) || LEGACY_MARKER_RE.test(m[2]))) {
			minHeadingLevel = minHeadingLevel === 0 ? m[1].length : Math.min(minHeadingLevel, m[1].length);
		}
	}
	if (minHeadingLevel === 0) minHeadingLevel = 2;

	const sections: NoteSection[] = [];
	let current: NoteSection | null = null;
	let inFrontmatter = false;
	let inFence: string | null = null;
	for (const line of lines) {
		if (line.trim() === "---" && (sections.length === 0 || inFrontmatter)) {
			inFrontmatter = !inFrontmatter;
			continue;
		}
		if (inFrontmatter) continue;
		const fence = line.match(/^\s*(```|~~~)/);
		if (fence) {
			inFence = inFence === null ? fence[1] : null;
		}
		const heading = inFence === null ? line.match(HEADING_RE) : null;
		if (heading && heading[1].length <= minHeadingLevel) {
			if (current) sections.push(current);
			const legacy = heading[2].match(LEGACY_MARKER_RE);
			const blockId = heading[2].match(BLOCK_ID_RE);
			current = {
				displayNumber: parseHeadingNumber(heading[2]),
				questionId: legacy ? legacy[1] : blockId ? blockId[1] : null,
				typeCode: legacy ? legacy[2] : null,
				blankCount: legacy ? parseInt(legacy[3], 10) || 0 : null,
				lines: [],
			};
			continue;
		}
		if (current) current.lines.push(line);
	}
	if (current) sections.push(current);
	return sections;
}

function parseChoiceLetters(lines: string[]): string[] {
	const selected: string[] = [];
	let total = 0;
	for (const line of lines) {
		const m = line.match(CHECKBOX_RE);
		if (!m) continue;
		total++;
		const text = m[2].trim();
		const letterMatch = text.match(/^([A-Za-z])/);
		const letter = (letterMatch ? letterMatch[1] : String.fromCharCode(64 + total)).toUpperCase();
		if (m[1].toLowerCase() === "x" && !selected.includes(letter)) selected.push(letter);
	}
	return selected.sort();
}

/** 旧版 %%cx-answer%% 块的正文，没有返回 null */
function legacyAnswerBlock(lines: string[]): string | null {
	let start = -1;
	let end = -1;
	for (let i = 0; i < lines.length; i++) {
		if (start < 0 && LEGACY_ANSWER_START.test(lines[i].trim())) start = i;
		else if (start >= 0 && LEGACY_ANSWER_END.test(lines[i].trim())) {
			end = i;
			break;
		}
	}
	if (start < 0) return null;
	const body = lines.slice(start + 1, end < 0 ? undefined : end);
	while (body.length && body[0].trim() === "") body.shift();
	stripOwnRecords(body);
	return body.join("\n");
}

/** 「### 作答」小节的正文，没有返回 null */
function answerSection(lines: string[], heading: string): string | null {
	const names = new Set([heading.trim() || DEFAULT_ANSWER_HEADING, DEFAULT_ANSWER_HEADING]);
	let start = -1;
	let level = 6;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(HEADING_RE);
		if (!m) continue;
		if (start < 0) {
			if (m[1].length >= 3 && names.has(m[2].trim())) {
				start = i;
				level = m[1].length;
			}
			continue;
		}
	}
	if (start < 0) return null;
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const m = lines[i].match(HEADING_RE);
		if (m && m[1].length <= level) break;
		body.push(lines[i]);
	}
	while (body.length && body[0].trim() === "") body.shift();
	stripOwnRecords(body);
	return body.join("\n");
}

/** 引用式作答区（callout 样式）：> [!note]- 作答 */
function answerCallout(lines: string[], heading: string): string | null {
	const names = new Set([heading.trim() || DEFAULT_ANSWER_HEADING, DEFAULT_ANSWER_HEADING]);
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^>\s*\[![a-zA-Z]+\][-+]?\s*(.*)$/);
		if (m && names.has(m[1].trim())) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (!/^>/.test(lines[i])) break;
		body.push(lines[i].replace(/^>\s?/, ""));
	}
	while (body.length && body[0].trim() === "") body.shift();
	stripOwnRecords(body);
	return body.join("\n");
}

/** 插件早期版本会把提交记录写在正文末尾（%% 超星…成功 %%），解析时按空行丢弃 */
const OWN_RECORD_RE = /^%%\s*超星(保存草稿|交卷)成功[^%]*%%$/;

function stripOwnRecords(lines: string[]): void {
	// 插件写过的记录行出现在正文任何位置都去掉（正常答案不会长这样）
	for (let i = lines.length - 1; i >= 0; i--) {
		if (OWN_RECORD_RE.test(lines[i].trim())) lines.splice(i, 1);
	}
	while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
}

function lettersFromText(block: string): string[] {
	const letters = block
		.toUpperCase()
		.replace(/[\s,，、;；/]+/g, "")
		.split("")
		.filter((c) => /[A-Z]/.test(c));
	return Array.from(new Set(letters)).sort();
}

/** 解析笔记里记录的所有作答（新版块 ID / 作答小节，兼容旧版 %% 标记） */
export function parseNote(content: string, style?: NoteStyle): ParsedNote {
	const heading = style?.answerHeading ?? DEFAULT_ANSWER_HEADING;
	const answers = new Map<string, ParsedAnswer>();
	const sections = splitNoteSections(content);
	let sectionsWithoutId = 0;

	for (const section of sections) {
		if (!section.questionId) {
			sectionsWithoutId++;
			continue;
		}
		const block =
			legacyAnswerBlock(section.lines) ??
			answerSection(section.lines, heading) ??
			answerCallout(section.lines, heading);
		const checked = parseChoiceLetters(section.lines);
		const handWritten = block ? lettersFromText(block) : [];
		const letters = handWritten.length > 0 ? handWritten : checked;
		const blockText = (block ?? "").trim();
		const blockLines = (block ?? "").split("\n").map((l) => l.trim());
		while (blockLines.length && blockLines[blockLines.length - 1] === "") blockLines.pop();

		// 新版笔记里题型由试卷决定（笔记只带题目 ID）；这里按内容形态归类：
		// 有勾选框 = 选择题，其它 = 填空/简答（具体由提交时对照试卷）
		const hasCheckboxes = section.lines.some((line) => CHECKBOX_RE.test(line));
		const kind: QuestionKind = section.typeCode
			? kindOf(section.typeCode)
			: hasCheckboxes
				? "single"
				: "subjective";

		if (kind === "single" || kind === "multiple" || kind === "judgement") {
			answers.set(section.questionId, {
				questionId: section.questionId,
				typeCode: section.typeCode ?? "",
				kind,
				letters,
				blanks: [],
				text: "",
				answered: letters.length > 0,
			});
			continue;
		}

		// 填空与简答共用一段作答内容：blanks 逐行、text 整段，提交时按试卷题型选用
		answers.set(section.questionId, {
			questionId: section.questionId,
			typeCode: section.typeCode ?? "",
			kind,
			letters,
			blanks: blockLines,
			text: blockText,
			answered: blockText.length > 0,
		});
	}

	return { answers, sectionsWithoutId, sectionCount: sections.length };
}

/** 统计笔记里的作答进度（状态栏用，不依赖试卷） */
export function countAnswered(content: string, style?: NoteStyle): { answered: number; total: number } {
	const heading = style?.answerHeading ?? DEFAULT_ANSWER_HEADING;
	const sections = splitNoteSections(content).filter((section) => section.questionId);
	let answered = 0;
	for (const section of sections) {
		const block =
			legacyAnswerBlock(section.lines) ??
			answerSection(section.lines, heading) ??
			answerCallout(section.lines, heading);
		const checked = section.lines.some((line) => /^\s*[-*+]\s*\[[xX]\]/.test(line));
		if (checked || (block ?? "").trim().length > 0) answered++;
	}
	return { answered, total: sections.length };
}

/** 兼容旧调用：只取答案表 */
export function parseNoteAnswers(content: string): Map<string, ParsedAnswer> {
	return parseNote(content).answers;
}

function judgementValue(letters: string[], options: { letter: string; text: string }[]): string {
	if (letters.length === 0) return "";
	const selected = new Set(letters);
	// 逐个选项判断「对/错」：优先看选项文字，其次 A=对 B=错
	for (const opt of options) {
		if (!selected.has(opt.letter.toUpperCase())) continue;
		if (/错|×|否/.test(opt.text)) return "false";
		if (/对|正确|√|是/.test(opt.text)) return "true";
		return opt.letter.toUpperCase() === "A" ? "true" : "false";
	}
	return selected.has("A") ? "true" : "false";
}

export interface Submission {
	answers: Answer[];
	problems: string[];
}

/** 把笔记答案转成提交用的答案，并给出来自笔记/试卷比对的提醒 */
export function buildSubmission(paper: Paper, parsed: Map<string, ParsedAnswer>): Submission {
	const problems: string[] = [];
	const answers: Answer[] = [];

	paper.questions.forEach((q, index) => {
		const label = `第 ${index + 1} 题（${q.typeName}）`;
		const note = parsed.get(q.id);
		if (!note) {
			problems.push(`${label} 在笔记里没有作答区，笔记可能过期，请重新拉取`);
			answers.push({
				questionId: q.id,
				typeCode: q.typeCode,
				kind: q.kind,
				value: "",
				display: "",
				answered: false,
			});
			return;
		}

		if (q.kind === "single" || q.kind === "multiple" || q.kind === "judgement") {
			let letters = Array.from(new Set(note.letters));
			if (q.kind === "single" && letters.length > 1) {
				problems.push(`${label} 勾选了多个选项（${letters.join(",")}），将只提交第一个`);
				letters = [letters[0]];
			}
			if (q.kind === "judgement" && letters.length > 1) {
				problems.push(`${label} 勾选了多个选项，将只提交第一个`);
				letters = [letters[0]];
			}
			const validLetters = new Set(q.options.map((o) => o.letter.toUpperCase()));
			const invalid = letters.filter((l) => !validLetters.has(l));
			if (invalid.length > 0) {
				problems.push(`${label} 的作答 ${invalid.join(",")} 不在题目的选项内`);
			}
			const value = q.kind === "judgement" ? judgementValue(letters, q.options) : letters.join("");
			answers.push({
				questionId: q.id,
				typeCode: q.typeCode,
				kind: q.kind,
				value,
				display: letters.length
					? letters
							.map((l) => `${l}${q.kind === "judgement" ? (value === "true" ? "（对）" : "（错）") : ""}`)
							.join(",")
					: "",
				answered: value.length > 0,
			});
			return;
		}

		if (q.kind === "completion") {
			const given = note.blanks.slice();
			if (given.length > q.blankCount) {
				problems.push(`${label} 填了 ${given.length} 空，题目只有 ${q.blankCount} 空，多余的已忽略`);
			}
			if (q.blankCount > 0 && given.length < q.blankCount) {
				problems.push(`${label} 只填了 ${given.length}/${q.blankCount} 空`);
			}
			if (given.some((b) => b === "")) {
				problems.push(`${label} 有未填的空`);
			}
			const blanks =
				q.blankCount > 0 ? Array.from({ length: q.blankCount }, (_, i) => given[i] ?? "") : given;
			answers.push({
				questionId: q.id,
				typeCode: q.typeCode,
				kind: q.kind,
				// 拼接值保留空位（空行 = 未填的空），与逐空字段一一对应
				value: blanks.join("\n"),
				blanks,
				display: blanks.map((b, i) => `第${i + 1}空: ${b || "（未填）"}`).join("；"),
				answered: blanks.length > 0 && blanks.every((b) => b !== ""),
			});
			return;
		}

		const text = note.text.trim();
		answers.push({
			questionId: q.id,
			typeCode: q.typeCode,
			kind: q.kind,
			value: text,
			display: text ? text.replace(/\n+/g, " ").slice(0, 120) : "",
			answered: text.length > 0,
		});
	});

	const known = new Set(paper.questions.map((q) => q.id));
	for (const id of parsed.keys()) {
		if (!known.has(id)) problems.push(`笔记里的题目标记 ${id} 在试卷中不存在，可能是旧版笔记`);
	}
	return { answers, problems };
}
