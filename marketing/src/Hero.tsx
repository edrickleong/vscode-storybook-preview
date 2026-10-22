import { AbsoluteFill, Img, staticFile } from 'remotion';
import { Backdrop } from './Demo';
import { Screen } from './Screen';
import { colors, fontFamily } from './theme';

/** README / social banner (1280×640, GitHub's social-preview size). */
export const Hero = () => (
  <Backdrop>
    <AbsoluteFill style={{ fontFamily, padding: '64px 0 0 64px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <Img src={staticFile('logo.svg')} style={{ width: 84, height: 84 }} />
        <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: -1.2, lineHeight: 1.05, width: 420 }}>Component Story Visualiser</div>
      </div>
      <div style={{ fontSize: 26, color: colors.muted, marginTop: 28, width: 440, lineHeight: 1.35 }}>
        Your Storybook stories, right beside your code in VS Code. They follow you as you switch files.
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 34, flexWrap: 'wrap', width: 460 }}>
        {['Auto-sync', 'CodeLens', 'Integrated browser', 'Hot reload'].map((tag) => (
          <div key={tag} style={{ fontSize: 18, padding: '8px 14px', borderRadius: 999, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)' }}>
            {tag}
          </div>
        ))}
      </div>
    </AbsoluteFill>
    <div style={{ position: 'absolute', left: 566, top: 128, transform: 'perspective(2400px) rotateY(-7deg)', transformOrigin: 'left center' }}>
      {/* Framed on the editor (with its CodeLens row) and the preview beside it. */}
      <Screen layers={[{ shot: '05-codelens-after' }]} camera={{ x: 850, y: 420, zoom: 1.2 }} width={690} />
    </div>
  </Backdrop>
);
