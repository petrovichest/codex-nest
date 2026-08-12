import {
  sha256,
  type CompletedNetworkCapture,
  type DroppedNetworkCapture,
} from "./network-capture";
import { NETWORK_CAPTURE_CHUNK_BYTES, type NetworkCaptureFrame } from "./protocol";

const CAPTURE_CHUNK_RAW_BYTES = (NETWORK_CAPTURE_CHUNK_BYTES / 4) * 3;

type SendCaptureFrame = (frame: NetworkCaptureFrame) => void;

export async function streamNetworkCapture(
  capture: CompletedNetworkCapture,
  send: SendCaptureFrame,
): Promise<void> {
  const captureId = crypto.randomUUID();
  const values = [
    ["metadata", capture.metadata] as const,
    ...(capture.requestBody ? ([["requestBody", capture.requestBody] as const] as const) : []),
    ...(capture.responseBody ? ([["responseBody", capture.responseBody] as const] as const) : []),
  ];
  const parts = {
    metadata: await descriptor(capture.metadata),
    ...(capture.requestBody
      ? {
          requestBody: {
            byteLength: capture.requestBody.byteLength,
            sha256: capture.requestBodySha256!,
          },
        }
      : {}),
    ...(capture.responseBody
      ? {
          responseBody: {
            byteLength: capture.responseBody.byteLength,
            sha256: capture.responseBodySha256!,
          },
        }
      : {}),
  };
  let started = false;
  try {
    send({
      type: "network.capture.start",
      captureId,
      threadId: capture.threadId,
      tabId: capture.tabId,
      exchangeId: capture.exchangeId,
      provider: "chrome",
      parts,
    });
    started = true;
    for (const [part, bytes] of values) {
      for (let offset = 0; offset < bytes.byteLength; offset += CAPTURE_CHUNK_RAW_BYTES) {
        send({
          type: "network.capture.chunk",
          captureId,
          part,
          offset,
          data: encodeBase64(bytes.subarray(offset, offset + CAPTURE_CHUNK_RAW_BYTES)),
        });
      }
    }
    send({ type: "network.capture.commit", captureId });
  } catch (error) {
    if (started) {
      try {
        send({
          type: "network.capture.abort",
          captureId,
          reason: errorMessage(error).slice(0, 1_024),
        });
      } catch {
        // The socket itself may be the reason the capture could not finish.
      }
    }
  }
}

export async function streamNetworkCaptureDrop(
  capture: DroppedNetworkCapture,
  send: SendCaptureFrame,
): Promise<void> {
  const captureId = crypto.randomUUID();
  const empty = new Uint8Array();
  let started = false;
  try {
    send({
      type: "network.capture.start",
      captureId,
      threadId: capture.threadId,
      tabId: capture.tabId,
      exchangeId: capture.exchangeId,
      provider: "chrome",
      parts: { metadata: await descriptor(empty) },
    });
    started = true;
    send({
      type: "network.capture.abort",
      captureId,
      reason: capture.reason,
    });
  } catch {
    if (!started) return;
    try {
      send({
        type: "network.capture.abort",
        captureId,
        reason: capture.reason,
      });
    } catch {
      // The connection may have closed between the failed body read and this notification.
    }
  }
}

async function descriptor(bytes: Uint8Array): Promise<{ byteLength: number; sha256: string }> {
  return { byteLength: bytes.byteLength, sha256: await sha256(bytes) };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
