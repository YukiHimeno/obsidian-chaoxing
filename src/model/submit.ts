import { Answer, Paper, Question } from "./types";

/**
 * 拼装交卷表单。
 *
 * 页面上的隐藏字段（totalQuestionNum、enc_work、workAnswerId 等都是服务器随页面下发的
 * 一次性状态）必须原样带回；答案字段按题型拼：
 *   选择 / 判断  answer{id} = A / AC / true|false
 *   填空         answer{id}1、answer{id}2… 逐空，外加 blankNum{id}="1,2,"
 *                （同时带一份拼接的 answer{id}，兼容只读单字段的处理逻辑）
 *   简答 / 其它  answer{id} = 文本
 *
 * pyFlag 留空表示交卷，"1" 表示只保存不提交。
 */
export function buildSubmitForm(paper: Paper, answers: Answer[], draft: boolean): Record<string, string> {
	const form: Record<string, string> = { ...paper.hiddenFields };
	form["pyFlag"] = draft ? "1" : "";
	form["answerwqbid"] = paper.questions.map((q) => q.id).join(",") + ",";

	for (const answer of answers) {
		const id = answer.questionId;
		form[`answertype${id}`] = answer.typeCode;
		if (answer.kind === "completion") {
			const blanks = answer.blanks ?? [];
			blanks.forEach((blank, index) => {
				form[`answer${id}${index + 1}`] = blank;
			});
			form[`blankNum${id}`] = blanks.map((_, index) => `${index + 1},`).join("");
			form[`answer${id}`] = blanks.join("\n");
		} else {
			form[`answer${id}`] = answer.value;
		}
	}
	return form;
}

/**
 * 手机端逐题提交的表单（doNormalHomeWorkSubmit）。
 *
 * 这种页面（`#phoneSubmit=1`）本身就是按题提交的：每道题带自己那份页面隐藏字段
 * （workRelationAnswerId、enc、encWork、questionId、index…），答案字段按题型拼：
 *   单选/判断 answer{id}，多选 answers{id}（复数），填空 answer{id}1..n + blankNum{id}，
 *   简答/其它 answer{id}。tempSave=true 表示只暂存。
 */
export function buildPhoneSubmitForm(
	question: Question | undefined,
	answer: Answer,
	draft: boolean,
): Record<string, string> {
	const form: Record<string, string> = { ...(question?.submitFields ?? {}) };
	form["tempSave"] = draft ? "true" : "false";
	const id = answer.questionId;
	form[`type${id}`] = answer.typeCode;
	if (question?.score) form[`score${id}`] = question.score;
	if (answer.kind === "multiple") {
		form[`answers${id}`] = answer.value;
	} else if (answer.kind === "completion") {
		const blanks = answer.blanks ?? [];
		blanks.forEach((blank, index) => {
			form[`answer${id}${index + 1}`] = blank;
		});
		form[`blankNum${id}`] = blanks.map((_, index) => `${index + 1},`).join("");
		form[`answer${id}`] = blanks.join("\n");
	} else {
		form[`answer${id}`] = answer.value;
	}
	return form;
}
