import { useId } from 'react';

interface ColeebriLogoProps {
  size?: number;
  className?: string;
  showWordmark?: boolean;
  /** Extra classes for the wordmark block (e.g. `hidden sm:flex` to hide it on phones). */
  wordmarkClassName?: string;
}

export function ColeebriLogo({
  size = 40,
  className = '',
  showWordmark = false,
  wordmarkClassName = ''
}: ColeebriLogoProps) {
  // Unique gradient ids: the logo is rendered more than once (header + hero)
  const uid = useId().replace(/:/g, '');
  const cobalt = `upnCobalt-${uid}`;
  const wing = `upnWing-${uid}`;
  return (
    <span className={`group inline-flex items-center gap-2.5 select-none ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0 transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-105 group-hover:-rotate-3"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={cobalt} x1="16" y1="14" x2="104" y2="106" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#2575F0" />
            <stop offset="55%" stopColor="#1758C4" />
            <stop offset="100%" stopColor="#0E3E94" />
          </linearGradient>
          <linearGradient id={wing} x1="50" y1="20" x2="96" y2="68" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#3B93FA" />
            <stop offset="100%" stopColor="#1A62D6" />
          </linearGradient>
        </defs>

        {/* Medallón circular inspirado en el colibrí emblemático UPN Colombia */}
        <circle
          cx="60"
          cy="60"
          r="54"
          fill="var(--bg-card)"
          stroke={`url(#${cobalt})`}
          strokeWidth="6.5"
        />

        {/* Cresta superior y ala elevada (curva P del emblema) */}
        <path
          d="M21 34C36 20 62 15 84 26C95 32 103 44 102 58C94 50 83 45 70 46C61 47 55 54 47 52C37 50 28 42 21 34Z"
          fill={`url(#${wing})`}
          className="origin-[65px_42px] transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:-translate-y-0.5 group-hover:rotate-2"
        />

        {/* Contorno bajo el pico */}
        <path
          d="M17 43C25 48 34 55 41 62C33 73 27 86 29 97C18 87 13 69 17 43Z"
          fill={`url(#${cobalt})`}
        />

        {/* Pecho / cuerpo vertical central (trazo U) */}
        <path
          d="M46 61C51 57 57 59 59 66C61 76 58 92 50 101C41 96 38 74 46 61Z"
          fill={`url(#${cobalt})`}
        />

        {/* Cola y plumaje inferior derecho (trazo N) */}
        <path
          d="M64 53C78 51 91 57 101 67C98 85 84 100 65 103C72 91 75 78 72 67C69 60 66 57 64 53Z"
          fill={`url(#${cobalt})`}
          className="origin-[76px_74px] transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:rotate-[-2deg]"
        />

        {/* Ojo del colibrí */}
        <circle cx="48" cy="40" r="4.2" fill="#0E3E94" />
        <circle cx="46.8" cy="38.8" r="1.4" fill="#FAF9F6" />

        {/* Destello iridiscente esmeralda característico del colibrí */}
        <path
          d="M58 29C71 26 83 31 91 40"
          stroke="#2E9B80"
          strokeWidth="3.2"
          strokeLinecap="round"
          className="opacity-80 transition-opacity duration-300 group-hover:opacity-100"
        />
      </svg>

      {showWordmark && (
        <span className={`flex flex-col leading-none ${wordmarkClassName}`}>
          <span className="font-editorial text-xl font-bold tracking-tight sm:text-2xl">
            col<span style={{ color: 'var(--accent-primary)' }}>ee</span>bri
          </span>
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: 'var(--text-muted)' }}
          >
            Biblioteca Abierta
          </span>
        </span>
      )}
    </span>
  );
}
