import type { Metadata, Viewport } from "next";
import { Bodoni_Moda, Fragment_Mono, Instrument_Sans, Mona_Sans, Newsreader } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

/**
 * Type. The glass display type (her name, the headings, the big figures): Mona Sans, heavy, a grotesk in
 * the spirit of the face Apple sets its liquid glass in (SF Pro, which cannot be hosted); thick, open strokes are
 * what glass needs to bend the world through. Ledes and the italic: Bodoni Moda. Reading text: Newsreader. The
 * interface, labels and figures: Instrument Sans. Hashes only: Fragment Mono. All SIL OFL.
 */
const display = Bodoni_Moda({ subsets: ["latin"], axes: ["opsz"], style: ["normal", "italic"], variable: "--font-bodoni", display: "swap" });
const serif = Newsreader({ subsets: ["latin"], axes: ["opsz"], style: ["normal", "italic"], variable: "--font-newsreader", display: "swap" });
const glassFace = Mona_Sans({ subsets: ["latin"], axes: ["wdth"], variable: "--font-mona", display: "swap" });
const text = Instrument_Sans({ subsets: ["latin"], axes: ["wdth"], variable: "--font-instrument", display: "swap" });
const mono = Fragment_Mono({ subsets: ["latin"], weight: "400", variable: "--font-fragment", display: "swap" });

export const metadata: Metadata = {
  title: "Red Queen",
  description: "A vault on Ethereum guarded by a policy that evolves under attack. Every rule is bred on-chain.",
  icons: { icon: "/mark.svg" },
};

export const viewport: Viewport = {
  themeColor: "#050608",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${glassFace.variable} ${serif.variable} ${text.variable} ${mono.variable}`}>
      <head>
        {/* without scripts the loading curtain would never lift */}
        <noscript>
          <style>{".curtain{display:none}"}</style>
        </noscript>
        {/* opt-in: ?rafshim drives requestAnimationFrame from timers (headless captures, hidden panes) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if(location.search.indexOf('rafshim')>-1){window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(performance.now())},16)};window.cancelAnimationFrame=function(id){clearTimeout(id)};}`,
          }}
        />
      </head>
      <body>
        <a href="#main" className="skip">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
