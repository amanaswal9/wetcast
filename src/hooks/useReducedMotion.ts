import { useMediaQuery } from './useMediaQuery'

// True when the system asks for reduced motion; animations should then be skipped.
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)')
}
