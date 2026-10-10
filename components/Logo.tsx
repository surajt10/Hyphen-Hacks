export default function Logo({ size = 24, bleed = false, className }: { size?: number; bleed?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" className={className} aria-hidden="true" focusable="false">
      <rect width="1024" height="1024" rx={bleed ? 0 : 232} fill="#0e1220" />
      <g fill="none" stroke="#5b8ed8" strokeWidth="20" strokeLinecap="round" strokeLinejoin="round">
        <path d="M264 587L437 611L435 711L235 697Z" />
        <path d="M437 611L608 562L718 439L788 316" />
      </g>
      <g fill="#6ea8fe">
        <circle cx="264" cy="587" r="40" />
        <circle cx="235" cy="697" r="31" />
        <circle cx="435" cy="711" r="14" />
        <circle cx="437" cy="611" r="20" />
        <circle cx="608" cy="562" r="21" />
        <circle cx="718" cy="439" r="20" />
      </g>
      <path d="M788 177L818 286L927 316L818 346L788 455L758 346L649 316L758 286Z" fill="#fff" />
    </svg>
  );
}
