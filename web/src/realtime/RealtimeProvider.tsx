import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

const REALTIME_EVENT_NAME = 'servora.change';
const FALLBACK_RECONCILIATION_MS = 60_000;

const CHANGE_TYPES = new Set([
  'job.created',
  'job.assignment_changed',
  'job.accepted',
  'job.started',
  'job.submitted_for_approval',
  'job.approved',
  'job.revision_requested',
  'job.cancelled',
  'job.updated',
]);

type RealtimeChangeEnvelope = Readonly<{
  id: string;
  type: string;
  entity: Readonly<{ type: 'job-card'; id: string }>;
  resourceKeys: readonly string[];
  occurredAt: string;
}>;

type RealtimeSyncRequiredEnvelope = Readonly<{
  id: string;
  type: 'sync.required';
  resourceKeys: readonly ['workspace'];
  occurredAt: string;
}>;

type RealtimeEnvelope = RealtimeChangeEnvelope | RealtimeSyncRequiredEnvelope;

export type RealtimeConnectionState = 'connecting' | 'connected' | 'disconnected';

export type RealtimeEventSource = Readonly<{
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
}>;

export type RealtimeEventSourceFactory = (url: string) => RealtimeEventSource;

type RealtimeContextValue = Readonly<{
  connectionState: RealtimeConnectionState;
  subscribe(resourceKeys: readonly string[], callback: () => void): () => void;
}>;

const inertRealtimeContext: RealtimeContextValue = {
  connectionState: 'disconnected',
  subscribe: () => () => {},
};

const RealtimeContext = createContext<RealtimeContextValue>(inertRealtimeContext);

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function isOccurredAt(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isResourceKeys(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((key) => typeof key === 'string' && key.length > 0);
}

function parseEnvelope(input: string): RealtimeEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isCursor(record.id) || !isOccurredAt(record.occurredAt) || !isResourceKeys(record.resourceKeys)) return null;
  if (record.type === 'sync.required') {
    if (record.resourceKeys.length !== 1 || record.resourceKeys[0] !== 'workspace') return null;
    return {
      id: record.id,
      type: 'sync.required',
      resourceKeys: ['workspace'],
      occurredAt: record.occurredAt,
    };
  }
  if (typeof record.type !== 'string' || !CHANGE_TYPES.has(record.type)) return null;
  if (!record.entity || typeof record.entity !== 'object') return null;
  const entity = record.entity as Record<string, unknown>;
  if (entity.type !== 'job-card' || typeof entity.id !== 'string' || entity.id.length === 0) return null;
  return {
    id: record.id,
    type: record.type,
    entity: { type: 'job-card', id: entity.id },
    resourceKeys: record.resourceKeys,
    occurredAt: record.occurredAt,
  };
}

function defaultEventSourceFactory(url: string): RealtimeEventSource {
  return new EventSource(url);
}

export function RealtimeProvider({
  children,
  eventSourceFactory = defaultEventSourceFactory,
}: {
  children: ReactNode;
  eventSourceFactory?: RealtimeEventSourceFactory;
}) {
  const subscriptions = useRef(new Map<string, Set<() => void>>());
  const queuedCallbacks = useRef(new Set<() => void>());
  const flushQueued = useRef(false);
  const lastCursor = useRef<bigint | null>(null);
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>('connecting');

  const queueCallbacks = useCallback((callbacks: Iterable<() => void>) => {
    for (const callback of callbacks) queuedCallbacks.current.add(callback);
    if (flushQueued.current || queuedCallbacks.current.size === 0) return;
    flushQueued.current = true;
    queueMicrotask(() => {
      flushQueued.current = false;
      const pending = [...queuedCallbacks.current];
      queuedCallbacks.current.clear();
      pending.forEach((callback) => callback());
    });
  }, []);

  const reconcileAll = useCallback(() => {
    const callbacks = new Set<() => void>();
    subscriptions.current.forEach((registered) => registered.forEach((callback) => callbacks.add(callback)));
    queueCallbacks(callbacks);
  }, [queueCallbacks]);

  const subscribe = useCallback((resourceKeys: readonly string[], callback: () => void) => {
    resourceKeys.forEach((resourceKey) => {
      const registered = subscriptions.current.get(resourceKey) ?? new Set<() => void>();
      registered.add(callback);
      subscriptions.current.set(resourceKey, registered);
    });
    return () => {
      resourceKeys.forEach((resourceKey) => {
        const registered = subscriptions.current.get(resourceKey);
        if (!registered) return;
        registered.delete(callback);
        if (registered.size === 0) subscriptions.current.delete(resourceKey);
      });
    };
  }, []);

  useEffect(() => {
    const eventSource = eventSourceFactory('/api/realtime/events');
    const onOpen: EventListener = () => {
      setConnectionState('connected');
      reconcileAll();
    };
    const onError: EventListener = () => setConnectionState('disconnected');
    const onChange: EventListener = (event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return;
      const envelope = parseEnvelope(event.data);
      if (!envelope) return;
      const cursor = BigInt(envelope.id);
      if (lastCursor.current !== null && cursor <= lastCursor.current) return;
      lastCursor.current = cursor;
      if (envelope.type === 'sync.required') {
        reconcileAll();
        return;
      }
      const callbacks = new Set<() => void>();
      envelope.resourceKeys.forEach((resourceKey) => {
        subscriptions.current.get(resourceKey)?.forEach((callback) => callbacks.add(callback));
      });
      queueCallbacks(callbacks);
    };
    eventSource.addEventListener('open', onOpen);
    eventSource.addEventListener('error', onError);
    eventSource.addEventListener(REALTIME_EVENT_NAME, onChange);
    return () => {
      eventSource.removeEventListener('open', onOpen);
      eventSource.removeEventListener('error', onError);
      eventSource.removeEventListener(REALTIME_EVENT_NAME, onChange);
      eventSource.close();
    };
  }, [eventSourceFactory, queueCallbacks, reconcileAll]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reconcileAll(); };
    const onFocus = () => reconcileAll();
    const onOnline = () => reconcileAll();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [reconcileAll]);

  useEffect(() => {
    if (connectionState !== 'disconnected') return;
    const timer = window.setInterval(reconcileAll, FALLBACK_RECONCILIATION_MS);
    return () => window.clearInterval(timer);
  }, [connectionState, reconcileAll]);

  const context = useMemo<RealtimeContextValue>(() => ({ connectionState, subscribe }), [connectionState, subscribe]);
  return <RealtimeContext.Provider value={context}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeConnectionState() {
  return useContext(RealtimeContext).connectionState;
}

export function useRealtimeInvalidation(resourceKeys: readonly string[], onInvalidate: () => void) {
  const { subscribe } = useContext(RealtimeContext);
  const callback = useRef(onInvalidate);
  callback.current = onInvalidate;
  const key = resourceKeys.join('\u001f');
  const stableResourceKeys = useMemo(() => key ? key.split('\u001f') : [], [key]);
  useEffect(() => subscribe(stableResourceKeys, () => callback.current()), [stableResourceKeys, subscribe]);
}
