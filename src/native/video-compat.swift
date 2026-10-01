import Foundation
import AVFoundation

// 保留压缩画面及原始时间戳，仅将音轨解码为 PCM，写入同一个 MOV。
let args = CommandLine.arguments
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
if args.count != 3 { fail("usage: video-compat input output.mov") }
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
do {
    let reader = try AVAssetReader(asset: asset)
    let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: args[2]), fileType: .mov)
    writer.shouldOptimizeForNetworkUse = true
    let group = DispatchGroup()
    var pairs: [(AVAssetReaderTrackOutput, AVAssetWriterInput)] = []
    guard let video = asset.tracks(withMediaType: .video).first else { fail("No video track") }
    let videoOutput = AVAssetReaderTrackOutput(track: video, outputSettings: nil)
    videoOutput.alwaysCopiesSampleData = false
    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: nil,
        sourceFormatHint: video.formatDescriptions.first.map { $0 as! CMFormatDescription })
    videoInput.transform = video.preferredTransform
    reader.add(videoOutput); writer.add(videoInput); pairs.append((videoOutput, videoInput))
    if let audio = asset.tracks(withMediaType: .audio).first {
        let audioOutput = AVAssetReaderTrackOutput(track: audio, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ])
        audioOutput.alwaysCopiesSampleData = false
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: nil)
        reader.add(audioOutput); writer.add(audioInput); pairs.append((audioOutput, audioInput))
    }
    guard writer.startWriting(), reader.startReading() else { fail("Cannot start: \(writer.error?.localizedDescription ?? reader.error?.localizedDescription ?? "unknown")") }
    writer.startSession(atSourceTime: .zero)
    for (index, pair) in pairs.enumerated() {
        let (output, input) = pair
        group.enter()
        var finished = false
        input.requestMediaDataWhenReady(on: DispatchQueue(label: "wiki.media.\(index)")) {
            if finished { return }
            while input.isReadyForMoreMediaData {
                guard let sample = output.copyNextSampleBuffer() else {
                    finished = true; input.markAsFinished(); group.leave(); return
                }
                if !input.append(sample) {
                    finished = true; input.markAsFinished(); group.leave(); return
                }
            }
        }
    }
    group.wait()
    if reader.status == .failed { writer.cancelWriting(); fail(reader.error?.localizedDescription ?? "Read failed") }
    if writer.status == .failed { fail(writer.error?.localizedDescription ?? "Write failed") }
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }; done.wait()
    guard writer.status == .completed else { fail(writer.error?.localizedDescription ?? "Write failed") }
} catch { fail(error.localizedDescription) }
