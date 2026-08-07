import { type ReactElement } from "react";

interface ActionIconProps {
  readonly children: ReactElement | readonly ReactElement[];
}

function ActionIcon({ children }: ActionIconProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="post-actions__icon"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

export function ReplyIcon(): ReactElement {
  return (
    <ActionIcon>
      <path d="M9 8 4 12l5 4" />
      <path d="M5 12h8a6 6 0 0 1 6 6" />
    </ActionIcon>
  );
}

export function QuoteIcon(): ReactElement {
  return (
    <ActionIcon>
      <path d="M6.5 9.5h4v4h-4v-1a4 4 0 0 1 4-4" />
      <path d="M14 9.5h4v4h-4v-1a4 4 0 0 1 4-4" />
    </ActionIcon>
  );
}

export function BoostIcon(): ReactElement {
  return (
    <ActionIcon>
      <path d="M7 7h9a3 3 0 0 1 3 3v1" />
      <path d="m16 4 3 3-3 3" />
      <path d="M17 17H8a3 3 0 0 1-3-3v-1" />
      <path d="m8 20-3-3 3-3" />
    </ActionIcon>
  );
}

export function FavouriteIcon(): ReactElement {
  return (
    <ActionIcon>
      <path d="m12 3 2.75 5.57 6.15.9-4.45 4.33 1.05 6.12L12 17.03l-5.5 2.89 1.05-6.12L3.1 9.47l6.15-.9L12 3Z" />
    </ActionIcon>
  );
}

export function BookmarkIcon(): ReactElement {
  return (
    <ActionIcon>
      <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4V4.5Z" />
    </ActionIcon>
  );
}

export function ReactIcon(): ReactElement {
  return (
    <ActionIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9h.01M15 9h.01" />
    </ActionIcon>
  );
}
