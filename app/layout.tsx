import type { Metadata } from "next";
import "./globals.css";

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
        {children}
      </body>
    </html>
  );
}
