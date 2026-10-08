import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Eye, EyeOff, LockKeyhole, Mail, UserRound } from "lucide-react";
import { ApiRequestError, apiRequest, setToken, supportEmail, type User } from "./api";
import Brand from "./Brand";

type AuthResponse = { token: string; user: User };
type AuthMode = "login" | "register" | "verify" | "forgot" | "reset";
type GoogleButtonText = "continue_with" | "signup_with";
type GoogleIdentityApi = {
  initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void;
  renderButton: (element: HTMLElement, options: { theme: "outline"; size: "large"; text: GoogleButtonText; shape: "rect"; width: number }) => void;
};

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentityApi } };
  }
}

export default function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const params = new URLSearchParams(window.location.search);
  const initialResetToken = params.get("token") ?? params.get("resetToken") ?? "";
  const initialVerificationEmail = params.get("verifyEmail") ?? "";
  const [mode, setMode] = useState<AuthMode>(initialResetToken ? "reset" : initialVerificationEmail ? "verify" : "login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(initialVerificationEmail);
  const [identifier, setIdentifier] = useState("");
  const [grade, setGrade] = useState("");
  const [username, setUsername] = useState("");
  const [usernameStatus, setUsernameStatus] = useState("");
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [usernameSuggestions, setUsernameSuggestions] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [resetToken, setResetToken] = useState(initialResetToken);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleLoadError, setGoogleLoadError] = useState("");
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? "";
  const googleCallbackRef = useRef<(credential: string) => void>(() => undefined);

  googleCallbackRef.current = (credential) => {
    void authenticateWithGoogle(credential);
  };

  useEffect(() => {
    if (!googleClientId || !googleButtonRef.current || (mode !== "login" && mode !== "register")) return;
    let cancelled = false;
    const renderButton = () => {
      if (cancelled || !window.google || !googleButtonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: ({ credential }) => googleCallbackRef.current(credential),
      });
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "outline",
        size: "large",
        text: mode === "register" ? "signup_with" : "continue_with",
        shape: "rect",
        width: Math.min(380, Math.max(280, googleButtonRef.current.clientWidth)),
      });
    };
    let script = document.querySelector<HTMLScriptElement>("#google-identity-script");
    if (window.google) {
      renderButton();
    } else {
      if (!script) {
        script = document.createElement("script");
        script.id = "google-identity-script";
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", renderButton);
      script.addEventListener("error", () => setGoogleLoadError("Google sign-in could not load. Check your connection and try again."));
    }
    return () => {
      cancelled = true;
      script?.removeEventListener("load", renderButton);
    };
  }, [googleClientId, mode]);

  async function checkUsernameAvailability() {
    setUsernameStatus("");
    setUsernameSuggestions([]);
    setUsernameAvailable(null);
    if (mode !== "register" || name.trim().length < 2 || username.trim().length < 3) return;
    try {
      const result = await apiRequest<{ available: boolean; message: string; suggestions: string[] }>("/api/auth/check-username", {
        method: "POST",
        body: JSON.stringify({ name, username }),
      });
      setUsernameAvailable(result.available);
      setUsernameStatus(result.message);
      setUsernameSuggestions(result.suggestions);
    } catch (requestError) {
      setUsernameStatus(requestError instanceof Error ? requestError.message : "Username availability could not be checked.");
    }
  }

  async function authenticateWithGoogle(credential: string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await apiRequest<AuthResponse>("/api/auth/google", {
        method: "POST",
        body: JSON.stringify({
          credential,
          intent: mode === "register" ? "register" : "login",
          ...(mode === "register" ? { grade, username } : {}),
        }),
      });
      setToken(response.token);
      onAuthenticated(response.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Google sign-in could not be completed.");
      setUsernameSuggestions(requestError instanceof ApiRequestError ? requestError.suggestions : []);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if ((mode === "register" || mode === "reset") && password !== passwordConfirmation) {
      setError("The passwords do not match. Please check both fields.");
      return;
    }
    if (mode === "register" && usernameAvailable === false) {
      setError("That username is already taken. Choose one of the suggested usernames.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "forgot") {
        const response = await apiRequest<{ message: string }>("/api/auth/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        setNotice(response.message);
        return;
      }
      if (mode === "verify") {
        const response = await apiRequest<{ message: string }>("/api/auth/verify-email", {
          method: "POST",
          body: JSON.stringify({ email, code: verificationCode }),
        });
        setMode("login");
        setPassword("");
        setVerificationCode("");
        setNotice(response.message);
        return;
      }
      if (mode === "reset") {
        const response = await apiRequest<{ message: string }>("/api/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({ token: resetToken, password, passwordConfirmation }),
        });
        window.history.replaceState({}, "", import.meta.env.BASE_URL);
        setPassword("");
        setPasswordConfirmation("");
        setResetToken("");
        setMode("login");
        setNotice(response.message);
        return;
      }
      if (mode === "register") {
        const response = await apiRequest<{ message: string }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ name, email, grade, username, password, passwordConfirmation }),
        });
        setMode("verify");
        setEmail(email);
        setPassword("");
        setPasswordConfirmation("");
        setVerificationCode("");
        setNotice(response.message);
        return;
      }
      const response = await apiRequest<AuthResponse>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ identifier, password }),
        },
      );
      setToken(response.token);
      onAuthenticated(response.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The request could not be completed.");
      setUsernameSuggestions(requestError instanceof ApiRequestError ? requestError.suggestions : []);
    } finally {
      setBusy(false);
    }
  }

  async function resendVerificationCode() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await apiRequest<{ message: string }>("/api/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setNotice(response.message);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "A new verification code could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-art">
        <Brand className="auth-brand" />
        <div className="auth-art-copy">
          <span className="section-kicker">YOUR LEARNING JOURNEY</span>
          <img className="auth-full-logo" src={`${import.meta.env.BASE_URL}vortex-learning-logo.png`} alt="VORTEX LEARNING emblem" />
          <h1>Big ideas<br />start <em>here.</em></h1>
          <p>A friendly space to learn, practise, and grow — one step at a time.</p>
          <div className="auth-illustration"><BookOpen size={72} strokeWidth={1.2} /><span>✳</span></div>
        </div>
        <div className="auth-art-footer">Kenya CBC · Made for curious minds</div>
      </section>
      <section className="auth-main">
        <div className="auth-form-wrap">
          <div className="auth-mobile-brand"><Brand /></div>
          <span className="section-kicker">{mode === "login" ? "WELCOME BACK" : mode === "register" ? "JOIN YOUR LEARNING SPACE" : mode === "verify" ? "EMAIL VERIFICATION" : mode === "forgot" ? "ACCOUNT RECOVERY" : "CHOOSE A NEW PASSWORD"}</span>
          <h2>{mode === "login" ? "Sign in to learn" : mode === "register" ? "Create your account" : mode === "verify" ? "Verify your email" : mode === "forgot" ? "Forgot your password?" : "Reset your password"}</h2>
          <p className="auth-intro">{mode === "login" ? "Pick up where you left off." : mode === "register" ? "Create a learner account to get started." : mode === "verify" ? `Enter the 5-digit code sent to ${email}. It expires after 10 minutes. If it is not in your inbox, check Spam or Junk, then request a new code.` : mode === "forgot" ? "Enter the email on your account and we’ll send a reset link." : "Choose a new password for your account."}</p>

          {(mode === "login" || mode === "register") && <div className="auth-tabs" role="tablist" aria-label="Account access">
            <button className={mode === "login" ? "auth-tab auth-tab-active" : "auth-tab"} onClick={() => { setMode("login"); setError(""); setNotice(""); }} role="tab" aria-selected={mode === "login"}>Sign in</button>
            <button className={mode === "register" ? "auth-tab auth-tab-active" : "auth-tab"} onClick={() => { setMode("register"); setError(""); setNotice(""); }} role="tab" aria-selected={mode === "register"}>Register</button>
          </div>}

          <form className="auth-form" onSubmit={submit}>
            {mode === "register" && (
              <label className="form-label">Student name<div className="auth-input-wrap"><UserRound size={16} /><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={80} placeholder="Your name" required /></div></label>
            )}
            {mode === "login" && <label className="form-label">Email or username<div className="auth-input-wrap"><Mail size={16} /><input type="text" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" maxLength={254} placeholder="you@example.com or username" required /></div></label>}
            {(mode === "register" || mode === "verify" || mode === "forgot") && <label className="form-label">{mode === "forgot" ? "Account email" : mode === "register" ? "Student or guardian email" : "Email address"}<div className="auth-input-wrap"><Mail size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} placeholder="you@example.com" required /></div></label>}
            {mode === "register" && <label className="form-label">CBC grade<select className="auth-grade-select" value={grade} onChange={(event) => setGrade(event.target.value)} required><option value="" disabled>Choose your grade</option>{Array.from({ length: 12 }, (_, index) => <option key={index + 1}>Grade {index + 1}</option>)}</select></label>}
            {mode === "register" && <label className="form-label">Username<div className="auth-input-wrap"><UserRound size={16} /><input value={username} onChange={(event) => { setUsername(event.target.value); setUsernameAvailable(null); setUsernameStatus(""); setUsernameSuggestions([]); }} onBlur={() => void checkUsernameAvailability()} autoComplete="username" minLength={3} maxLength={30} pattern="[A-Za-z0-9._@#-]{3,30}" title="Use 3–30 characters: letters, numbers, periods, underscores, @, #, or hyphens." aria-describedby="username-format-help" placeholder="Choose a username" required /></div><span id="username-format-help" className="username-availability">Use 3–30 characters: letters, numbers, periods, underscores, @, #, or hyphens.</span>{usernameStatus && <span className={`username-availability ${usernameAvailable === false ? "username-taken" : usernameAvailable ? "username-available" : ""}`} role="status">{usernameStatus}</span>}{usernameSuggestions.length > 0 && <div className="username-suggestions" aria-label="Available username suggestions">{usernameSuggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => { setUsername(suggestion); setUsernameAvailable(true); setUsernameStatus("This suggested username is available."); setUsernameSuggestions([]); }}>{suggestion}</button>)}</div>}</label>}
            {mode === "verify" && <label className="form-label">5-digit verification code<div className="auth-input-wrap"><input className="verification-code-input" type="text" inputMode="numeric" pattern="[0-9]{5}" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 5))} autoComplete="one-time-code" maxLength={5} placeholder="00000" aria-label="5-digit verification code" required /></div></label>}
            {(mode === "login" || mode === "register" || mode === "reset") && <>
              <label className="form-label">{mode === "reset" ? "New password" : "Password"}<span className="auth-input-wrap"><LockKeyhole size={16} /><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? 1 : 6} maxLength={72} placeholder={mode === "login" ? "Your password" : "At least 6 characters"} required /><button className="password-toggle" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
              {(mode === "register" || mode === "reset") && <label className="form-label">Confirm password<span className="auth-input-wrap"><LockKeyhole size={16} /><input type={showConfirmation ? "text" : "password"} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} autoComplete="new-password" minLength={6} maxLength={72} placeholder="Enter the password again" required /><button className="password-toggle" type="button" onClick={() => setShowConfirmation((value) => !value)} aria-label={showConfirmation ? "Hide confirmation password" : "Show confirmation password"}>{showConfirmation ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>}
            </>}
            {mode === "register" && <p className="auth-safety">Use an email you or your parent/guardian can access. We’ll send a one-time 5-digit code here; verify it before signing in.</p>}
            {mode === "login" && <div className="auth-access-actions">
              <div className="auth-access-item"><span>Forgot your password?</span><button className="auth-action-button auth-action-reset" type="button" onClick={() => { setEmail(identifier.includes("@") ? identifier : ""); setMode("forgot"); setError(""); setNotice(""); }}>Forgot Password</button></div>
            </div>}
            {error && <div className="auth-error" role="alert">{error}</div>}
            {notice && <div className="auth-notice" role="status">{notice}</div>}
            <button className="auth-submit" type="submit" disabled={busy}>{busy ? "Please wait..." : mode === "login" ? "Sign in" : mode === "register" ? "Create learner account" : mode === "verify" ? "Verify email" : mode === "forgot" ? "Send reset link" : "Save new password"} <ArrowRight size={16} /></button>
          </form>
          {(mode === "login" || mode === "register") && <div className="auth-google-section">
            <div className="auth-divider"><span>or</span></div>
            {googleClientId ? <div ref={googleButtonRef} className="google-button-slot" /> : <button className="auth-google-unconfigured" type="button" disabled>Continue with Google · setup required</button>}
            {!googleClientId && <p className="google-setup-note">Google sign-in will be available when the site owner configures the Google OAuth client ID.</p>}
            {googleLoadError && <p className="google-setup-note" role="status">{googleLoadError}</p>}
          </div>}
          {mode === "forgot" && <div className="auth-recovery-alternative"><span>Haven't verified your email yet?</span><button className="auth-action-button auth-action-verify" type="button" onClick={() => { setMode("verify"); setError(""); setNotice(""); }}>Verify Email</button></div>}
          {mode === "verify" && <button className="auth-action-button auth-action-verify auth-resend-button" type="button" onClick={() => void resendVerificationCode()} disabled={busy}>{busy ? "Sending..." : "Resend verification code"}</button>}
          {(mode === "forgot" || mode === "reset" || mode === "verify") && <button className="forgot-link auth-back-link" type="button" onClick={() => { setMode("login"); setError(""); setNotice(""); window.history.replaceState({}, "", import.meta.env.BASE_URL); }}><ArrowLeft size={14} /> Back to sign in</button>}
          <p className="auth-help">Need help? Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a></p>
        </div>
      </section>
    </main>
  );
}
