import {
  AnalysisErrorCode,
  type AnalysisResult,
  type AnalysisWorkerRequest,
  type AnalysisWorkerResponse,
  WorkerMessageType,
} from './analysis-types';
import { FastSpectrumAnalyzer } from './fast-spectrum-analysis';

function postMessageToClient(
  response: AnalysisWorkerResponse,
  transfer: Transferable[] = [],
): void {
  self.postMessage(response, transfer);
}

function transferOf(result: AnalysisResult): Transferable[] {
  return [result.frameProbabilities.buffer, result.frameTimestamps.buffer];
}

self.addEventListener('message', (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data;
  if (request.type !== WorkerMessageType.Analyze) {
    return;
  }

  try {
    const analyzer = new FastSpectrumAnalyzer(request.samples);
    analyzer.configure(request.options ?? {});
    const previewFrameCount = analyzer.frameCountForSeconds(30);
    analyzer.analyzeFrames(0, previewFrameCount);
    const preview = analyzer.toResult(previewFrameCount);
    postMessageToClient(
      {
        type: WorkerMessageType.Progress,
        jobId: request.jobId,
        progress: 0,
        preview,
      },
      transferOf(preview),
    );
    analyzer.analyzeFrames(previewFrameCount, analyzer.frameCount);
    const result = analyzer.toResult(analyzer.frameCount);
    postMessageToClient(
      {
        type: WorkerMessageType.Result,
        jobId: request.jobId,
        result,
      },
      transferOf(result),
    );
  } catch {
    postMessageToClient({
      type: WorkerMessageType.Error,
      jobId: request.jobId,
      code: AnalysisErrorCode.AnalysisFailed,
    });
  }
});
