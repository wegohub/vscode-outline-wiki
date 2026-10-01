# 开发、验证与发布

## 环境与构建

使用 Node.js 24、pnpm 11。若通过 nvm 安装，请在 shell 中启用对应 Node 版本。macOS 需要 Xcode Command Line Tools 编译 AVFoundation helper。`media/bin/video-compat-darwin` 是由仓库 Swift 源码构建的 universal arm64/x86_64 产物；源码变更时构建脚本会自动重新生成。跨平台打包需要保留或先在 macOS 重建此组件，非 macOS 本机音轨处理使用已有 ffmpeg。

```bash
pnpm install --frozen-lockfile
pnpm run check-types
pnpm test
pnpm run build
node scripts/check-single-prosemirror.mjs
pnpm run package
```

prepublish 只能构建，不可调用 vsce package（会无限递归）。VSIX 不提交 Git；`.vscodeignore` 控制安装包内容，`.gitignore` 控制仓库内容，两者用途不同。

## 调试

VS Code 打开项目按 F5；launch 配置以 `test/fixtures/workspace` 作为隔离工作区，preLaunchTask 自动启动 watch。宿主日志看输出面板的 Outline Wiki，webview 日志看开发者工具。避免用真实业务工作区运行破坏夹具的探针。

## 真机自动探针

官方 `pnpm run test:integration` 当前存在宿主启动问题，不能当作已通过。已验证通道是开发模式自动探针：

在夹具根创建 `__autoprobe__.json`：

```json
{ "out": "__probe-report.json", "source": "src/hello.go" }
```

macOS 启动独立开发宿主：

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir=/tmp/vscode-dev-outline-wiki/user \
  --extensions-dir=/tmp/vscode-dev-outline-wiki/ext \
  --extensionDevelopmentPath="$PWD" \
  "$PWD/test/fixtures/workspace"
```

开发模式识别标记，自动建文档、渲染公式/图表、插入媒体、检查侧栏切换与改名迁移，报告写到指定 out。若夹具没有受信任，先在隔离开发窗口确认信任。标记可选 `video` 本机路径测试实际音频解码；这个私有标记和用户媒体禁止提交。

检查每项 results/sidebarResults 的 ok，以及 phase2 的 docMoved/oldGone/linkRewritten。报告可能含本机路径、DOM 文本或媒体引用；发布前脱敏，只保留必要证据。仓库中的脱敏历史报告不等于每个系统都测试过。

## 公开提交

- `git status --short` 和 `git diff --cached` 检查实际提交内容；忽略规则不会移除已跟踪或历史中的敏感数据。
- 不提交 `.env`、凭据配置、私钥、访问令牌、个人邮箱、真实业务素材、截图和原始探针输出。
- 用户 Wiki static 资源/播放缓存不进 Git；docs 与 index 可进 Git，但正文和索引也可能含私人信息，仍需审核。
- 已提交的凭据需要先撤销/轮换，再清理历史，不能只靠删除文件。
- 安装包和构建产物保存在本机，不随源代码首次推送；原生 helper 是可复现的项目组件，源码一并提交。

## 发布检查

类型、单测、build、单一 ProseMirror 必须通过；需要宿主行为的变更跑真机探针并手工走查。核对 package version、CHANGELOG、README、第三方许可和安装包内容。更新 README 的版本号安装示例。发布 Marketplace 或 GitHub Release 是独立发布动作；git push 只上传源码，不自动发布插件。
