export function Badge({ text, tone = 'info' }: { text: string; tone?: 'info' | 'success' }) {
  const background = tone === 'success' ? '#16a34a' : '#0ea5e9';
  return (
    <span style={{ background, color: '#fff', borderRadius: 999, padding: '2px 10px', fontFamily: 'sans-serif' }}>
      {text}
    </span>
  );
}
