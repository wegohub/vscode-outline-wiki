# 扩展插件命令

本项目有两类入口：VS Code 命令面板/快捷键/工具栏，由扩展宿主执行；Wiki 编辑器的 `/` 菜单，由 webview 发消息给宿主。新增功能先选择入口，再确定是否需要读写工作区。

## 1. 新增 VS Code 命令

在 `package.json` 的 `contributes.commands` 贡献稳定的命令 ID：

```json
{
  "command": "outlineWiki.insertNote",
  "title": "插入说明模板",
  "category": "Outline Wiki",
  "icon": "$(note)"
}
```

在 `src/extension/extension.ts` 的 `activate()` 内、已有 `context.subscriptions.push(...)` 注册列表中加入处理器。这里已有 `activeSession()`，会优先选择可见侧栏，否则选择标签页会话：

```ts
vscode.commands.registerCommand('outlineWiki.insertNote', async () => {
  const session = activeSession();
  if (!session) {
    void vscode.window.showWarningMessage('请先打开一个 Wiki 文档。');
    return;
  }
  session.post({ type: 'insertMarkdown', markdown: '\n> 说明：请填写内容\n' });
}),
```

不要只贡献不注册，也不要只注册不贡献。注册返回值加入 subscriptions，扩展停用时才能销毁。插入正文优先使用现有 `insertMarkdown`，由编辑器在当前选区执行事务并走统一保存流程；不要直接覆盖磁盘正文。

可选地在 `contributes.keybindings` 加快捷键，在 `contributes.menus['view/title']` 加侧栏按钮：

```json
{
  "command": "outlineWiki.insertNote",
  "when": "view == outlineWiki.currentFile",
  "group": "navigation@3"
}
```

按入口指定合理的 `when` 条件。快捷键的 `key` 使用各平台通用组合，macOS 覆盖写在 `mac` 字段；避免覆盖常见编辑快捷键。较新 VS Code 会根据 commands 自动激活扩展，无需为每个命令重复增加 activationEvents。

## 2. 新增 `/` 菜单命令

当前库没有公开 BlockMenu 扩展接口，`src/webview/extensions/slash-menu.ts` 只扩展原有 `items` getter。保留原菜单，在返回数组后追加项：

```ts
{ name: 'ow_note', title: '说明', keywords: '说明 note', icon: AttachmentIcon }
```

菜单 `name` 必须与命令扩展的 `name` 一致。参照 `localVideoExtension()` 写扩展工厂：

```ts
export function noteExtension(): unknown {
  return {
    type: 'extension', name: 'ow_note', bindEditor() {},
    commands: () => () => () => {
      post({ type: 'requestInsertNote' });
      return true;
    }
  };
}
```

这段示例需要先按下一节加入 `requestInsertNote` 协议。然后在 `src/webview/Editor.tsx` 引入工厂，加入现有 extensions 数组。库会无条件调用 `bindEditor()`，不能省略；菜单必须有 icon。不要再次修改原型 getter，否则模块重复初始化可能叠加菜单项。

已有入口可作为完整参考：`/视频` → `requestLocalVideo` → MediaHooks.pickLocalVideo → insertMarkdown。`/embed` 属于 embeds 菜单，通过 `src/webview/embeds/media.tsx` 注册匹配器、icon、component，中文提示在 `dictionary.zh.ts`；不要给视频链接误套网页 iframe。

## 3. 新增双向消息

唯一协议定义在 `src/shared/protocol.ts`。需要文件选择器、本机资源或 VS Code API 的功能必须交给宿主：

1. `WebviewToHost` 增加 `{ type: 'requestInsertNote' }`。
2. webview 用 `src/webview/api.ts` 的 `post()` 发消息，保留现有 sessionId 封装。
3. `DocSession` 在 `src/extension/docEditorProvider.ts` 的消息 switch 中处理请求。若需要 activate 内的能力，在 MediaHooks 添加接口并在 `extension.ts` 实现。
4. 使用现有 `insertMarkdown` 响应即可；需要返回数据时，增加对应 `HostToWebview` 类型，在 `main.tsx` 分发。异步请求带唯一 id，处理成功、错误、超时与会话销毁。

不能直接调用 `webview.postMessage` 绕过 DocSession，也不能接受嵌入 iframe 发来的无会话标记消息。慢速媒体转换不要阻塞保存队列，参照 requestCompatibleVideo 的异步返回方式。

## 4. 新增编辑节点或媒体类型

- 纯算法放 `src/core/`，禁止 import vscode；媒体类型尽量扩展共用的 `media-type.ts`。
- schema、parseMarkdown、toMarkdown 一起实现，验证 Markdown 保存后再次加载仍保留原内容。
- nodeView/embed 的库回调禁止 React hooks；需要状态时返回 React class 元素，参照 VideoPlayer。
- 围栏节点名是 `code_block`，语言在 `attrs.language`。
- 保持 React 17、ReactDOM.render 和唯一 ProseMirror 实例。只在外部更新时给编辑器 value，普通输入不能重置状态。
- 二进制只能进入 static；正文只能进入 docs，索引只能写 index.json。使用 assertWriteAllowed、UUID 命名、工作区边界和体积限制，避免原始文件名变成写盘路径。
- 保持媒体 asWebviewUri 和父页面 connect-src none，不启动本地服务。网页嵌入保持 sandbox，目标站点可能拒绝 iframe。

## 5. 验证新增功能

运行开发指南的类型、单测、构建与 ProseMirror 检查；新增涉及纯逻辑的不变量要补单测。F5 或自动探针验证实际宿主行为，检查菜单可见、点击有结果、取消不改正文、切换文件不串会话、Markdown 往返不丢内容。涉及文件选择器/声音主观质量的 UX 仍需手工验证。

## 当前命令清单

| ID（均以 outlineWiki. 开头） | 行为 |
| --- | --- |
| openDoc | 打开当前源文件的 Wiki 侧栏 |
| openSource | 打开对应源文件 |
| newPage | 创建独立 Wiki 页 |
| insertMedia / insertMediaUrl | 引用或导入资源 / 插入播放链接 |
| rebuildIndex | 扫描文档并重建索引 |
| verifyRefs | 报告缺失的资源引用 |
| gcAssets | 只报告未引用资源，不删除 |
| configGitIgnore | 配置 static 的 Git 忽略规则 |
| toggleMetadataVisibility | 在工作区 files.exclude 中切换元数据目录可见性 |
| refresh | 刷新侧栏 |
| revealDoc / openInSystemPlayer | 显示文件 / 用系统程序打开；后者需要文件参数 |
| openDocFromTree | 保留的内部入口，命令面板隐藏 |
| runProbe | 开发诊断探针，会生成测试夹具与报告 |

normalizeLinks 尚未实现，已移除无效命令入口。hideMetadataFolder 目前是未接线的配置项，使用 toggleMetadataVisibility 命令；static.dedupeByContent 也尚未实现。不要在文档或 UI 中承诺这些设置生效。
