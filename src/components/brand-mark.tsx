import './brand-mark.css';

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand-lockup${compact ? ' brand-lockup-compact' : ''}`} aria-label="RILL media downloader">
      <span className="brand-symbol" aria-hidden="true">
        <span className="brand-signal" />
        <span className="brand-arrow" />
        <span className="brand-tray" />
      </span>
      <span className="brand-name" aria-hidden="true">RILL</span>
      <span className="brand-caption" aria-hidden="true">
        media<br />transfer
      </span>
    </div>
  );
}
