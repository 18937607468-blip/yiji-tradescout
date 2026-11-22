/** Lightweight, local artwork. Business data is never encoded in this decoration. */
export function BrandMark() {
  return <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M9 10c8-3 22-3 30 0M11 13c1 8 10 10 12 15m14-15c-1 8-10 10-12 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M19 32c2-2 8-2 10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <ellipse cx="24" cy="36" rx="15" ry="5" stroke="currentColor" strokeWidth="1.2" opacity=".62" />
    <ellipse cx="24" cy="36" rx="8" ry="2.5" stroke="currentColor" opacity=".7" />
    <circle cx="24" cy="27" r="2" fill="currentColor" />
    <circle cx="17" cy="15" r="1.25" fill="currentColor" opacity=".5" />
    <circle cx="28" cy="13" r="1" fill="currentColor" opacity=".65" />
  </svg>;
}

export function BrandRipples() {
  return <svg className="ts-brand-ripples" viewBox="0 0 520 180" fill="none" aria-hidden="true">
    <g transform="rotate(-9 250 90)" stroke="currentColor">
      <ellipse cx="221" cy="95" rx="45" ry="11" />
      <ellipse cx="224" cy="94" rx="88" ry="23" />
      <ellipse cx="226" cy="93" rx="135" ry="37" />
      <ellipse cx="230" cy="92" rx="184" ry="54" />
      <path d="M-4 93C19 10 437-7 479 82c41 87-460 107-483 11Z" />
    </g>
    <path d="M407 136c18-11 40-6 49 2-23 10-38 8-49-2Z" fill="currentColor" opacity=".11" />
  </svg>;
}
