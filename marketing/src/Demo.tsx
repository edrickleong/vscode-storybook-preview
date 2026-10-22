import type { ReactNode } from 'react';
import {
  AbsoluteFill,
  Img,
  Series,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { Screen, WIDE, focus, highlight, useCamera, type Rect } from './Screen';
import { colors, fontFamily } from './theme';

const SCREEN_WIDTH = 1320;

// ----------------------------------------------------------------------------- building blocks

export const Backdrop = ({ children }: { children?: ReactNode }) => (
  <AbsoluteFill
    style={{
      fontFamily,
      color: colors.text,
      background: `radial-gradient(1200px 700px at 50% -10%, rgba(109,93,252,0.45), transparent 70%), linear-gradient(180deg, ${colors.bgTop}, ${colors.bgBottom})`,
    }}
  >
    {children}
  </AbsoluteFill>
);

const useEnter = (delay = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 20 });
};

/** Fades a whole scene out over its last few frames. */
const SceneFade = ({ children }: { children: ReactNode }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(frame, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], { extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const Caption = ({ title, detail }: { title: string; detail?: string }) => {
  const enter = useEnter(4);
  return (
    <div style={{ position: 'absolute', top: 48, width: '100%', textAlign: 'center', opacity: enter, transform: `translateY(${(1 - enter) * 16}px)` }}>
      <div style={{ fontSize: 50, fontWeight: 800, letterSpacing: -1 }}>{title}</div>
      {detail && <div style={{ fontSize: 26, marginTop: 10, color: colors.muted }}>{detail}</div>}
    </div>
  );
};

const Stage = ({ children }: { children: ReactNode }) => (
  <div style={{ position: 'absolute', top: 205, left: (1920 - SCREEN_WIDTH) / 2 }}>{children}</div>
);

/** A soft ring drawn around a rectangle of the screenshot. */
const Ring = ({ rect, delay = 0 }: { rect: Rect; delay?: number }) => {
  const enter = useEnter(delay);
  const pad = 6;
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x - pad,
        top: rect.y - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        borderRadius: 10,
        border: `3px solid ${colors.accent}`,
        boxShadow: `0 0 0 6px rgba(255,154,77,0.18)`,
        opacity: enter,
      }}
    />
  );
};

