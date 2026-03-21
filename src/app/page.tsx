"use client";

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2, Lock, Mail, User, UserPlus } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';

type AuthMode = 'signin' | 'signup';

type FriendlyAuthErrorOptions = {
  mode: AuthMode;
};

function getFriendlyAuthError(authError: unknown, options: FriendlyAuthErrorOptions): string {
  const fallback = options.mode === 'signup' ? 'Sign up failed.' : 'Authentication failed.';
  const raw = authError instanceof Error ? authError.message : fallback;
  const normalized = raw.toLowerCase();

  if (options.mode === 'signup' && normalized.includes('database error saving new user')) {
    return 'Supabase could not create the account. This is usually a Supabase Auth setup issue, such as a broken trigger or profile table linked to auth.users after your reset. Check your Supabase Auth triggers or remove the old signup trigger before trying again.';
  }

  if (options.mode === 'signin' && normalized.includes('invalid login credentials')) {
    return 'The email or password is incorrect. Check your credentials and try again.';
  }

  if (options.mode === 'signin' && (normalized.includes('email not confirmed') || normalized.includes('email not confirmed'))) {
    return 'Your account exists, but the email address has not been confirmed yet. Check your inbox and verify the account before signing in.';
  }

  return raw;
}


async function maybeStoreBrowserCredential(options: {
  enabled: boolean;
  email: string;
  password: string;
  name?: string;
}) {
  if (!options.enabled || typeof window === 'undefined') return;

  const PasswordCredentialCtor = (window as Window & {
    PasswordCredential?: new (data: { id: string; password: string; name?: string }) => unknown;
  }).PasswordCredential;
  const credentialsApi = (navigator as Navigator & {
    credentials?: { store?: (credential: unknown) => Promise<unknown> };
  }).credentials;

  if (!PasswordCredentialCtor || !credentialsApi?.store) return;

  try {
    const credential = new PasswordCredentialCtor({
      id: options.email,
      password: options.password,
      name: options.name,
    });
    await credentialsApi.store(credential);
  } catch {
    // Ignore unsupported browser credential-manager failures.
  }
}

function InsightVaultMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="iv-auth-g1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#2563eb" />
        </linearGradient>
        <linearGradient id="iv-auth-g2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <linearGradient id="iv-auth-g3" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect x="1" y="9" width="3.5" height="6.5" rx="1.1" fill="url(#iv-auth-g1)" />
      <rect x="6.25" y="5.5" width="3.5" height="10" rx="1.1" fill="url(#iv-auth-g2)" />
      <rect x="11.5" y="2" width="3.5" height="13.5" rx="1.1" fill="url(#iv-auth-g3)" />
    </svg>
  );
}

