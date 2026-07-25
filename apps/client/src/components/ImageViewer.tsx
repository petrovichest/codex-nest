import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../i18n";
import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "./Icons";

export type ViewerImage = {
  src: string;
  alt: string;
};

export function ImageViewer({
  images,
  index,
  opener,
  onIndexChange,
  onClose,
}: {
  images: ViewerImage[];
  index: number;
  opener: HTMLButtonElement | null;
  onIndexChange(index: number): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const image = images[index];

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
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [images.length, index, onClose, onIndexChange]);

  if (!image) return null;

  return createPortal(
    <div
      className="image-viewer-backdrop"
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
        <img className="image-viewer-image" src={image.src} alt={image.alt} />
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
