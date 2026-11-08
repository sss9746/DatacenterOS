import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
export const number = (value: number, digits = 0) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export const fraction = (value: number, total: number) => total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0;