export default function HomePage() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabase(), []);
  const [mode, setMode] = useState<AuthMode>('signin');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const resetAuthForm = () => {
      setDisplayName('');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setRememberMe(false);
      setError(null);
      setMessage(null);
    };

    resetAuthForm();

    const handlePageShow = () => {
      resetAuthForm();
    };

    window.addEventListener('pageshow', handlePageShow);

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session) {
        router.replace('/upload');
        return;
      }
      setCheckingSession(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        router.replace('/upload');
      }
    });

    return () => {
      mounted = false;
      window.removeEventListener('pageshow', handlePageShow);
      subscription.subscription.unsubscribe();
    };
  }, [router, supabase]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!email.trim() || !password.trim()) {
      setError('Email and password are required.');
      return;
    }

    if (mode === 'signup' && !displayName.trim()) {
      setError('Display name is required for sign up.');
      return;
    }

    if (mode === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signin') {
        const normalizedEmail = email.trim();
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (signInError) throw signInError;
        await maybeStoreBrowserCredential({
          enabled: rememberMe,
          email: normalizedEmail,
          password,
          name: displayName.trim() || normalizedEmail,
        });
        router.replace('/upload');
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            display_name: displayName.trim(),
          },
        },
      });
      if (signUpError) throw signUpError;

      if (data.session) {
        router.replace('/upload');
        return;
      }

      await maybeStoreBrowserCredential({
        enabled: rememberMe,
        email: email.trim(),
        password,
        name: displayName.trim() || email.trim(),
      });
      setMessage('Account created. Check your email for a confirmation link before signing in.');
      setMode('signin');
      setDisplayName('');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
    } catch (authError) {
      console.warn('Auth error:', authError);
      setError(getFriendlyAuthError(authError, { mode }));
    } finally {
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-dim)' }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          Checking session...
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden flex items-center justify-center px-4" style={{ background: 'var(--bg-page)' }}>
      <div className="absolute inset-0 bg-grid-dots opacity-30 pointer-events-none" />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 70% 55% at 50% 25%, rgba(37,99,235,0.08) 0%, transparent 65%)' }} />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 35% 25% at 20% 20%, rgba(59,130,246,0.05) 0%, transparent 70%)' }} />

      <div className="relative z-10 grid w-full max-w-5xl lg:grid-cols-[1.15fr_0.85fr] gap-6 items-stretch">
        <section
          className="rounded-[28px] p-8 md:p-10"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.25), 0 40px 100px rgba(0,0,0,0.55)',
          }}
        >
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.3)' }}>
              <InsightVaultMark size={18} />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>InsightVault Lite</p>
              <p className="text-sm" style={{ color: 'var(--text-ghost)' }}>Secure AI analysis for CSV and PDF workflows</p>
            </div>
          </div>

          <h1 className="text-4xl md:text-5xl font-semibold leading-tight mb-4" style={{ letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
            Sign in to analyze
            <br />
            <span style={{ background: 'linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              data and documents with AI
            </span>
          </h1>

          <p className="max-w-xl text-sm md:text-base leading-relaxed mb-8" style={{ color: 'var(--text-dim)' }}>
            InsightVault Lite combines multi-step AI workflows, grounded retrieval, and external tool orchestration so users can upload CSV or PDF files, ask questions, and get structured answers they can act on.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['Multi-step workflow', 'Classify -> retrieve -> process -> generate'],
              ['Agent-style routing', 'Summary, analysis, comparison, and action flows'],
              ['External orchestration', 'Slack delivery and production-style response handling'],
            ].map(([title, body]) => (
              <div
                key={title}
                className="rounded-2xl p-4 card-hover cursor-default"
                style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)' }}
              >
                <p className="text-sm font-semibold mb-1 transition-colors duration-200" style={{ color: 'var(--text-primary)' }}>{title}</p>
                <p className="text-xs leading-relaxed transition-colors duration-200" style={{ color: 'var(--text-muted)' }}>{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section
          className="rounded-[28px] p-7 md:p-8"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.22), 0 28px 80px rgba(0,0,0,0.45)',
          }}
        >
          <div className="relative grid grid-cols-2 rounded-xl p-1 mb-6 overflow-hidden" style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)' }}>
            <div
              className="absolute top-1 bottom-1 left-1 w-[calc(50%-6px)] rounded-lg transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform"
              style={{
                background: 'rgba(59,130,246,0.14)',
                boxShadow: 'inset 0 0 0 1px rgba(59,130,246,0.18), 0 10px 26px rgba(37,99,235,0.14)',
                transform: mode === 'signin' ? 'translateX(0%) scale(1)' : 'translateX(calc(100% + 6px)) scale(1)',
              }}
            />
            <button
              type="button"
              onClick={() => { setMode('signin'); setError(null); setMessage(null); }}
              className="relative z-10 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={mode === 'signin' ? { color: '#60a5fa' } : { color: 'var(--text-dim)' }}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => { setMode('signup'); setError(null); setMessage(null); }}
              className="relative z-10 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={mode === 'signup' ? { color: '#60a5fa' } : { color: 'var(--text-dim)' }}
            >
              Sign up
            </button>
          </div>

          <div
            key={mode}
            className="will-change-transform"
            style={{
              animation: mode === 'signin'
                ? 'authPanelSlideInLeft 360ms cubic-bezier(0.22,1,0.36,1)'
                : 'authPanelSlideInRight 360ms cubic-bezier(0.22,1,0.36,1)',
            }}
          >
            <h2 className="text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              {mode === 'signin' ? 'Welcome back' : 'Create your account'}
            </h2>
            <p className="text-sm mb-6" style={{ color: 'var(--text-dim)' }}>
              {mode === 'signin' ? 'Sign in with your email and password to continue.' : 'Create an email/password account to access uploads and chat.'}
            </p>

            <form onSubmit={handleSubmit} className="space-y-4" autoComplete={mode === 'signin' ? 'on' : 'off'}>
            {mode === 'signup' && (
              <label className="block">
                <span className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-ghost)' }}>Display name</span>
                <div className="flex min-h-[56px] items-center gap-3 rounded-2xl px-4" style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)' }}>
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <User className="w-4 h-4" style={{ color: 'var(--text-faint)' }} />
                  </div>
                  <input
                    type="text"
                    value={displayName}
                    onChange={event => setDisplayName(event.target.value)}
                    className="h-6 w-full bg-transparent text-[15px] leading-none outline-none placeholder:opacity-100"
                    style={{ color: 'var(--text-secondary)' }}
                    placeholder="Your display name"
                    autoComplete="off"
                    name="signup-display-name"
                  />
                </div>
              </label>
            )}

            <label className="block">
              <span className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-ghost)' }}>Email</span>
              <div className="flex min-h-[56px] items-center gap-3 rounded-2xl px-4" style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)' }}>
                <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <Mail className="w-4 h-4" style={{ color: 'var(--text-faint)' }} />
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  className="h-6 w-full bg-transparent text-[15px] leading-none outline-none placeholder:opacity-100"
                  style={{ color: 'var(--text-secondary)' }}
                  placeholder="you@example.com"
                  autoComplete={mode === 'signin' ? 'username' : 'off'}
                  name={mode === 'signin' ? 'email' : 'signup-email'}
                />
              </div>
            </label>

            <label className="block">
              <span className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-ghost)' }}>Password</span>
              <div className="flex min-h-[56px] items-center gap-3 rounded-2xl px-4" style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)' }}>
                <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <Lock className="w-4 h-4" style={{ color: 'var(--text-faint)' }} />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  className="h-6 w-full bg-transparent text-[15px] leading-none outline-none placeholder:opacity-100"
                  style={{ color: 'var(--text-secondary)' }}
                  placeholder="Enter your password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  name={mode === 'signin' ? 'password' : 'signup-password'}
                />
              </div>
            </label>

            {mode === 'signup' && (
              <label className="block">
                <span className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-ghost)' }}>Confirm password</span>
                <div className="flex min-h-[56px] items-center gap-3 rounded-2xl px-4" style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)' }}>
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <UserPlus className="w-4 h-4" style={{ color: 'var(--text-faint)' }} />
                  </div>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={event => setConfirmPassword(event.target.value)}
                    className="h-6 w-full bg-transparent text-[15px] leading-none outline-none placeholder:opacity-100"
                    style={{ color: 'var(--text-secondary)' }}
                    placeholder="Confirm your password"
                    autoComplete="new-password"
                    name="signup-confirm-password"
                  />
                </div>
              </label>
            )}

            {mode === 'signin' && (
              <label className="inline-flex items-center gap-1.5 px-0.5 text-[12px] leading-none select-none" style={{ color: 'var(--text-dim)' }}>
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={event => setRememberMe(event.target.checked)}
                  className="h-3 w-3 rounded-[3px] border border-[var(--border-strong)] bg-transparent accent-blue-500"
                />
                <span>Remember me</span>
              </label>
            )}

            {error && (
              <div className="rounded-xl px-3 py-2.5 text-sm" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)', color: '#f87171' }}>
                {error}
              </div>
            )}

            {message && (
              <div className="rounded-xl px-3 py-2.5 text-sm" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.18)', color: '#93c5fd' }}>
                {message}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all"
              style={loading ? { background: 'var(--bg-muted)', color: 'var(--text-ghost)', border: '1px solid var(--border-strong)' } : { background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', color: '#fff', border: '1px solid rgba(59,130,246,0.4)', boxShadow: '0 0 24px rgba(37,99,235,0.35)' }}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Working...
                </>
              ) : (
                <>
                  <span>{mode === 'signin' ? 'Sign in' : 'Create account'}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
