import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Nav } from './_components/Nav';
import { SimProvider } from './_components/sim';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mnemio campaign dashboard',
  description: 'A view onto the cold-email engine: every number comes from the database.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b0f14' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="shell">
          <Nav />
          <div className="frame">
            <SimProvider>
              <main id="main" className="main">
                {children}
              </main>
            </SimProvider>
          </div>
        </div>
      </body>
    </html>
  );
}
