export function Avatar({ initials, size = 48 }: { initials: string; size?: number }) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%', background: '#7c3aed', color: '#fff',
        display: 'grid', placeItems: 'center', fontFamily: 'sans-serif', fontWeight: 700,
      }}
    >
      {initials}
    </div>
  );
}
