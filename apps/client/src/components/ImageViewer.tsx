import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../i18n";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, XIcon } from "./Icons";

export type ViewerImage = {
  src: string;
  alt: string;
  status?: "loading" | "ready" | "failed";
};

export function ImageViewer({
  images,
  index,
  opener,
  onIndexChange,
  onClose,
  onRetry,
  onDownload,
}: {
  images: ViewerImage[];
  index: number;
  opener: HTMLElement | null;
  onIndexChange(index: number): void;
  onClose(): void;
  onRetry?(): void;
  onDownload?(): Promise<void>;
}) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const downloadBusyRef = useRef(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const image = images[index];
  useEffect(() => setDownloadFailed(false), [index]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        onIndexChange(index - 1);
      } else if (event.key === "ArrowRight" && index < images.length - 1) {
        event.preventDefault();
        onIndexChange(index + 1);
      } else if (event.key === "Tab") {
        const buttons = [
          ...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
            []),
        ];
        const first = buttons[0],
          last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [images.length, index, onClose, onIndexChange]);

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let disposed = false;
    let remove: (() => Promise<void>) | undefined;
    void CapacitorApp.addListener("backButton", onClose).then((handle) => {
      if (disposed) void handle.remove();
      else remove = () => handle.remove();
    });
    return () => {
      disposed = true;
      void remove?.();
    };
  }, [onClose]);

  async function download() {
    if (!onDownload || downloadBusyRef.current) return;
    downloadBusyRef.current = true;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      await onDownload();
    } catch {
      setDownloadFailed(true);
    } finally {
      downloadBusyRef.current = false;
      setDownloading(false);
    }
  }

  if (!image) return null;

  return createPortal(
    <div
      ref={dialogRef}
      className="image-viewer-backdrop chat-image-viewer"
      data-android-back-layer
      role="dialog"
      aria-modal="true"
      aria-label={t("Просмотр изображений")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="image-viewer-control image-viewer-close"
        aria-label={t("Закрыть")}
        onClick={onClose}
      >
        <XIcon />
      </button>
      {onDownload && (
        <button
          type="button"
          className="image-viewer-control image-viewer-download"
          aria-label={t("Скачать {{name}}", { name: image.alt })}
          title={t("Скачать")}
          disabled={downloading || (image.status !== undefined && image.status !== "ready")}
          onClick={() => void download()}
        >
          {downloading ? <span className="spinner small" /> : <ArrowDownIcon />}
        </button>
      )}
      {downloadFailed && (
        <div className="image-viewer-error" role="alert">
          {t("Не удалось скачать файл. Нажмите ещё раз.")}
        </div>
      )}
      <div
        className="image-viewer-stage"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {images.length > 1 && (
          <button
            type="button"
            className="image-viewer-control image-viewer-nav image-viewer-previous"
            aria-label={t("Предыдущее изображение")}
            disabled={index === 0}
            onClick={() => onIndexChange(index - 1)}
          >
            <ArrowLeftIcon />
          </button>
        )}
        {image.status === "loading" ? (
          <div className="image-viewer-status" role="status">
            <span className="spinner small" />
            {t("Загружаем изображение…")}
          </div>
        ) : image.status === "failed" ? (
          <button type="button" className="image-viewer-retry" onClick={onRetry}>
            {t("Не удалось загрузить изображение. Повторить")}
          </button>
        ) : (
          <img className="image-viewer-image" src={image.src} alt={image.alt} />
        )}
        {images.length > 1 && (
          <button
            type="button"
            className="image-viewer-control image-viewer-nav image-viewer-next"
            aria-label={t("Следующее изображение")}
            disabled={index === images.length - 1}
            onClick={() => onIndexChange(index + 1)}
          >
            <ArrowRightIcon />
          </button>
        )}
      </div>
      {images.length > 1 && (
        <div className="image-viewer-counter" aria-live="polite">
          {t("Изображение {{current}} из {{total}}", {
            current: index + 1,
            total: images.length,
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
