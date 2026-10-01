# Outline Wiki for VS Code

工作区里**每个文件对应一篇 Wiki 文档**，文档用 **Outline 的编辑器组件**
（`rich-markdown-editor@11.21.3`）撰写；文档与索引进 git，静态资源放 `.metadata/static/`
由网盘同步。视频走 VS Code 原生 Range 播放，**不启动任何本地服务**。

## 快速开始

1. 打开工作区和源文件，点击右侧 **Outline Wiki** 图标（或 `⌥⌘W`），直接显示 Wiki 编辑器。
2. 切换源文件，侧栏自动显示对应 Wiki；没有 Wiki 时居中显示 **创建 Wiki**，点击才创建。
3. 在侧栏直接编辑，输入自动保存；也可按 `⌘S` / `Ctrl+S`。
4. 侧栏只显示 Wiki 正文，跟随源文件切换；直接打开 `.wiki.md` 文件仍可使用原有标签页编辑器。

Wiki 默认位于右侧辅助侧栏；点击图标打开。VS Code 会保留手动移动过的布局，
如果升级后仍在左侧，右键 Wiki 图标 →「移动到」→「辅助侧栏」，或执行「视图: 重置视图位置」。
不要把整个主侧栏移到右边，资源管理器可以继续留在左边。

侧栏与标签页共用 VS Code TextDocument、资源入库、外部改动同步和冲突提示；
侧栏切换前先同步最后一次输入，避免 debounce 尚未结束时丢字。侧栏自动保存，标签页保留手动保存行为。

## `.metadata/` 布局（按"进不进 git"切分）

```
.metadata/
├── index.json      ✅ 进 git   映射缓存：标题/时间戳/引用清单（可删可重建）
├── docs/           ✅ 进 git   每文件一篇 Wiki 文档（UTF-8 markdown）
├── docs/_pages/    ✅ 进 git   独立页面（不挂源文件）
└── static/         🚫 不进 git 全部二进制资源（走网盘同步）
    ├── .gitignore             自忽略文件（它本身进 git，clone 后目录即存在）
    └── upload/2026-10-01/9f2a1c3d-….png   入库文件：UUID 命名 + 日期目录
```

目录职责是**可测试的不变量**：二进制只能写进 `static/**`，文本只能写进 `docs/**` 或
`index.json`（唯一例外 `static/.gitignore`）。所以宿主仓库的 `.gitignore` 只需要处理 `static` 一件事——
推荐自忽略法（扩展首次入库时会自动写入）：

```gitignore
*
!.gitignore
```

运行 `Outline Wiki: 配置 Git 忽略规则` 可随时重建；也支持写进仓库根 `.gitignore`。

## 视频 / 资源

- **`/视频` 或 `/video`**：直接选择本机视频文件，复制到 `static/upload/<日期>/<uuid>.<扩展名>` 并插入播放器。
- **引用已存在的视频**：`Outline Wiki: 插入视频/音频` → 从 `static/` 里选（**零拷贝**），或从磁盘导入
  （复制进 `static/upload/<今天>/<uuid>.ext`）。
- **播放链接**：`Outline Wiki: 插入播放链接` → 填 `https://…/demo.mp4`。
- **`/embed` 或 `/网页`**：输入 http(s) 网页地址，在 iframe 中嵌入；禁止嵌入的网站可使用卡片上的「在浏览器打开」。
- 粘贴截图 / 拖入小图：经 `postMessage` 交给宿主直接落盘（上限 `outlineWiki.static.maxInlineUploadMB`，默认 16MB），
  成功后直接显示图片，不弹成功提示。超出时会提示"大文件请放进 `.metadata/static/` 再引用"。
- 名字**都是 UUID**（不做内容去重，同一张图贴两次就是两个文件）；原始文件名记在 `index.json` 里，
  图片的 alt 文本会保留原名。
