import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { z } from "npm:zod@3.24.1";
import { gradeNumber, seniorCompulsorySubjects, seniorPathways } from "../_shared/curriculum.ts";

type Role = "student" | "admin";
type Profile = {
  id: string;
  name: string;
  username: string;
  email: string;
  email_verified: boolean;
  user_code: string | null;
  role: Role;
  grade: string | null;
  curriculum_registered: boolean;
  pathway: string | null;
  active: boolean;
  last_seen_at: string | null;
  created_at: string;
};
type PublicUser = Pick<Profile, "id" | "name" | "username" | "user_code" | "role" | "grade">;
type Subject = { id: string; name: string; topic: string; icon: string; color: string; grade: string; sort_order: number };
type Lesson = { id: string; subject_id: string; content_type: "lesson" | "note"; title: string; summary: string; content: string; sort_order: number };
type Assessment = { id: string; title: string; subject_id: string; kind: string; duration_minutes: number; opens_at: string; published: boolean };
type Question = { id: string; assessment_id: string; prompt: string; options_json: string[]; correct_option: number; points: number; sort_order: number };
type Attempt = { id: string; user_id: string; assessment_id: string; status: string; started_at: string; submitted_at: string | null; score: number | null; total_points: number };
type AuthContext = { profile: Profile; token: string };
type DbResult<T> = { data: T | null; error: { message: string } | null };

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
if (!supabaseUrl || !serviceKey || !anonKey) {
  throw new Error("Supabase URL, service key, and anon/publishable key must be configured for the API function.");
}

const service = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const allowedOrigins = new Set([
  "https://fidelsteven14-gif.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);
const maxResourceBytes = 20 * 1024 * 1024;

const usernameSchema = z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9._@#-]+$/);
const passwordSchema = z.string().min(6).max(72);
const gradeSchema = z.string().regex(/^Grade (?:[1-9]|1[0-2])$/);
const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());

const checkUsernameSchema = z.object({
  name: z.string().trim().min(2).max(80),
  username: usernameSchema,
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  grade: gradeSchema,
  username: usernameSchema,
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
}).refine((input) => input.password === input.passwordConfirmation, {
  message: "Passwords do not match.",
  path: ["passwordConfirmation"],
});

const verifyEmailSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
  name: z.string().trim().min(2).max(80).optional(),
  username: usernameSchema.optional(),
  grade: gradeSchema.optional(),
}).superRefine((value, context) => {
  const registrationFields = [value.name, value.username, value.grade];
  if (registrationFields.some(Boolean) && !registrationFields.every(Boolean)) {
    context.addIssue({
      code: "custom",
      path: ["name"],
      message: "Complete all learner details to finish registration.",
    });
  }
});

const resendEmailSchema = z.object({
  email: emailSchema,
});

const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(72),
});

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20).max(1000),
});

const forgotPasswordSchema = z.object({
  email: emailSchema,
});

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(2000),
  refreshToken: z.string().min(20).max(1000),
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
}).refine((input) => input.password === input.passwordConfirmation, {
  message: "Passwords do not match.",
  path: ["passwordConfirmation"],
});

const googleAuthSchema = z.object({
  credential: z.string().min(100).max(10_000),
  intent: z.enum(["login", "register"]),
  grade: gradeSchema.optional(),
  username: usernameSchema.optional(),
}).superRefine((value, context) => {
  if (value.intent === "register" && !value.grade) context.addIssue({ code: "custom", path: ["grade"], message: "Choose a grade to register." });
  if (value.intent === "register" && !value.username) context.addIssue({ code: "custom", path: ["username"], message: "Choose a username to register." });
});

const lessonInputSchema = z.object({
  subjectId: z.string().min(1).max(80),
  type: z.enum(["lesson", "note"]),
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(3).max(500),
  content: z.string().trim().min(3).max(20_000),
});

const assessmentInputSchema = z.object({
  title: z.string().trim().min(3).max(120),
  subjectId: z.string().min(1).max(80),
  durationMinutes: z.number().int().min(1).max(240),
  opensAt: z.string().datetime(),
  kind: z.enum(["PRACTICE", "QUIZ", "EXAM"]).default("PRACTICE"),
  questions: z.array(z.object({
    prompt: z.string().trim().min(3).max(2000),
    options: z.array(z.string().trim().min(1).max(300)).min(2).max(8),
    correctOption: z.number().int().min(0).max(7),
    points: z.number().int().min(1).max(100).default(1),
  }).refine((question) => question.correctOption < question.options.length, {
    message: "The correct answer must match one of the available options.",
  })).min(1).max(100),
  publish: z.boolean().default(false),
});

const resourceInputSchema = z.object({
  subjectId: z.string().min(1).max(80),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).default(""),
  topic: z.string().trim().min(2).max(120),
  term: z.string().trim().min(1).max(40),
  category: z.enum(["revision-paper", "study-guide", "syllabus", "topic-summary", "reference-document"]),
});

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  grade: gradeSchema,
});

const curriculumRegistrationSchema = z.object({
  pathway: z.enum(["stem", "arts-sports", "social-sciences"]).nullable(),
  subjectIds: z.array(z.string().min(1).max(100)).min(1).max(30),
}).superRefine((value, context) => {
  if (new Set(value.subjectIds).size !== value.subjectIds.length) {
    context.addIssue({ code: "custom", path: ["subjectIds"], message: "Remove duplicate subjects before saving." });
  }
});

const submitAnswerSchema = z.object({
  questionId: z.string().min(1).max(80),
  selectedOption: z.number().int().min(0).max(19),
});

const updateResourceStatusSchema = z.object({
  status: z.enum(["draft", "published", "archived"]),
});

const createInvitationSchema = z.object({
  grade: gradeSchema,
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...Object.fromEntries(new Headers(headers)) },
  });
}

function empty(status = 204, headers: HeadersInit = {}): Response {
  return new Response(null, { status, headers });
}

function fail(message: string, status: number, details?: unknown): Response {
  return json({ error: message, ...(details ? { details } : {}) }, status);
}

function unwrap<T>(result: DbResult<T>): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("The database operation returned no data.");
  return result.data;
}

function publicUser(profile: Profile): PublicUser {
  return {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    user_code: profile.user_code,
    role: profile.role,
    grade: profile.grade,
  };
}

function userForClient(profile: Profile): Record<string, unknown> {
  const user = publicUser(profile);
  return { id: user.id, name: user.name, username: user.username, userCode: user.user_code, role: user.role, grade: user.grade };
}

