import Foundation
import Vision
import AppKit

let directory = CommandLine.arguments[1]
let output = CommandLine.arguments[2]
let fps = Double(CommandLine.arguments[3])!
let paths = try FileManager.default.contentsOfDirectory(atPath: directory).filter { $0.hasSuffix(".jpg") }.sorted()
var frames: [[String: Any]] = []
for (index, name) in paths.enumerated() {
    try autoreleasepool {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(url: URL(fileURLWithPath: directory).appendingPathComponent(name)).perform([request])
        let results = (request.results ?? []).compactMap { observation -> [String: Any]? in
            guard let text = observation.topCandidates(1).first else { return nil }
            return ["text": text.string, "confidence": text.confidence, "x": observation.boundingBox.minX, "y": observation.boundingBox.minY]
        }
        frames.append(["frameNumber": index + 1, "t": Double(index) / fps, "results": results])
    }
}
try JSONSerialization.data(withJSONObject: frames, options: [.sortedKeys]).write(to: URL(fileURLWithPath: output))
