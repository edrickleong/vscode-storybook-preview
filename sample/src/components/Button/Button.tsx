export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'small' | 'medium' | 'large';
  onClick?: () => void;
}

const colours = {
  primary: { background: '#2563eb', color: '#fff' },
  secondary: { background: '#e5e7eb', color: '#111827' },
  danger: { background: '#dc2626', color: '#fff' },
};

const padding = { small: '4px 10px', medium: '8px 16px', large: '12px 24px' };

export function Button({ label, variant = 'primary', size = 'medium', onClick }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...colours[variant], padding: padding[size], border: 0, borderRadius: 6, fontSize: 16 }}
    >
      {label}
    </button>
  );
}
