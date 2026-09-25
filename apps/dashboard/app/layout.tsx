import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { RadarStreamProvider } from "@/lib/stream";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crypto Radar",
  description: "Coinbase market radar — local, phase 1 (observation only)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen font-sans antialiased">
        <RadarStreamProvider>
          <Header />
          <main className="mx-auto max-w-[1600px] px-4 py-6">{children}</main>
        </RadarStreamProvider>
      </body>
    </html>
  );
}
