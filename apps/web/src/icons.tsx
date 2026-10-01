/** Small inline SVG icons for the reference drawing UI (14 px, currentColor). */
import type { ReactNode } from 'react';

const icon = (children: ReactNode) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Icon = {
  cursor: icon(
    <path d="M4 2.5v10l2.8-2.6 1.9 4.1 1.6-.7-1.9-4.1h3.8z" fill="currentColor" stroke="none" />,
  ),
  trendLine: icon(
    <>
      <path d="M4 12L12 4" />
      <circle cx="3.5" cy="12.5" r="1.6" />
      <circle cx="12.5" cy="3.5" r="1.6" />
    </>,
  ),
  horizontalLine: icon(
    <>
      <path d="M1.5 8h4.4M10.1 8h4.4" />
      <circle cx="8" cy="8" r="1.6" />
    </>,
  ),
  rectangle: icon(<rect x="2.5" y="4" width="11" height="8" rx="0.5" />),
  undo: icon(<path d="M5.5 4L2.5 7l3 3M2.5 7h7a4 4 0 010 8H7" />),
  redo: icon(<path d="M10.5 4l3 3-3 3M13.5 7h-7a4 4 0 000 8H9" />),
  list: icon(<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />),
  locked: icon(
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </>,
  ),
  unlocked: icon(
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 014.9-.7" />
    </>,
  ),
  visible: icon(
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>,
  ),
  hidden: icon(
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <path d="M2.5 13.5l11-11" />
    </>,
  ),
  duplicate: icon(
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 3.5v-.5a.5.5 0 00-.5-.5H3a.5.5 0 00-.5.5v7a.5.5 0 00.5.5h.5" />
    </>,
  ),
  trash: icon(<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9M6.7 7v4.5M9.3 7v4.5" />),
  close: icon(<path d="M4 4l8 8M12 4l-8 8" />),
};
