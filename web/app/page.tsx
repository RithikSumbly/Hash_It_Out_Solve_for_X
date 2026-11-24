"use client";
import dynamic from "next/dynamic";
import { useUI } from "@/lib/ui";
import { Header, Hero, Loader, StageTracker } from "@/components/sections/Top";
import { AttackField, FeedSection, TryIt, VaultSection } from "@/components/sections/Middle";
import { BetSection, ChartsSection, Generations, LineageSection, ProofSection } from "@/components/sections/Lower";
import { PhoneView } from "@/components/sections/Phone";
import { RolesSection } from "@/components/sections/Roles";
import { AttackLab, CinemaOverlay, PolicyInspector, ScarCard, TimeMachine } from "@/components/overlays/Overlays";
import { Tour } from "@/components/overlays/Tour";
import { Audience } from "@/components/overlays/Audience";
import { Cursor, EdgePulse, PointerField, Toasts } from "@/components/ui/primitives";
import { RubyField } from "@/components/ui/Ruby";
import { SmoothScroll } from "@/components/ui/SmoothScroll";
import { Annotations } from "@/components/ui/Annotations";
import { Curtain } from "@/components/ui/Curtain";

const Scene = dynamic(() => import("@/components/stage/Stage"), { ssr: false });
const Scene2D = dynamic(() => import("@/components/scene/Scene2D"), { ssr: false });

export default function Page() {
  const webgl = useUI((s) => s.webgl);
  const phone = useUI((s) => s.phone);
  const cinema = useUI((s) => s.cinema);
  return (
    <>
      {webgl ? <Scene phone={phone} /> : <Scene2D phone={phone} />}
      <EdgePulse />
      <PointerField />
      <RubyField />
      {phone ? null : <Cursor />}
      <Loader />
      <Curtain />
      <StageTracker />
      {phone ? (
        <main id="main">
          <PhoneView />
        </main>
      ) : (
        <>
          <SmoothScroll />
          {webgl ? <Annotations /> : null}
          <Header />
          <main id="main" className="relative z-10" style={{ opacity: cinema ? 0 : 1, pointerEvents: cinema ? "none" : "auto", transition: "opacity 800ms cubic-bezier(0.16,1,0.3,1)" }}>
            <Hero />
            <VaultSection />
            <AttackField />
            <TryIt />
            <FeedSection />
            <Generations />
            <LineageSection />
            <ChartsSection />
            <BetSection />
            <RolesSection />
            <ProofSection />
          </main>
          <CinemaOverlay />
        </>
      )}
      <PolicyInspector />
      <AttackLab />
      <ScarCard />
      <TimeMachine />
      {phone ? null : <Tour />}
      <Audience />
      <Toasts />
    </>
  );
}
