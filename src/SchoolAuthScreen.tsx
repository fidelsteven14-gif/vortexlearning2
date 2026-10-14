import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Eye, EyeOff, GraduationCap, LockKeyhole, Mail, School, ShieldCheck } from "lucide-react";
import { apiRequest, setToken, supportEmail, type User } from "./api";
import Brand from "./Brand";

type Mode = "login" | "student-lookup" | "student-confirm" | "student-register" | "teacher-register" | "verify" | "forgot" | "reset";
type LoginRole = "student" | "teacher";
type StudentDetails = { name: string; assessmentNumber: string; grade: string; stream: string; subjects: Array<{ id: string; name: string }> };
type AuthResponse = { token: string; refreshToken?: string; user: User };
type ActivationIdentity = { schoolName: string; assessmentNumber: string; guardianPhone: string };

function PasswordInput({
  value,
  onChange,
  autoComplete,
  minLength,
  maxLength,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
  maxLength: number;
  required: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return <div className="auth-input-wrap">
    <LockKeyhole size={16} />
    <input type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} minLength={minLength} maxLength={maxLength} required={required} />
    <button className="password-toggle" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible}>
      {visible ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>
  </div>;
}

function recoveryTokens() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const recoveryError = hash.get("error_code") ?? query.get("error_code") ?? hash.get("error") ?? query.get("error");
  return {
    token: query.get("token") ?? query.get("resetToken") ?? query.get("access_token") ?? hash.get("access_token") ?? "",
    refreshToken: query.get("refresh_token") ?? hash.get("refresh_token") ?? "",
    error: recoveryError ? "This password reset link could not be validated. It may have expired or already been used. Request a new link below." : "",
  };
}

