import { AbsoluteFill, Img, staticFile } from 'remotion';

/** The Marketplace icon: the logo on a transparent background. */
export const Icon = () => (
  <AbsoluteFill>
    <Img src={staticFile('logo.svg')} style={{ width: '100%', height: '100%' }} />
  </AbsoluteFill>
);
