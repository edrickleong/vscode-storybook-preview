import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from './Card';

// No explicit title: Storybook derives one from the file path.
const meta: Meta<typeof Card> = {
  component: Card,
};
export default meta;

type Story = StoryObj<typeof Card>;

export const Default: Story = { args: { heading: 'Card heading', children: 'Some card content.' } };

export const LongContent: Story = {
  name: 'With long content',
  args: { heading: 'Long card', children: 'Lorem ipsum dolor sit amet, '.repeat(8) },
};
