# Phase 0 探针结论（在真机 VS Code 1.140.0 上实测）

运行方式（无需人工点击）：开发模式下，工作区根存在 `__autoprobe__.json`（内容
`{ "out": "__probe-report.json", "source": "src/hello.go" }`），扩展激活后自动
建文档 → 打开自定义编辑器 → 跑探针 → 把 JSON 写到指定文件。

启动命令（macOS，用 `bin/code` CLI shim + 独立 user-data-dir，避免被单实例锁吞掉参数）：

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir=/tmp/vscode-dev-outline-wiki/user \
  --extensions-dir=/tmp/vscode-dev-outline-wiki/ext \
  --extensionDevelopmentPath="$PWD" --disable-workspace-trust \
  "$PWD/test/fixtures/workspace"
```

原始报告留档：`docs/probe-report-2026-10-01.json`。

## 结论（全部 5/5 通过）

| 探针 | 结论 | 对设计的影响 |
| --- | --- | --- |
| `editorMounted` | ✅ `rich-markdown-editor@11.21.3` + React 17 在 VS Code webview 里**真的渲染出 ProseMirror**（"文本长度 25"） | 最大的技术风险退场；Phase 1 的编辑器选型成立 |
| `baseResolution` | ✅ `<base href="${asWebviewUri(文档)}">` 生效：`../../static/__probe__/probe.png` 原样解析为 `https://file+.vscode-resource.vscode-cdn.net/<工作区路径>/...` 并成功加载 1×1 PNG | **方案 A 成立 → 加载/保存都不需要改写链接**，磁盘上的相对 markdown 就是唯一真源（方案 B 双向改写只作为备选记录） |
| `mediaRangeSeek` | ✅ 2.00s WAV，`currentTime` seek 到 1.20s 精确命中，buffered 1 段 | **Range / 拖动端到端可用，确认不需要任何本地 HTTP 服务**（用户最关心的 JCEF 痛点在此彻底解决） |
| `codecSupport` | ✅ `canPlayType` 实测：`avc1.42E01E+mp4a.40.2`→probably、`hvc1`(HEVC)→probably、`vp9+opus`→probably、`av01`→probably、`audio/mpeg`→probably、`audio/flac`→probably、`opus`→probably、`video/x-matroska; avc1`→probably、`audio/wav`→maybe | 与 libffmpeg 符号证据一致；`docs/MEDIA-MATRIX.md` 的"预期"列可按此定稿为"本机实测" |
| `binaryPostMessage` | ✅ **两个方向都能直传 `Uint8Array`**（宿主日志：`webview→host 二进制 postMessage: Uint8Array(3)`；探针：host→webview 成功） | 入库通道可以用二进制，省掉 base64 的 33% 膨胀；base64 退化为回退路径 |

## 过程中发现并修掉的两个问题（供后续复用）

1. **`open -n -a "Visual Studio Code" --args ...` 起不了开发宿主**：会被 VS Code 的单实例锁转发给正在运行的实例，`--extensionDevelopmentPath` 被静默忽略（扩展宿主日志里完全没有它）。必须用 `Resources/app/bin/code` 这个 CLI shim，并配独立 `--user-data-dir` / `--extensions-dir`。
2. **探针时序**：第一版在"webview 刚收到 `init`、编辑器还没挂载"的窗口里就跑探针，得出 `editorMounted: false` 与 `binaryPostMessage: false` 两个**假阴性**。现在先 `waitForReady` + 等 3s，再先发二进制、后发 `runProbe`。凡是"宿主主动测量 webview 状态"的探针都要遵守这个时序。

## Phase 2 结论（同样在真机 1.140.0 上自动跑出来）

场景：源文件 `src/__rename_probe__.go` 跨层级改名到 `deep/nested/__rename_probe__.go`，
文档里带一条指向 `static/` 的相对链接（深度从 2 层变 4 层，`..` 数量必须从 2 变 3）。

| 观察点 | 结论 |
| --- | --- |
| `workspace.fs.rename` 是否触发 `onDidRenameFiles` | ❌ **不触发**（扩展自己调 fs 改名不走事件） |
| `WorkspaceEdit.renameFile` 是否触发 | ✅ **触发**（这正是用户在资源管理器里改名、以及其它扩展改名的标准路径） |
| 文档是否随迁 | ✅ `.metadata/docs/src/...` → `.metadata/docs/deep/nested/...`，旧文件已消失 |
| static 链接层数是否重算 | ✅ `../../static/...` → `../../../static/...` |
| `_` 转义 | ✅ `src/__rename_probe__.go` → `src/___rename_probe__.go.wiki.md`（镜像时补一个 `_`） |

