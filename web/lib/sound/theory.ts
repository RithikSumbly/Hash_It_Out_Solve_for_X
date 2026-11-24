/**
 * Music theory for the Red Queen sound engine — pure, dependency-free, no DOM/Web-Audio values.
 *
 * The theory here (musical cryptography, the Solfa cipher, diatonic modes, the tonal-metric hierarchy,
 * equal temperament vs just intonation) is bent to the Red Queen brand.
 *
 * Everything is deterministic: the same genome always yields the same key, so the sound is a true
 * sonification of the on-chain state, reproducible offline.
 */

// ---------------------------------------------------------------- tuning

/** MIDI note number -> frequency in 12-TET (A4 = 69 = 440 Hz). */
export function mtof(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Just-intonation ratios for a major-ish seven-tone set over one octave (plus the octave).
 * The healthy vault bed is tuned to these pure ratios (beat-free); under attack the partials are
 * lerped toward 12-TET and beyond, so roughness encodes pressure. (MSD2: the ET-vs-JI thread.)
 */
export const JI_RATIOS = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8, 2];

/**
 * Blend a just-intonation ratio toward its 12-TET neighbour. t=0 is pure JI, t=1 is equal
 * temperament, t>1 detunes past it into audible beating.
 */
export function tuneRatio(jiRatio: number, t: number): number {
  const cents = 1200 * Math.log2(jiRatio); // JI position in cents
  const etCents = Math.round(cents / 100) * 100; // nearest 12-TET step
  const blended = cents + (etCents - cents) * t;
  return Math.pow(2, blended / 1200);
}

// ---------------------------------------------------------------- modes

/**
 * The seven diatonic modes as semitone offsets from the tonic, ordered BRIGHT -> DARK
 * (number of raised degrees descending). This brightness ordering is the Solfa cipher's mode axis
 * and the classic modal brightness scale: Lydian is the brightest, Locrian the darkest.
 */
export const MODES: ReadonlyArray<{ name: string; steps: readonly number[] }> = [
  { name: "Lydian", steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: "Ionian", steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: "Mixolydian", steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: "Aeolian", steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: "Phrygian", steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: "Locrian", steps: [0, 1, 3, 5, 6, 8, 10] },
];

/** Index into MODES: Dorian — the Red Queen's home mode (shares the "D minor feel" of the lineage). */
export const HOME_MODE = 3;

/**
 * Pitch classes of the Red Queen lineage, taken verbatim from the MSD2 song's pitch set
 * (A#, C, D, F, G, A). The genome's tonic is chosen from this set, so every generation stays inside
 * the family's harmony while still being able to modulate. Ordered as a gentle journey around it.
 */
export const LINEAGE_PCS = [2, 5, 9, 0, 7, 10]; // D, F, A, C, G, A#
/** Home tonic: D4. */
export const HOME_TONIC = 62;

// ---------------------------------------------------------------- genome -> key

/** A small, stable integer hash of the 32-gene genome. */
function geneHash(genes: readonly number[]): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < genes.length; i++) {
    h ^= (genes[i] | 0) & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export interface Key {
  /** MIDI note of the tonic in the bed's register (octave ~3). */
  tonic: number;
  /** index into MODES (0 bright .. 6 dark). */
  mode: number;
  modeName: string;
  /** semitone offsets of the current mode. */
  steps: readonly number[];
  /** tonic pitch class 0..11. */
  pc: number;
}

/**
 * Derive the musical key from the live genome.
 *  - MODE from the genome's "disposition": a policy that weights the suspicion features heavily is
 *    defensive and tense, so it sits in a darker mode; a light-handed policy sits brighter. This is
 *    the Solfa idea of a (tone, mode) key, driven here by the organism itself.
 *  - TONIC pitch class from a hash over the lineage pitch set, so each lineage has its own home note.
 */
export function genomeKey(genes: readonly number[]): Key {
  const g = genes && genes.length >= 24 ? genes : new Array(32).fill(0);
  // disposition: mean magnitude of the 8 linear feature weights (genes 0..7) and the 8 interaction
  // weights (genes 8..15). Higher = more aggressively defensive = darker.
  let lin = 0;
  for (let i = 0; i < 8; i++) lin += Math.abs(g[i] | 0);
  let inter = 0;
  for (let i = 8; i < 16; i++) inter += Math.abs(g[i] | 0);
  const defense = lin / 8 + inter / 8; // typical gene magnitudes are O(100..1000)
  // squash into 0..6 (bright..dark). ~0 -> Lydian, large -> Locrian.
  const darkness = 1 - 1 / (1 + defense / 2200);
  let mode = Math.round(darkness * 6);
  if (mode < 0) mode = 0;
  if (mode > 6) mode = 6;
  const pc = LINEAGE_PCS[geneHash(g) % LINEAGE_PCS.length];
  // place the tonic near D3..D4 so the bed stays in a low-mid register
  const tonic = 50 + ((pc - 2 + 12) % 12); // D3=50 as the anchor
  return { tonic, mode, modeName: MODES[mode].name, steps: MODES[mode].steps, pc };
}

/** The default key before any policy is known: D Dorian in the lineage home register. */
export function homeKey(): Key {
  return { tonic: HOME_TONIC - 12, mode: HOME_MODE, modeName: MODES[HOME_MODE].name, steps: MODES[HOME_MODE].steps, pc: 2 };
}

/** Diatonic degree (0-based) -> MIDI note in the given key, wrapping octaves. */
export function degreeToMidi(key: Key, degree: number): number {
  const oct = Math.floor(degree / 7);
  const step = key.steps[((degree % 7) + 7) % 7];
  return key.tonic + 12 * oct + step;
}

// ---------------------------------------------------------------- reason gamut

/**
 * The 16 reason bits -> 16 pitches ("the reason gamut").
 *
 *  - bits 0..7 are the eight LINEAR features (LARGE_AMOUNT, NEW_RECIPIENT, ... EPOCH_OUTFLOW). They
 *    map to clean diatonic scale degrees 1..8, so a simple refusal rings as a consonant interval.
 *  - bits 8..15 are the eight INTERACTION rules (AMOUNT×NOVELTY ... CONTRACT_SINK). They map to
 *    chromatic tension tones an octave up, so a sophisticated, multi-feature attack that the policy
 *    caught sounds pointed and dissonant — the music says "this one was clever".
 *
 * This is the Solfa/musical-cryptogram principle (a fixed symbol -> a fixed note) applied to the
 * refusal bitmask, with the tonal-metric hierarchy deciding how salient each note is at mix time.
 */
const INTERACTION_TENSIONS = [1, 6, 8, 3, 13, 10, 11, 14]; // b9, #11, #5, m3, b9+8ve, m7, M7, #5+8ve

export function reasonGamut(key: Key): number[] {
  const g: number[] = new Array(16);
  for (let i = 0; i < 8; i++) g[i] = degreeToMidi(key, i); // degrees 1..8 (0..7)
  for (let j = 0; j < 8; j++) g[8 + j] = key.tonic + 12 + INTERACTION_TENSIONS[j];
  return g;
}

/** The fired reason bits, as an array of bit indices (0..15). */
export function reasonBits(reason: bigint | number): number[] {
  const m = BigInt(reason);
  const out: number[] = [];
  for (let i = 0; i < 16; i++) if ((m >> BigInt(i)) & 1n) out.push(i);
  return out;
}

// ---------------------------------------------------------------- cipher motif

/**
 * The "French" musical cipher (Écorcheville, Haydn centenary 1909): the alphabet is wrapped under the
 * seven note names A..G in rows (A-G, H-N, O-U, V-Z). Each letter collapses to a scale degree 0..6.
 * Used to carve the Red Queen signature motif (soggetto cavato), à la the B-A-C-H motif.
 */
export function frenchCipher(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) continue; // A..Z only
    out.push((c - 65) % 7); // note-name index 0..6 == A..G
  }
  return out;
}

