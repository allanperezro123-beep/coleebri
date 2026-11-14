import { useId, type CSSProperties } from 'react';

interface ColeebriLogoProps {
  size?: number;
  className?: string;
  showWordmark?: boolean;
  /** Extra classes for the wordmark block (e.g. `hidden sm:flex` to hide it on phones). */
  wordmarkClassName?: string;
}

/**
 * Geometric hummingbird + open-book emblem (`coleebri logo.svg`), adapted with React-scoped
 * gradient IDs, broken-palette dark-mode outline contrast (`--logo-ink`), and CSS wing/page motion.
 */
export function ColeebriMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  const rawId = useId();
  const gid = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const id = (name: string) => `${gid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;

  // Natural aspect ratio of #coleebri-icon crop (viewBox="208 228 608 428") is ~1.42:1.
  const width = Math.round(size * 1.42);
  const inkStroke: CSSProperties = { stroke: 'var(--logo-ink, #092E63)' };
  const inkFill: CSSProperties = { fill: 'var(--logo-ink, #092E63)' };

  return (
    <svg
      width={width}
      height={size}
      viewBox="208 228 608 428"
      xmlns="http://www.w3.org/2000/svg"
      className={`coleebri-mark shrink-0 overflow-visible ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={id('wing_L1')} x1="0%" y1="0%" x2="100%" y2="20%">
          <stop offset="0%" stopColor="#096FC4" />
          <stop offset="100%" stopColor="#0D84C1" />
        </linearGradient>
        <linearGradient id={id('wing_L2')} x1="0%" y1="0%" x2="100%" y2="20%">
          <stop offset="0%" stopColor="#0974C3" />
          <stop offset="100%" stopColor="#0E77B8" />
        </linearGradient>
        <linearGradient id={id('wing_L3')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1D4C97" />
          <stop offset="100%" stopColor="#163E82" />
        </linearGradient>

        <linearGradient id={id('wing_R1')} x1="0%" y1="20%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#14B6C4" />
          <stop offset="100%" stopColor="#0CD5D3" />
        </linearGradient>
        <linearGradient id={id('wing_R2')} x1="0%" y1="20%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#14B9C6" />
          <stop offset="100%" stopColor="#0DD7D4" />
        </linearGradient>
        <linearGradient id={id('wing_R3')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#15AFC5" />
          <stop offset="100%" stopColor="#1AB9C7" />
        </linearGradient>

        <linearGradient id={id('head_grad')} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#0E80CD" />
          <stop offset="100%" stopColor="#0ADBF5" />
        </linearGradient>
        <linearGradient id={id('neck_grad')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0991CF" />
          <stop offset="50%" stopColor="#0FD2DB" />
          <stop offset="100%" stopColor="#14E0CC" />
        </linearGradient>
        <linearGradient id={id('breast_grad')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0F98C4" />
          <stop offset="100%" stopColor="#0FC3BB" />
        </linearGradient>

        <linearGradient id={id('page_L')} x1="0%" y1="0%" x2="100%" y2="85%">
          <stop offset="0%" stopColor="#05CEEE" />
          <stop offset="55%" stopColor="#08A6DC" />
          <stop offset="100%" stopColor="#097DCB" />
        </linearGradient>
        <linearGradient id={id('page_R')} x1="0%" y1="0%" x2="100%" y2="85%">
          <stop offset="0%" stopColor="#10AEC0" />
          <stop offset="100%" stopColor="#0FD2CE" />
        </linearGradient>

        <linearGradient id={id('tail_L')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0E77B7" />
          <stop offset="100%" stopColor="#1F4D96" />
        </linearGradient>
        <linearGradient id={id('tail_C')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0C8CBC" />
          <stop offset="100%" stopColor="#0FC3B7" />
        </linearGradient>
        <linearGradient id={id('tail_R')} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0E82C4" />
          <stop offset="100%" stopColor="#12B8B9" />
        </linearGradient>
      </defs>

      <g style={inkStroke} strokeWidth="12" strokeLinejoin="round" strokeLinecap="round">
        {/* Left wing feathers */}
        <g className="coleebri-wing-l">
          <path
            className="coleebri-feather coleebri-feather-3"
            fill={url('wing_L3')}
            d="M 298,376 C 300,412 324,430 356,432 L 356,376 Z"
          />
          <path
            className="coleebri-feather coleebri-feather-2"
            fill={url('wing_L2')}
            d="M 260,316 C 266,364 300,386 356,390 L 356,326 Z"
          />
          <path
            className="coleebri-feather coleebri-feather-1"
            fill={url('wing_L1')}
            d="M 228,244 C 230,298 266,332 384,354 L 384,316 Z"
          />
        </g>

        {/* Right wing feathers */}
        <g className="coleebri-wing-r">
          <path
            className="coleebri-feather coleebri-feather-3"
            fill={url('wing_R3')}
            d="M 726,376 C 724,412 700,430 668,432 L 668,376 Z"
          />
          <path
            className="coleebri-feather coleebri-feather-2"
            fill={url('wing_R2')}
            d="M 764,316 C 758,364 724,386 668,390 L 668,326 Z"
          />
          <path
            className="coleebri-feather coleebri-feather-1"
            fill={url('wing_R1')}
            d="M 796,244 C 794,298 758,332 640,354 L 640,316 Z"
          />
        </g>

        {/* Tail */}
        <g className="coleebri-tail">
          <path
            fill={url('tail_L')}
            d="M 480,504 L 448,558 C 440,574 446,594 464,606 L 496,626 L 504,516 Z"
          />
          <path
            fill={url('tail_R')}
            d="M 544,504 L 576,558 C 584,574 578,594 560,606 L 528,626 L 520,516 Z"
          />
          <path fill={url('tail_C')} d="M 512,516 L 476,612 L 512,638 L 548,612 Z" />
        </g>

        {/* Head, beak and throat */}
        <g className="coleebri-head">
          <path
            fill={url('head_grad')}
            d="M 458,368 L 464,308 C 468,272 496,254 528,260 C 546,263 558,272 574,272 L 652,254 L 578,286 C 558,296 550,314 552,340 C 554,362 558,378 544,404 Z"
          />
          <circle cx="510" cy="290" r="10" style={inkFill} stroke="none" />
          <path
            fill={url('neck_grad')}
            d="M 480,384 C 484,334 514,296 568,282 C 550,304 548,332 556,362 C 562,386 552,424 512,462 C 492,436 480,410 480,384 Z"
          />
        </g>

        {/* Outer open-book covers */}
        <g className="coleebri-book">
          <path fill="none" d="M 356,344 L 356,472 C 412,474 464,492 506,526" />
          <path fill="none" strokeWidth="10" d="M 374,352 L 374,458 C 422,462 466,480 506,514" />
          <path fill="none" d="M 668,344 L 668,472 C 612,474 560,492 518,526" />
          <path fill="none" strokeWidth="10" d="M 650,352 L 650,458 C 602,462 558,480 518,514" />

          {/* Right page */}
          <g className="coleebri-page-r">
            <path
              fill={url('page_R')}
              d="M 556,374 L 632,332 L 632,444 C 594,450 558,468 518,504 L 518,412 C 530,396 542,384 556,374 Z"
            />
            <path
              fill="none"
              stroke="#9FF6FC"
              strokeWidth="8"
              strokeLinejoin="miter"
              d="M 623,344 L 623,437 C 592,443 562,456 532,482"
            />
            <path fill="none" d="M 556,374 L 632,332 L 632,444 C 594,450 558,468 518,504" />
          </g>

          {/* Center breast fold */}
          <path
            fill={url('breast_grad')}
            d="M 512,398 C 526,374 548,356 568,348 C 582,386 576,436 512,518 L 512,398 Z"
          />

          {/* Left page */}
          <g className="coleebri-page-l">
            <path
              fill={url('page_L')}
              d="M 392,320 L 392,444 C 436,450 474,472 512,518 L 512,398 C 482,362 440,338 392,320 Z"
            />
            <path
              fill="none"
              stroke="#9FF6FC"
              strokeWidth="8"
              strokeLinejoin="miter"
              d="M 401,332 L 401,437 C 436,443 468,460 498,494"
            />
            <path
              fill="none"
              d="M 392,320 L 392,444 C 436,450 474,472 512,518 L 512,398 C 482,362 440,338 392,320 Z"
            />
          </g>
        </g>
      </g>
    </svg>
  );
}

export function ColeebriLogo({ size = 40, className = '', showWordmark = false, wordmarkClassName = '' }: ColeebriLogoProps) {
  return (
    <span className={`coleebri-brand group inline-flex items-center gap-2.5 select-none ${className}`}>
      <ColeebriMark size={size} />
      {showWordmark && (
        <span className={`flex flex-col leading-none ${wordmarkClassName}`}>
          <span
            className="coleebri-wordmark font-editorial text-[1.35rem] font-semibold tracking-[-0.02em] sm:text-2xl"
            style={{ color: 'var(--logo-wordmark, var(--text-primary))' }}
          >
            Col<span style={{ color: 'var(--accent-primary)' }}>ee</span>bri
          </span>
          <span
            className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: 'var(--text-muted)' }}
          >
            Biblioteca abierta
          </span>
        </span>
      )}
    </span>
  );
}
