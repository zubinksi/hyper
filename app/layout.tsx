import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import PositionsFooter from "./components/PositionsFooter";

export const metadata: Metadata = {
  title: "Hyperliquid Dashboard",
  description: "Real-time Hyperliquid trading dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{ height: "100%" }}>
      <body style={{ margin: 0, height: "100%", display: "flex", flexDirection: "column" }}>
        <Providers>
          {children}
          <PositionsFooter />
        </Providers>
      </body>
    </html>
  );
}