因此实现选择是：**只监听后置的 `onDidRenameFiles`**，完全不用未文档化的
`onWillRenameFiles + waitUntil(WorkspaceEdit.renameFile)`。终端 `git mv` 表现为
create+delete：那种情况下文档原地变成"未关联文档"（不删不改），新建文件若推导出已有文档则
自动重关联——都不丢内容。

**踩坑记录**：断言链接是否被重算时不能用 `includes('../../static/...')` —— 它是
`../../../static/...` 的子串，会误报"未重算"。要精确取出链接目标再比较。

## Git 卫生结论（用真 git 验证）

`.metadata/static/.gitignore` 内容为 `*` + `!.gitignore` 时：

```
$ git check-ignore -v .metadata/static/upload/2026-10-01/abc.png
.metadata/static/.gitignore:1:*	.metadata/static/upload/2026-10-01/abc.png
$ git check-ignore -q .metadata/index.json   # 非零退出 = 未被忽略 ✓
$ git check-ignore -q .metadata/docs/a.wiki.md  # 未忽略 ✓

$ git add -A . && git ls-files
.gitignore
.metadata/docs/a.wiki.md
.metadata/index.json
.metadata/static/.gitignore
```

即：**只有静态资源被挡在 git 外**，`docs/`、`index.json` 与 `static/.gitignore` 本身正常入库，
clone 后 `static/` 目录也会存在（因为里面有一个被跟踪的文件）——完全符合"方便做 .gitignore"的诉求。

## 打包（已产出可安装产物）

```bash
pnpm run package   # = npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

产物 `outline-wiki-0.1.0.vsix`：**74 个文件 / 1.35 MB**（加 `.vscodeignore` 前是 126 个文件 / 2.68 MB）。
已真装验证：

```bash
code --extensions-dir=/tmp/... --user-data-dir=/tmp/... --install-extension outline-wiki-0.1.0.vsix
→ Extension 'outline-wiki-0.1.0.vsix' was successfully installed.
code --list-extensions → wegohub.outline-wiki
```

**踩坑（严重）**：`vsce package` 会先执行 `vscode:prepublish`。我一开始把它写成 `pnpm run package`，
而 `package` 里又调用 `vsce package` → **无限递归**，几分钟内堆出上千个 node 进程。
正确写法是让 `vscode:prepublish` **只做构建**：

```jsonc
"vscode:prepublish": "node esbuild.mjs --production && node scripts/check-single-prosemirror.mjs",
"package": "npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository"
```

## 剩余工作（下一轮起点）

Phase 3（媒体与静态资源）：
- 入库链路自动化验证：在自动探针里加 `ingestBytes` 场景，断言"UUID 命名 + 落在 `static/upload/<date>/` + 索引记录 + 违反目录不变量会抛错"。
- 媒体 Picker 的端到端 UX（QuickPick 引用 `static/`、从磁盘导入、播放链接输入框、超上限给指引）。
- `enableFindWidget` 是否在自定义编辑器里生效（唯一还没探的 Phase 0 项）。

Phase 4（mermaid + 公式，必做）：
- `src/webview/extensions/mermaid.ts`：ProseMirror 插件 + `Decoration.widget`，围栏仍是普通 ` ```mermaid ` 代码块；懒加载 chunk 用 `<script src=asWebviewUri(...)>` 注入；LRU 缓存 + IntersectionObserver + `securityLevel: 'strict'` + 错误态。
- `src/webview/extensions/math.ts`：`math_inline`/`math_block` 两个 duck-typed 节点 + `rulePlugins` 注入 markdown-it 规则 + KaTeX nodeView；`$…$`/`$$…$$` 形态对齐 Outline；`rejectNumericOnly` 防货币误判。
- 往返测试（jsdom 挂载真实编辑器 + 取 `editor.value()`）覆盖 math/mermaid/货币/转义/坏 mermaid。

