import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type PropsWithChildren, type ReactElement } from "react";

const appQueryClient = new QueryClient();
const appStore = createStore();

export function AppProviders({ children }: PropsWithChildren): ReactElement {
  return (
    <JotaiProvider store={appStore}>
      <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>
    </JotaiProvider>
  );
}
