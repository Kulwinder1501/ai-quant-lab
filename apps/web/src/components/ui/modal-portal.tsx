"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const subscribe = () => () => {};

/**
 * Renders its children into document.body.
 *
 * A `position: fixed` overlay is positioned against the nearest ancestor that has a transform, not the
 * viewport. `Reveal` leaves `translate-y-0` on its wrapper once it has faded in, which is a transform, so a
 * modal rendered inside the page body is laid out against that wrapper: it opened thousands of pixels below
 * the fold, with the backdrop covering only part of the screen. Mounting it on the body sidesteps every
 * such ancestor. Nothing renders on the server, where there is no body.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return mounted ? createPortal(children, document.body) : null;
}