其它：
- 官方 `@vscode/test-cli` 跑法在本机卡住（宿主能起来但 15 分钟无输出），已改用"开发宿主 + `__autoprobe__.json`"这条自动化通道；正式发布前把 `workspaceContains:__autoprobe__.json` 这条 activation event 摘掉。
- 发布前补 README、CHANGELOG、THIRD-PARTY-NOTICES（BSD-3 声明 + 不得用 Outline 名称背书）。


## 已清理

- 6 条 `Accessing a window scoped configuration for a resource is not expected` 警告：已给 13 个设置项补 `"scope": "resource"`。


## Phase 4 进展（真机 1.140.0）

**数学公式：✅ 通过**。自动探针在真机上报 `KaTeX 节点 2（期望 2，精确相等）`，即
`$E=mc^2$`（行内）与 `$$…$$`（块级）都渲染成了 KaTeX，且文档里的 `$5 and $6` **没有**被
误判成公式（数量精确相等才成立，多一个就说明货币被吞了）。实现要点：两个 duck-typed 节点
（`math_inline`/`math_block`）+ `rulePlugins` 注入 markdown-it 规则 + `toMarkdown` 原样写回，
磁盘上仍是 `$…$`/`$$…$$`，GitHub 也能渲染。

**mermaid：✅ 已通过**（真机报 `mermaid 容器 1、SVG 1（期望 1）`）。

