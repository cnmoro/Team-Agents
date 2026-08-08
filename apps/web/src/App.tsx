import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { ToastViewport } from '@astryxdesign/core/Toast';
import { Spinner } from '@astryxdesign/core/Spinner';
import { VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { AuthProvider, useAuth } from './state/AuthContext.js';
import { ChatProvider } from './state/ChatContext.js';
import { LoginScreen } from './components/LoginScreen.js';
import { Shell } from './components/Shell.js';

type ThemeMode = 'light' | 'dark';

interface ThemeModeContextValue {
  mode: ThemeMode;
  toggleMode: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: 'light',
  toggleMode: () => {},
});

/** Code blocks need the current mode to pick a Shiki theme. */
export function useThemeMode(): ThemeModeContextValue {
  return useContext(ThemeModeContext);
}

const MODE_KEY = 'teamagents.theme';

function readInitialMode(): ThemeMode {
  const stored = localStorage.getItem(MODE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function AuthGate(): ReactNode {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="ta-centered">
        <VStack gap={3} hAlign="center">
          <Spinner size="lg" />
          <Text type="supporting" color="secondary">
            Restoring your session…
          </Text>
        </VStack>
      </div>
    );
  }

  if (!user) return <LoginScreen />;

  return (
    <ChatProvider>
      <Shell />
    </ChatProvider>
  );
}

export function App(): ReactNode {
  const [mode, setMode] = useState<ThemeMode>(readInitialMode);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  const toggleMode = useCallback(() => {
    setMode((current) => (current === 'light' ? 'dark' : 'light'));
  }, []);

  const themeValue = useMemo(() => ({ mode, toggleMode }), [mode, toggleMode]);

  return (
    <ThemeModeContext.Provider value={themeValue}>
      <Theme theme={neutralTheme} mode={mode}>
        <ToastViewport position="topEnd" maxVisible={4}>
          <AuthProvider>
            <AuthGate />
          </AuthProvider>
        </ToastViewport>
      </Theme>
    </ThemeModeContext.Provider>
  );
}
