import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DialogProvider } from "@/components/Dialogs";
import { Header } from "@/components/Header";
import { CoinDrawerProvider } from "@/components/Intel";
import { RadarStreamProvider } from "@/lib/stream";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crypto Radar",
  description: "Crypto signal radar — all coins, multi-source, local (information only)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen font-sans antialiased">
        <RadarStreamProvider>
          <DialogProvider>
            <CoinDrawerProvider>
              <Header />
              <main className="mx-auto max-w-[1600px] px-4 py-6">{children}</main>
            </CoinDrawerProvider>
          </DialogProvider>
        </RadarStreamProvider>
      </body>
    </html>
  );
}
