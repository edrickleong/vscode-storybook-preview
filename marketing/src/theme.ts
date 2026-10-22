import { loadFont } from '@remotion/google-fonts/Inter';

export const { fontFamily } = loadFont('normal', { weights: ['400', '600', '800'], subsets: ['latin'] });

export const colors = {
  bgTop: '#1B1244',
  bgBottom: '#0B0820',
  brand: '#6D5DFC',
  brandDeep: '#2A1A7A',
  accent: '#FF9A4D',
  text: '#F4F2FF',
  muted: '#B4ACE8',
};

export const FPS = 30;
