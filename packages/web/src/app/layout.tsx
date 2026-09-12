import type { ReactNode } from "react";

export const metadata = {
  title: "Argus",
  description: "Attention monitor for Solana memecoins",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#010409",
          color: "#e6edf3",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
