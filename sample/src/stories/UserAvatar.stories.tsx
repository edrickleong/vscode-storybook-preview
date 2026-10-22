import type { Meta, StoryObj } from '@storybook/react-vite';
import { Avatar } from '../components/Avatar/Avatar';

// Lives away from the component: found by following the import.
const meta = { title: 'People/Avatar', component: Avatar } satisfies Meta<typeof Avatar>;
export default meta;

export const Small: StoryObj<typeof meta> = { args: { initials: 'EL', size: 32 } };
export const Large: StoryObj<typeof meta> = { args: { initials: 'EL', size: 96 } };