/**
 * The Red Queen signature line: "REDQUEEN" through the French cipher, read in the current key.
 * Note names A..G -> degrees relative to C, then transposed into the key as a melodic cell for the
 * epoch cadence. Returns MIDI notes in the bed's upper register.
 */
export function signatureMotif(key: Key): number[] {
  // A..G note-name index -> diatonic degree of the key's own scale, so the motif stays in-key.
  const names = frenchCipher("REDQUEEN"); // R->(17%7=3)=D, E->E(4), D->D(3), Q->(16%7=2)=C, U->C(2), E, E, N->(13%7=6)=G
  // map note-name index (A=0..G=6) to a degree of the current mode by nearest scale tone of C-major
  // layout, then lift an octave for a bell-like cadence voice.
  const cMajorDeg = [5, 6, 0, 1, 2, 3, 4]; // A,B,C,D,E,F,G as degrees of a C-rooted scale
  return names.map((n) => degreeToMidi(key, cMajorDeg[n] + 7) + 12);
}

/**
 * Map a 0..1 height fraction (the cursor's height on the queen's glass, `gfx.touch.point.y / 2.5`)
 * to a MIDI note in the current key — low on her foot, high at her crown — spanning ~1.5 octaves in
 * the low-mid register. Used by the singing-glass resonance under the cursor.
 */
export function heightToNote(key: Key, heightFrac: number): number {
  const h = Math.max(0, Math.min(1, heightFrac));
  const degree = Math.round(h * 9); // 0..9 -> degree across ~1.5 octaves
  return degreeToMidi(key, degree); // sits near the tonic's own register (low-mid)
}

// ---------------------------------------------------------------- chords

/** A tiny seeded PRNG, so every random choice in the engine is reproducible offline. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pcOf = (midi: number) => ((midi % 12) + 12) % 12;

/** Pitch classes of the diatonic triad (or seventh chord) built on scale degree `deg`, root first. */
export function chordPcs(key: Key, deg: number, seventh = false): number[] {
  return (seventh ? [0, 2, 4, 6] : [0, 2, 4]).map((d) => pcOf(degreeToMidi(key, deg + d)));
}

/** True when the triad on `deg` has a diminished fifth (held under a drone, that tritone grates). */
export function isDiminished(key: Key, deg: number): boolean {
  return degreeToMidi(key, deg + 4) - degreeToMidi(key, deg) === 6;
}

/** Every MIDI note in [lo, hi] whose pitch class is in `pcs`, ascending. */
export function ladder(pcs: readonly number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(pcOf(m))) out.push(m);
  return out;
}

/** The nearest note of the key's scale strictly above `midi` (a colour tone for clever attacks). */
export function scaleStepAbove(key: Key, midi: number): number {
  for (let m = midi + 1; m < midi + 13; m++) if (key.steps.includes(pcOf(m - key.tonic))) return m;
  return midi + 2;
}

// ---------------------------------------------------------------- stereo

/** Deterministic pan (-1..1) for a caller address, loosely matching the ink jet's attack side. */
export function panForCaller(caller: string): number {
  let h = 0;
  for (let i = 2; i < caller.length; i++) h = (h * 31 + caller.charCodeAt(i)) & 0xffff;
  const a = (h / 0xffff) * Math.PI * 2;
  return Math.max(-1, Math.min(1, Math.sin(a) * 0.9));
}
