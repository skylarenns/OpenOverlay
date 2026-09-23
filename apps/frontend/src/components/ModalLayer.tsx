import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function ModalLayer({
  children,
  initialFocusRef,
  onClose
}: {
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("root");
    const wasInert = appRoot?.hasAttribute("inert") ?? false;
    const previousAriaHidden = appRoot?.getAttribute("aria-hidden") ?? null;
    if (appRoot) {
      appRoot.setAttribute("inert", "");
      appRoot.setAttribute("aria-hidden", "true");
    }

    const firstFocusable = () => {
      const requested = initialFocusRef?.current;
      const fallback = layerRef.current?.querySelector<HTMLElement>(MODAL_FOCUSABLE_SELECTOR) ?? layerRef.current;
      (requested ?? fallback)?.focus();
    };
    firstFocusable();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !layerRef.current) return;
      const focusable = [...layerRef.current.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)].filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true"
      );
      if (focusable.length === 0) {
        event.preventDefault();
        layerRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (appRoot) {
        if (!wasInert) appRoot.removeAttribute("inert");
        if (previousAriaHidden === null) appRoot.removeAttribute("aria-hidden");
        else appRoot.setAttribute("aria-hidden", previousAriaHidden);
      }
      openerRef.current?.focus();
    };
  }, [initialFocusRef]);

  return createPortal(
    <div
      ref={layerRef}
      className="prompt-backdrop"
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      {children}
    </div>,
    document.body
  );
}
