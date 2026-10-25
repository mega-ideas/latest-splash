import Image from 'next/image';

/* Route-level loading state: the original droplet mark riding ripple
   rings on the brand stage, with a settling progress shimmer. */
export default function Loading() {
  return (
    <div className="cin-loading" role="status" aria-label="Loading Splash">
      <div className="cin-loading-stage">
        <span className="cin-loading-ring" aria-hidden="true" />
        <span className="cin-loading-ring is-late" aria-hidden="true" />
        <Image
          src="/splash-main-icon.png"
          alt=""
          width={841}
          height={823}
          className="cin-loading-mark"
          sizes="68px"
          priority
        />
      </div>
      <strong className="cin-loading-word">Splash</strong>
      <span className="cin-loading-bar" aria-hidden="true">
        <i />
      </span>
      <small className="cin-loading-line">Preparing your desk</small>
    </div>
  );
}
