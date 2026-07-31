import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";

const MOBILE_DRAWER_QUERY = "(max-width: 820px)";
const DIRECTION_LOCK_DISTANCE = 10;
const OPEN_PROGRESS = 0.3;

type Gesture = {
  startX: number;
  startY: number;
  drawerWidth: number;
  distance: number;
  active: boolean;
  startedOpen: boolean;
};

export function useDrawerNavigation({
  open,
  routeKey,
  threadActive,
  side,
  setOpen,
}: {
  open: boolean;
  routeKey: string;
  threadActive: boolean;
  side: "left" | "right";
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const openRef = useRef(open);
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_DRAWER_QUERY).matches);
  const [dragging, setDragging] = useState(false);

  openRef.current = open;

  useEffect(() => {
    const query = window.matchMedia(MOBILE_DRAWER_QUERY);
    const update = (event: MediaQueryListEvent) => setMobile(event.matches);
    setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    function clearDragStyles() {
      frame!.style.removeProperty("--drawer-drag-translate");
      frame!.style.removeProperty("--drawer-drag-progress");
    }

    function clearGesture() {
      gestureRef.current = null;
      setDragging(false);
    }

    function touchStart(event: TouchEvent) {
      if (!mobile) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-project-drag-handle], .markdown-table-scroll")
      ) {
        clearGesture();
        return;
      }
      if (event.touches.length !== 1) {
        clearGesture();
        return;
      }

      clearDragStyles();
      const touch = event.touches[0];
      const measuredWidth = sidebarRef.current?.getBoundingClientRect().width ?? 0;
      const drawerWidth = measuredWidth || Math.min(310, window.innerWidth * 0.88);
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        drawerWidth,
        distance: 0,
        active: false,
        startedOpen: openRef.current,
      };
    }

    function touchMove(event: TouchEvent) {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (event.touches.length !== 1) {
        clearGesture();
        return;
      }

      const touch = event.touches[0];
      const deltaX = touch.clientX - gesture.startX;
      const deltaY = touch.clientY - gesture.startY;
      const sideDirection = side === "left" ? 1 : -1;
      const directionalDistance = (gesture.startedOpen ? -1 : 1) * deltaX * sideDirection;

      if (!gesture.active) {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < DIRECTION_LOCK_DISTANCE) return;
        if (directionalDistance <= 0 || Math.abs(deltaX) <= Math.abs(deltaY)) {
          clearGesture();
          return;
        }
        gesture.active = true;
        setDragging(true);
      }

      event.preventDefault();
      gesture.distance = Math.min(gesture.drawerWidth, Math.max(0, directionalDistance));
      const distanceProgress = gesture.distance / gesture.drawerWidth;
      const visibleProgress = gesture.startedOpen ? 1 - distanceProgress : distanceProgress;
      const hiddenDirection = side === "left" ? -1 : 1;
      const translate = hiddenDirection * gesture.drawerWidth * 1.04 * (1 - visibleProgress);
      frame!.style.setProperty("--drawer-drag-translate", `${translate}px`);
      frame!.style.setProperty("--drawer-drag-progress", String(visibleProgress));
    }

    function touchEnd() {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const crossedThreshold =
        gesture.active && gesture.distance >= gesture.drawerWidth * OPEN_PROGRESS;
      const shouldOpen = gesture.startedOpen ? !crossedThreshold : crossedThreshold;
      gestureRef.current = null;
      setDragging(false);
      setOpen(shouldOpen);
    }

    function touchCancel() {
      clearGesture();
    }

    frame.addEventListener("touchstart", touchStart, { passive: true });
    frame.addEventListener("touchmove", touchMove, { passive: false });
    frame.addEventListener("touchend", touchEnd);
    frame.addEventListener("touchcancel", touchCancel);
    return () => {
      frame.removeEventListener("touchstart", touchStart);
      frame.removeEventListener("touchmove", touchMove);
      frame.removeEventListener("touchend", touchEnd);
      frame.removeEventListener("touchcancel", touchCancel);
      frame.style.removeProperty("--drawer-drag-translate");
      frame.style.removeProperty("--drawer-drag-progress");
    };
  }, [mobile, setOpen, side]);

  useEffect(() => {
    if (mobile) return;
    gestureRef.current = null;
    setDragging(false);
    setOpen(false);
  }, [mobile, setOpen]);

  useEffect(() => {
    gestureRef.current = null;
    setDragging(false);
    frameRef.current?.style.removeProperty("--drawer-drag-translate");
    frameRef.current?.style.removeProperty("--drawer-drag-progress");
  }, [routeKey]);

  useEffect(() => {
    if (!open) return;
    gestureRef.current = null;
    setDragging(false);
  }, [open]);

  useEffect(() => {
    if (!mobile || (!open && !dragging)) return;
    blurActiveTextInput();
  }, [dragging, mobile, open]);

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android" || !mobile || (!threadActive && !open)) return;

    let disposed = false;
    let removeListener: (() => Promise<void>) | undefined;
    void CapacitorApp.addListener("backButton", () => {
      if (open) setOpen(false);
      else if (threadActive) setOpen(true);
    }).then((handle) => {
      if (disposed) void handle.remove();
      else removeListener = () => handle.remove();
    });

    return () => {
      disposed = true;
      void removeListener?.();
    };
  }, [mobile, open, setOpen, threadActive]);

  return { dragging, frameRef, sidebarRef };
}

function blurActiveTextInput() {
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  ) {
    active.blur();
  }
}
