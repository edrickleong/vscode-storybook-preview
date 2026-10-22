import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from '.';

export default { title: 'Design System/Badge', component: Badge } satisfies Meta<typeof Badge>;

export const Info: StoryObj<typeof Badge> = { args: { text: 'New' } };
export const Success: StoryObj<typeof Badge> = { args: { text: 'Done', tone: 'success' } };
