import type { ReactNode } from 'react';

export interface CardProps {
  heading: string;
  children?: ReactNode;
}

export function Card({ heading, children }: CardProps) {
  return (
    <section style={{ border: '1px solid #d1d5db', borderRadius: 8, padding: 16, width: 280, fontFamily: 'sans-serif' }}>
      <h3 style={{ marginTop: 0 }}>{heading}</h3>
      <div>{children}</div>
    </section>
  );
}