function authClient(): SupabaseClient {
  return createClient(supabaseUrl!, anonKey!, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function profileById(id: string): Promise<Profile | null> {
  const { data, error } = await service.from("profiles").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Profile | null;
}

async function bodyJson(request: Request, maxBytes = 100 * 1024): Promise<unknown> {
  const size = Number(request.headers.get("content-length") ?? 0);
  if (size > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  try {
    return await request.json();
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function invalidBody(result: z.SafeParseError<unknown>): Response {
  return fail("Please check the information you entered.", 400, result.error.flatten().fieldErrors);
}

async function rateAllowed(request: Request, route: string, limit: number, windowSeconds: number): Promise<boolean> {
  const address = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${address}:${route}`));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { data, error } = await service.rpc("consume_api_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

async function authenticate(request: Request): Promise<AuthContext | Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return fail("Sign in to continue.", 401);
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) return fail("Your session has expired. Please sign in again.", 401);
  const profile = await profileById(data.user.id);
  if (!profile || !profile.active) return fail("This account is unavailable. Please contact your school.", 401);
  if (!profile.email_verified || !data.user.email_confirmed_at) {
    return fail("Verify your email before accessing your learning space.", 401);
  }
  return { profile, token };
}

function isAuthContext(value: AuthContext | Response): value is AuthContext {
  return !(value instanceof Response);
}

function roleFailure(context: AuthContext, roles: Role[]): Response | null {
  return roles.includes(context.profile.role) ? null : fail("You do not have permission to do that.", 403);
}

async function recordAdminAction(
  adminId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  const { error } = await service.from("admin_audit_logs").insert({
    admin_id: adminId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details_json: details,
  });
  if (error) throw new Error(error.message);
}

function randomId(): string {
  return crypto.randomUUID();
}

function suggestUsernames(name: string, unavailable: Set<string>, count = 5): string[] {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "learner";
  const suggestions: string[] = [];
  for (let attempt = 0; attempt < 60 && suggestions.length < count; attempt += 1) {
    const candidate = `${base}${crypto.getRandomValues(new Uint32Array(1))[0] % 9990 + 10}`;
    if (!unavailable.has(candidate) && !suggestions.includes(candidate)) suggestions.push(candidate);
  }
  return suggestions;
}

async function appSession(session: { access_token: string; refresh_token: string }, userId: string): Promise<Record<string, unknown>> {
  const profile = await profileById(userId);
  if (!profile || !profile.active) throw new Error("The verified account profile is unavailable. Please contact support.");
  if (!profile.email_verified) throw new Error("Verify your email before signing in. You can request a new verification code below.");
  return { token: session.access_token, refreshToken: session.refresh_token, user: userForClient(profile) };
}

async function createVerifiedStudentProfile(
  user: { id: string; email?: string },
  input: { name: string; username: string; grade: string },
): Promise<void> {
  if (!user.email) throw new Error("Verified account has no email address.");
  const { error } = await service.from("profiles").insert({
    id: user.id,
    name: input.name,
    username: input.username.toLowerCase(),
    email: user.email.toLowerCase(),
    email_verified: true,
    role: "student",
    grade: input.grade,
  });
  if (error?.code === "23505") {
    throw new Error("That email or username is already associated with another platform account.");
  }
  if (error) throw new Error(error.message);
}

async function googleProfile(credential: string): Promise<{ email: string; name: string }> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!clientId) throw new Error("GOOGLE_AUTH_NOT_CONFIGURED");
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("GOOGLE_CREDENTIAL_REJECTED");
  const claims: { aud?: string; iss?: string; email?: string; email_verified?: boolean | string; name?: string } = await response.json();
  if (
    claims.aud !== clientId
    || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "")
    || (claims.email_verified !== true && claims.email_verified !== "true")
    || !claims.email
    || !claims.name
  ) throw new Error("GOOGLE_CREDENTIAL_REJECTED");
  return { email: claims.email.toLowerCase(), name: claims.name.trim() };
}

async function authRoutes(request: Request, path: string): Promise<Response | null> {
  const limited = async (limit: number, seconds: number): Promise<boolean> =>
    await rateAllowed(request, path, limit, seconds);

  if (request.method === "POST" && path === "/api/auth/check-username") {
    if (!await limited(20, 900)) return fail("Too many username checks. Please wait and try again.", 429);
    const parsed = checkUsernameSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const normalized = parsed.data.username.toLowerCase();
    const { data, error } = await service.from("profiles").select("username").eq("username", normalized).limit(1);
    if (error) throw new Error(error.message);
    const unavailable = new Set((data as Array<{ username: string }>).map((row) => row.username.toLowerCase()));
    if (unavailable.has(normalized)) {
      return json({
        available: false,
        message: "That username is already taken. Choose one of these available options:",
        suggestions: suggestUsernames(parsed.data.name, unavailable),
      });
    }
    return json({ available: true, message: "This username is available.", suggestions: [] });
  }

  if (request.method === "POST" && path === "/api/auth/register") {
    if (!await limited(10, 900)) return fail("Too many registration attempts. Please wait and try again.", 429);
    const parsed = registerSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const input = parsed.data;
    const { data: emailCollision, error: emailError } = await service.from("profiles").select("id")
      .eq("email", input.email).maybeSingle();
    if (emailError) throw new Error(emailError.message);
    if (emailCollision) {
      return fail("That email address is already registered. Try signing in or recovering the account.", 409);
    }
    const { data: usernameCollision, error: usernameError } = await service.from("profiles").select("username")
      .eq("username", input.username.toLowerCase()).maybeSingle();
    if (usernameError) throw new Error(usernameError.message);
    if (usernameCollision) {
      const unavailable = new Set([(usernameCollision as { username: string }).username.toLowerCase()]);
      return fail("That username is already taken. Choose one of these available options:", 409, {
        suggestions: suggestUsernames(input.name, unavailable),
      });
    }
    const { data, error } = await authClient().auth.signUp({
      email: input.email,
      password: input.password,
    });
    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes("already") || message.includes("registered")) {
        return fail("That email address is already registered. Try signing in or recovering the account.", 409);
      }
      console.error("Supabase registration failed:", error.name);
      return fail("Your account could not be created or the verification email could not be sent. Please try again later.", 503);
    }
    if (!data.user) return fail("Your account could not be created. Please try again.", 503);
    return json({ message: "A verification code has been sent to your email address.", email: input.email }, 201);
  }

  if (request.method === "POST" && path === "/api/auth/verify-email") {
    if (!await limited(10, 900)) return fail("Too many verification attempts. Please wait and try again.", 429);
    const parsed = verifyEmailSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    if (parsed.data.username) {
      const { data: usernameCollision, error: usernameError } = await service.from("profiles")
        .select("id").eq("username", parsed.data.username.toLowerCase()).limit(1);
      if (usernameError) throw new Error(usernameError.message);
      if (usernameCollision?.length) {
        return fail("That username has already been taken. Choose another username before verifying your email.", 409);
      }
    }
    const { data, error } = await authClient().auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.code,
      type: "signup",
    });
    if (error || !data.user) return fail("That verification code is invalid or has expired. Check it and try again, or request a new code.", 400);
    const existingProfile = await profileById(data.user.id);
    if (existingProfile) {
      const { error: profileError } = await service.from("profiles").update({ email_verified: true }).eq("id", data.user.id);
      if (profileError) throw new Error(profileError.message);
    } else {
      if (!parsed.data.name || !parsed.data.username || !parsed.data.grade) {
        return fail("Your email is verified, but registration details are missing. Please register again or contact support.", 422);
      }
      try {
        await createVerifiedStudentProfile(data.user, {
          name: parsed.data.name,
          username: parsed.data.username,
          grade: parsed.data.grade,
        });
      } catch (profileError) {
        if (profileError instanceof Error && profileError.message.includes("already associated")) {
          return fail(profileError.message, 409);
        }
        throw profileError;
      }
    }
    return json({ message: "Your email is verified. You can now sign in." });
  }

  if (request.method === "POST" && path === "/api/auth/resend-verification") {
    if (!await limited(5, 3600)) return fail("Too many verification requests. Please wait and try again.", 429);
    const parsed = resendEmailSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const { error } = await authClient().auth.resend({ type: "signup", email: parsed.data.email });
    if (error) console.error("Supabase verification resend failed:", error.name);
    return json({ message: "If this account needs verification, a new code has been sent." }, 202);
  }

  if (request.method === "POST" && path === "/api/auth/login") {
    if (!await limited(30, 900)) return fail("Too many sign-in attempts. Please wait and try again.", 429);
    const parsed = loginSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const identifier = parsed.data.identifier.trim().toLowerCase();
    const { data: row, error: profileError } = identifier.includes("@")
      ? await service.from("profiles").select("email,active,email_verified").eq("email", identifier).maybeSingle()
      : await service.from("profiles").select("email,active,email_verified").eq("username", identifier).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    const profile = row as { email: string; active: boolean; email_verified: boolean } | null;
    if (profile && !profile.active) return fail("This account is inactive. Please contact your administrator.", 403);
    if (profile && !profile.email_verified) {
      return fail("Verify your email before signing in. Enter the six-digit code we sent to your inbox.", 403);
    }
    const { data, error } = await authClient().auth.signInWithPassword({
      email: profile?.email ?? identifier,
      password: parsed.data.password,
    });
    if (error) {
      if (error.message.toLowerCase().includes("email not confirmed")) {
        return fail("Verify your email before signing in. Enter the six-digit code we sent to your inbox.", 403);
      }
      return fail("Email, username, or password is incorrect.", 401);
    }
    if (!data.session || !data.user) return fail("Email, username, or password is incorrect.", 401);
    if (!profile) {
      return fail("This verified email has no learner profile yet. Contact platform support to finish setting up the account.", 403);
    }
    const output = await appSession(data.session, data.user.id);
    await service.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", data.user.id);
    return json(output);
  }

  if (request.method === "POST" && path === "/api/auth/refresh") {
    const parsed = refreshTokenSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return fail("Your session has expired. Please sign in again.", 401);
    const { data, error } = await authClient().auth.refreshSession({ refresh_token: parsed.data.refreshToken });
    if (error || !data.session || !data.user) return fail("Your session has expired. Please sign in again.", 401);
    try {
      return json(await appSession(data.session, data.user.id));
    } catch {
      return fail("This account is unavailable. Please contact your school.", 401);
    }
  }

  if (request.method === "POST" && path === "/api/auth/google") {
    if (!await limited(20, 900)) return fail("Too many Google sign-in attempts. Please wait and try again.", 429);
    const parsed = googleAuthSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    let identity: { email: string; name: string };
    try {
      identity = await googleProfile(parsed.data.credential);
    } catch (error) {
      if (error instanceof Error && error.message === "GOOGLE_AUTH_NOT_CONFIGURED") {
        return fail("Google sign-in is not configured yet. Use email or username sign-in for now.", 503);
      }
      return fail("Google could not verify this sign-in. Please try again.", 401);
    }
    const { data: existing, error: lookupError } = await service.from("profiles").select("id,username")
      .eq("email", identity.email).maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (parsed.data.intent === "login" && !existing) {
      return fail("No active account uses this Google email. Choose Register to create a learner account.", 401);
    }
    if (parsed.data.intent === "register") {
      if (existing) return fail("An account already uses this Google email. Sign in with Google instead.", 409);
      const { data: nameCollision, error: usernameError } = await service.from("profiles").select("username")
        .eq("username", parsed.data.username!.toLowerCase()).maybeSingle();
      if (usernameError) throw new Error(usernameError.message);
      if (nameCollision) return fail("That username is already taken. Choose one of these available options:", 409, {
        suggestions: suggestUsernames(identity.name, new Set([(nameCollision as { username: string }).username.toLowerCase()])),
      });
    }
    const { data, error } = await authClient().auth.signInWithIdToken({ provider: "google", token: parsed.data.credential });
    if (error || !data.user || !data.session) {
      console.error("Supabase Google sign-in failed:", error?.name ?? "UnknownError");
      return fail("Google sign-in is temporarily unavailable. Please use email or username sign-in.", 503);
    }
    if (parsed.data.intent === "register") {
      try {
        await createVerifiedStudentProfile(data.user, {
          name: identity.name,
          username: parsed.data.username!,
          grade: parsed.data.grade!,
        });
      } catch (profileError) {
        if (profileError instanceof Error && profileError.message.includes("already associated")) {
          return fail(profileError.message, 409);
        }
        throw profileError;
      }
    } else {
      await service.from("profiles").update({ email_verified: true }).eq("id", data.user.id);
    }
    return json(await appSession(data.session, data.user.id), parsed.data.intent === "register" ? 201 : 200);
  }

  if (request.method === "POST" && path === "/api/auth/forgot-password") {
    if (!await limited(5, 3600)) return fail("Too many recovery requests. Please wait and try again.", 429);
    const parsed = forgotPasswordSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const { data: profile, error: lookupError } = await service.from("profiles").select("email,active")
      .eq("email", parsed.data.email).maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (profile && (profile as { active: boolean }).active) {
      const { error } = await authClient().auth.resetPasswordForEmail(parsed.data.email, {
        redirectTo: "https://fidelsteven14-gif.github.io/vortexlearning2/",
      });
      if (error) console.error("Supabase password recovery email failed:", error.name);
    }
    return json({ message: "If an active account uses that email, a reset link will be sent. Check your inbox and spam folder; if it does not arrive, try again later or contact support." }, 202);
  }

  if (request.method === "POST" && path === "/api/auth/reset-password") {
    if (!await limited(10, 900)) return fail("Too many password reset attempts. Please wait and try again.", 429);
    const parsed = resetPasswordSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const client = authClient();
    const { data, error } = await client.auth.setSession({
      access_token: parsed.data.token,
      refresh_token: parsed.data.refreshToken,
    });
    if (error || !data.user) return fail("This reset link is invalid or has expired. Request a new one.", 400);
    const { error: updateError } = await client.auth.updateUser({ password: parsed.data.password });
    if (updateError) return fail("The password could not be reset. Please request a new recovery email.", 400);
    return json({ message: "Your password has been reset. You can now sign in with your new password." });
  }
  return null;
}

async function studentRoutes(request: Request, path: string, url: URL): Promise<Response | null> {
  if (path === "/api/me" && request.method === "GET") {
    const auth = await authenticate(request);
    return isAuthContext(auth) ? json({ user: userForClient(auth.profile) }) : auth;
  }

  const isStudentRoute = [
    "/api/presence",
    "/api/profile",
    "/api/curriculum/registration",
    "/api/students/lookup",
    "/api/dashboard",
    "/api/exams",
    "/api/results",
  ].includes(path)
    || /^\/api\/resources\/[^/]+\/file$/.test(path)
    || /^\/api\/subjects\/[^/]+\/lessons$/.test(path)
    || /^\/api\/lessons\/[^/]+\/complete$/.test(path)
    || /^\/api\/exams\/[^/]+\/start$/.test(path)
    || /^\/api\/attempts\/[^/]+\/(answers|submit)$/.test(path);
  if (!isStudentRoute) return null;

  const auth = await authenticate(request);
  if (!isAuthContext(auth)) return auth;
  if (auth.profile.role !== "student") return fail("You do not have permission to do that.", 403);
  const user = auth.profile;

  if (path === "/api/presence" && request.method === "POST") {
    const { error } = await service.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", user.id);
    if (error) throw new Error(error.message);
    return empty();
  }

  if (path === "/api/profile" && request.method === "PATCH") {
    const parsed = updateProfileSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    if (user.curriculum_registered && user.grade !== parsed.data.grade) {
      return fail("Your grade is locked after subject registration. Contact your school administrator to change it.", 409);
    }
    const { data, error } = await service.from("profiles")
      .update({ name: parsed.data.name, grade: parsed.data.grade, pathway: user.grade === parsed.data.grade ? user.pathway : null })
      .eq("id", user.id).select("*").single();
    if (error) throw new Error(error.message);
    return json({ user: userForClient(data as Profile) });
  }

  if (path === "/api/curriculum/registration" && request.method === "GET") {
    const number = gradeNumber(user.grade);
    if (number === null) {
      return json({ grade: null, needsGrade: true, complete: false, pathway: null, subjects: [], compulsory: [], pathways: [] });
    }
    const { data: rows, error } = await service.from("subjects").select("id,name,topic,icon,color,grade,sort_order")
      .eq("grade", user.grade).order("sort_order").order("name");
    if (error) throw new Error(error.message);
    const subjects = rows as Subject[];
    const compulsory = number >= 10 ? subjects.filter((subject) => seniorCompulsorySubjects.includes(subject.name as typeof seniorCompulsorySubjects[number])) : [];
    const pathways = number >= 10 ? seniorPathways.map((pathway) => ({
      id: pathway.id,
      name: pathway.name,
      shortName: pathway.shortName,
      description: pathway.description,
      subjects: subjects.filter((subject) => pathway.subjects.includes(subject.name) && !seniorCompulsorySubjects.includes(subject.name as typeof seniorCompulsorySubjects[number])),
    })) : [];
    const { data: selected, error: registrationError } = await service.from("student_subject_registrations")
      .select("subject_id").eq("user_id", user.id);
    if (registrationError) throw new Error(registrationError.message);
    const validPathway = pathways.some((pathway) => pathway.id === user.pathway) ? user.pathway : null;
    return json({
      grade: user.grade,
      needsGrade: false,
      complete: user.curriculum_registered,
      pathway: validPathway,
      subjects: number < 10 ? subjects : [],
      compulsory,
      pathways,
      selectedSubjectIds: (selected as Array<{ subject_id: string }>).map((row) => row.subject_id),
    });
  }

  if (path === "/api/curriculum/registration" && request.method === "POST") {
    const parsed = curriculumRegistrationSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const number = gradeNumber(user.grade);
    if (number === null) return fail("We need to know your grade before we can register your subjects.", 409);
    if ((number < 10 && parsed.data.pathway !== null) || (number >= 10 && parsed.data.pathway === null)) {
      return fail(number < 10 ? "Pathways are only available to Grades 10–12." : "Choose a pathway for your Senior School grade.", 400);
    }
    const { data: rows, error } = await service.from("subjects").select("id,name").eq("grade", user.grade);
    if (error) throw new Error(error.message);
    const subjects = rows as Array<{ id: string; name: string }>;
    const pathwayNames = new Set(seniorPathways.find((pathway) => pathway.id === parsed.data.pathway)?.subjects ?? []);
    const allowed = new Set(subjects.filter((subject) => number < 10 || pathwayNames.has(subject.name)).map((subject) => subject.id));
    if (parsed.data.subjectIds.some((id) => !allowed.has(id))) {
      return fail("One or more selected subjects are not available for your grade and pathway.", 400);
    }
    const core = number >= 10
      ? subjects.filter((subject) => seniorCompulsorySubjects.includes(subject.name as typeof seniorCompulsorySubjects[number])).map((subject) => subject.id)
      : [];
    if (number >= 10 && core.length !== seniorCompulsorySubjects.length) {
      return fail("The compulsory subjects for your grade are not fully configured. Contact support.", 409);
    }
    const { error: saveError } = await service.rpc("save_curriculum_registration", {
      p_user_id: user.id,
      p_pathway: parsed.data.pathway,
      p_subject_ids: [...new Set([...core, ...parsed.data.subjectIds])],
    });
    if (saveError) throw new Error(saveError.message);
    return json({ message: "Your grade-specific subject registration has been saved." });
  }

  if (path === "/api/students/lookup" && request.method === "GET") {
    if (!await rateAllowed(request, path, 20, 60)) return fail("Too many student lookups. Please wait and try again.", 429);
    const parsed = z.string().trim().toUpperCase().regex(/^VX-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/).safeParse(url.searchParams.get("code"));
    if (!parsed.success) return fail("Enter a valid student code.", 400);
    const { data, error } = await service.from("profiles").select("user_code,name,grade")
      .eq("user_code", parsed.data).eq("role", "student").eq("active", true).maybeSingle();
    if (error) throw new Error(error.message);
    const record = data as { user_code: string; name: string; grade: string | null } | null;
    return json({ student: record ? { userCode: record.user_code, name: record.name, grade: record.grade } : null });
  }

  const resourceFile = path.match(/^\/api\/resources\/([^/]+)\/file$/);
  if (resourceFile && request.method === "GET") {
    const resourceId = decodeURIComponent(resourceFile[1]);
    const { data: registrations, error: registrationError } = await service.from("student_subject_registrations")
      .select("subject_id").eq("user_id", user.id);
    if (registrationError) throw new Error(registrationError.message);
    const subjectIds = (registrations as Array<{ subject_id: string }>).map((row) => row.subject_id);
    if (!subjectIds.length) return fail("This resource is not available for your account.", 404);
    const { data: resource, error } = await service.from("learning_resources")
      .select("storage_key,original_filename,subjects!inner(grade)")
      .eq("id", resourceId).eq("status", "published").in("subject_id", subjectIds).maybeSingle();
    if (error) throw new Error(error.message);
    const item = resource as { storage_key: string | null; original_filename: string | null; subjects: { grade: string } } | null;
    if (!item?.storage_key || item.subjects.grade !== user.grade) return fail("This resource is not available for your account.", 404);
    const { data: file, error: downloadError } = await service.storage.from("learning-resources").download(item.storage_key);
    if (downloadError || !file) return fail("The PDF file is missing. Please contact the school administrator.", 404);
    const filename = item.original_filename?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? "learning-resource.pdf";
    return new Response(await file.arrayBuffer(), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  if (path === "/api/dashboard" && request.method === "GET") {
    const { data: registrations, error: registrationError } = await service.from("student_subject_registrations")
      .select("subject_id").eq("user_id", user.id);
    if (registrationError) throw new Error(registrationError.message);
    const subjectIds = (registrations as Array<{ subject_id: string }>).map((row) => row.subject_id);
    const [subjectResult, completionResult, assessmentResult, resourceResult, attemptResult] = await Promise.all([
      subjectIds.length
        ? service.from("subjects").select("id,name,topic,icon,color,grade,sort_order").in("id", subjectIds).eq("grade", user.grade).order("sort_order")
        : Promise.resolve({ data: [], error: null }),
      service.from("user_lesson_completions").select("lesson_id,completed_at").eq("user_id", user.id),
      subjectIds.length
        ? service.from("assessments").select("id,title,kind,duration_minutes,opens_at,subject_id").in("subject_id", subjectIds).eq("published", true).gte("opens_at", new Date().toISOString()).order("opens_at").limit(20)
        : Promise.resolve({ data: [], error: null }),
      subjectIds.length
        ? service.from("learning_resources").select("id,title,description,topic,term,category,original_filename,size_bytes,subject_id").in("subject_id", subjectIds).eq("status", "published").order("title")
        : Promise.resolve({ data: [], error: null }),
      service.from("attempts").select("id,assessment_id,status,score,total_points").eq("user_id", user.id),
    ]);
    for (const result of [subjectResult, completionResult, assessmentResult, resourceResult, attemptResult]) {
      if (result.error) throw new Error(result.error.message);
    }
    const subjects = subjectResult.data as Subject[];
    const completions = completionResult.data as Array<{ lesson_id: string; completed_at: string }>;
    const assessments = assessmentResult.data as Assessment[];
    const resources = resourceResult.data as Array<{
      id: string; title: string; description: string; topic: string; term: string; category: string;
      original_filename: string | null; size_bytes: number | null; subject_id: string;
    }>;
    const attempts = attemptResult.data as Attempt[];
    const lessonResult = subjectIds.length
      ? await service.from("lessons").select("id,subject_id").in("subject_id", subjectIds)
      : { data: [], error: null };
    if (lessonResult.error) throw new Error(lessonResult.error.message);
    const lessonRows = lessonResult.data as Array<{ id: string; subject_id: string }>;
    const completeIds = new Set(completions.map((row) => row.lesson_id));
    const courses = subjects.map((subject) => {
      const lessons = lessonRows.filter((lesson) => lesson.subject_id === subject.id);
      const completed = lessons.filter((lesson) => completeIds.has(lesson.id)).length;
      return {
        id: subject.id,
        name: subject.name,
        topic: subject.topic,
        progress: lessons.length ? Math.round((completed / lessons.length) * 100) : 0,
        lessons: `${completed} of ${lessons.length} lessons`,
        completed_lessons: completed,
        total_lessons: lessons.length,
        icon: subject.icon,
        color: subject.color,
      };
    });
    const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
    const attemptByAssessment = new Map(attempts.map((attempt) => [attempt.assessment_id, attempt]));
    const upcomingExams = assessments.filter((assessment) => {
      const attempt = attemptByAssessment.get(assessment.id);
      return !attempt || attempt.status === "in_progress";
    }).slice(0, 8).map((assessment) => ({
      id: assessment.id,
      title: assessment.title,
      kind: assessment.kind,
      duration_minutes: assessment.duration_minutes,
      opens_at: assessment.opens_at,
      subject_name: subjectById.get(assessment.subject_id)?.name ?? "",
    }));
    const resourceList = resources.filter((resource) => subjectById.has(resource.subject_id)).map((resource) => ({
      id: resource.id,
      title: resource.title,
      description: resource.description,
      topic: resource.topic,
      term: resource.term,
      category: resource.category,
      filename: resource.original_filename,
      sizeBytes: resource.size_bytes ?? 0,
      subjectId: resource.subject_id,
      subjectName: subjectById.get(resource.subject_id)!.name,
      grade: subjectById.get(resource.subject_id)!.grade,
    }));
    const days = new Set(completions.map((completion) => completion.completed_at.slice(0, 10)));
    let streakDays = 0;
    const day = new Date();
    if (!days.has(day.toISOString().slice(0, 10))) day.setUTCDate(day.getUTCDate() - 1);
    while (days.has(day.toISOString().slice(0, 10))) {
      streakDays += 1;
      day.setUTCDate(day.getUTCDate() - 1);
    }
    const lessonsCompleted = courses.reduce((sum, course) => sum + course.completed_lessons, 0);
    const lessonsTotal = courses.reduce((sum, course) => sum + course.total_lessons, 0);
    return json({
      student: userForClient(user),
      curriculumRegistration: { complete: user.curriculum_registered, pathway: user.pathway, grade: user.grade },
      courses,
      upcomingExams,
      resources: resourceList,
      stats: {
        lessonsCompleted,
        lessonsTotal,
        learningProgress: lessonsTotal ? Math.round((lessonsCompleted / lessonsTotal) * 100) : 0,
        streakDays,
        completedExams: attempts.filter((attempt) => ["submitted", "marked"].includes(attempt.status)).length,
        examsInProgress: attempts.filter((attempt) => attempt.status === "in_progress").length,
      },
    });
  }

  const subjectLessons = path.match(/^\/api\/subjects\/([^/]+)\/lessons$/);
  if (subjectLessons && request.method === "GET") {
    const subjectId = decodeURIComponent(subjectLessons[1]);
    const { data: registration, error: registrationError } = await service.from("student_subject_registrations")
      .select("subject_id").eq("user_id", user.id).eq("subject_id", subjectId).maybeSingle();
    if (registrationError) throw new Error(registrationError.message);
    if (!registration || !user.grade) return fail("This learning area is not available for your account.", 404);
    const { data: subject, error: subjectError } = await service.from("subjects").select("grade")
      .eq("id", subjectId).maybeSingle();
    if (subjectError) throw new Error(subjectError.message);
    if (!subject || (subject as { grade: string }).grade !== user.grade) return fail("This learning area is not available for your account.", 404);
    const { data: lessons, error } = await service.from("lessons").select("id,content_type,title,summary,content,sort_order")
      .eq("subject_id", subjectId).order("sort_order");
    if (error) throw new Error(error.message);
    const { data: completions, error: completionError } = await service.from("user_lesson_completions")
      .select("lesson_id,completed_at").eq("user_id", user.id);
    if (completionError) throw new Error(completionError.message);
    const byLesson = new Map((completions as Array<{ lesson_id: string; completed_at: string }>).map((row) => [row.lesson_id, row.completed_at]));
    return json({
      lessons: (lessons as Lesson[]).map((lesson) => ({
        id: lesson.id,
        type: lesson.content_type,
        title: lesson.title,
        summary: lesson.summary,
        content: lesson.content,
        completed: byLesson.has(lesson.id),
        completedAt: byLesson.get(lesson.id) ?? null,
      })),
    });
  }

  const completeLesson = path.match(/^\/api\/lessons\/([^/]+)\/complete$/);
  if (completeLesson && request.method === "POST") {
    const lessonId = decodeURIComponent(completeLesson[1]);
    const { data: lesson, error } = await service.from("lessons")
      .select("id,subject_id,subjects!inner(grade)")
      .eq("id", lessonId).eq("subjects.grade", user.grade ?? "").maybeSingle();
    if (error) throw new Error(error.message);
    if (!lesson) return fail("This lesson is not available.", 404);
    const lessonRow = lesson as { id: string; subject_id: string };
    const { data: registration, error: registrationError } = await service.from("student_subject_registrations")
      .select("subject_id").eq("user_id", user.id).eq("subject_id", lessonRow.subject_id).maybeSingle();
    if (registrationError) throw new Error(registrationError.message);
    if (!registration) return fail("This lesson is not available.", 404);
    const { error: saveError } = await service.from("user_lesson_completions")
      .upsert({ user_id: user.id, lesson_id: lessonId, completed_at: new Date().toISOString() }, { onConflict: "user_id,lesson_id", ignoreDuplicates: true });
    if (saveError) throw new Error(saveError.message);
    return json({ completed: true, lessonId });
  }

  if (path === "/api/exams" && request.method === "GET") {
    const { data: registrations, error: registrationError } = await service.from("student_subject_registrations").select("subject_id").eq("user_id", user.id);
    if (registrationError) throw new Error(registrationError.message);
    const ids = (registrations as Array<{ subject_id: string }>).map((row) => row.subject_id);
    if (!ids.length) return json({ exams: [] });
    const { data: exams, error } = await service.from("assessments").select("id,title,kind,duration_minutes,opens_at,subject_id,subjects!inner(name,grade)")
      .eq("published", true).eq("subjects.grade", user.grade ?? "").in("subject_id", ids).order("opens_at");
    if (error) throw new Error(error.message);
    const { data: attempts, error: attemptError } = await service.from("attempts")
      .select("id,assessment_id,status,score,total_points").eq("user_id", user.id);
    if (attemptError) throw new Error(attemptError.message);
    const attemptMap = new Map((attempts as Array<Attempt & { assessment_id: string }>).map((attempt) => [attempt.assessment_id, attempt]));
    return json({
      exams: (exams as Array<Assessment & { subjects: { name: string } }>).map((exam) => {
        const attempt = attemptMap.get(exam.id);
        return {
          id: exam.id, title: exam.title, kind: exam.kind, duration_minutes: exam.duration_minutes,
          opens_at: exam.opens_at, subject_name: exam.subjects.name,
          attempt_id: attempt?.id ?? null, attempt_status: attempt?.status ?? null,
          score: attempt?.score ?? null, total_points: attempt?.total_points ?? null,
        };
      }),
    });
  }

  const examStart = path.match(/^\/api\/exams\/([^/]+)\/start$/);
  if (examStart && request.method === "POST") {
    const examId = decodeURIComponent(examStart[1]);
    const { data: exam, error } = await service.from("assessments").select("id,duration_minutes,opens_at,subject_id,subjects!inner(grade)")
      .eq("id", examId).eq("published", true).eq("subjects.grade", user.grade ?? "").maybeSingle();
    if (error) throw new Error(error.message);
    if (!exam) return fail("This examination is not available.", 404);
    const assessment = exam as Assessment & { subjects: { grade: string } };
    const { data: registration, error: registrationError } = await service.from("student_subject_registrations")
      .select("subject_id").eq("user_id", user.id).eq("subject_id", assessment.subject_id).maybeSingle();
    if (registrationError) throw new Error(registrationError.message);
    if (!registration) return fail("This examination is not available.", 404);
    if (new Date(assessment.opens_at).getTime() > Date.now()) return fail("This examination is not open yet.", 409);
    let { data: attempt, error: attemptError } = await service.from("attempts").select("*")
      .eq("user_id", user.id).eq("assessment_id", examId).maybeSingle();
    if (attemptError) throw new Error(attemptError.message);
    if (!attempt) {
      const { data: questions, error: questionError } = await service.from("questions").select("points").eq("assessment_id", examId);
      if (questionError) throw new Error(questionError.message);
      const totalPoints = (questions as Array<{ points: number }>).reduce((sum, question) => sum + question.points, 0);
      const now = new Date().toISOString();
      const { data: created, error: createError } = await service.from("attempts").insert({
        id: randomId(), user_id: user.id, assessment_id: examId, status: "in_progress", started_at: now, total_points: totalPoints,
      }).select("*").single();
      if (createError?.code === "23505") {
        const existingAttempt = await service.from("attempts").select("*").eq("user_id", user.id).eq("assessment_id", examId).single();
        if (existingAttempt.error) throw new Error(existingAttempt.error.message);
        attempt = existingAttempt.data;
      } else if (createError) {
        throw new Error(createError.message);
      } else {
        attempt = created;
      }
    }
    const current = attempt as Attempt;
    if (current.status !== "in_progress") return fail("This examination has already been submitted.", 409);
    const expiresAt = new Date(new Date(current.started_at).getTime() + assessment.duration_minutes * 60_000).toISOString();
    if (Date.now() > new Date(expiresAt).getTime()) {
      await service.from("attempts").update({ status: "submitted", submitted_at: new Date().toISOString() }).eq("id", current.id).eq("status", "in_progress");
      return fail("The time for this attempt has ended.", 409);
    }
    const [questionResult, answerResult] = await Promise.all([
      service.from("questions").select("id,prompt,options_json,points,sort_order").eq("assessment_id", examId).order("sort_order"),
      service.from("answers").select("question_id,selected_option").eq("attempt_id", current.id),
    ]);
    if (questionResult.error) throw new Error(questionResult.error.message);
    if (answerResult.error) throw new Error(answerResult.error.message);
    const answers = new Map((answerResult.data as Array<{ question_id: string; selected_option: number }>).map((answer) => [answer.question_id, answer.selected_option]));
    return json({
      attemptId: current.id,
      expiresAt,
      questions: (questionResult.data as Question[]).map((question) => ({
        id: question.id,
        prompt: question.prompt,
        points: question.points,
        selected_option: answers.get(question.id) ?? null,
        options: question.options_json,
      })),
    });
  }

  const answerRoute = path.match(/^\/api\/attempts\/([^/]+)\/answers$/);
  if (answerRoute && request.method === "PUT") {
    const parsed = submitAnswerSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const { data: attempt, error } = await service.from("attempts").select("id,status,started_at,assessment_id,assessments!inner(duration_minutes)")
      .eq("id", decodeURIComponent(answerRoute[1])).eq("user_id", user.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!attempt || (attempt as Attempt).status !== "in_progress") return fail("This active examination attempt was not found.", 404);
    const current = attempt as Attempt & { assessments: { duration_minutes: number } };
    if (Date.now() > new Date(current.started_at).getTime() + current.assessments.duration_minutes * 60_000) {
      await service.from("attempts").update({ status: "submitted", submitted_at: new Date().toISOString() }).eq("id", current.id).eq("status", "in_progress");
      return fail("The examination time has ended; answers can no longer be changed.", 409);
    }
    const { data: question, error: questionError } = await service.from("questions").select("options_json")
      .eq("id", parsed.data.questionId).eq("assessment_id", current.assessment_id).maybeSingle();
    if (questionError) throw new Error(questionError.message);
    if (!question) return fail("That question does not belong to this attempt.", 404);
    if (parsed.data.selectedOption >= (question as { options_json: string[] }).options_json.length) {
      return fail("Choose one of the available answer options.", 400);
    }
    const savedAt = new Date().toISOString();
    const { error: saveError } = await service.from("answers").upsert({
      attempt_id: current.id,
      question_id: parsed.data.questionId,
      selected_option: parsed.data.selectedOption,
      updated_at: savedAt,
    }, { onConflict: "attempt_id,question_id" });
    if (saveError) throw new Error(saveError.message);
    return json({ saved: true, savedAt });
  }

  const submitRoute = path.match(/^\/api\/attempts\/([^/]+)\/submit$/);
  if (submitRoute && request.method === "POST") {
    const { data: attempt, error } = await service.from("attempts").select("*")
      .eq("id", decodeURIComponent(submitRoute[1])).eq("user_id", user.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!attempt) return fail("This examination attempt was not found.", 404);
    const current = attempt as Attempt;
    if (current.status !== "in_progress") return fail("This examination has already been submitted.", 409);
    const { data: questions, error: questionError } = await service.from("questions")
      .select("id,correct_option,points").eq("assessment_id", current.assessment_id);
    if (questionError) throw new Error(questionError.message);
    const { data: answers, error: answerError } = await service.from("answers")
      .select("question_id,selected_option").eq("attempt_id", current.id);
    if (answerError) throw new Error(answerError.message);
    const chosen = new Map((answers as Array<{ question_id: string; selected_option: number }>).map((answer) => [answer.question_id, answer.selected_option]));
    const score = (questions as Array<{ id: string; correct_option: number; points: number }>)
      .reduce((sum, question) => sum + (chosen.get(question.id) === question.correct_option ? question.points : 0), 0);
    const submittedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await service.from("attempts")
      .update({ status: "submitted", submitted_at: submittedAt, score })
      .eq("id", current.id).eq("status", "in_progress").select("id").maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (!updated) return fail("This examination has already been submitted.", 409);
    return json({ submitted: true, score, totalPoints: current.total_points, submittedAt });
  }

  if (path === "/api/results" && request.method === "GET") {
    const { data: attempts, error } = await service.from("attempts").select("id,status,score,total_points,submitted_at,assessments!inner(title,subject_id,subjects!inner(name))")
      .eq("user_id", user.id).in("status", ["submitted", "marked"]).order("submitted_at", { ascending: false });
    if (error) throw new Error(error.message);
    return json({
      results: (attempts as Array<Attempt & { assessments: { title: string; subjects: { name: string } } }>).map((attempt) => ({
        attempt_id: attempt.id,
        title: attempt.assessments.title,
        subject_name: attempt.assessments.subjects.name,
        status: attempt.status,
        score: attempt.score,
        total_points: attempt.total_points,
        submitted_at: attempt.submitted_at,
      })),
    });
  }
  return null;
}

async function adminRoutes(request: Request, path: string, url: URL): Promise<Response | null> {
  const known = [
    "/api/admin/overview",
    "/api/admin/students",
    "/api/admin/audit-log",
    "/api/admin/catalog",
    "/api/admin/resources",
    "/api/admin/content",
    "/api/admin/lessons",
    "/api/admin/assessments",
    "/api/admin/invitations",
  ].includes(path)
    || /^\/api\/admin\/(students|resources|lessons|assessments)\/[^/]+(?:\/(file|status))?$/.test(path);
  if (!known) return null;
  const auth = await authenticate(request);
  if (!isAuthContext(auth)) return auth;
  const denied = roleFailure(auth, ["admin"]);
  if (denied) return denied;
  const adminId = auth.profile.id;
  const findSubject = async (id: string): Promise<Subject | null> => {
    const { data, error } = await service.from("subjects").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data as Subject | null;
  };

  if (path === "/api/admin/overview" && request.method === "GET") {
    const activeSince = new Date(Date.now() - 5 * 60_000).toISOString();
    const counts = await Promise.all([
      service.from("profiles").select("id", { count: "exact", head: true }).eq("role", "student"),
      service.from("profiles").select("id", { count: "exact", head: true }).eq("role", "student").eq("active", true).gte("last_seen_at", activeSince),
      service.from("attempts").select("id", { count: "exact", head: true }).eq("status", "in_progress"),
      service.from("attempts").select("id", { count: "exact", head: true }).in("status", ["submitted", "marked"]),
      service.from("assessments").select("id", { count: "exact", head: true }).eq("published", true),
    ]);
    const errors = counts.map((result) => result.error).filter(Boolean);
    if (errors.length) throw new Error(errors[0]!.message);
    return json({
      generatedAt: new Date().toISOString(),
      counts: {
        registeredStudents: counts[0].count ?? 0,
        activeStudents: counts[1].count ?? 0,
        examsInProgress: counts[2].count ?? 0,
        examsSubmitted: counts[3].count ?? 0,
        publishedAssessments: counts[4].count ?? 0,
      },
    });
  }

  if (path === "/api/admin/students" && request.method === "GET") {
    const { data, error } = await service.from("profiles")
      .select("id,name,username,user_code,grade,active,email_verified,created_at,last_seen_at")
      .eq("role", "student").order("created_at", { ascending: false }).order("name");
    if (error) throw new Error(error.message);
    return json({
      students: (data as Array<{
        id: string; name: string; username: string; user_code: string | null; grade: string | null;
        active: boolean; email_verified: boolean; created_at: string; last_seen_at: string | null;
      }>).map((student) => ({
        id: student.id,
        name: student.name,
        username: student.username,
        userCode: student.user_code,
        grade: student.grade,
        active: student.active,
        emailVerified: student.email_verified,
        createdAt: student.created_at,
        lastSeenAt: student.last_seen_at,
      })),
    });
  }

  const deleteStudent = path.match(/^\/api\/admin\/students\/([^/]+)$/);
  if (deleteStudent && request.method === "DELETE") {
    const id = decodeURIComponent(deleteStudent[1]);
    const { data: target, error } = await service.from("profiles").select("id,role")
      .eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!target) return fail("This learner account was not found.", 404);
    if ((target as { role: string }).role !== "student") return fail("Only student accounts can be deleted from the learner directory.", 400);
    if (id === adminId) return fail("You cannot delete the currently signed-in administrator account.", 400);
    const { error: deleteError } = await service.auth.admin.deleteUser(id);
    if (deleteError) throw new Error(deleteError.message);
    return empty();
  }

  if (path === "/api/admin/audit-log" && request.method === "GET") {
    const parsed = z.coerce.number().int().min(1).max(100).default(50).safeParse(url.searchParams.get("limit") ?? 50);
    if (!parsed.success) return fail("Audit log limit must be between 1 and 100.", 400);
    const { data, error } = await service.from("admin_audit_logs").select("*")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(parsed.data);
    if (error) throw new Error(error.message);
    const events = data as Array<{
      id: string; action: string; entity_type: string; entity_id: string;
      details_json: Record<string, unknown>; created_at: string; admin_id: string;
    }>;
    const ids = [...new Set(events.map((event) => event.admin_id))];
    const { data: profiles, error: profileError } = ids.length
      ? await service.from("profiles").select("id,name,username").in("id", ids)
      : { data: [], error: null };
    if (profileError) throw new Error(profileError.message);
    const byId = new Map((profiles as Array<{ id: string; name: string; username: string }>).map((profile) => [profile.id, profile]));
    return json({
      events: events.map((event) => ({
        id: event.id,
        action: event.action,
        entityType: event.entity_type,
        entityId: event.entity_id,
        details: event.details_json,
        createdAt: event.created_at,
        adminName: byId.get(event.admin_id)?.name ?? "",
        adminUsername: byId.get(event.admin_id)?.username ?? "",
      })),
    });
  }

  if (path === "/api/admin/catalog" && request.method === "GET") {
    const { data, error } = await service.from("subjects").select("id,name,grade,sort_order").order("grade").order("sort_order");
    if (error) throw new Error(error.message);
    return json({ subjects: data });
  }

  if (path === "/api/admin/resources" && request.method === "GET") {
    const { data, error } = await service.from("learning_resources")
      .select("id,subject_id,title,description,topic,term,category,status,original_filename,size_bytes,created_at,updated_at,subjects!inner(name,grade)")
      .order("updated_at", { ascending: false }).order("title");
    if (error) throw new Error(error.message);
    return json({
      resources: (data as Array<{
        id: string; subject_id: string; title: string; description: string; topic: string; term: string;
        category: string; status: string; original_filename: string | null; size_bytes: number | null;
        created_at: string; updated_at: string; subjects: { name: string; grade: string };
      }>).map((resource) => ({
        id: resource.id,
        subjectId: resource.subject_id,
        subjectName: resource.subjects.name,
        grade: resource.subjects.grade,
        title: resource.title,
        description: resource.description,
        topic: resource.topic,
        term: resource.term,
        category: resource.category,
        status: resource.status,
        filename: resource.original_filename,
        sizeBytes: resource.size_bytes,
        createdAt: resource.created_at,
        updatedAt: resource.updated_at,
      })),
    });
  }

  if (path === "/api/admin/resources" && request.method === "POST") {
    const parsed = resourceInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    if (!await findSubject(parsed.data.subjectId)) return fail("Choose a valid learning area.", 404);
    const id = randomId();
    const { error } = await service.from("learning_resources").insert({
      id, subject_id: parsed.data.subjectId, title: parsed.data.title, description: parsed.data.description,
      topic: parsed.data.topic, term: parsed.data.term, category: parsed.data.category, created_by: adminId,
    });
    if (error) throw new Error(error.message);
    await recordAdminAction(adminId, "resource_created", "learning_resource", id, { title: parsed.data.title });
    return json({ id, status: "draft" }, 201);
  }

  const resource = path.match(/^\/api\/admin\/resources\/([^/]+)(?:\/(file|status))?$/);
  if (resource) {
    const id = decodeURIComponent(resource[1]);
    const suffix = resource[2] ?? "";
    if (request.method === "PUT" && !suffix) {
      const parsed = resourceInputSchema.safeParse(await bodyJson(request));
      if (!parsed.success) return invalidBody(parsed);
      if (!await findSubject(parsed.data.subjectId)) return fail("Choose a valid learning area.", 404);
      const { data, error } = await service.from("learning_resources").update({
        subject_id: parsed.data.subjectId, title: parsed.data.title, description: parsed.data.description,
        topic: parsed.data.topic, term: parsed.data.term, category: parsed.data.category, updated_at: new Date().toISOString(),
      }).eq("id", id).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return fail("This learning resource was not found.", 404);
      await recordAdminAction(adminId, "resource_updated", "learning_resource", id, { title: parsed.data.title });
      return json({ updated: true });
    }

    if (request.method === "PUT" && suffix === "file") {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > maxResourceBytes) return fail("The PDF is larger than the 20 MB upload limit.", 413);
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
        return fail("Choose a non-empty PDF file to upload.", 400);
      }
      const { data: existing, error } = await service.from("learning_resources").select("storage_key")
        .eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!existing) return fail("Create a resource draft before uploading its PDF.", 404);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length) return fail("Choose a non-empty PDF file to upload.", 400);
      if (bytes.length > maxResourceBytes) return fail("The PDF is larger than the 20 MB upload limit.", 413);
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return fail("The selected file is not a valid PDF document.", 415);
      let pageCount: number;
      try {
        pageCount = (await PDFDocument.load(bytes, { throwOnInvalidObject: true })).getPageCount();
      } catch {
        return fail("The PDF appears to be corrupt or unreadable. Please choose a valid PDF.", 400);
      }
      if (pageCount < 1) return fail("The PDF must contain at least one page.", 400);
      let decoded: string;
      try {
        decoded = decodeURIComponent(request.headers.get("x-file-name") ?? "learning-resource.pdf");
      } catch {
        return fail("The selected filename is invalid.", 400);
      }
      const filename = decoded.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "learning-resource.pdf";
      if (!filename.toLowerCase().endsWith(".pdf")) return fail("Only PDF files can be uploaded.", 415);
      const random = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const storageKey = `${id}-${random}.pdf`;
      const { error: uploadError } = await service.storage.from("learning-resources").upload(storageKey, bytes, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (uploadError) throw new Error(uploadError.message);
      const { error: updateError } = await service.from("learning_resources")
        .update({ storage_key: storageKey, original_filename: filename, size_bytes: bytes.length, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (updateError) {
        await service.storage.from("learning-resources").remove([storageKey]);
        throw new Error(updateError.message);
      }
      await recordAdminAction(adminId, "resource_pdf_uploaded", "learning_resource", id, {
        filename, sizeBytes: bytes.length, pageCount,
      });
      const oldKey = (existing as { storage_key: string | null }).storage_key;
      if (oldKey) {
        const { error: cleanupError } = await service.storage.from("learning-resources").remove([oldKey]);
        if (cleanupError) {
          console.error("Old resource PDF cleanup failed:", cleanupError.name);
          return fail("The new PDF was uploaded, but the previous file could not be removed. Contact platform support.", 500);
        }
      }
      return json({ uploaded: true, filename, sizeBytes: bytes.length, pageCount });
    }

    if (request.method === "GET" && suffix === "file") {
      const { data: item, error } = await service.from("learning_resources")
        .select("storage_key,original_filename").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      const fileRow = item as { storage_key: string | null; original_filename: string | null } | null;
      if (!fileRow?.storage_key || !fileRow.original_filename) return fail("Upload a PDF to preview this resource.", 404);
      const { data: file, error: downloadError } = await service.storage.from("learning-resources").download(fileRow.storage_key);
      if (downloadError || !file) return fail("The stored PDF is missing. Upload the file again before sharing this resource.", 404);
      return new Response(await file.arrayBuffer(), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${fileRow.original_filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    }

    if (request.method === "PATCH" && suffix === "status") {
      const parsed = updateResourceStatusSchema.safeParse(await bodyJson(request));
      if (!parsed.success) return invalidBody(parsed);
      const { data: item, error } = await service.from("learning_resources").select("storage_key")
        .eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!item) return fail("This learning resource was not found.", 404);
      if (parsed.data.status === "published" && !(item as { storage_key: string | null }).storage_key) {
        return fail("Upload and preview a valid PDF before publishing this resource.", 409);
      }
      const { error: updateError } = await service.from("learning_resources")
        .update({ status: parsed.data.status, updated_at: new Date().toISOString() }).eq("id", id);
      if (updateError) throw new Error(updateError.message);
      await recordAdminAction(adminId, `resource_${parsed.data.status}`, "learning_resource", id);
      return json({ status: parsed.data.status });
    }

    if (request.method === "DELETE" && !suffix) {
      const { data: item, error } = await service.from("learning_resources").select("storage_key")
        .eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!item) return fail("This learning resource was not found.", 404);
      const storageKey = (item as { storage_key: string | null }).storage_key;
      const { error: deleteError } = await service.from("learning_resources").delete().eq("id", id);
      if (deleteError) throw new Error(deleteError.message);
      await recordAdminAction(adminId, "resource_deleted", "learning_resource", id);
      if (storageKey) {
        const { error: storageError } = await service.storage.from("learning-resources").remove([storageKey]);
        if (storageError) {
          console.error("Deleted resource PDF cleanup failed:", storageError.name);
          return fail("The resource was deleted, but its stored PDF could not be removed. Contact platform support.", 500);
        }
      }
      return empty();
    }
  }

  if (path === "/api/admin/content" && request.method === "GET") {
    const [lessonResult, assessmentResult] = await Promise.all([
      service.from("lessons").select("id,subject_id,content_type,title,summary,content,subjects!inner(name,grade,sort_order)")
        .order("title"),
      service.from("assessments").select("id,title,subject_id,kind,duration_minutes,opens_at,published,subjects!inner(name,grade,sort_order)")
        .order("opens_at", { ascending: false }),
    ]);
    if (lessonResult.error) throw new Error(lessonResult.error.message);
    if (assessmentResult.error) throw new Error(assessmentResult.error.message);
    const assessments = assessmentResult.data as Array<Assessment & { subjects: { name: string; grade: string }; id: string }>;
    const ids = assessments.map((assessment) => assessment.id);
    const [questionResult, attemptResult] = ids.length
      ? await Promise.all([
        service.from("questions").select("assessment_id,prompt,options_json,correct_option,points,sort_order").in("assessment_id", ids).order("sort_order"),
        service.from("attempts").select("assessment_id").in("assessment_id", ids),
      ])
      : [{ data: [], error: null }, { data: [], error: null }];
    if (questionResult.error) throw new Error(questionResult.error.message);
    if (attemptResult.error) throw new Error(attemptResult.error.message);
    const questions = questionResult.data as Array<Question & { assessment_id: string }>;
    const attemptCounts = new Map<string, number>();
    for (const attempt of attemptResult.data as Array<{ assessment_id: string }>) {
      attemptCounts.set(attempt.assessment_id, (attemptCounts.get(attempt.assessment_id) ?? 0) + 1);
    }
    return json({
      lessons: (lessonResult.data as Array<Lesson & { subjects: { name: string; grade: string } }>).map((lesson) => ({
        id: lesson.id,
        subjectId: lesson.subject_id,
        subjectName: lesson.subjects.name,
        grade: lesson.subjects.grade,
        type: lesson.content_type,
        title: lesson.title,
        summary: lesson.summary,
        content: lesson.content,
      })),
      assessments: assessments.map((assessment) => ({
        id: assessment.id,
        title: assessment.title,
        subjectId: assessment.subject_id,
        subjectName: assessment.subjects.name,
        grade: assessment.subjects.grade,
        kind: assessment.kind,
        durationMinutes: assessment.duration_minutes,
        opensAt: assessment.opens_at,
        published: assessment.published,
        attemptCount: attemptCounts.get(assessment.id) ?? 0,
        questions: questions.filter((question) => question.assessment_id === assessment.id).map((question) => ({
          prompt: question.prompt,
          options: question.options_json,
          correctOption: question.correct_option,
          points: question.points,
          sortOrder: question.sort_order,
        })),
      })),
    });
  }

  if (path === "/api/admin/lessons" && request.method === "POST") {
    const parsed = lessonInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    if (!await findSubject(parsed.data.subjectId)) return fail("Choose a valid learning area.", 404);
    const { data: last, error: orderError } = await service.from("lessons").select("sort_order")
      .eq("subject_id", parsed.data.subjectId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
    if (orderError) throw new Error(orderError.message);
    const lessonId = randomId();
    const { error } = await service.from("lessons").insert({
      id: lessonId,
      subject_id: parsed.data.subjectId,
      content_type: parsed.data.type,
      title: parsed.data.title,
      summary: parsed.data.summary,
      content: parsed.data.content,
      sort_order: ((last as { sort_order: number } | null)?.sort_order ?? 0) + 1,
    });
    if (error) throw new Error(error.message);
    await recordAdminAction(adminId, "lesson_created", "lesson", lessonId, { title: parsed.data.title });
    return json({ lessonId }, 201);
  }

  const editLesson = path.match(/^\/api\/admin\/lessons\/([^/]+)$/);
  if (editLesson && request.method === "PUT") {
    const parsed = lessonInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    if (!await findSubject(parsed.data.subjectId)) return fail("Choose a valid learning area.", 404);
    const id = decodeURIComponent(editLesson[1]);
    const { data, error } = await service.from("lessons").update({
      subject_id: parsed.data.subjectId, content_type: parsed.data.type, title: parsed.data.title,
      summary: parsed.data.summary, content: parsed.data.content,
    }).eq("id", id).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail("This lesson or note was not found.", 404);
    await recordAdminAction(adminId, "lesson_updated", "lesson", id, { title: parsed.data.title });
    return json({ updated: true });
  }

  if (path === "/api/admin/assessments" && request.method === "POST") {
    const parsed = assessmentInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    if (!await findSubject(parsed.data.subjectId)) return fail("Choose a valid learning area.", 404);
    const assessmentId = randomId();
    const { error } = await service.rpc("save_assessment", {
      p_assessment_id: assessmentId,
      p_title: parsed.data.title,
      p_subject_id: parsed.data.subjectId,
      p_kind: parsed.data.kind,
      p_duration_minutes: parsed.data.durationMinutes,
      p_opens_at: parsed.data.opensAt,
      p_published: parsed.data.publish,
      p_admin_id: adminId,
      p_questions: parsed.data.questions,
      p_update: false,
    });
    if (error) throw new Error(error.message);
    await recordAdminAction(adminId, "assessment_created", "assessment", assessmentId, { title: parsed.data.title });
    return json({ assessmentId, questionCount: parsed.data.questions.length, published: parsed.data.publish }, 201);
  }

  const editAssessment = path.match(/^\/api\/admin\/assessments\/([^/]+)$/);
  if (editAssessment && request.method === "PUT") {
    const parsed = assessmentInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    if (!await findSubject(parsed.data.subjectId)) return fail("Choose a valid learning area.", 404);
    const assessmentId = decodeURIComponent(editAssessment[1]);
    const { error } = await service.rpc("save_assessment", {
      p_assessment_id: assessmentId,
      p_title: parsed.data.title,
      p_subject_id: parsed.data.subjectId,
      p_kind: parsed.data.kind,
      p_duration_minutes: parsed.data.durationMinutes,
      p_opens_at: parsed.data.opensAt,
      p_published: parsed.data.publish,
      p_admin_id: adminId,
      p_questions: parsed.data.questions,
      p_update: true,
    });
    if (error?.message.includes("ASSESSMENT_HAS_ATTEMPTS")) {
      return fail("This assessment already has learner attempts and can no longer be edited.", 409);
    }
    if (error?.message.includes("ASSESSMENT_NOT_FOUND")) return fail("This assessment was not found.", 404);
    if (error) throw new Error(error.message);
    await recordAdminAction(adminId, "assessment_updated", "assessment", assessmentId, { title: parsed.data.title });
    return json({ updated: true, questionCount: parsed.data.questions.length, published: parsed.data.publish });
  }

  if (path === "/api/admin/invitations" && request.method === "POST") {
    const parsed = createInvitationSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const codeHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString();
    const { error } = await service.from("invitations").insert({
      code_hash: codeHash, grade: parsed.data.grade, created_by: adminId, expires_at: expiresAt,
    });
    if (error) throw new Error(error.message);
    await recordAdminAction(adminId, "invitation_created", "invitation", codeHash, { grade: parsed.data.grade });
    return json({ code, grade: parsed.data.grade, expiresAt }, 201);
  }
  return null;
}

function apiPath(pathname: string): string {
  const marker = "/functions/v1/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return pathname;
  const remainder = pathname.slice(markerIndex + marker.length);
  const functionNameEnd = remainder.indexOf("/");
  return functionNameEnd < 0 ? "/api/health" : remainder.slice(functionNameEnd);
}

function addCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name");
    headers.set("Access-Control-Max-Age", "600");
    headers.append("Vary", "Origin");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) {
    return json({ error: "This website is not allowed to connect to the learning service." }, 403);
  }
  if (request.method === "OPTIONS") return addCors(empty(), origin);

  const url = new URL(request.url);
  const path = apiPath(url.pathname);
  try {
    if (path === "/api/health" && request.method === "GET") {
      return addCors(json({ status: "ok" }), origin);
    }
    const authResponse = await authRoutes(request, path);
    if (authResponse) return addCors(authResponse, origin);
    const studentResponse = await studentRoutes(request, path, url);
    if (studentResponse) return addCors(studentResponse, origin);
    const adminResponse = await adminRoutes(request, path, url);
    if (adminResponse) return addCors(adminResponse, origin);
    return addCors(fail("API endpoint not found.", 404), origin);
  } catch (error) {
    if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
      return addCors(fail("The request is larger than the allowed limit.", 413), origin);
    }
    if (error instanceof Error && error.message === "INVALID_JSON") {
      return addCors(fail("Please send valid JSON request data.", 400), origin);
    }
    console.error("Supabase API request failed:", error instanceof Error ? error.name : "UnknownError");
    return addCors(fail("The server could not complete that request.", 500), origin);
  }
});
