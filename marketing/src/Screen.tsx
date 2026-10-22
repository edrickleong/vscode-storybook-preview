import type { CSSProperties, ReactNode } from 'react';
import { Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import shots from '../public/shots.json';

export type ShotName = keyof typeof shots.shots;
export type Rect = { x: number; y: number; width: number; height: number };

/** Viewport of the captured VS Code window in CSS px (screenshots are at 2× DPR). */
export const VIEW = { width: shots.viewport!.width, height: shots.viewport!.height };

export const highlight = (shot: ShotName, name: string): Rect => {
  const rect = (shots.shots[shot].highlights as Record<string, Rect | null>)[name];
  if (!rect) throw new Error(`No "${name}" highlight recorded for ${shot}`);
  return rect;
};

/** A camera position over the screenshot: a point (CSS px) to centre on, and a zoom level. */
export type Camera = { x: number; y: number; zoom: number };
export const WIDE: Camera = { x: VIEW.width / 2, y: VIEW.height / 2, zoom: 1 };

/** Frames `rect` so it fills about `fill` of the window. */
export const focus = (rect: Rect, fill = 0.72, maxZoom = 2.4): Camera => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
  zoom: Math.max(1, Math.min(maxZoom, (VIEW.width * fill) / rect.width, (VIEW.height * fill) / rect.height)),
});

const ease = Easing.bezier(0.45, 0, 0.2, 1);

/** Interpolates between cameras at the given frames. */
export const useCamera = (keys: [frame: number, camera: Camera][]): Camera => {
  const frame = useCurrentFrame();
  const at = keys.map(([f]) => f);
  const pick = (k: keyof Camera) =>
    at.length === 1 ? keys[0][1][k] : interpolate(frame, at, keys.map(([, c]) => c[k]), { easing: ease, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return { x: pick('x'), y: pick('y'), zoom: pick('zoom') };
};

/**
 * A macOS-style window showing one or more stacked screenshots (for cross-fades),
 * viewed through `camera`. Children render in screenshot (CSS px) coordinates.
 */
export const Screen = ({
  layers,
  camera,
  width,
  style,
  children,
}: {
  layers: { shot: ShotName; opacity?: number }[];
  camera: Camera;
  width: number;
  style?: CSSProperties;
  children?: ReactNode;
}) => {
  const height = (width * VIEW.height) / VIEW.width;
  const k = (width / VIEW.width) * camera.zoom;
  // Keep the camera inside the image so we never show past its edges.
  const halfW = VIEW.width / (2 * camera.zoom);
  const halfH = VIEW.height / (2 * camera.zoom);
  const cx = Math.min(Math.max(camera.x, halfW), VIEW.width - halfW);
  const cy = Math.min(Math.max(camera.y, halfH), VIEW.height - halfH);

  return (
    <div
      style={{
        width,
        height,
        borderRadius: 18,
        overflow: 'hidden',
        position: 'relative',
        background: '#181818',
        boxShadow: '0 40px 120px rgba(5, 2, 30, 0.65), 0 0 0 1px rgba(255,255,255,0.08)',
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: VIEW.width,
          height: VIEW.height,
          transformOrigin: '0 0',
          transform: `translate(${width / 2 - cx * k}px, ${height / 2 - cy * k}px) scale(${k})`,
        }}
      >
        {layers.map(({ shot, opacity = 1 }) => (
          <Img
            key={shot}
            src={staticFile(`shots/${shot}.png`)}
            style={{ position: 'absolute', inset: 0, width: VIEW.width, height: VIEW.height, opacity }}
          />
        ))}
        {children}
      </div>
    </div>
  );
};
