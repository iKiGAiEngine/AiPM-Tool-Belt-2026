import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";

interface TestModeContextType {
  isTestMode: boolean;
  toggleTestMode: () => void;
  isLockedOn: boolean;
}

const TestModeContext = createContext<TestModeContextType>({
  isTestMode: false,
  toggleTestMode: () => {},
  isLockedOn: false,
});

const STORAGE_KEY = "aipm-test-mode";

export function TestModeProvider({ children }: { children: ReactNode }) {
  const { isViewer } = useAuth();

  const [isTestMode, setIsTestMode] = useState(() => {
    if (isViewer) return true;
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (isViewer) {
      setIsTestMode(true);
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, String(isTestMode));
    } catch {}
  }, [isTestMode, isViewer]);

  const toggleTestMode = useCallback(() => {
    if (isViewer) return;
    setIsTestMode((prev) => !prev);
  }, [isViewer]);

  return (
    <TestModeContext.Provider value={{ isTestMode, toggleTestMode, isLockedOn: isViewer }}>
      {children}
    </TestModeContext.Provider>
  );
}

export function useTestMode() {
  return useContext(TestModeContext);
}