/** A mouse pointer gliding to (x, y) and clicking at `clickAt`. Screenshot coordinates. */
const Cursor = ({ from, to, moveAt, clickAt }: { from: [number, number]; to: [number, number]; moveAt: [number, number]; clickAt: number }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, moveAt, [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const e = 1 - Math.pow(1 - t, 3);
  const x = from[0] + (to[0] - from[0]) * e;
  const y = from[1] + (to[1] - from[1]) * e;
  const pressed = frame >= clickAt && frame < clickAt + 5;
  const ring = interpolate(frame, [clickAt, clickAt + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <>
      {frame >= clickAt && (
        <div
          style={{
            position: 'absolute',
            left: to[0] - 22,
            top: to[1] - 22,
            width: 44,
            height: 44,
            borderRadius: 22,
            border: `3px solid ${colors.accent}`,
            opacity: 1 - ring,
            transform: `scale(${0.4 + ring})`,
          }}
        />
      )}
      <svg width="22" height="30" viewBox="0 0 22 30" style={{ position: 'absolute', left: x - 2, top: y - 2, transform: `scale(${pressed ? 0.85 : 1})`, transformOrigin: '2px 2px', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.5))' }}>
        <path d="M2 2 L2 24 L8 18.5 L12 28 L16 26.3 L12 17 L20 17 Z" fill="#fff" stroke="#000" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </>
  );
};

// ----------------------------------------------------------------------------- scenes

const Intro = () => {
  const logo = useEnter(0);
  const title = useEnter(10);
  const sub = useEnter(18);
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <Img src={staticFile('logo.svg')} style={{ width: 220, height: 220, transform: `scale(${0.6 + 0.4 * logo})`, opacity: logo }} />
        <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: -2, marginTop: 40, opacity: title, transform: `translateY(${(1 - title) * 20}px)` }}>
          Component Story Visualiser
        </div>
        <div style={{ fontSize: 34, marginTop: 18, color: colors.muted, opacity: sub }}>
          Your Storybook stories, right beside your code.
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

const OpenScene = () => {
  const preview = highlight('01-open-component', 'preview');
  const camera = useCamera([
    [0, WIDE],
    [40, WIDE],
    [85, focus({ ...preview, x: preview.x - 520, width: preview.width + 520 }, 0.95, 1.5)],
    [150, focus({ ...preview, x: preview.x - 520, width: preview.width + 520 }, 0.95, 1.5)],
  ]);
  return (
    <Backdrop>
      <Caption title="Open a component. Its story opens beside it." detail="In VS Code's integrated browser, with focus still in your code." />
      <Stage>
        <Screen layers={[{ shot: '01-open-component' }]} camera={camera} width={SCREEN_WIDTH}>
          <Ring rect={preview} delay={45} />
        </Screen>
      </Stage>
    </Backdrop>
  );
};

const SwitchScene = () => {
  const frame = useCurrentFrame();
  const fade = (start: number) => interpolate(frame, [start, start + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <Backdrop>
      <Caption title="Switch files. The preview follows." detail="Same tab, swapped in place, so you never juggle browser windows." />
      <Stage>
        <Screen
          layers={[
            { shot: '01-open-component' },
            { shot: '02-switch-card', opacity: fade(35) },
            { shot: '03-switch-avatar', opacity: fade(85) },
          ]}
          camera={WIDE}
          width={SCREEN_WIDTH}
        />
      </Stage>
    </Backdrop>
  );
};

const CodeLensScene = () => {
  const frame = useCurrentFrame();
  const danger = highlight('04-codelens-before', 'dangerLens');
  // The lens row plus a couple of lines of code around it.
  const lens: Rect = { x: danger.x - 190, y: danger.y - 60, width: 390, height: 140 };
  const target: [number, number] = [danger.x + danger.width / 2, danger.y + danger.height / 2];
  const after = interpolate(frame, [96, 104], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const camera = useCamera([
    [0, WIDE],
    [30, focus(lens, 0.62, 2.6)],
    [104, focus(lens, 0.62, 2.6)],
    [135, { x: 900, y: 420, zoom: 1.35 }],
    [180, { x: 900, y: 420, zoom: 1.35 }],
  ]);
  return (
    <Backdrop>
      <Caption title="Every story, one click away." detail="CodeLens above your component lists its stories. The eye marks what's showing." />
      <Stage>
        <Screen layers={[{ shot: '04-codelens-before' }, { shot: '05-codelens-after', opacity: after }]} camera={camera} width={SCREEN_WIDTH}>
          <Cursor from={[target[0] + 170, target[1] + 150]} to={target} moveAt={[42, 84]} clickAt={90} />
        </Screen>
      </Stage>
    </Backdrop>
  );
};

const StoriesViewScene = () => {
  const stories = highlight('06-stories-view', 'stories');
  const camera = useCamera([
    [0, WIDE],
    [30, focus({ ...stories, width: stories.width + 60 }, 0.6, 2.2)],
    [95, focus({ ...stories, width: stories.width + 60 }, 0.6, 2.2)],
    [130, WIDE],
  ]);
  return (
    <Backdrop>
      <Caption title="Browse them from the Explorer, too." detail="The Stories view lists the active component's stories. Click to preview." />
      <Stage>
        <Screen layers={[{ shot: '06-stories-view' }]} camera={camera} width={SCREEN_WIDTH}>
          <Ring rect={stories} delay={30} />
        </Screen>
      </Stage>
    </Backdrop>
  );
};

const LiveEditScene = () => {
  const frame = useCurrentFrame();
  const after = interpolate(frame, [55, 63], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const camera = useCamera([
    [0, WIDE],
    [30, { x: 980, y: 380, zoom: 1.45 }],
    [120, { x: 980, y: 380, zoom: 1.45 }],
  ]);
  return (
    <Backdrop>
      <Caption title="Edit the component. Watch it update." detail="Storybook hot-reloads the preview instantly, with no refresh and no lost place." />
      <Stage>
        <Screen layers={[{ shot: '06-stories-view' }, { shot: '07-live-edit', opacity: after }]} camera={camera} width={SCREEN_WIDTH} />
      </Stage>
    </Backdrop>
  );
};

const SidebarScene = () => {
  const sidebar = highlight('08-story-view-sidebar', 'sidebar');
  const camera = useCamera([
    [0, WIDE],
    [35, focus({ ...sidebar, width: sidebar.width + 420 }, 0.9, 1.6)],
    [120, focus({ ...sidebar, width: sidebar.width + 420 }, 0.9, 1.6)],
  ]);
  return (
    <Backdrop>
      <Caption title="Prefer the side bar? Put it there." detail="Move the Story view to the Primary or Secondary Side Bar, or the Panel." />
      <Stage>
        <Screen layers={[{ shot: '08-story-view-sidebar' }]} camera={camera} width={SCREEN_WIDTH}>
          <Ring rect={sidebar} delay={35} />
        </Screen>
      </Stage>
    </Backdrop>
  );
};

const Outro = () => {
  const logo = useEnter(0);
  const text = useEnter(10);
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <Img src={staticFile('logo.svg')} style={{ width: 160, height: 160, opacity: logo, transform: `scale(${0.7 + 0.3 * logo})` }} />
        <div style={{ fontSize: 64, fontWeight: 800, marginTop: 34, opacity: text, letterSpacing: -1.5 }}>Component Story Visualiser</div>
        <div style={{ fontSize: 30, marginTop: 16, color: colors.muted, opacity: text }}>Free and open source for VS Code</div>
        <div
          style={{
            marginTop: 40,
            padding: '16px 30px',
            borderRadius: 14,
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.14)',
            fontSize: 28,
            fontFamily: 'Menlo, monospace',
            opacity: text,
          }}
        >
          github.com/edrickleong/vscode-component-story-visualiser
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

export const SCENES = [
  { component: Intro, frames: 75 },
  { component: OpenScene, frames: 150 },
  { component: SwitchScene, frames: 135 },
  { component: CodeLensScene, frames: 180 },
  { component: StoriesViewScene, frames: 140 },
  { component: LiveEditScene, frames: 120 },
  { component: SidebarScene, frames: 125 },
  { component: Outro, frames: 90 },
];

export const DEMO_FRAMES = SCENES.reduce((sum, s) => sum + s.frames, 0);

export const Demo = () => (
  <Series>
    {SCENES.map(({ component: Scene, frames }, i) => (
      <Series.Sequence key={i} durationInFrames={frames}>
        <SceneFade>
          <Scene />
        </SceneFade>
      </Series.Sequence>
    ))}
  </Series>
);
