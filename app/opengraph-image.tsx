import { ImageResponse } from 'next/og';

export const alt = 'Splash working-capital network for Southeast Asia payouts';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

const colors = {
  bg: '#F6F0ED',
  ink: '#1F4452',
  slate: '#326273',
  teal: '#5C9EAD',
  gold: '#D9A441',
  surface: '#FFFFFF',
  surface2: '#FBF7F5',
  line: '#E5DCD6',
};

function Route({ left, top, width, rotate, color }: { left: number; top: number; width: number; rotate: number; color: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        display: 'flex',
        left,
        top,
        width,
        height: 6,
        borderRadius: 999,
        background: color,
        opacity: .82,
        transform: `rotate(${rotate}deg)`,
        transformOrigin: 'left center',
      }}
    />
  );
}

function CityNode({ left, top, label, accent = false }: { left: number; top: number; label: string; accent?: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        left,
        top,
        width: 126,
        gap: 14,
      }}
    >
      <div
        style={{
          display: 'flex',
          width: 72,
          height: 72,
          border: `3px solid ${colors.ink}`,
          background: accent ? colors.gold : colors.teal,
          boxShadow: `18px 18px 0 ${colors.surface}, 18px 18px 0 3px ${colors.ink}`,
          transform: 'rotate(45deg) scaleY(.58)',
        }}
      />
      <div
        style={{
          display: 'flex',
          color: colors.slate,
          fontSize: 14,
          fontWeight: 900,
          letterSpacing: 2,
          textAlign: 'center',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
    </div>
  );
}

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          position: 'relative',
          display: 'flex',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          background: colors.bg,
          color: colors.ink,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 42,
            border: `2px solid ${colors.line}`,
            background: 'rgba(255,255,255,0.38)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            display: 'flex',
            right: 34,
            bottom: 28,
            width: 620,
            height: 480,
          }}
        >
          <div
            style={{
              position: 'absolute',
              display: 'flex',
              left: 78,
              top: 68,
              width: 460,
              height: 250,
              border: `3px solid ${colors.line}`,
              background: 'rgba(255,255,255,0.42)',
              transform: 'rotate(-26deg) skewX(18deg)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              display: 'flex',
              left: 160,
              top: 146,
              width: 300,
              height: 154,
              border: `3px solid ${colors.line}`,
              transform: 'rotate(-26deg) skewX(18deg)',
            }}
          />
          <Route left={162} top={312} width={268} rotate={-30} color={colors.teal} />
          <Route left={276} top={180} width={244} rotate={22} color="rgba(50,98,115,0.42)" />
          <Route left={162} top={312} width={84} rotate={-30} color={colors.gold} />
          <CityNode left={104} top={290} label="Kuala Lumpur" accent />
          <CityNode left={310} top={174} label="Singapore" />
          <CityNode left={488} top={236} label="Manila" />
          <CityNode left={406} top={70} label="Bangkok" />
          <CityNode left={506} top={360} label="Jakarta" />
        </div>
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            width: 610,
            padding: '78px 0 0 78px',
            gap: 24,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div
              style={{
                display: 'flex',
                width: 58,
                height: 58,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 14,
                background: colors.surface,
                border: `2px solid ${colors.line}`,
                color: colors.teal,
                fontSize: 36,
                fontWeight: 900,
              }}
            >
              S
            </div>
            <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 4, textTransform: 'uppercase' }}>Splash</div>
          </div>
          <div style={{ fontSize: 23, color: colors.teal, fontWeight: 900, letterSpacing: 4, textTransform: 'uppercase' }}>
            Working-capital network
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              fontSize: 68,
              lineHeight: 1.04,
              fontWeight: 950,
              letterSpacing: '-2px',
            }}
          >
            <div style={{ display: 'flex' }}>Collect USD.</div>
            <div style={{ display: 'flex' }}>Pay Southeast Asia.</div>
            <div style={{ display: 'flex' }}>
              <div style={{ display: 'flex', width: 390, whiteSpace: 'nowrap' }}>Keep cash</div>
              <div style={{ display: 'flex', color: colors.teal, fontStyle: 'italic' }}>working.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            {['Sandbox', 'Sui testnet', 'No customer funds'].map((item) => (
              <div
                key={item}
                style={{
                  display: 'flex',
                  border: `2px solid ${colors.line}`,
                  borderRadius: 999,
                  background: colors.surface,
                  padding: '10px 16px',
                  color: colors.slate,
                  fontSize: 18,
                  fontWeight: 800,
                }}
              >
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