- 本机 MP4/MOV/M4V 自动准备兼容播放缓存：保留压缩画面及时间戳，将 PCM 声音放到同一个 MOV。macOS 使用随包提供的 AVFoundation helper（无需另外安装工具），其他平台需要已有 ffmpeg。缓存位于 `static/video-cache/`，原视频与 Markdown 不变；首次准备可能占用较大磁盘空间，之后复用缓存。
- 只使用原生播放器的一套播放、音量、进度和倍速控件，无额外启用声音按钮或独立音轨同步。宿主不允许的全屏入口隐藏；屏幕全屏使用「外部播放」。
- 不支持的内置编码（AC3/DTS 音轨、VC-1/WMV 容器等）会在卡片上给出**用系统播放器打开 / 在访达中显示**。

## 支持格式（本机 VS Code 1.140 实测 `canPlayType`）

| 类型 | 结果 |
| --- | --- |
| MP4 / MOV / M4V（H.264+AAC、HEVC、AV1） | `probably` |
| WebM / MKV（VP9+Opus、H.264） | `probably` |
| MP3 / FLAC / Opus / WAV | `probably` / `maybe` |
| AC3/DTS 音轨、VC-1/WMV、RealVideo | 不支持 → 走系统播放器兜底 |

拖动进度条可用（`asWebviewUri` 端到端支持 HTTP Range，实测 seek 精确命中）。
HLS `.m3u8`、需要登录态的流、视频画面转码**不在范围内**。AAC 的 `canPlayType` 结果不能证明声音实际可播放，见兼容声音处理。

## 公式与图表

- **数学公式**：`$E=mc^2$`、`$$…$$`，markdown 原样保存（GitHub 也能渲染）；`$5 and $6` 这类货币默认不会被误判
  （`outlineWiki.math.rejectNumericOnly`）。点击公式可就地编辑（`⌘⏎` 完成 / `Esc` 取消）。
- **mermaid**：用 ```mermaid 围栏，图渲染在围栏下方（源码保持可见）。只加渲染，**存储格式不变**。

## 命令

`打开当前文件的 Wiki 侧边栏`、`打开对应源文件`、`新建独立 Wiki 页`、`插入视频/音频`、`插入播放链接`、
`重建索引`、`检查资源引用`（找缺失文件，对应网盘未同步）、`列出未被引用的资源`、`配置 Git 忽略规则`、
`用系统播放器打开`、`在访达中显示`。

## 已知限制

- 编辑器是 Outline **2021 年那代**组件：没有 mention、行内评论、toggle block、图片 `=WxH` 尺寸。
- 库要求链接文本等于链接目标才识别为 embed，所以给媒体加标题的写法会退化成普通链接。
- 文档内相对链接的 `..` 层数取决于文档自身深度；源文件跨层级移动时扩展会自动重算（终端 `git mv`
  会表现为 create+delete，此时文档变成"未关联文档"而不丢内容）。
- `static/` 不进 git ⇒ 别人 clone 后需要先同步网盘才能看到图/视频；`检查资源引用` 会明确列出缺失项。

许可证与第三方声明见随包提供的 THIRD-PARTY-NOTICES.md。

## 安装

当前通过 VSIX 安装，尚未发布到 Marketplace。开发者克隆仓库后构建：

```bash
git clone https://github.com/wegohub/vscode-outline-wiki.git
cd vscode-outline-wiki
pnpm install --frozen-lockfile
pnpm run package
code --install-extension outline-wiki-0.3.3.vsix
```

需要 Node.js 24 和 pnpm 11。macOS 构建原生声音组件需要 Xcode Command Line Tools（`xcode-select --install`）；最终安装包自带组件，使用者不需开发工具。非 macOS 的本机声音兼容处理需要已有 ffmpeg，尚未验证其他平台的播放效果。

## 参与开发与扩展命令

- [开发指南](docs/DEVELOPMENT.md)：构建、调试、验证、发布检查。
- [命令扩展指南](docs/EXTENDING.md)：新增 VS Code 命令、快捷键、视图按钮、`/` 菜单与双向消息。
- [当前交接](docs/HANDOVER.md)：架构、不变量与已知限制。
- [设计决策](docs/DECISIONS.md)与[媒体验证](docs/MEDIA-MATRIX.md)：历史证据与踩坑记录。
- AI 编码代理从 [AGENTS.md](AGENTS.md) 进入。

使用 MIT 许可证，见 [LICENSE](LICENSE)；第三方组件的版权和许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。本扩展与 Outline 官方产品无隶属关系。
