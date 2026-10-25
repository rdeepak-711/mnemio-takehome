'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/journey', label: 'Journey' },
  { href: '/contacts', label: 'Contacts' },
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
