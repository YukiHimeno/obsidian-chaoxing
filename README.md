# 超星学习通作业（Obsidian 插件）

> 非官方客户端，使用超星的学生端接口。请仅用于个人学习便利，自行评估账号与使用条款风险。

## 功能

- 拉取课程 → 作业列表（含「未提交 / 待批阅 / 已完成 / 已截止」状态与剩余时间）
- 把一份作业的题目（题干、选项、图片、题型、空数）渲染成一份 Markdown 笔记
- 在笔记内作答：选择题勾选复选框；填空题逐行对应每一空；简答/论述自由书写
- 提交前确认弹窗：逐题列出你填的答案，标红未作答的题，并给出格式提醒
- 「仅保存不提交」（暂存）与「刷新题目（保留已填答案）」
- 学习通的**字体加密**（`cxSecretStyle`）已内置解码：题干不会变成乱码
- 题目里的内嵌图片自动落盘为附件，用 `![[...]]` 引用
- 桌面端与移动端 Obsidian 均可用（请求走 Obsidian 的 `requestUrl`）

## 安装

1. 从 [Releases] 或本仓库下载 `manifest.json`、`main.js`、`styles.css`、`assets/font_map.txt`；
2. 在你的 vault 里新建目录 `<vault>/.obsidian/plugins/chaoxing-homework/`；
3. 把上面的文件按原目录结构放进去（`assets/` 要一起放，否则字体加密页面无法解码）；
4. 在 Obsidian 的「设置 → 第三方插件」中启用「超星学习通作业」。

从源码构建：

```bash
npm install
npm run build      # 产出 main.js
```

## 使用

| 命令 | 作用 |
| --- | --- |
| `超星学习通: 拉取作业列表` | 选课程 → 选作业 → 生成/更新笔记（侧边栏书本图标同效） |
| `超星学习通: 刷新当前作业` | 重新拉题目，**保留**已填答案（老师改了题、或笔记被误删内容时用） |
| `超星学习通: 提交当前作业` | 弹出确认框 → 交卷，成功后写回状态 |
| `超星学习通: 保存当前作业` | 暂存到服务器但不交卷 |



## 开发

```bash
npm run dev        # 监听构建（把整个目录软链到 vault 的 plugins 下即可热更新）
npm test           # 单测：MD5、字体解密（fontTools 交叉校验）、真实页面解析、笔记往返、提交表单
node tools/smoke.mjs   # 集成冒烟：打桩 obsidian 模块，跑通 拉取→作答→提交 全流程
npm run font-map   # 重新生成 assets/font_map.txt
```

目录：`src/api`（HTTP 与超星接口）、`src/model`（类型、页面解析、Markdown、字体解密、提交表单）、
`src/sync`（笔记格式与工作流）、`src/ui`（选择与确认弹窗）。

## 致谢

接口格式与页面结构参考了这些开源项目的逆向成果：
[yatori-go-core](https://github.com/yatori-dev/yatori-go-core)（手机端链路与页面样本）、
[Samueli924/chaoxing](https://github.com/Samueli924/chaoxing)（网页端提交表单）、
[xygodcyx/chaoxing](https://github.com/xygodcyx/chaoxing)（字体解密与字形哈希表）、
[ocsjs](https://github.com/ocsjs/ocsjs)。
