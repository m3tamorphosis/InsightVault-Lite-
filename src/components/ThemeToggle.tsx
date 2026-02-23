'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';

type Theme = 'system' | 'light' | 'dark';

function applyTheme(theme: Theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const saved = localStorage.getItem('theme') as Theme | null;
    if (saved === 'dark' || saved === 'light' || saved === 'system') {
      setTheme(saved);
    }
  }, []);

  const cycle = () => {
    const next: Theme =
      theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
    localStorage.setItem('theme', next);
    applyTheme(next);
  };

  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const label = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System';

  return (
    <button
      onClick={cycle}
      title={`Theme: ${label} — click to cycle`}
      className="fixed bottom-5 right-5 z-50 flex items-center gap-1.5 px-3 py-2 rounded-full text-xs transition-all duration-200 hover:opacity-80"
      style={{
        background: 'var(--bg-element-3)',
        border: '1px solid var(--border-strong)',
        color: 'var(--text-dim)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </button>
  );
}
