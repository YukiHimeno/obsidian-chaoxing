import { App, Modal, Setting, SuggestModal } from "obsidian";
import { Course, WorkListItem } from "../model/types";

/**
 * 单选弹窗（课程 / 作业）基类。
 *
 * 选中 → onPick(item)；直接关掉窗口 → onCancel()（保证调用方的 Promise 一定被结算）。
 * Obsidian 里 onChooseSuggestion 与 onClose 的先后顺序没有对外承诺，所以 onClose
 * 里延迟一拍再判断，避免把「选中」误判成「取消」。
 */
abstract class PickerModal<T> extends SuggestModal<T> {
	private settled = false;

	protected finish(action: () => void): void {
		if (this.settled) return;
		this.settled = true;
		action();
	}

	protected abstract onPick(item: T): void;
	protected abstract onCancel(): void;

	onChooseSuggestion(item: T): void {
		this.finish(() => this.onPick(item));
	}

	onClose(): void {
		setTimeout(() => {
			this.finish(() => this.onCancel());
		}, 0);
	}
}

export class CoursePickerModal extends PickerModal<Course> {
	constructor(
		app: App,
		private courses: Course[],
		private onChoose: (course: Course | null) => void,
	) {
		super(app);
		this.setPlaceholder("选择课程（输入以过滤）");
		this.emptyStateText = "没有匹配的课程";
	}

	protected onPick(course: Course): void {
		this.onChoose(course);
	}

	protected onCancel(): void {
		this.onChoose(null);
	}

	getSuggestions(query: string): Course[] {
		const q = query.trim().toLowerCase();
		if (!q) return this.courses;
		return this.courses.filter((c) => c.name.toLowerCase().includes(q));
	}

	renderSuggestion(course: Course, el: HTMLElement): void {
		el.createDiv({ text: course.name });
		el.createEl("small", { text: `courseId ${course.courseId} ｜ clazzId ${course.clazzId}`, cls: "chaoxing-hint" });
	}
}

const STATUS_CLASS: Array<[RegExp, string]> = [
	[/未交|未提交|待做|未完成|进行中/, "chaoxing-status-pending"],
	[/已完成|已批阅|已提交/, "chaoxing-status-done"],
	[/已截止|过期/, "chaoxing-status-overdue"],
];

export class WorkPickerModal extends PickerModal<WorkListItem> {
	constructor(
		app: App,
		course: Course,
		private works: WorkListItem[],
		private onChoose: (item: WorkListItem | null) => void,
	) {
		super(app);
		this.setPlaceholder(`《${course.name}》的作业（输入以过滤）`);
		this.emptyStateText = "没有匹配的作业";
	}

	protected onPick(item: WorkListItem): void {
		this.onChoose(item);
	}

	protected onCancel(): void {
		this.onChoose(null);
	}

	getSuggestions(query: string): WorkListItem[] {
		const q = query.trim().toLowerCase();
		if (!q) return this.works;
		return this.works.filter((w) => w.title.toLowerCase().includes(q) || w.status.includes(q));
	}

	renderSuggestion(item: WorkListItem, el: HTMLElement): void {
		const row = el.createDiv({ cls: "chaoxing-work-row" });
		row.createDiv({ text: item.title, cls: "chaoxing-work-title" });
		const statusCls = STATUS_CLASS.find(([re]) => re.test(item.status))?.[1] ?? "";
		row.createDiv({ text: item.status || "未知状态", cls: `chaoxing-status ${statusCls}` });
		if (item.remain) el.createEl("small", { text: item.remain, cls: "chaoxing-hint" });
	}
}

export class ConfirmModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private title: string,
		private lines: string[],
		private resolve: (ok: boolean) => void,
	) {
		super(app);
	}

	private finish(ok: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(ok);
		this.close();
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		for (const line of this.lines) this.contentEl.createEl("p", { text: line });
		new Setting(this.contentEl)
			.addButton((btn) => btn.setButtonText("取消").onClick(() => this.finish(false)))
			.addButton((btn) => btn.setButtonText("确定覆盖").setWarning().onClick(() => this.finish(true)));
	}

	onClose(): void {
		this.finish(false);
	}
}

export interface SubmitPreviewRow {
	index: number;
	typeName: string;
	display: string;
	answered: boolean;
}

export interface SubmitPreviewData {
	workTitle: string;
	rows: SubmitPreviewRow[];
	problems: string[];
}

export class SubmitPreviewModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private data: SubmitPreviewData,
		private resolve: (ok: boolean) => void,
	) {
		super(app);
	}

	private finish(ok: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(ok);
		this.close();
	}

	onOpen(): void {
		const { rows, problems, workTitle } = this.data;
		const unanswered = rows.filter((r) => !r.answered).length;
		this.titleEl.setText(`确认交卷：${workTitle}`);

		this.contentEl.createEl("p", {
			text: `共 ${rows.length} 题，已作答 ${rows.length - unanswered} 题${unanswered ? `，未作答 ${unanswered} 题（红色行）` : ""}`,
		});

		if (problems.length > 0) {
			const details = this.contentEl.createEl("details", { cls: "chaoxing-problems" });
			details.createEl("summary", { text: `${problems.length} 条提醒（点开查看）` });
			const ul = details.createEl("ul");
			for (const p of problems.slice(0, 50)) ul.createEl("li", { text: p });
		}

		const table = this.contentEl.createEl("table", { cls: "chaoxing-answer-table" });
		const thead = table.createTHead().insertRow();
		thead.insertCell().setText("题号");
		thead.insertCell().setText("题型");
		thead.insertCell().setText("作答");
		const tbody = table.createTBody();
		for (const row of rows) {
			const tr = tbody.insertRow();
			if (!row.answered) tr.addClass("chaoxing-unanswered");
			tr.insertCell().setText(String(row.index));
			tr.insertCell().setText(row.typeName);
			tr.insertCell().setText(row.display || "（未作答）");
		}

		new Setting(this.contentEl)
			.addButton((btn) => btn.setButtonText("取消").onClick(() => this.finish(false)))
			.addButton((btn) =>
				btn
					.setButtonText("确认交卷")
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	onClose(): void {
		this.finish(false);
	}
}
