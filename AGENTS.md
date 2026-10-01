# AGENTS.md

给接手本项目的 AI 编码代理：**先读 [docs/HANDOVER.md](docs/HANDOVER.md)**（完整交接文档：
架构、真机证据、已知问题、硬约束、发布 checklist），再读 [docs/DECISIONS.md](docs/DECISIONS.md)
（每条结论的证据与踩坑记录）。本文件只放"不读就会犯错"的部分。

## 环境

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"   # 非登录 shell 没有 node/pnpm
pnpm run check-types && pnpm test && pnpm run build && node scripts/check-single-prosemirror.mjs
```

改完后要真机验证 → 见 HANDOVER §5 的**自动探针通道**（`__autoprobe__.json`，无人值守）；
官方 `@vscode/test-cli` / `test:integration` 目前是坏的，别当它是绿的。

## 硬约束（违反必然出问题）

1. nodeView / embed 组件里**禁止 React hooks**（库把它们当普通函数调用 → `Invalid hook call` 白屏）。
2. duck-typed 扩展**必须**有 `bindEditor()`（空实现也算）。
3. 库把 ``` 围栏解析成 **`code_block`**（不是 `code_fence`），语言在 `attrs.language`。
4. 全图只能有**一份** prosemirror；改了依赖就重跑 `scripts/check-single-prosemirror.mjs`。
5. `vscode:prepublish` **只能**做构建（调用 `vsce package` 会无限递归）。
6. React 17 + `ReactDOM.render`；只有外部改动才给编辑器传 `value`。
7. 走 `asWebviewUri()` 的 HTTP 端点播视频（**不要**引入本地服务）；CSP `connect-src 'none'`。
8. 二进制只写 `static/**`，文本只写 `docs/**` 或 `index.json`（`assertWriteAllowed` 强制，有单测）。
9. `src/core/**` 不许 import `vscode`——它是可单测的纯逻辑层。

## 当前状态

v0.3.3 使用单个原生 video 和 PCM MOV 缓存；不要恢复旧独立音轨同步方案。
命令扩展看 docs/EXTENDING.md。normalizeLinks 尚未实现，已移除无效贡献；
hideMetadataFolder 尚未读取，使用已贡献的 toggleMetadataVisibility 命令。
继续补充拖放、选文件和媒体主观音质的手工 UX 验证，不能把能力探针当作全部 UX 验证。

公开提交前检查文件与历史，不提交凭据、个人绝对路径、用户媒体或运行时探针产物。
