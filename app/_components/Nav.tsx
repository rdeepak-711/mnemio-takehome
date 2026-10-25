'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The six sections of the brief, in its order, then deliverability (T22b, D71).
const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/timeline', label: 'Campaign Timeline' },
  { href: '/journey', label: 'Contact Journeys' },
  { href: '/classifier', label: 'AI Classifier' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/activity', label: 'Activity Log' },
  { href: '/deliverability', label: 'Deliverability' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Dashboard pages">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true" />
        Mnemio
      </span>
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} aria-current={path === l.href ? 'page' : undefined}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
