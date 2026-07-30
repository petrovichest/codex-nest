import type {
  TranscriptionConfigResponse,
  TranscriptionProvider,
  TranscriptionTimingEstimate,
} from "@codexnest/protocol";

import type { Translate } from "../i18n";

const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export type TextSelection = {
  start: number;
  end: number;
};

export function microphoneUnavailableReason(
  config: TranscriptionConfigResponse | null,
  provider: TranscriptionProvider | null,
  canTranscribe: boolean,
  t: Translate,
): string | null {
  if (!config || !provider || !config.providers.includes(provider) || !canTranscribe) {
    return t("Распознавание речи не настроено");
  }
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    return typeof window !== "undefined" && window.isSecureContext === false
      ? t("Для доступа к микрофону откройте CodexNest по HTTPS")
      : t("Запись с микрофона не поддерживается на этом устройстве");
  }
  return recordingMimeType() ? null : t("Этот браузер не поддерживает запись WebM или MP4");
}

export function recordingMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    RECORDING_MIME_TYPES.find(
      (type) => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type),
    ) ?? null
  );
}

export function recordingErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return t("Нет доступа к микрофону. Разрешите его в настройках приложения или браузера");
    }
    if (error.name === "NotFoundError") return t("Микрофон не найден");
    if (error.name === "NotReadableError") return t("Микрофон занят другим приложением");
  }
  return t("Не удалось начать запись с микрофона");
}

export function formatRecordingTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function estimatedTranscriptionSeconds(
  estimate: TranscriptionTimingEstimate | null,
  audioDurationMs: number,
): number | null {
  const fixed = estimate?.estimatedFixedProcessingMs;
  const perSecond = estimate?.estimatedProcessingMsPerAudioSecond;
  if (fixed === null || fixed === undefined || perSecond === null || perSecond === undefined) {
    return null;
  }
  return Math.max(1, Math.ceil((fixed + (audioDurationMs / 1_000) * perSecond) / 1_000));
}

export function formatEstimatedTranscriptionTime(
  elapsedSeconds: number,
  estimatedTotalSeconds: number | null,
): string {
  if (estimatedTotalSeconds === null) return formatRecordingTime(elapsedSeconds);
  if (elapsedSeconds <= estimatedTotalSeconds) {
    return `≈${formatRecordingTime(Math.max(0, estimatedTotalSeconds - elapsedSeconds))}`;
  }
  return `+${formatRecordingTime(elapsedSeconds - estimatedTotalSeconds)}`;
}

export function insertTranscriptAtSelection(
  input: string,
  transcript: string,
  selection: TextSelection,
  maxLength = Number.POSITIVE_INFINITY,
): { value: string; caret: number } | null {
  const clean = transcript.trim();
  if (!clean) return null;
  const start = Math.min(selection.start, input.length);
  const end = Math.max(start, Math.min(selection.end, input.length));
  const before = input.slice(0, start);
  const after = input.slice(end);
  const leading = before && !/\s$/.test(before) ? " " : "";
  const trailing = after && !/^\s/.test(after) ? " " : "";
  const completeInsertion = `${leading}${clean}${trailing}`;
  const available = Math.max(0, maxLength - before.length - after.length);
  const inserted = completeInsertion.slice(0, available);
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length - (inserted === completeInsertion ? trailing.length : 0),
  };
}
