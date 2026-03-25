"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "ed1c8661cd48e06fa3397987e8db2281";
const STORAGE_KEY = "hl_wallet_type"; // "injected" | "walletconnect"

interface WalletState {
  address: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any | null;
  connecting: boolean;
  error: string | null;
}

interface WalletCtx extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletCtx>({
  address: null,
  provider: null,
  connecting: false,
  error: null,
  connect: async () => {},
  disconnect: async () => {},
});

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>({
    address: null,
    provider: null,
    connecting: false,
    error: null,
  });

  // Store ref to avoid stale closure in disconnect
  const providerRef = useRef<WalletState["provider"]>(null);
  useEffect(() => { providerRef.current = state.provider; }, [state.provider]);

  // Silent reconnect on mount
  useEffect(() => {
    const saved = typeof window !== "undefined"
      ? localStorage.getItem(STORAGE_KEY)
      : null;
    if (!saved) return;

    (async () => {
      try {
        if (saved === "injected") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const inj = (window as any).ethereum;
          if (!inj) return;
          const accounts: string[] = await inj.request({ method: "eth_accounts" });
          if (accounts[0]) {
            setState({ address: accounts[0], provider: inj, connecting: false, error: null });
          }
        } else if (saved === "walletconnect") {
          const { default: EthereumProvider } = await import(
            "@walletconnect/ethereum-provider"
          );
          const wc = await EthereumProvider.init({
            projectId: WC_PROJECT_ID,
            chains: [1],
            showQrModal: false, // silent — only restores if session exists
            methods: ["eth_signTypedData_v4", "eth_accounts", "eth_requestAccounts", "personal_sign"],
            events: ["accountsChanged", "disconnect"],
          });
          if (wc.accounts.length > 0) {
            setState({ address: wc.accounts[0], provider: wc, connecting: false, error: null });
          }
        }
      } catch {
        // silent reconnect failure is OK — user can manually connect
        localStorage.removeItem(STORAGE_KEY);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      // 1. Injected wallet (MetaMask, Rabby, etc.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inj = typeof window !== "undefined" ? (window as any).ethereum : null;
      if (inj) {
        const accounts: string[] = await inj.request({ method: "eth_requestAccounts" });
        localStorage.setItem(STORAGE_KEY, "injected");
        setState({ address: accounts[0], provider: inj, connecting: false, error: null });
        return;
      }

      // 2. WalletConnect
      const { default: EthereumProvider } = await import(
        "@walletconnect/ethereum-provider"
      );
      const wc = await EthereumProvider.init({
        projectId: WC_PROJECT_ID,
        chains: [1],
        showQrModal: true,
        methods: ["eth_signTypedData_v4", "eth_accounts", "eth_requestAccounts", "personal_sign"],
        events: ["accountsChanged", "disconnect"],
      });
      await wc.connect();
      localStorage.setItem(STORAGE_KEY, "walletconnect");
      setState({ address: wc.accounts[0] ?? null, provider: wc, connecting: false, error: null });
    } catch (err: unknown) {
      localStorage.removeItem(STORAGE_KEY);
      setState((s) => ({
        ...s,
        connecting: false,
        error: err instanceof Error ? err.message : "Connection failed",
      }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    const p = providerRef.current;
    if (p?.disconnect) {
      try { await p.disconnect(); } catch { /* ignore */ }
    }
    localStorage.removeItem(STORAGE_KEY);
    setState({ address: null, provider: null, connecting: false, error: null });
  }, []);

  return (
    <WalletContext.Provider value={{ ...state, connect, disconnect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