export default function SchoolAuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const recovery = recoveryTokens();
  const [mode, setMode] = useState<Mode>(recovery.token ? "reset" : recovery.error ? "forgot" : "login");
  const [loginRole, setLoginRole] = useState<LoginRole>("student");
  const [schoolName, setSchoolName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [student, setStudent] = useState<StudentDetails | null>(null);
  const [studentConfirmed, setStudentConfirmed] = useState(false);
  const [activation, setActivation] = useState<ActivationIdentity | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(recovery.error);
  const [busy, setBusy] = useState(false);

  function changeMode(next: Mode) {
    setError("");
    setNotice("");
    setMode(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "login") {
        const response = await apiRequest<AuthResponse>("/api/auth/school-login", {
          method: "POST",
          body: JSON.stringify({ role: loginRole, ...(schoolName.trim() ? { schoolName } : {}), identifier, password }),
        });
        setToken(response.token, response.refreshToken);
        onAuthenticated(response.user);
        return;
      }
      if (mode === "student-lookup") {
        const identity = { schoolName: schoolName.trim(), assessmentNumber: identifier.trim(), guardianPhone: guardianPhone.trim() };
        const response = await apiRequest<{ student: StudentDetails }>("/api/onboarding/student/lookup", {
          method: "POST",
          body: JSON.stringify(identity),
        });
        setActivation(identity);
        setStudent(response.student);
        setStudentConfirmed(false);
        changeMode("student-confirm");
        return;
      }
      if (mode === "student-register") {
        if (!activation || !studentConfirmed) {
          setError("Confirm that the school details shown belong to you before continuing.");
          return;
        }
        if (password !== confirmation) {
          setError("The passwords do not match. Check both fields and try again.");
          return;
        }
        const response = await apiRequest<{ message: string; email: string }>("/api/onboarding/register-student", {
          method: "POST",
          body: JSON.stringify({ ...activation, email, password, passwordConfirmation: confirmation }),
        });
        setEmail(response.email);
        setPassword("");
        setConfirmation("");
        changeMode("verify");
        setNotice(response.message);
        return;
      }
      if (mode === "teacher-register") {
        if (password !== confirmation) {
          setError("The passwords do not match. Check both fields and try again.");
          return;
        }
        const response = await apiRequest<{ message: string; email: string }>("/api/onboarding/register-teacher", {
          method: "POST",
          body: JSON.stringify({ schoolName, activationCode, email, password, passwordConfirmation: confirmation }),
        });
        setEmail(response.email);
        setPassword("");
        setConfirmation("");
        changeMode("verify");
        setNotice(response.message);
        return;
      }
      if (mode === "verify") {
        const response = await apiRequest<{ message: string }>("/api/onboarding/verify-email", {
          method: "POST",
          body: JSON.stringify({ email, code: verificationCode }),
        });
        setStudent(null);
        setActivation(null);
        setIdentifier("");
        setPassword("");
        setVerificationCode("");
        changeMode("login");
        setNotice(response.message);
        return;
      }
      if (mode === "forgot") {
        const response = await apiRequest<{ message: string }>("/api/auth/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        setNotice(response.message);
        return;
      }
      if (mode === "reset") {
        if (password !== confirmation) {
          setError("The passwords do not match. Check both fields and try again.");
          return;
        }
        const response = await apiRequest<{ message: string }>("/api/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({
            token: recovery.token,
            refreshToken: recovery.refreshToken,
            password,
            passwordConfirmation: confirmation,
          }),
        });
        window.history.replaceState({}, "", import.meta.env.BASE_URL);
        setPassword("");
        setConfirmation("");
        changeMode("login");
        setNotice(response.message);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The request could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
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
      setError(requestError instanceof Error ? requestError.message : "A verification code could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "login" ? "Sign in to your school" :
    mode === "student-lookup" ? "Find your school record" :
      mode === "student-confirm" ? "Confirm your details" :
        mode === "student-register" ? "Activate your student account" :
          mode === "teacher-register" ? "Activate your school staff account" :
            mode === "verify" ? "Verify your email" :
              mode === "forgot" ? "Reset your password" : "Choose a new password";
  const intro = mode === "login" ? "Use the school and official details already recorded for your account." :
    mode === "student-lookup" ? "Enter your school, assessment number, and the guardian phone recorded by your class teacher." :
      mode === "student-confirm" ? "Check that the school roster has found the right learner before creating an account." :
        mode === "verify" ? `Enter the six-digit code sent to ${email}.` :
          mode === "teacher-register" ? "Enter the single-use activation code given to you by your School Administrator." :
            mode === "forgot" ? "Enter the email address on your account. If it is registered, a recovery link will be sent." :
              mode === "reset" ? "Choose a new password for your account." :
                "Set an email address and password for your school account.";

  return (
    <main className="auth-page">
      <section className="auth-art">
        <Brand className="auth-brand" />
        <div className="auth-art-copy">
          <span className="section-kicker">VORTEX LEARNING</span>
          <img className="auth-full-logo" src={`${import.meta.env.BASE_URL}vortex-learning-logo.png`} alt="Vortex Learning emblem" />
          <h1>Learning grows<br /><em>together.</em></h1>
          <p>Your school community, learning, and progress in one place.</p>
          <div className="auth-illustration"><BookOpen size={72} strokeWidth={1.2} /><span>✳</span></div>
        </div>
        <div className="auth-art-footer">Kenya CBC · A school-based learning space</div>
      </section>
      <section className="auth-main">
        <div className="auth-form-wrap">
          <div className="auth-mobile-brand"><Brand /></div>
          <span className="section-kicker">{mode === "login" ? "SCHOOL PORTAL" : mode === "verify" ? "EMAIL VERIFICATION" : "ACCOUNT ACCESS"}</span>
          <h2>{title}</h2>
          <p className="auth-intro">{intro}</p>
          {mode === "login" && <div className="auth-tabs" role="tablist" aria-label="Account type">
            <button className={loginRole === "student" ? "auth-tab auth-tab-active" : "auth-tab"} type="button" role="tab" aria-selected={loginRole === "student"} onClick={() => setLoginRole("student")}>Student</button>
            <button className={loginRole === "teacher" ? "auth-tab auth-tab-active" : "auth-tab"} type="button" role="tab" aria-selected={loginRole === "teacher"} onClick={() => setLoginRole("teacher")}>Teacher / Staff</button>
          </div>}

          {mode === "student-confirm" && student && <div className="school-student-confirm">
            <div><span>Full name</span><strong>{student.name}</strong></div>
            <div><span>Grade and stream</span><strong>{student.grade} {student.stream}</strong></div>
            <div><span>Assessment number</span><strong>{student.assessmentNumber}</strong></div>
            <div><span>Subjects</span><strong>{student.subjects.map((subject) => subject.name).join(", ")}</strong></div>
            <label><input type="checkbox" checked={studentConfirmed} onChange={(event) => setStudentConfirmed(event.target.checked)} /> These details belong to me.</label>
            <button className="primary-button" type="button" disabled={!studentConfirmed} onClick={() => changeMode("student-register")}>Continue to account setup <ArrowRight size={15} /></button>
          </div>}

          {mode !== "student-confirm" && <form className="auth-form" onSubmit={(event) => void submit(event)} autoComplete="off">
            {(mode === "student-lookup" || mode === "teacher-register" || (mode === "login" && loginRole === "student")) && <label className="form-label">School name<div className="auth-input-wrap"><School size={16} /><input value={schoolName} onChange={(event) => setSchoolName(event.target.value)} maxLength={160} autoComplete="organization" placeholder="Enter your school name" required /></div></label>}
            {mode === "login" && loginRole === "teacher" && <label className="form-label">School name <span className="optional-label">(enter Vortex Learning for the platform Super Admin)</span><div className="auth-input-wrap"><School size={16} /><input value={schoolName} onChange={(event) => setSchoolName(event.target.value)} maxLength={160} autoComplete="organization" placeholder="Enter your school name" /></div></label>}
            {mode === "login" && <label className="form-label">{loginRole === "student" ? "Assessment number" : "Registered phone number"}<div className="auth-input-wrap"><GraduationCap size={16} /><input type="text" value={identifier} onChange={(event) => setIdentifier(event.target.value)} maxLength={254} autoComplete="username" placeholder={loginRole === "student" ? "Your assessment number" : "Your registered phone number"} required /></div></label>}
            {mode === "login" && <label className="form-label">Password<PasswordInput value={password} onChange={setPassword} autoComplete="current-password" maxLength={72} required /></label>}
            {mode === "student-lookup" && <>
              <label className="form-label">Assessment number<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} maxLength={40} required /></label>
              <label className="form-label">Guardian phone number<input type="tel" value={guardianPhone} onChange={(event) => setGuardianPhone(event.target.value)} autoComplete="tel" maxLength={24} required /></label>
            </>}
            {mode === "teacher-register" && <>
              <label className="form-label">Single-use activation code<input value={activationCode} onChange={(event) => setActivationCode(event.target.value)} autoComplete="one-time-code" maxLength={16} pattern="[0-9a-fA-F]{16}" required /></label>
              <label className="form-label">Email address<div className="auth-input-wrap"><Mail size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} required /></div></label>
              <label className="form-label">Create password<PasswordInput value={password} onChange={setPassword} autoComplete="new-password" minLength={6} maxLength={72} required /></label>
              <label className="form-label">Confirm password<PasswordInput value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={6} maxLength={72} required /></label>
            </>}
            {mode === "student-register" && <>
              <label className="form-label">Email address<div className="auth-input-wrap"><Mail size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} required /></div></label>
              <label className="form-label">Create password<PasswordInput value={password} onChange={setPassword} autoComplete="new-password" minLength={6} maxLength={72} required /></label>
              <label className="form-label">Confirm password<PasswordInput value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={6} maxLength={72} required /></label>
            </>}
            {mode === "verify" && <label className="form-label">6-digit verification code<input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required /></label>}
            {mode === "forgot" && <label className="form-label">Account email<div className="auth-input-wrap"><Mail size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} required /></div></label>}
            {mode === "reset" && <>
              <label className="form-label">New password<PasswordInput value={password} onChange={setPassword} autoComplete="new-password" minLength={6} maxLength={72} required /></label>
              <label className="form-label">Confirm password<PasswordInput value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={6} maxLength={72} required /></label>
            </>}
            {mode === "login" && <button className="auth-action-button auth-action-reset" type="button" onClick={() => changeMode("forgot")}>Forgot password?</button>}
            {error && <div className="auth-error" role="alert">{error}</div>}
            {notice && <div className="auth-notice" role="status">{notice}</div>}
            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "student-lookup" ? "Find my school record" : mode === "student-register" || mode === "teacher-register" ? "Create account" : mode === "verify" ? "Verify email" : mode === "forgot" ? "Send recovery link" : "Save new password"}
              <ArrowRight size={16} />
            </button>
          </form>}

          {mode === "login" && <div className="school-auth-alternatives">
            <button type="button" onClick={() => changeMode("student-lookup")}>Activate a student account</button>
            <button type="button" onClick={() => changeMode("teacher-register")}>Activate a teacher or staff account</button>
          </div>}
          {mode === "verify" && <>
            <button className="auth-action-button auth-resend-button" type="button" onClick={() => void resendVerification()} disabled={busy}>Resend verification code</button>
            <p className="auth-intro"><ShieldCheck size={14} /> After verification, you will return here to sign in with your school details.</p>
          </>}
          {mode !== "login" && <button className="forgot-link auth-back-link" type="button" onClick={() => changeMode("login")}><ArrowLeft size={14} /> Back to sign in</button>}
          <p className="auth-help">Need help? Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a></p>
        </div>
      </section>
    </main>
  );
}
