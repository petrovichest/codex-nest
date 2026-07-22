#!/usr/bin/env python3
"""Expose an installed faster-whisper model through CodexNest's local STT API."""

from __future__ import annotations

import argparse
import json
import logging
import os
import tempfile
import threading
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MAX_AUDIO_BYTES = 24 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024
LOG = logging.getLogger("codexnest-stt")


class TranscriptionServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], model: Any):
        super().__init__(address, TranscriptionHandler)
        self.model = model
        self.transcription_lock = threading.Lock()


class TranscriptionHandler(BaseHTTPRequestHandler):
    server: TranscriptionServer

    def do_GET(self) -> None:
        if self.path not in ("/", "/health"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_json(HTTPStatus.OK, {"status": "ok"})

    def do_POST(self) -> None:
        if self.path != "/inference":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            audio, suffix, language = self.read_transcription_request()
        except RequestError as error:
            self.send_json(error.status, {"error": error.message})
            return

        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
                temporary.write(audio)
                temporary_path = temporary.name
            with self.server.transcription_lock:
                segments, _info = self.server.model.transcribe(
                    temporary_path,
                    language=None if language == "auto" else language,
                    task="transcribe",
                    beam_size=5,
                    vad_filter=True,
                    condition_on_previous_text=True,
                )
                text = "".join(segment.text for segment in segments).strip()
            if not text:
                self.send_json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": "No speech detected"})
                return
            self.send_json(HTTPStatus.OK, {"text": text})
        except Exception:
            LOG.exception("Transcription failed")
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Transcription failed"})
        finally:
            if temporary_path:
                Path(temporary_path).unlink(missing_ok=True)

    def read_transcription_request(self) -> tuple[bytes, str, str]:
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data;"):
            raise RequestError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Expected multipart form data")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError as error:
            raise RequestError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required") from error
        if length < 1 or length > MAX_REQUEST_BYTES:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Audio recording is too large")

        body = self.rfile.read(length)
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
        )
        if not message.is_multipart():
            raise RequestError(HTTPStatus.BAD_REQUEST, "Invalid multipart body")

        audio: bytes | None = None
        suffix = ".webm"
        language = "auto"
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            payload = part.get_payload(decode=True)
            if name == "file" and isinstance(payload, bytes):
                audio = payload
                suffix = safe_suffix(part.get_filename())
            elif name == "language" and isinstance(payload, bytes):
                language = payload.decode("utf-8", errors="replace").strip().lower()

        if not audio:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Audio file is required")
        if len(audio) > MAX_AUDIO_BYTES:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Audio recording is too large")
        if language not in ("auto", "ru", "en"):
            raise RequestError(HTTPStatus.BAD_REQUEST, "language must be auto, ru, or en")
        return audio, suffix, language

    def send_json(self, status: HTTPStatus, payload: dict[str, str]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        LOG.info("%s - %s", self.client_address[0], format % args)


class RequestError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def safe_suffix(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    return suffix if suffix in (".webm", ".mp4", ".wav", ".m4a") else ".audio"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8178)
    parser.add_argument("--threads", type=int, default=max(1, os.cpu_count() or 1))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    from faster_whisper import WhisperModel

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    LOG.info("Loading faster-whisper model from %s", args.model)
    model = WhisperModel(
        str(args.model),
        device="cpu",
        compute_type="int8",
        cpu_threads=args.threads,
    )
    server = TranscriptionServer((args.host, args.port), model)
    LOG.info("Local STT listening at http://%s:%d", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
