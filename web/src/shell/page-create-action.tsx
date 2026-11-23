import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * The page's own primary create action, shown by the desktop topbar in place
 * of the global `Yeni iş` menu (DESIGN.md "Contextual create control").
 *
 * The page stays the owner of the action: it decides the label and whether the
 * current user may create, and it registers `null` when it may not. The topbar
 * then falls back to `Yeni iş`.
 */
export type PageCreateAction = {
  label: string;
  /** Runs the create flow. `trigger` is the topbar button, for focus return. */
  run: (trigger: HTMLElement) => void;
  disabled?: boolean;
};

type Registered = PageCreateAction & { token: symbol };

type PageCreateActionContextValue = {
  action: Registered | null;
  setAction: (next: Registered | null, owner: symbol) => void;
};

const PageCreateActionContext = createContext<PageCreateActionContextValue | null>(null);

export function PageCreateActionProvider({ children }: { children: ReactNode }) {
  const [action, setActionState] = useState<Registered | null>(null);
  // Stable identity: registering pages list it as an effect dependency.
  const setAction = useCallback((next: Registered | null, owner: symbol) => setActionState((current) => {
    if (next) return next;
    // Only the registering page may clear its own action, so a page that
    // unmounts after the next page registered cannot erase that newer action.
    return current?.token === owner ? null : current;
  }), []);
  const value = useMemo<PageCreateActionContextValue>(() => ({ action, setAction }), [action, setAction]);
  return <PageCreateActionContext.Provider value={value}>{children}</PageCreateActionContext.Provider>;
}

/** Registers the page's create action while the page is mounted. No-op outside the shell. */
export function useRegisterPageCreateAction(action: PageCreateAction | null): void {
  const context = useContext(PageCreateActionContext);
  const setAction = context?.setAction;
  const tokenRef = useRef<symbol>(Symbol('page-create-action'));
  const runRef = useRef(action?.run);
  runRef.current = action?.run;
  const label = action?.label;
  const disabled = action?.disabled ?? false;

  useEffect(() => {
    if (!setAction) return undefined;
    const token = tokenRef.current;
    setAction(label === undefined ? null : {
      token,
      label,
      disabled,
      run: (trigger) => runRef.current?.(trigger),
    }, token);
    return () => setAction(null, token);
  }, [setAction, label, disabled]);
}

export function usePageCreateAction(): PageCreateAction | null {
  return useContext(PageCreateActionContext)?.action ?? null;
}
