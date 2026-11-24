import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, isAbort, toApiError } from '../lib/api/http'
import { log } from '../lib/log'

export type Loader<T> = (options: { signal: AbortSignal; fresh: boolean }) => Promise<T>

export interface ResourceState<T> {
  status: 'idle' | 'loading' | 'success' | 'error'
  data?: T
  error?: ApiError
  // True while re-fetching data that is already on screen.
  refreshing: boolean
}

// Loads data for a key, cancels stale requests, keeps showing the previous
// data while refreshing the same key, and can auto-refresh on an interval.
export function useResource<T>(key: string | null, loader: Loader<T>, refreshMs?: number) {
  const [state, setState] = useState<ResourceState<T>>({ status: 'idle', refreshing: false })
  const [tick, setTick] = useState(0)
  const loaderRef = useRef(loader)
  const forceFresh = useRef(false)
  const lastKey = useRef<string | null>(null)

  useLayoutEffect(() => {
    loaderRef.current = loader
  })

  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    const sameKey = lastKey.current === key
    lastKey.current = key
    const fresh = forceFresh.current
    forceFresh.current = false

    setState((prev) =>
      sameKey && prev.data !== undefined ? { ...prev, refreshing: true } : { status: 'loading', refreshing: false },
    )

    loaderRef
      .current({ signal: controller.signal, fresh })
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'success', data, refreshing: false })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return
        const apiError = toApiError(error)
        // On the public copy a missing server is expected, so it isn't reported as an error.
        if (apiError.kind === 'no-server') log.debug('not on the public copy', key)
        else log.error('load failed', key, apiError.message)
        // Keep any data already on screen; the UI shows it as stale.
        setState((prev) => ({ status: 'error', error: apiError, data: prev.data, refreshing: false }))
      })

    return () => controller.abort()
  }, [key, tick])

  useEffect(() => {
    if (!refreshMs || key === null) return
    const id = window.setInterval(() => setTick((t) => t + 1), refreshMs)
    return () => window.clearInterval(id)
  }, [key, refreshMs])

  const reload = useCallback(() => {
    forceFresh.current = true
    setTick((t) => t + 1)
  }, [])

  return { ...state, reload }
}
