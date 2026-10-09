/** 数据模型：课程 / 作业条目 / 试卷 / 题目 / 答案 */

export interface Course {
	courseId: string;
	clazzId: string;
	cpi: string;
	name: string;
	teacher?: string;
}

export interface WorkListItem {
	title: string;
	status: string;
	remain?: string;
	courseId: string;
	clazzId: string;
	cpi: string;
	/** mtaskmsgspecial 链接的参数 */
	taskrefId: string;
	msgId: string;
	userId: string;
	type: string;
	encTask: string;
	/** 列表里给出的完整“进入作业”链接 */
	rawUrl: string;
	/** 课程名（来自作业总列表 / 当前所选课程） */
	courseName?: string;
}

/** 进入作业页后从页面里提取到的参数 */
export interface EnterInfo {
	cpi: string;
	workAnswerId: string;
	enc: string;
	/** 进入页提示的题目数量（部分作业有） */
	questionTotal?: number;
	/** 需要滑块验证码时非空 */
	captchaId?: string;
}

export interface QuestionOption {
	/** 选项字母 A/B/C/D… */
	letter: string;
	text: string;
}

export type QuestionKind = "single" | "multiple" | "judgement" | "completion" | "subjective" | "unknown";

export interface Question {
	id: string;
	typeCode: string;
	kind: QuestionKind;
	/** 展示用的题型名，如「单选题」 */
	typeName: string;
	/** 题干（已转成 markdown） */
	title: string;
	options: QuestionOption[];
	/** 填空题的空的个数 */
	blankCount: number;
	/** 题目分值（手机端逐题提交要用） */
	score?: string;
	/** 题目在整卷里的序号（手机端逐题提交要用） */
	index?: number;
	/** 页面上已有的作答（拉取时同步进笔记） */
	existingAnswer?: string;
	/** 这道题所在页面上的隐藏字段（手机端逐题提交按题回传） */
	submitFields?: Record<string, string>;
	/** 该题页面上 answer* 字段的原值（翻页时原样回传，避免覆盖已有作答） */
	rawAnswerFields?: Record<string, string>;
}

export interface Paper {
	title?: string;
	questions: Question[];
	/** 提交方式：手机端逐题（doNormalHomeWorkSubmit）或网页端一次交卷（addStudentWorkNew） */
	submitMode: "phone" | "web";
	/** 提交时需要原样带回的表单隐藏字段（不含答案字段） */
	hiddenFields: Record<string, string>;
	fullScore?: string;
	/** 页面使用了 cxSecretStyle 字体加密（已尝试解码） */
	encrypted: boolean;
}

export interface Answer {
	questionId: string;
	typeCode: string;
	kind: QuestionKind;
	/** 该题页面上的隐藏字段（逐题提交时回传） */
	submitFields?: Record<string, string>;
	/** 题目分值 */
	score?: string;
	/** 单个提交值：选择题字母、判断题 true/false、填空/简答文本 */
	value: string;
	/** 填空题逐空答案 */
	blanks?: string[];
	/** 确认弹窗里显示的摘要 */
	display: string;
	answered: boolean;
}

export interface SubmitResult {
	ok: boolean;
	msg: string;
}

export const QUESTION_KIND_BY_CODE: Record<string, QuestionKind> = {
	"0": "single",
	"1": "multiple",
	"2": "completion",
	"3": "judgement",
	"4": "subjective",
	"5": "subjective",
	"6": "subjective",
	"7": "subjective",
	"9": "subjective",
	"10": "subjective",
	"11": "unknown",
	"13": "unknown",
	"14": "unknown",
	"15": "unknown",
	"18": "unknown",
	"19": "unknown",
	"20": "subjective",
};

export const QUESTION_TYPE_NAME: Record<string, string> = {
	"0": "单选题",
	"1": "多选题",
	"2": "填空题",
	"3": "判断题",
	"4": "简答题",
	"5": "名词解释",
	"6": "论述题",
	"7": "计算题",
	"8": "其它",
	"9": "分录题",
	"10": "资料题",
	"11": "连线题",
	"13": "排序题",
	"14": "完型填空",
	"15": "阅读理解",
	"18": "口语题",
	"19": "听力题",
	"20": "共用选项题",
	"21": "测评题",
};
