> **v0.3.1 更正**：下表只代表 canPlayType 声明能力，不证明真实解码。用户的实际 MP4 检查为 AAC 立体声 44.1kHz，旧版无声音。即使 libffmpeg 包含 AAC 符号，VS Code 实际构建也可能禁用 AAC；官方文档明确记录此限制。
> 现用系统 afconvert（macOS）/已安装 ffmpeg（其他平台）生成 WAV 缓存，并与视频同步，原文件不变。用户文件实测转换为约 300s 双声道 WAV，PCM 非零；自动无手势播放受 Chromium 策略限制，需点击启用声音。

# 媒体格式矩阵（本机 VS Code 1.140.0 / Chromium 150 实测）

`canPlayType` 输出（探针 `codecSupport`，报告见 `docs/probe-report-latest.json`）：

| 探针类型 | 结果 |
| --- | --- |
| `video/mp4; codecs="avc1.42E01E, mp4a.40.2"` | `probably` |
| `video/mp4; codecs="hvc1.1.6.L93.B0"`（HEVC） | `probably` |
| `video/webm; codecs="vp9, opus"` | `probably` |
| `video/webm; codecs="av01.0.05M.08"`（AV1） | `probably` |
| `video/x-matroska; codecs="avc1.42E01E"`（MKV） | `probably` |
| `audio/mpeg` / `audio/flac` / `audio/ogg; codecs="opus"` | `probably` |
| `audio/wav` | `maybe` |

`<audio>` 实测：2.00s WAV，`currentTime` seek 到 1.20s 精确命中，buffered 1 段 —— 即
`asWebviewUri` 端到端支持 HTTP Range（拖动可用）。

与 libffmpeg 符号证据一致：`libffmpeg.dylib` 内含 H264 / HEVC / AV1 / VP8 / VP9 / AAC / FLAC / Opus /
Vorbis / E-AC3 / MP3 / MPEG-2 / WMV3 / MJPEG / ProRes 解码器 + VideoToolbox，解复用器覆盖
`mov,mp4,m4a,3gp`、`Matroska/WebM`、`Ogg`、`MPEG-TS`、`FLV`、`AVI`、`WAV`、`AAC`、`FLAC`、`MP3`。

**已知不支持**：AC3/DTS 音轨、VC-1、ASF/WMV 容器、RealVideo、HLS、需登录态的流。
