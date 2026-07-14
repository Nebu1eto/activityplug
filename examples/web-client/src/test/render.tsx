import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type PropsWithChildren, type ReactElement } from "react";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
}

export function renderApp(ui: ReactElement): RenderResult {
  const queryClient = createTestQueryClient();
  const store = createStore();

  function TestProviders({ children }: PropsWithChildren): ReactElement {
    return (
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </JotaiProvider>
    );
  }

  return render(ui, { wrapper: TestProviders });
}
