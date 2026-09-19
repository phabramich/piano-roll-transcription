import { AnalysisErrorCode, type AnalysisResult } from './analysis-types';
import { FastSpectrumAnalyzer } from './fast-spectrum-analysis';
import type { FastSpectrumOptions } from './fast-spectrum-analysis';
import {
  FastSpectrumWorkerMessageType,
  type FastSpectrumAnalyzeRequest,
  type FastSpectrumWorkerResponse,
} from './fast-spectrum';

function postMessageToClient(
  response: FastSpectrumWorkerResponse,
  transfer: Transferable[] = [],
): void {
  self.postMessage(response, transfer);
}

self.addEventListener('message', (event: MessageEvent<FastSpectrumAnalyzeRequest>) => {
  const request = event.data;
  if (request.type !== FastSpectrumWorkerMessageType.Analyze) {
    return;
  }

  try {
    const analyzer = new FastSpectrumAnalyzer(request.samples);
    // `options` is added to the request in parallel — read it defensively so
    // this compiles and runs whether or not the field is present yet.
    analyzer.configure((request as { options?: FastSpectrumOptions }).options ?? {});
    const previewFrameCount = analyzer.frameCountForSeconds(30);
    analyzer.analyzeFrames(0, previewFrameCount);
    postPreview(request.jobId, analyzer.toResult(previewFrameCount));
    analyzer.analyzeFrames(previewFrameCount, analyzer.frameCount);
    postResult(request.jobId, analyzer.toResult(analyzer.frameCount));
  } catch {
    postMessageToClient({
      type: FastSpectrumWorkerMessageType.Error,
      jobId: request.jobId,
      code: AnalysisErrorCode.AnalysisFailed,
    });
  }
});

function postResult(jobId: number, result: AnalysisResult): void {
  postMessageToClient(
    {
      type: FastSpectrumWorkerMessageType.Result,
      jobId,
      result,
    },
    [result.frameProbabilities.buffer, result.frameTimestamps.buffer],
  );
}

function postPreview(jobId: number, result: AnalysisResult): void {
  postMessageToClient(
    {
      type: FastSpectrumWorkerMessageType.Preview,
      jobId,
      result,
    },
    [result.frameProbabilities.buffer, result.frameTimestamps.buffer],
  );
}
