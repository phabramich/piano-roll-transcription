import { AnalysisErrorCode, type AnalysisResult } from './analysis-types';
import { analyzeFastSpectrum } from './fast-spectrum-analysis';
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
    const result = analyzeFastSpectrum(request.samples);
    postResult(request.jobId, result);
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
