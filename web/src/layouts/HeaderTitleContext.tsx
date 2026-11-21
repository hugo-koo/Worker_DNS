import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

export interface HeaderTitleState {
  title: string;
  isVisible: boolean;
}

interface InternalHeaderTitleState extends HeaderTitleState {
  pathname: string;
}

interface HeaderTitleContextValue {
  headerTitle: HeaderTitleState;
  pathname: string;
  scrollContainerEl: HTMLDivElement | null;
  setHeaderState: React.Dispatch<React.SetStateAction<InternalHeaderTitleState>>;
}

const DEFAULT_PUBLIC_STATE: HeaderTitleState = {
  title: "",
  isVisible: false
};

const HeaderTitleContext = createContext<HeaderTitleContextValue>({
  headerTitle: DEFAULT_PUBLIC_STATE,
  pathname: "",
  scrollContainerEl: null,
  setHeaderState: () => {}
});

export interface HeaderTitleProviderProps {
  /** Scrollable main content container element inside MainLayout. */
  scrollContainerEl: HTMLDivElement | null;
  /** Current router pathname used to scope sticky title state per route. */
  pathname: string;
  children: React.ReactNode;
}

const HEADER_BAR_HEIGHT_PX = 56; // Matches HeaderNavbar h-14 (3.5rem)

/**
 * Provides scroll-container context and active sticky header title state
 * shared between page views and HeaderNavbar.
 */
export const HeaderTitleProvider: React.FC<HeaderTitleProviderProps> = ({
  scrollContainerEl,
  pathname,
  children
}) => {
  const [headerState, setHeaderState] = useState<InternalHeaderTitleState>({
    pathname,
    title: "",
    isVisible: false
  });

  const headerTitle: HeaderTitleState =
    headerState.pathname === pathname
      ? { title: headerState.title, isVisible: headerState.isVisible }
      : DEFAULT_PUBLIC_STATE;

  return (
    <HeaderTitleContext.Provider
      value={{ headerTitle, pathname, scrollContainerEl, setHeaderState }}
    >
      {children}
    </HeaderTitleContext.Provider>
  );
};

/**
 * Reads the current sticky navbar title state for presentation inside HeaderNavbar.
 */
export function useHeaderTitleState(): HeaderTitleState {
  return useContext(HeaderTitleContext).headerTitle;
}

/**
 * Observes a page's primary heading element inside MainLayout's scroll container.
 * When the heading scrolls upward completely behind the top bar, reveals `title`
 * centered inside HeaderNavbar; hides it again as soon as the heading re-emerges.
 *
 * @param title - Localized page main title to display in HeaderNavbar when scrolled past.
 * @returns Callback ref to attach to the primary heading element (or its tight wrapper).
 */
export function useStickyHeaderTitle<T extends HTMLElement = HTMLElement>(
  title: string | undefined
): React.RefCallback<T> {
  const { pathname, scrollContainerEl, setHeaderState } = useContext(HeaderTitleContext);
  const [targetEl, setTargetEl] = useState<T | null>(null);

  const refCallback = useCallback(
    (node: T | null) => {
      setTargetEl(node);
      if (!node) {
        setHeaderState((prev) =>
          prev.pathname === pathname ? { ...prev, isVisible: false } : prev
        );
      }
    },
    [pathname, setHeaderState]
  );

  useEffect(() => {
    if (!title || !targetEl || !scrollContainerEl) {
      return;
    }

    const syncFromRect = (isIntersecting: boolean, headingRect: DOMRect, rootTop: number) => {
      const hiddenAboveHeader =
        !isIntersecting &&
        scrollContainerEl.scrollTop > 0 &&
        headingRect.bottom <= rootTop + 1;
      setHeaderState({ pathname, title, isVisible: hiddenAboveHeader });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const fallbackRootTop =
          scrollContainerEl.getBoundingClientRect().top + HEADER_BAR_HEIGHT_PX;
        const rootTop = entry.rootBounds?.top ?? fallbackRootTop;
        syncFromRect(entry.isIntersecting, entry.boundingClientRect, rootTop);
      },
      {
        root: scrollContainerEl,
        rootMargin: `-${HEADER_BAR_HEIGHT_PX}px 0px 0px 0px`,
        threshold: 0
      }
    );

    observer.observe(targetEl);

    return () => {
      observer.disconnect();
    };
  }, [title, targetEl, scrollContainerEl, pathname, setHeaderState]);

  return refCallback;
}
