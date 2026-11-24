"use client";
import { useEffect } from "react";
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { scene } from "@/lib/scene";

if (typeof window !== "undefined") gsap.registerPlugin(ScrollTrigger);

let lenis: Lenis | null = null;

/** hold the page still (the menu is open) or let it scroll again */
export function holdScroll(on: boolean) {
  if (lenis) {
    if (on) lenis.stop();
    else lenis.start();
  }
  document.documentElement.style.overflow = on ? "hidden" : "";
}

export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  // the first chapter is the very top of the page, whatever its layout
  const top = id === "top" ? 0 : el.getBoundingClientRect().top + window.scrollY;
  if (lenis) lenis.scrollTo(top, { duration: 1.6 });
  else window.scrollTo({ top, behavior: scene.reducedMotion ? "auto" : "smooth" });
}

/** Lenis smooth scroll driving GSAP ScrollTrigger on one ticker. Disabled for reduced motion. */
export function SmoothScroll() {
  useEffect(() => {
    if (scene.reducedMotion) return;
    gsap.registerEase?.("rq.out", (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)));
    const l = new Lenis({ lerp: 0.085, wheelMultiplier: 0.9, smoothWheel: true });
    lenis = l;
    l.on("scroll", (e: Lenis) => {
      ScrollTrigger.update();
      scene.scrollV = e.velocity * 60;
    });
    const root = document.documentElement;
    let lastSv = 0;
    const tick = (t: number) => {
      l.raf(t * 1000);
      scene.scrollV *= 0.92; // decays to rest when the wheel stops
      const sv = Math.max(-1, Math.min(1, scene.scrollV / 2600));
      if (Math.abs(sv - lastSv) > 0.002) {
        lastSv = sv;
        root.style.setProperty("--sv", sv.toFixed(3));
      }
    };
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      l.destroy();
      lenis = null;
    };
  }, []);
  return null;
}
