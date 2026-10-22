import { Composition, Still } from 'remotion';
import { DEMO_FRAMES, Demo } from './Demo';
import { Hero } from './Hero';
import { Icon } from './Icon';
import { FPS } from './theme';

export const Root = () => (
  <>
    <Composition id="Demo" component={Demo} durationInFrames={DEMO_FRAMES} fps={FPS} width={1920} height={1080} />
    <Still id="Hero" component={Hero} width={1280} height={640} />
    <Still id="Icon" component={Icon} width={256} height={256} />
  </>
);
