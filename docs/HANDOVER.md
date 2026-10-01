# 当前交接：vscode-outline-wiki v0.3.3

本文件描述当前实现；历史实验与已淘汰方案在 DECISIONS.md，不能把旧 WAV+独立 audio 同步方案重新当成约束。开发与命令扩展分别见 DEVELOPMENT.md、EXTENDING.md。

## 1. 产品行为

右侧辅助侧栏只有 Wiki 编辑器，点击 Outline Wiki 图标打开。切换源文件自动跟随，有对应 Wiki 时加载，没有时居中显示“创建 Wiki”。切换前 flush 旧会话，防止最后一次输入丢失；sessionId 隔离重载前后的消息。侧栏自动保存，直接打开 wiki.md 的 CustomTextEditor 保留手动保存。

粘贴/拖入图片写到 static/upload/<日期>/<UUID>，成功后直接显示；`/视频` 选择本机文件并导入，`/embed` 输入 HTTP(S) 网页地址。公式和 Mermaid 保留原始 Markdown，旧自动源文件回链按精确模板移除，用户正文手写链接保留。

## 2. 代码地图

| 位置 | 职责 |
| --- | --- |
| src/core | 可单测的路径、命名、索引、引用算法；禁止依赖 vscode |
| src/shared/protocol.ts | 宿主与 webview 消息类型唯一真源 |
| src/extension/extension.ts | activate、命令、入库、迁移、开发自动探针 |
| wikiSidebarProvider.ts | 当前源文件跟随、空态、会话切换 |
| docEditorProvider.ts | DocSession、消息、同步/冲突/保存、旧标签页编辑器 |
| workspaceModel.ts / migrate.ts | 工作区、索引、监听、源文件改名迁移 |
| webviewHtml.ts | CSP、base URL、资源权限、会话标记 |
| videoCompat.ts / src/native/video-compat.swift | 单文件兼容音轨缓存 |
| src/webview/main.tsx / Editor.tsx | UI 消息、粘贴拖放、编辑器与 flush |
| extensions/slash-menu.ts / math.tsx / mermaid.ts | 菜单、数学、图表 |
| embeds/media.tsx / videoPlayer.tsx | 媒体、网页嵌入与原生视频 |

## 3. 数据契约与硬约束

.metadata/docs/<镜像源路径>.wiki.md 保存正文，docs/_pages 是独立页；index.json 是可重建映射缓存。正文和索引进 Git；static 资源由用户另行同步，不进 Git。入库一律 UUID，原始文件名记录在索引。二进制只写 static，文本只写 docs 或 index.json，static/.gitignore 是唯一特殊文本。所有运行时写入要通过 assertWriteAllowed。

源文件改名通过 onDidRenameFiles 后置事件迁移 Wiki 并重算相对链接。workspace.fs.rename 不触发该事件，WorkspaceEdit.renameFile 才触发；终端 git mv 表现为 create/delete，此时不自动迁移、不删正文。

nodeView/embed 回调禁止 React hooks，库将回调当普通函数调用；可返回 React class 元素。扩展必须有 bindEditor。围栏解析为 code_block，语言在 attrs.language。全图只允许一份 ProseMirror。保持 React17 与 ReactDOM.render，仅外部改动传 value，普通输入不能重置光标。

媒体通过 asWebviewUri 和 base URL 解析磁盘相对链接，不启动本地服务；父页面 connect-src none。网页 iframe 有 sandbox，拒绝嵌入的网站不能绕过其策略。所有双向消息匹配随机 sessionId，防止子网页伪造宿主消息。

## 4. 当前视频实现

只有一个原生 video，声音和画面在同一 MOV 中，由原生解复用与时钟管理播放、seek、音量和倍速。macOS AVFoundation helper 直通压缩视频样本并保留时间戳，将音频解码为 PCM，生成 static/video-cache 缓存；其他平台使用已安装的 ffmpeg，尚未真机验证。任务串行、同源复用、临时文件原子重命名、失败清理，不阻塞正文保存。原视频和 Markdown 不改写。

PCM 占更多磁盘空间，首次需要等待准备，之后复用。不要恢复隐藏 audio、MediaSync 或额外顶部声音控件。当前 VS Code 宿主 fullscreenEnabled=false，隐藏无效全屏控件，保留外部播放；不能承诺绕过宿主权限或任何高负载/损坏文件下绝无同步异常。

## 5. 验证通道与证据

运行 `pnpm run check-types && pnpm test && pnpm run build && node scripts/check-single-prosemirror.mjs`。真机自动探针通过夹具根的 __autoprobe__.json 启动，完整操作见 DEVELOPMENT.md。官方 test:integration 当前不能作为绿灯。

v0.3.3：80 单测、类型/构建/单一 ProseMirror/VSIX 安装通过；VS Code 1.140.0 macOS arm64 真机 20 项探针及改名三断言通过，脱敏报告见 probe-report-latest.json。实际 AAC 视频的单个 video 音频解码字节为 1413120，seek 到120s误差0s，暂停稳定、音量0.25、倍速1.5通过。正常安装后的真实点击播放到0:55，CPU短时抽样2.5%；未录制扬声器，不等于主观音质验证或长期CPU平均。

## 6. 已知限制与后续工作

- normalizeLinks 没有实现，已移除无效贡献；toggleMetadataVisibility 已贡献并注册。
- hideMetadataFolder、static.dedupeByContent 仍是未接线设置，不要声称生效。
- 大文件 webview 入库仍使用 base64，虽然二进制 postMessage 探针可用；上限16MB，建议大资源直接放 static 后引用。
- Outline 2021 年编辑器不含现役产品的所有能力，媒体链接文本必须匹配目标才被识别为 embed。
- 继续验证系统文件选择器、拖放、声音主观质量、Intel Mac/其他操作系统；能力探针不等于全部 UX。
- Markdown 正文/索引也可能有用户私人数据，上传公开仓库时必须审核；不得提交原始报告、本机路径或用户媒体。

## 7. 发布

prepublish 只能构建，不能调用 vsce package。改依赖必须重跑单一 ProseMirror。公开仓库的 main 从脱敏当前快照开始，旧本机交接提交不推送。源码推送不等于 Marketplace 发布，发布流程见 DEVELOPMENT.md。
