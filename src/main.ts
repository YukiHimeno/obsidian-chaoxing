import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { ChaoxingApi } from "./api/chaoxing";
import { ChaoxingHttp } from "./api/http";
import { FontHashTable, parseFontMap } from "./model/font";
import { ChaoxingSettings, ChaoxingSettingTab, DEFAULT_SETTINGS, noteStyleOf } from "./settings";
import { countAnswered } from "./sync/note";
import { Session } from "./sync/session";

export default class ChaoxingPlugin extends Plugin {
	settings: ChaoxingSettings = DEFAULT_SETTINGS;
	http!: ChaoxingHttp;
	api!: ChaoxingApi;
	session!: Session;
	private fontTable?: FontHashTable | null;
	private statusBarEl: HTMLElement | null = null;
	private statusTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.http = new ChaoxingHttp(
			() => this.settings.cookie,
			async (cookie) => {
				this.settings.cookie = cookie;
				await this.saveSettings();
			},
		);
		this.api = new ChaoxingApi(this.http);
		this.session = new Session({
			app: this.app,
			settings: this.settings,
			api: this.api,
			loadFontTable: () => this.loadFontTable(),
			onChanged: () => this.updateStatusBar(),
		});

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("chaoxing-statusbar");
		this.statusBarEl.onClickEvent(() => void this.session.pullWorksFlow());
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateStatusBar()));
		this.registerEvent(this.app.workspace.on("editor-change", () => this.scheduleStatusUpdate()));
		this.updateStatusBar();

		this.addSettingTab(new ChaoxingSettingTab(this.app, this));

		this.addRibbonIcon("book-open", "超星学习通：拉取作业列表", () => {
			void this.session.pullWorksFlow();
		});

		this.addCommand({
			id: "pull-works",
			name: "拉取作业列表",
			callback: () => void this.session.pullWorksFlow(),
		});
		this.addCommand({
			id: "refresh-work",
			name: "刷新当前作业（重新拉取题目，保留已填答案）",
			callback: () => void this.session.refreshActiveNote(),
		});
		this.addCommand({
			id: "submit-work",
			name: "提交当前作业",
			callback: () => void this.session.submitActiveNote(false),
		});
		this.addCommand({
			id: "save-draft",
			name: "保存当前作业（暂存，不交卷）",
			callback: () => void this.session.submitActiveNote(true),
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 状态栏：显示当前作业笔记的作答进度（点一下 = 拉取作业列表） */
	updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		const file = this.app.workspace.getActiveFile();
		const frontmatter = file
			? (this.app.metadataCache.getFileCache(file)?.frontmatter?.chaoxing as Record<string, unknown> | undefined)
			: undefined;
		if (!(file instanceof TFile) || !frontmatter?.workId) {
			el.setText("超星：未打开作业笔记");
			el.setAttribute("aria-label", "超星学习通：点此拉取作业列表");
			return;
		}
		const style = noteStyleOf(this.settings);
		void this.app.vault
			.cachedRead(file)
			.then((content) => {
				if (this.app.workspace.getActiveFile()?.path !== file.path) return;
				const { answered, total } = countAnswered(content, style);
				const name = String(frontmatter.workName ?? file.basename);
				el.setText(`超星 ｜ ${name} ｜ 已答 ${answered}/${total}`);
				const remain = typeof frontmatter.remain === "string" ? ` ｜ ${frontmatter.remain}` : "";
				el.setAttribute("aria-label", `${name} ｜ 状态：${String(frontmatter.status ?? "")}${remain}`);
			})
			.catch(() => el.setText("超星：未打开作业笔记"));
	}

	private scheduleStatusUpdate(): void {
		if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
		this.statusTimer = window.setTimeout(() => {
			this.statusTimer = null;
			this.updateStatusBar();
		}, 400);
	}

	/** 字体哈希表（1MB 左右）只在遇到加密页面时读一次 */
	async loadFontTable(): Promise<FontHashTable | null> {
		if (this.fontTable !== undefined) return this.fontTable;
		try {
			const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
			const path = normalizePath(`${dir}/assets/font_map.txt`);
			const text = await this.app.vault.adapter.read(path);
			this.fontTable = parseFontMap(text);
			if (this.fontTable.size === 0) {
				new Notice("字体哈希表为空，加密页面将无法解码");
				this.fontTable = null;
			}
		} catch (error) {
			console.warn("[chaoxing] 读取字体哈希表失败", error);
			new Notice("读取 assets/font_map.txt 失败，遇到字体加密页面时题干会乱码");
			this.fontTable = null;
		}
		return this.fontTable;
	}
}