根因（靠"在插件 state.init 里把 `doc.descendants` 的节点名+attrs 打到宿主日志"一招定位）：
**这个库把 ``` 围栏解析成 `code_block`，不是 `code_fence`**（语言仍挂在 `attrs.language`）。
打点输出：`heading, text, paragraph, text, paragraph, text, math_inline, text, math_block, code_block:mermaid, text`。
只匹配 `code_fence` 的话装饰器永远插不上。修复：两种节点名都认。

留下的可观测性：一个 mermaid 围栏都没找到、但文档里确实有代码围栏时，会往宿主日志打一条
`[mermaid] 文档里有代码围栏但语言不是 mermaid：<节点序列>`，下次这类问题一眼可查。

## ⚠️ 真机踩到的大坑：nodeView / embed 组件里不能用 React hooks

现象：加上数学扩展后编辑器整块不渲染（`.ProseMirror` 不存在），webview 日志里是
`Invalid hook call. Hooks can only be called inside of the body of a function component`，
栈顶指向 `RichMarkdownEditor`。

根因：库的 `ComponentView` 把 `component`（nodeView 组件、embed 组件）当**普通函数**调用，
不是在 React 渲染树里调用，所以组件内任何 `useState/useMemo/useEffect` 都会抛错，
而且是在 `init()` 里同步抛，直接把编辑器搞挂。

结论（以后写这个库的任何扩展都要守）：
- nodeView / embed 的 `component` 必须是**无 hook 的纯函数组件**；
- 需要状态时用命令式 DOM：公式的编辑态是"点击后在 host 里换入 textarea、提交时 dispatch 事务"，
  媒体卡片的"不支持该编码"兜底是 `media.closest('.ow-media').replaceWith(buildFallback(...))`。

另外两条同样重要的经验：
- 每个 duck-typed 扩展**必须提供 `bindEditor()`**：`ExtensionManager` 构造时对每个扩展无条件调用它，
  缺了就抛 TypeError（这次也踩了）。
- `prosemirror-view@1.18.1` 不带类型声明，而 `@types/prosemirror-view` 的依赖链会和 1.25 的
  prosemirror-model 类型打架 → 在 `src/webview/types/prosemirror-view.d.ts` 里做了
  `Decoration`/`DecorationSet` 的最小本地声明。


## 2026-10-01 接管：侧栏与编辑同步（v0.2.0–v0.3.0）

- 原有主逻辑保留，新增 `WikiSidebarProvider` 复用 `DocSession`。活动源文件变化刷新侧栏；缺少 Wiki 时只显示居中创建按钮，点击后才生成文档。
- 切换前通过 requestFlush → flush → flushed 等待旧文档保存，消息串行处理；随机 sessionId 隔离旧实例消息。快速切换、隐藏恢复、外部修改同步均有真机探针。
- 默认贡献位置使用 `viewsContainers.secondarySidebar`（本机 VS Code 1.140.0 支持）。已记住的布局仍由 VS Code 决定，可手动移动视图。v0.3.0 删除第二个树视图及源文件按钮，侧栏只展示 Wiki。
- 旧模板自动回链只在第一标题后且源路径、相对链接精确匹配时移除；正文手写链接保留。新模板不再添加回链。
- 数学 token.content 必须进入 schema 的 source 属性；否则渲染存在但序列化丢公式。新增 markdownRoundTrip 验证公式、货币、Mermaid 保留。

## 媒体与网页插入（v0.3.0）

- 剪贴板图片仍保存到 `.metadata/static/upload/<日期>/<UUID>.png`，取消成功弹窗。真实 paste 事件探针发现文件入库但节点丢失：`Slice.maxOpen` 会打开非叶 image/embed 节点，插入后丢媒体。改为只打开外层 paragraph，保持媒体节点闭合。
- `/视频` 使用 `requestLocalVideo` 宿主消息打开系统文件选择器，导入现有 upload 路径后走 insertMarkdown。归档库没有 slash 扩展接口，因此只扩展 BlockMenu.items getter，并注册带 bindEditor 的命令扩展。
- `/embed` 提供网页嵌入菜单，HTTP(S) 页面渲染为 sandbox iframe；媒体/附件地址不被网页匹配器覆盖。库要求 embeds 有 icon 才显示菜单，中文 pasteLinkWithTitle 必须是函数才能输入地址。
- 父 webview 保持 connect-src none，CSP 新增 frame-src http: https:；iframe 禁止父页面导航，保留外部浏览器入口。目标站点的 frame-ancestors / X-Frame-Options 可能禁止嵌入，这不是扩展能绕过的限制。
- 不可用 `event.source === window.parent` 过滤 VS Code 宿主消息：acquireVsCodeApi 包装会覆盖 window.parent，导致真实宿主消息被丢弃。改用 bootstrap 随机 sessionId 验证双向消息，探针验证无 token 的 iframe 伪造消息不能修改编辑器。
- 本机视频入库探针使用直接传入 URI 替代系统选文件步骤，只验证日期 UUID 路径与字节一致，不能当作系统对话框交互或真实视频解码的手工验证。

- 媒体插入探针最初使用 `__probe__` 路径，库把链接文字中的双下划线解析成 underline，无法匹配简单链接。夹具改用 `probe-media`；实际导入的日期/UUID 路径不会含该标记。手写带双下划线的媒体链接仍属于归档库的已知解析限制。

最终验证（2026-10-01T02:30:40.787Z）：VS Code 1.140.0 生产构建真机 19/19 项通过，另有改名迁移三项断言通过。类型检查、80 个单测、单一 ProseMirror 检查及 v0.3.0 VSIX 独立配置安装通过。报告见 `docs/probe-report-latest.json`。系统文件选择对话框和任意真实视频仍未作手工 UX 走查。


## v0.3.1：实际 AAC 无声与全屏权限（2026-10-01）

- 用户提供的 MP4 经 afinfo 确认为 44.1kHz 双声道 AAC，300.003991 秒。官方 webview 文档明确说明 AAC 可能无声；历史 canPlayType/动态库符号不等于实际播放证据。
- macOS afconvert 将该视频音轨解码为 LEI16 WAV：300.003991 秒，前 15s PCM RMS 约 207.5（非静音）。audioCompat.ts 将其保存到 static/audio-cache，源文件和 Wiki Markdown 不改写；并发复用任务、临时输出在失败时删除，保存队列不等待转换。
- 用隐藏 audio 播放 WAV，与原 video 同步 play/pause/seek/rate/volume；两个元素分别解码。VideoPlayer 用 class，无 hooks。
- 自动探针没有可信用户手势，audio.play 会拒绝；传 Electron autoplay-policy 标志也未解除该限制。探针明确验证 WAV 解码/seek 和拒绝后提示用户点击，不把无手势音轨播放失败写成播放成功。
- 已在用户正常 VS Code 安装修复包，重新加载后打开已有 bitmap_test.go Wiki，通过真实「启用声音」点击启动播放；界面从暂停推进到 3:14，未出现音轨加载错误或自动播放拒绝提示。放大按钮显示「退出放大」，退出恢复正常布局。这是交互与解码证据，不声称工具录到了扬声器声音。
- 实测 document.fullscreenEnabled=false：宿主 iframe 不允许扩展原生全屏，扩展无法自行修改外层权限。自定义按钮优先尝试 Fullscreen API，受限则固定覆盖整个 webview；屏幕级全屏仍需系统播放器。不要承诺视图区放大等于屏幕全屏。
- 非 macOS 使用已安装的 ffmpeg，当前机器没有 ffmpeg，未做其他平台转换验证；不自动安装程序或更改宿主安全策略。

最终生产构建验证：2026-10-01T02:50:08.817Z，VS Code 1.140.0，20/20 自动检查及改名三项断言通过。AAC 检查包含实际 WAV 解码、seek 同步、自动播放拒绝提示与视图区放大；它不等于无手势有声播放或原生屏幕全屏。类型检查、80 单测、单一 ProseMirror 与 VSIX 安装通过。


## v0.3.2：音轨卡顿与高 CPU

- v0.3.1 的 onCanPlay 调用 sync(true)，无条件写 currentTime。音轨跳转又产生 canplay，可形成反馈循环；用户报告声音卡顿，正常 Code renderer（59739）top 抽样为 100.5% CPU。先前的静态解码/单次 seek 检查不足以验证持续播放，这是上版实现缺陷。
- 抽取纯 MediaSync：ready 只在首次对齐；seeked 才强制对齐；canplay/playing 只恢复播放，正常 tick 每秒最多一次、小漂移调整速率而不 seek；大漂移跳转至少间隔 5 秒。
- 播放请求使用 single-flight，NotAllowed 等拒绝后停止自动重试，用户点击才解锁；AbortError 不误判为权限拒绝。音轨 preload=metadata，窗口隐藏暂停。
- 回归覆盖 100 次 canplay 不新增 seek、不重复 play、低频速率纠偏、显式 seek、自动播放拒绝、AbortError、销毁暂停。实际视频探针统计 100 次 canplay 导致的额外跳转次数，避免把“加载成功”当成“持续播放不卡”。

最终验证：2026-10-01T02:59:40.791Z，生产构建 20/20 真机检查通过，100 次 canplay 额外 seek=0，显式拖动误差=0s；改名三断言通过。86 单测、类型检查、单一 ProseMirror 与 VSIX 构建通过。用户正常 Code 同一 renderer 59739：修复前 top 抽样 100.5%，重启扩展后空闲 0.0%，真实点击播放时抽样 3.2%；播放进度连续推进到 1:15，然后主动暂停并恢复正常布局。CPU 是短时抽样，不代表所有媒体或长时间平均；尚无扬声器录音证据。


## v0.3.3：单个原生 video 与统一音画时间线

- 用户选择原生播放器，移除顶部放大/启用声音/音量整排控件，以及隐藏 audio、MediaSync 和对应旧测试。视频和声音现在在同一个 MOV 内，由同一个 video 解码；不再用 JavaScript 反复追赶两个元素的进度。
- macOS AVFoundation helper 直通压缩视频样本，将音频解码为 16-bit PCM，保留原始样本时间戳及视频 transform。helper 随 VSIX 提供 macOS13+ universal arm64/x86_64；使用者无需安装 Swift/ffmpeg。其他平台已有 ffmpeg 为回退，尚未在其他系统验证。
- 缓存在 static/video-cache，根据源文件 URI/大小/修改时间复用；任务串行、并发同文件复用、原子重命名、失败清理临时文件。原视频和 Markdown 不改写。PCM 比压缩音轨更占磁盘空间；首次需等待准备。
- 实际 AAC 视频的真机探针检查单个 video、实际音频解码字节计数，不再用 canplay/canPlayType 代替有声解码证据。原生 seek 到 120s 误差 0s，音量 0.25、倍速 1.5、暂停稳定通过。
- 正常 Code 安装并重启扩展后，缓存准备提示消失，原生静音和音量控件可用，真实点击播放持续推进；没有独立音轨或额外控件。持续播放到 0:55 后暂停；渲染进程 64820 短时 CPU 抽样为 2.5%（不代表长期平均）。未录制扬声器，不能把解码证据写成主观音质验证。
- 当前 VS Code 宿主 fullscreenEnabled=false，保留外部播放入口；控件设置 nofullscreen，并用 Chromium 控件伪元素隐藏其仍显示的无效全屏按钮。不能保证任意损坏媒体或系统高负载下绝无音画异常。

最终验证：2026-10-01T03:21:54.326Z，VS Code 1.140.0 生产构建 20/20 真机检查及改名三项断言通过；实际音频解码字节 1413120。80 单测、类型检查、单一 ProseMirror、v0.3.3 VSIX 打包安装通过。
