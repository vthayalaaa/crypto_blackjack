import type { Metadata } from "next";
import { Providers } from "../components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Decentralized Blackjack",
  description: "Two players each put in the same buy-in, play one hand of blackjack, and the closest to 21 takes the pot.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
