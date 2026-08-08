import { useCallback } from 'react';
import { useToast } from '@astryxdesign/core/Toast';

type ToastOptions = Parameters<ReturnType<typeof useToast>>[0];

/**
 * `useToast` with sane dismissal defaults.
 *
 * Astryx keeps error toasts on screen until they are dismissed by hand, on the
 * theory that a failure should not vanish unnoticed. In a chat window that
 * turns routine, recoverable errors — "that repository is still in use" — into
 * clutter the user has to clear one by one, so errors auto-hide here too, just
 * more slowly than informational ones.
 */
export function useAppToast(): (options: ToastOptions) => void {
  const toast = useToast();

  return useCallback(
    (options: ToastOptions) => {
      const isError = options.type === 'error';
      toast({
        isAutoHide: true,
        autoHideDuration: isError ? 8000 : 5000,
        ...options,
      });
    },
    [toast],
  );
}
