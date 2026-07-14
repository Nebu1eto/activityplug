import { type ReactElement, type ReactNode } from "react";

import { useI18n } from "../../i18n/i18n.js";
import { LocaleControl } from "../../i18n/locale-control.js";
import { type MessageKey } from "../../i18n/messages.js";
import { ProductLink, useProductLocation } from "../../routing/location.js";

export interface ProductShellProps {
  readonly children: ReactNode;
  readonly context?: ReactNode;
  readonly navigation?: ReactNode;
  readonly headerActions?: ReactNode;
}

const navigationItems = [
  { name: "home", href: "/", messageKey: "nav.home" },
  { name: "local", href: "/local", messageKey: "nav.local" },
  { name: "federated", href: "/federated", messageKey: "nav.federated" },
  { name: "search", href: "/search", messageKey: "nav.search" },
] as const satisfies readonly {
  readonly name: string;
  readonly href: string;
  readonly messageKey: MessageKey;
}[];

export function ProductShell({
  children,
  context = null,
  navigation,
  headerActions,
}: ProductShellProps): ReactElement {
  const location = useProductLocation();
  const { t } = useI18n();

  return (
    <div className="product-shell">
      <a className="skip-link" href="#main-content">
        {t("a11y.skipToContent")}
      </a>
      <header className="product-shell__header">
        <ProductLink className="product-shell__brand" href="/">
          ActivityPlug
        </ProductLink>
        <div className="product-shell__header-actions">
          {headerActions}
          <LocaleControl />
        </div>
      </header>
      <div className="product-shell__grid">
        <nav
          aria-label={t("a11y.primaryNavigation")}
          className="product-shell__navigation"
          data-layout-slot="navigation"
        >
          {navigation ?? (
            <ul className="product-navigation">
              {navigationItems.map((item) => (
                <li key={item.name}>
                  <ProductLink
                    aria-current={location.name === item.name ? "page" : undefined}
                    href={item.href}
                  >
                    {t(item.messageKey)}
                  </ProductLink>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <main
          className="product-shell__main"
          data-layout-slot="main"
          id="main-content"
          tabIndex={-1}
        >
          {children}
        </main>
        <aside
          aria-label={t("a11y.contextPanel")}
          className="product-shell__context"
          data-layout-slot="context"
        >
          {context}
        </aside>
      </div>
    </div>
  );
}
