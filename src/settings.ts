import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { ChaoxingApi } from "./api/chaoxing";
import { ChaoxingAuthError } from "./api/http";
import type ChaoxingPlugin from "./main";
import { NoteStyle } from "./sync/note";

export interface ChaoxingSettings {
	/** 从浏览器复制来的完整 Cookie 字符串 */
	cookie: string;
	/** 作业笔记保存目录 */
	noteFolder: string;
	/** 每门课程一个子目录 */
	folderPerCourse: boolean;
	/** 把题目里的图片（含内置 base64 与远程图片）存入 vault */
	saveImages: boolean;
	/** 作答小节的标题文字 */
	answerHeading: string;
	/** 题目标题里显示分值 */
	showScoreInHeading: boolean;
	/** 题目标题里显示题型 */
	showTypeInHeading: boolean;
	/** 生成顶部的信息 callout */
	showInfoCallout: boolean;
	/** 选择题用任务列表（勾选） */
	choiceAsTasks: boolean;
}

export const DEFAULT_SETTINGS: ChaoxingSettings = {
	cookie: "",
	noteFolder: "超星作业",
	folderPerCourse: true,
	saveImages: true,
	answerHeading: "作答",
	showScoreInHeading: true,
	showTypeInHeading: true,
	showInfoCallout: true,
	choiceAsTasks: true,
};

/** 由设置得到笔记样式 */
export function noteStyleOf(settings: ChaoxingSettings): NoteStyle {
	return {
		answerHeading: settings.answerHeading.trim() || "作答",
		showScore: settings.showScoreInHeading,
		showTypeName: settings.showTypeInHeading,
		showInfoCallout: settings.showInfoCallout,
		choiceAsTasks: settings.choiceAsTasks,
	};
}

export class ChaoxingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ChaoxingPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "超星学习通作业" });

		new Setting(containerEl)
			.setName("Cookie")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("在浏览器登录 ");
					frag.createEl("a", { text: "mooc1.chaoxing.com", href: "https://mooc1.chaoxing.com" });
					frag.appendText(
						" 后，按 F12 打开开发者工具 → Network → 刷新页面 → 点任意请求 → 复制 Request Headers 里的整段 Cookie 值粘贴到这里。",
					);
				}),
			)
			.addTextArea((text) => {
				text.inputEl.rows = 5;
				text.inputEl.style.width = "100%";
				text.setPlaceholder("fid=...; _uid=...; UID=...; vc3=...; uf=...; ...")
					.setValue(this.plugin.settings.cookie)
					.onChange(async (value) => {
						this.plugin.settings.cookie = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("检查登录状态")
			.setDesc("读取当前登录账号（用于验证 Cookie 是否有效）。")
			.addButton((btn) =>
				btn.setButtonText("测试").onClick(async () => {
					btn.setDisabled(true).setButtonText("测试中…");
					try {
						const api = new ChaoxingApi(this.plugin.http);
						const account = await api.getAccountInfo();
						if (account?.puid) {
							const who = [account.name, account.school].filter(Boolean).join(" ｜ ");
							new Notice(`登录有效：${who || `puid ${account.puid}`}`);
						} else {
							const courses = await api.getCourses();
							new Notice(`Cookie 有效，读到 ${courses.length} 门课程${courses[0] ? `，如《${courses[0].name}》` : ""}`);
						}
					} catch (error) {
						if (error instanceof ChaoxingAuthError) new Notice(error.message, 8000);
						else new Notice(`测试失败：${error instanceof Error ? error.message : String(error)}`, 8000);
					} finally {
						btn.setDisabled(false).setButtonText("测试");
					}
				}),
			);

		new Setting(containerEl)
			.setName("笔记目录")
			.setDesc("作业笔记的保存位置（相对 vault 根目录）")
			.addText((text) =>
				text
					.setPlaceholder("超星作业")
					.setValue(this.plugin.settings.noteFolder)
					.onChange(async (value) => {
						this.plugin.settings.noteFolder = value.trim() || "超星作业";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("每门课程一个子目录")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.folderPerCourse).onChange(async (value) => {
					this.plugin.settings.folderPerCourse = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("保存题目图片")
			.setDesc(
				"题干/选项里的图片（内嵌 base64 与远程图片）都下载到笔记目录的 attachments 下，用 ![[…]] 引用；关闭则保留原始链接。",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.saveImages).onChange(async (value) => {
					this.plugin.settings.saveImages = value;
					await this.plugin.saveSettings();
				}),
			);

		containerEl.createEl("h3", { text: "笔记样式" });
		containerEl.createEl("p", {
			text: "题目标题的格式是「## 1. 题型（分值） ^cx-题目ID」；^cx-… 是 Obsidian 原生块 ID，阅读模式下不可见，提交时靠它把作答对回题目，建议保留。",
			cls: "chaoxing-help",
		});

		new Setting(containerEl)
			.setName("作答小节标题")
			.setDesc("填空/简答/计算题的作答区标题（默认「作答」，例如可改成「我的解答」）")
			.addText((text) =>
				text
					.setPlaceholder("作答")
					.setValue(this.plugin.settings.answerHeading)
					.onChange(async (value) => {
						this.plugin.settings.answerHeading = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("标题显示分值")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showScoreInHeading).onChange(async (value) => {
					this.plugin.settings.showScoreInHeading = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("标题显示题型")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTypeInHeading).onChange(async (value) => {
					this.plugin.settings.showTypeInHeading = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("顶部信息栏")
			.setDesc("笔记开头的课程/状态/截止信息 callout。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showInfoCallout).onChange(async (value) => {
					this.plugin.settings.showInfoCallout = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("选择题用勾选框")
			.setDesc("开启：选项是任务列表，勾选即作答；关闭：普通列表，在作答区写字母（如 AC）。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.choiceAsTasks).onChange(async (value) => {
					this.plugin.settings.choiceAsTasks = value;
					await this.plugin.saveSettings();
				}),
			);

		containerEl.createEl("h3", { text: "使用说明" });
		containerEl.createEl("ol", {
			cls: "chaoxing-help",
		}, (list) => {
			list.createEl("li", { text: "填好 Cookie 后，运行命令「超星学习通: 拉取作业列表」。" });
			list.createEl("li", { text: "选择课程 → 选择作业，插件会把题目拉成一份 Markdown 笔记。" });
			list.createEl("li", { text: "在笔记里作答：选择题勾选复选框，填空/简答写在每道题的「作答」小节里。" });
			list.createEl("li", { text: "运行「超星学习通: 提交当前作业」，确认答案后交卷。" });
		});
		containerEl.createEl("p", {
			text: "提示：自动拉取/提交属于非官方接口调用，可能违反平台使用条款，请仅用于个人学习便利并自行评估风险。",
			cls: "chaoxing-help",
		});
	}
}
