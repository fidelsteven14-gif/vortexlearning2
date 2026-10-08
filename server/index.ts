import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { z } from "zod";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  createId,
  createInvitationCode,
  createStudentCode,
  db,
  hashInvitation,
  runInTransaction,
} from "./database.js";
import { gradeNumber, seniorCompulsorySubjects, seniorPathways } from "../shared/curriculum.js";
import {
  emailDeliveryConfigured,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  supportAddress,
} from "./mailer.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const resourceStoragePath = resolve(process.env.RESOURCE_STORAGE_PATH ?? "data/resources");
const maxResourceBytes = 20 * 1024 * 1024;
const originList = (process.env.WEB_ORIGINS
  ?? (process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173"))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
if (process.env.NODE_ENV === "production" && !originList.length) {
  throw new Error("Set WEB_ORIGINS to the exact frontend origin(s) before starting the production API.");
}
const allowedWebOrigins = new Set(originList.map((origin) => {
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`Invalid WEB_ORIGINS entry: ${origin}`);
  }
  if (!["https:", "http:"].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
    throw new Error(`WEB_ORIGINS entries must be exact HTTP(S) origins without paths: ${origin}`);
  }
  return parsedOrigin.origin;
}));
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error("Set JWT_SECRET to a random string of at least 32 characters.");
}

type UserRole = "student" | "admin";
type AuthUser = { id: string; name: string; username: string; userCode: string | null; role: UserRole; grade: string | null };
type AuthRequest = Request & { user?: AuthUser };
function routeId(req: Request, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  const origin = req.header("Origin");
  if (!origin) {
    next();
    return;
  }
  if (!allowedWebOrigins.has(origin)) {
    res.status(403).json({ error: "This website is not allowed to connect to the learning service." });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.vary("Origin");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
    return;
  }
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", "https://accounts.google.com/gsi/client"],
      connectSrc: ["'self'", "https://accounts.google.com/gsi/"],
      frameSrc: ["'self'", "https://accounts.google.com/gsi/"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
    },
  },
}));
app.use(express.json({ limit: "100kb" }));
const authRequestLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use("/api/auth", authRequestLimit);

const usernameSchema = z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9._@#-]+$/);
const passwordSchema = z.string().min(6).max(72);
const gradeSchema = z.string().regex(/^Grade (?:[1-9]|1[0-2])$/);
const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());
const loginIdentifierSchema = z.string().trim().min(3).max(254);
const loginSchema = z.object({
  identifier: loginIdentifierSchema,
  password: z.string().min(1).max(72),
});
const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  grade: gradeSchema,
  username: usernameSchema,
  password: passwordSchema,
  passwordConfirmation: z.string().min(6).max(72),
}).refine((input) => input.password === input.passwordConfirmation, {
  message: "Passwords do not match.",
  path: ["passwordConfirmation"],
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
const resetRequestLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const resetSubmitLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const usernameCheckLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const googleLoginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const verificationRequestLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const verificationSubmitLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const verificationCodeLifetimeMs = 10 * 60_000;
const maxVerificationAttempts = 5;

function issueToken(user: AuthUser, authVersion = 0): string {
  return jwt.sign({ sub: user.id, role: user.role, ver: authVersion }, jwtSecret!, { expiresIn: "8h", issuer: "jifunze" });
}

function hashVerificationCode(code: string): string {
  return createHmac("sha256", jwtSecret!).update(code).digest("hex");
}

function suggestUsernames(name: string, count = 5): string[] {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "learner";
  const suggestions: string[] = [];
  for (let attempt = 0; attempt < 40 && suggestions.length < count; attempt += 1) {
    const candidate = `${base}${randomInt(10, 10_000)}`;
    const exists = db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(candidate);
    if (!exists && !suggestions.includes(candidate)) suggestions.push(candidate);
  }
  return suggestions;
}

async function getVerifiedGoogleProfile(credential: string): Promise<{ email: string; name: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_AUTH_NOT_CONFIGURED");
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("GOOGLE_CREDENTIAL_REJECTED");
  const claims = await response.json() as { aud?: string; iss?: string; email?: string; email_verified?: boolean | string; name?: string };
  if (
    claims.aud !== clientId
    || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "")
    || claims.email_verified !== true && claims.email_verified !== "true"
    || !claims.email
    || !claims.name
  ) throw new Error("GOOGLE_CREDENTIAL_REJECTED");
  return { email: claims.email.toLowerCase(), name: claims.name.trim() };
}

function publicUser(row: AuthUser): AuthUser {
  return { id: row.id, name: row.name, username: row.username, userCode: row.userCode, role: row.role, grade: row.grade };
}

function authRequired(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  try {
    const payload = jwt.verify(token, jwtSecret!, { issuer: "jifunze" }) as JwtPayload;
    if (typeof payload.sub !== "string") {
      res.status(401).json({ error: "Your session is invalid. Please sign in again." });
      return;
    }
    const row = db.prepare(
      "SELECT id, name, username, user_code AS userCode, role, grade, active, auth_version, email_verified FROM users WHERE id = ?",
    ).get(payload.sub) as (AuthUser & { active: number; auth_version: number; email_verified: number }) | undefined;
    if (!row || !row.active || (payload.ver ?? 0) !== row.auth_version) {
      res.status(401).json({ error: "This account is unavailable. Please contact your school." });
      return;
    }
    if (!row.email_verified) {
      res.status(401).json({ error: "Verify your email before accessing your learning space." });
      return;
    }
    req.user = publicUser(row);
    next();
  } catch {
    res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}

function roleRequired(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "You do not have permission to do that." });
      return;
    }
    next();
  };
}

function validateBody<T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Please check the information you entered.", details: result.error.flatten().fieldErrors });
    return undefined;
  }
  return result.data;
}

function recordAdminAction(adminId: string, action: string, entityType: string, entityId: string, details: Record<string, string | number | boolean | null> = {}): void {
  db.prepare(`
    INSERT INTO admin_audit_logs (id, admin_id, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(createId(), adminId, action, entityType, entityId, JSON.stringify(details));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/check-username", usernameCheckLimit, (req, res) => {
  const input = validateBody(z.object({ name: z.string().trim().min(2).max(80), username: usernameSchema }), req, res);
  if (!input) return;
  const exists = db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(input.username);
  if (exists) {
    res.json({ available: false, message: "That username is already taken. Choose one of these available options:", suggestions: suggestUsernames(input.name) });
    return;
  }
  res.json({ available: true, message: "This username is available.", suggestions: [] });
});

app.post("/api/auth/register", async (req, res, next) => {
  const input = validateBody(registerSchema, req, res);
  if (!input) return;
  if (!emailDeliveryConfigured) {
    res.status(503).json({ error: `Email verification is not configured yet. Contact ${supportAddress} for help.` });
    return;
  }
  try {
    const existingEmail = db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(input.email);
    if (existingEmail) {
      res.status(409).json({ error: "That email address is already registered. Try signing in or recovering the account." });
      return;
    }
    const existingUsername = db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(input.username);
    if (existingUsername) {
      res.status(409).json({
        error: "That username is already taken. Choose one of these available options:",
        suggestions: suggestUsernames(input.name),
      });
      return;
    }

    const user = {
      id: createId(),
      name: input.name,
      username: input.username,
      userCode: createStudentCode(),
      role: "student",
      grade: input.grade,
    } satisfies AuthUser;
    const passwordHash = await bcrypt.hash(input.password, 12);
    const code = randomInt(0, 100_000).toString().padStart(5, "0");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + verificationCodeLifetimeMs).toISOString();
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      try {
        runInTransaction(() => {
          db.prepare(
            "INSERT INTO users (id, name, username, password_hash, email, email_verified, user_code, role, grade) VALUES (?, ?, ?, ?, ?, 0, ?, 'student', ?)",
          ).run(user.id, user.name, user.username, passwordHash, input.email, user.userCode, user.grade);
          db.prepare(
            "INSERT INTO email_verifications (user_id, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)",
          ).run(user.id, hashVerificationCode(code), expiresAt, now.toISOString());
        });
        created = true;
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: users.username")) {
          res.status(409).json({
            error: "That username is already taken. Choose one of these available options:",
            suggestions: suggestUsernames(input.name),
          });
          return;
        }
        if (error instanceof Error && (error.message.includes("users.email") || error.message.includes("idx_users_email_unique"))) {
          res.status(409).json({ error: "That email address is already registered. Try signing in or recovering the account." });
          return;
        }
        if (error instanceof Error && (error.message.includes("idx_users_user_code_unique") || error.message.includes("users.user_code")) && attempt < 4) {
          user.userCode = createStudentCode();
          continue;
        }
        throw error;
      }
    }
    if (!created) throw new Error("A unique student code could not be generated.");
    try {
      await sendVerificationEmail(input.email, code);
    } catch (error) {
      db.prepare("DELETE FROM users WHERE id = ? AND email_verified = 0").run(user.id);
      console.error("Registration verification email delivery failed:", error instanceof Error ? error.name : "Unknown error");
      res.status(503).json({ error: `Your verification email could not be sent. Please try again or contact ${supportAddress}.` });
      return;
    }
    res.status(201).json({ message: "A verification code has been sent to your email address.", email: input.email });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/verify-email", verificationSubmitLimit, (req, res) => {
  const input = validateBody(z.object({
    email: emailSchema,
    code: z.string().regex(/^\d{5}$/),
  }), req, res);
  if (!input) return;

  const now = new Date().toISOString();
  const result = runInTransaction(() => {
    const user = db.prepare("SELECT id, email_verified FROM users WHERE email = ? COLLATE NOCASE AND active = 1")
      .get(input.email) as { id: string; email_verified: number } | undefined;
    if (!user) return "invalid";
    if (user.email_verified) return "already";
    const verification = db.prepare("SELECT code_hash, expires_at, attempts FROM email_verifications WHERE user_id = ?")
      .get(user.id) as { code_hash: string; expires_at: string; attempts: number } | undefined;
    if (!verification) return "invalid";
    if (new Date(verification.expires_at).getTime() <= Date.now()) {
      db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);
      return "expired";
    }
    if (verification.attempts >= maxVerificationAttempts) {
      db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);
      return "invalid";
    }
    const suppliedHash = Buffer.from(hashVerificationCode(input.code), "hex");
    const storedHash = Buffer.from(verification.code_hash, "hex");
    if (!timingSafeEqual(suppliedHash, storedHash)) {
      const attempts = verification.attempts + 1;
      if (attempts >= maxVerificationAttempts) {
        db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);
      } else {
        db.prepare("UPDATE email_verifications SET attempts = ? WHERE user_id = ?").run(attempts, user.id);
      }
      return "invalid";
    }
    db.prepare("UPDATE users SET email_verified = 1 WHERE id = ? AND email_verified = 0").run(user.id);
    db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);
    return "verified";
  });

  if (result === "verified") {
    res.json({ message: "Your email is verified. You can now sign in." });
    return;
  }
  res.status(400).json({
    error: result === "already"
      ? "This email is already verified. You can sign in."
      : result === "expired"
        ? "That verification code has expired. Request a new code."
        : "That verification code is invalid or has expired. Check it and try again, or request a new code.",
  });
});

app.post("/api/auth/resend-verification", verificationRequestLimit, async (req, res) => {
  const input = validateBody(z.object({ email: emailSchema }), req, res);
  if (!input) return;
  if (!emailDeliveryConfigured) {
    res.status(503).json({ error: `Email verification is not configured yet. Contact ${supportAddress} for help.` });
    return;
  }

  const user = db.prepare(`
    SELECT u.id, u.email, v.created_at
    FROM users u LEFT JOIN email_verifications v ON v.user_id = u.id
    WHERE u.email = ? COLLATE NOCASE AND u.email_verified = 0 AND u.active = 1
  `).get(input.email) as { id: string; email: string; created_at: string | null } | undefined;
  if (user && (!user.created_at || Date.now() - new Date(user.created_at).getTime() >= 60_000)) {
    const code = randomInt(0, 100_000).toString().padStart(5, "0");
    const now = new Date();
    db.prepare(`
      INSERT INTO email_verifications (user_id, code_hash, expires_at, attempts, created_at)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at
    `).run(user.id, hashVerificationCode(code), new Date(now.getTime() + verificationCodeLifetimeMs).toISOString(), now.toISOString());
    try {
      await sendVerificationEmail(user.email, code);
    } catch (error) {
      db.prepare("DELETE FROM email_verifications WHERE user_id = ? AND code_hash = ?").run(user.id, hashVerificationCode(code));
      const errorCode = error instanceof Error ? error.name : "UnknownError";
      const responseCode = typeof error === "object" && error !== null && "responseCode" in error
        ? error.responseCode
        : undefined;
      console.error("Verification email resend failed:", errorCode, responseCode ?? "");
      res.status(503).json({ error: `A new verification email could not be sent right now. Please try again later or contact ${supportAddress}.` });
      return;
    }
  }
  res.status(202).json({ message: "If this account needs verification, a new code has been sent." });
});

app.post("/api/auth/login", async (req, res, next) => {
  await handleLogin(req, res, next);
});

app.post("/api/auth/google", googleLoginLimit, async (req, res, next) => {
  const input = validateBody(z.object({
    credential: z.string().min(100).max(10_000),
    intent: z.enum(["login", "register"]),
    grade: gradeSchema.optional(),
    username: usernameSchema.optional(),
  }).superRefine((value, context) => {
    if (value.intent === "register" && !value.grade) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["grade"], message: "Choose a grade to register." });
    }
    if (value.intent === "register" && !value.username) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["username"], message: "Choose a username to register." });
    }
  }), req, res);
  if (!input) return;

  let profile: { email: string; name: string };
  try {
    profile = await getVerifiedGoogleProfile(input.credential);
  } catch (error) {
    if (error instanceof Error && error.message === "GOOGLE_AUTH_NOT_CONFIGURED") {
      res.status(503).json({ error: "Google sign-in is not configured yet. Use email or username sign-in for now." });
      return;
    }
    if (error instanceof Error && error.message === "GOOGLE_CREDENTIAL_REJECTED") {
      res.status(401).json({ error: "Google could not verify this sign-in. Please try again." });
      return;
    }
    console.error("Google sign-in verification failed:", error instanceof Error ? error.name : "UnknownError");
    res.status(503).json({ error: "Google sign-in is temporarily unavailable. Please use email or username sign-in." });
    return;
  }

  try {
    let row = db.prepare(
      "SELECT id, name, username, user_code AS userCode, password_hash, role, grade, active, auth_version, email_verified FROM users WHERE email = ? COLLATE NOCASE",
    ).get(profile.email) as (AuthUser & { password_hash: string; active: number; auth_version: number; email_verified: number }) | undefined;

    if (input.intent === "register") {
      if (row) {
        res.status(409).json({ error: "An account already uses this Google email. Sign in with Google instead." });
        return;
      }
      const username = input.username!;
      if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
        res.status(409).json({
          error: "That username is already taken. Choose one of these available options:",
          suggestions: suggestUsernames(profile.name),
        });
        return;
      }
      const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
      const user: AuthUser = {
        id: createId(),
        name: profile.name,
        username,
        userCode: createStudentCode(),
        role: "student",
        grade: input.grade!,
      };
      try {
        db.prepare(
          "INSERT INTO users (id, name, username, password_hash, email, email_verified, user_code, role, grade) VALUES (?, ?, ?, ?, ?, 1, ?, 'student', ?)",
        ).run(user.id, user.name, user.username, passwordHash, profile.email, user.userCode, user.grade);
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: users.username")) {
          res.status(409).json({
            error: "That username is already taken. Choose one of these available options:",
            suggestions: suggestUsernames(profile.name),
          });
          return;
        }
        throw error;
      }
      res.status(201).json({ token: issueToken(user), user });
      return;
    }

    if (!row || !row.active) {
      res.status(401).json({ error: "No active account uses this Google email. Choose Register to create a learner account." });
      return;
    }
    if (!row.email_verified) {
      db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(row.id);
      row.email_verified = 1;
    }
    const user = publicUser(row);
    res.json({ token: issueToken(user, row.auth_version), user });
  } catch (error) {
    next(error);
  }
});

async function handleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const input = validateBody(loginSchema, req, res);
  if (!input) return;
  try {
    const row = db.prepare(
      "SELECT id, name, username, user_code AS userCode, password_hash, role, grade, active, auth_version, email_verified FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE",
    ).get(input.identifier, input.identifier) as (AuthUser & { password_hash: string; active: number; auth_version: number; email_verified: number }) | undefined;
    const valid = row ? await bcrypt.compare(input.password, row.password_hash) : false;
    if (!row || !valid || !row.active) {
      res.status(401).json({ error: "Email, username, or password is incorrect." });
      return;
    }
    if (!row.email_verified) {
      res.status(403).json({ error: "Verify your email before signing in. You can request a new verification code below." });
      return;
    }
    const user = publicUser(row);
    res.json({ token: issueToken(user, row.auth_version), user });
  } catch (error) {
    next(error);
  }
}

app.post("/api/auth/forgot-password", resetRequestLimit, async (req, res) => {
  const input = validateBody(z.object({ email: emailSchema }), req, res);
  if (!input) return;
  if (!emailDeliveryConfigured) {
    res.status(503).json({ error: `Password recovery email is not configured yet. Contact ${supportAddress} for help.` });
    return;
  }
  const row = db.prepare("SELECT id, email FROM users WHERE email = ? COLLATE NOCASE AND active = 1")
    .get(input.email) as { id: string; email: string } | undefined;
  if (!row) {
    res.status(202).json({ message: "If an active account uses that email, a reset link will be sent." });
    return;
  }

  const now = new Date();
  const recentReset = db.prepare("SELECT created_at FROM password_resets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(row.id) as { created_at: string } | undefined;
  if (recentReset && now.getTime() - new Date(recentReset.created_at).getTime() < 60_000) {
    res.status(202).json({ message: "If an active account uses that email, a reset link will be sent." });
    return;
  }
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
  db.prepare("DELETE FROM password_resets WHERE user_id = ? OR expires_at <= ?").run(row.id, now.toISOString());
  db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash, row.id, expiresAt, now.toISOString());
  try {
    await sendPasswordResetEmail(row.email, token);
  } catch (error) {
    db.prepare("DELETE FROM password_resets WHERE token_hash = ?").run(tokenHash);
    const errorCode = error instanceof Error ? error.name : "UnknownError";
    const responseCode = typeof error === "object" && error !== null && "responseCode" in error ? error.responseCode : undefined;
    console.error("Password reset email delivery failed:", errorCode, responseCode ?? "");
  }
  res.status(202).json({
    message: "If an active account uses that email, a reset link will be sent. Check your inbox and spam folder; if it does not arrive, try again later or contact support.",
  });
});

app.post("/api/auth/reset-password", resetSubmitLimit, async (req, res) => {
  const input = validateBody(z.object({
    token: z.string().min(20).max(200),
    password: passwordSchema,
    passwordConfirmation: passwordSchema,
  }).refine((values) => values.password === values.passwordConfirmation, {
    message: "Passwords do not match.",
    path: ["passwordConfirmation"],
  }), req, res);
  if (!input) return;
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  const reset = db.prepare("SELECT token_hash, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?")
    .get(tokenHash) as { token_hash: string; user_id: string; expires_at: string; used_at: string | null } | undefined;
  if (!reset || reset.used_at || new Date(reset.expires_at).getTime() <= Date.now()) {
    res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
    return;
  }
  try {
    const passwordHash = await bcrypt.hash(input.password, 12);
    runInTransaction(() => {
      const claim = db.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
        .run(new Date().toISOString(), tokenHash, new Date().toISOString());
      if (claim.changes !== 1) throw new Error("RESET_TOKEN_ALREADY_USED");
      db.prepare("UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?")
        .run(passwordHash, reset.user_id);
    });
    const account = db.prepare("SELECT email FROM users WHERE id = ?").get(reset.user_id) as { email: string | null } | undefined;
    if (account?.email) {
      try {
        await sendPasswordChangedEmail(account.email);
      } catch (error) {
        console.error("Password-change notification delivery failed:", error instanceof Error ? error.name : "Unknown error");
      }
    }
    res.json({ message: "Your password has been reset. You can now sign in with your new password." });
  } catch (error) {
    if (error instanceof Error && error.message === "RESET_TOKEN_ALREADY_USED") {
      res.status(400).json({ error: "This reset link has already been used. Request a new one." });
      return;
    }
    console.error("Password reset failed:", error instanceof Error ? error.name : "Unknown error");
    res.status(500).json({ error: "The password could not be reset. Please try again." });
  }
});

app.get("/api/me", authRequired, (req: AuthRequest, res) => res.json({ user: req.user }));

app.post("/api/presence", authRequired, (req: AuthRequest, res) => {
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?")
    .run(new Date().toISOString(), req.user!.id);
  res.status(204).end();
});

app.patch("/api/profile", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const input = validateBody(z.object({
    name: z.string().trim().min(2).max(80),
    grade: gradeSchema,
  }), req, res);
  if (!input) return;
  const account = db.prepare("SELECT grade, curriculum_registered AS curriculumRegistered FROM users WHERE id = ?")
    .get(req.user!.id) as { grade: string | null; curriculumRegistered: number } | undefined;
  if (account?.curriculumRegistered && account.grade !== input.grade) {
    res.status(409).json({ error: "Your grade is locked after subject registration. Contact your school administrator to change it." });
    return;
  }
  db.prepare("UPDATE users SET name = ?, grade = ?, pathway = CASE WHEN grade = ? THEN pathway ELSE NULL END WHERE id = ?")
    .run(input.name, input.grade, input.grade, req.user!.id);
  res.json({ user: { ...req.user!, name: input.name, grade: input.grade } });
});

app.get("/api/curriculum/registration", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const user = db.prepare("SELECT grade, curriculum_registered AS curriculumRegistered, pathway FROM users WHERE id = ?")
    .get(req.user!.id) as { grade: string | null; curriculumRegistered: number; pathway: string | null } | undefined;
  const number = gradeNumber(user?.grade);
  if (number === null) {
    res.json({ grade: null, needsGrade: true, complete: false, pathway: null, subjects: [], compulsory: [], pathways: [] });
    return;
  }
  const subjectRows = db.prepare("SELECT id, name, topic, icon, color, grade FROM subjects WHERE grade = ? ORDER BY sort_order, name")
    .all(user!.grade) as Array<{ id: string; name: string; topic: string; icon: string; color: string; grade: string }>;
  const compulsoryNames = new Set<string>(seniorCompulsorySubjects);
  const compulsory = number >= 10 ? subjectRows.filter((subject) => compulsoryNames.has(subject.name)) : [];
  const pathways = number >= 10 ? seniorPathways.map((pathway) => ({
    id: pathway.id,
    name: pathway.name,
    shortName: pathway.shortName,
    description: pathway.description,
    subjects: subjectRows.filter((subject) => new Set<string>(pathway.subjects).has(subject.name) && !compulsoryNames.has(subject.name)),
  })) : [];
  const offeredPathwayIds = new Set(pathways.map((pathway) => pathway.id));
  const validSavedPathway = user?.pathway && offeredPathwayIds.has(user.pathway as typeof seniorPathways[number]["id"])
    ? user.pathway
    : null;
  const selectedSubjectIds = db.prepare("SELECT subject_id AS subjectId FROM student_subject_registrations WHERE user_id = ?")
    .all(req.user!.id) as Array<{ subjectId: string }>;
  res.json({
    grade: user!.grade,
    needsGrade: false,
    complete: Boolean(user?.curriculumRegistered),
    pathway: validSavedPathway,
    subjects: number < 10 ? subjectRows : [],
    compulsory,
    pathways,
    selectedSubjectIds: selectedSubjectIds.map(({ subjectId }) => subjectId),
  });
});

app.post("/api/curriculum/registration", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const input = validateBody(z.object({
    pathway: z.enum(["stem", "arts-sports", "social-sciences"]).nullable(),
    subjectIds: z.array(z.string().min(1).max(100)).min(1).max(30),
  }).superRefine((value, context) => {
    if (new Set(value.subjectIds).size !== value.subjectIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectIds"], message: "Remove duplicate subjects before saving." });
    }
  }), req, res);
  if (!input) return;
  const user = db.prepare("SELECT grade FROM users WHERE id = ?").get(req.user!.id) as { grade: string | null } | undefined;
  const number = gradeNumber(user?.grade);
  if (number === null) {
    res.status(409).json({ error: "We need to know your grade before we can register your subjects." });
    return;
  }
  if (number < 10 && input.pathway !== null || number >= 10 && input.pathway === null) {
    res.status(400).json({ error: number < 10 ? "Pathways are only available to Grades 10–12." : "Choose a pathway for your Senior School grade." });
    return;
  }
  const gradeSubjects = db.prepare("SELECT id, name FROM subjects WHERE grade = ?")
    .all(user!.grade) as Array<{ id: string; name: string }>;
  const allowedSubjectIds: Set<string> = number < 10
    ? new Set(gradeSubjects.map((subject) => subject.id))
    : new Set(gradeSubjects
      .filter((subject) => new Set<string>(seniorPathways.find((pathway) => pathway.id === input.pathway)?.subjects ?? []).has(subject.name))
      .map((subject) => subject.id));
  if (input.subjectIds.some((subjectId) => !allowedSubjectIds.has(subjectId))) {
    res.status(400).json({ error: "One or more selected subjects are not available for your grade and pathway." });
    return;
  }
  const coreIds = number >= 10
    ? gradeSubjects.filter((subject) => seniorCompulsorySubjects.includes(subject.name as typeof seniorCompulsorySubjects[number])).map((subject) => subject.id)
    : [];
  if (number >= 10 && coreIds.length !== seniorCompulsorySubjects.length) {
    res.status(409).json({ error: "The compulsory subjects for your grade are not fully configured. Contact support." });
    return;
  }
  if (number >= 10 && input.subjectIds.length === 0) {
    res.status(400).json({ error: "Select at least one subject from your chosen pathway." });
    return;
  }
  runInTransaction(() => {
    db.prepare("DELETE FROM student_subject_registrations WHERE user_id = ?").run(req.user!.id);
    const insert = db.prepare("INSERT INTO student_subject_registrations (user_id, subject_id) VALUES (?, ?)");
    for (const subjectId of new Set([...coreIds, ...input.subjectIds])) insert.run(req.user!.id, subjectId);
    db.prepare("UPDATE users SET curriculum_registered = 1, pathway = ? WHERE id = ?")
      .run(input.pathway, req.user!.id);
  });
  res.json({ message: "Your grade-specific subject registration has been saved." });
});

app.get("/api/students/lookup", authRequired, roleRequired("student"), rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const parsed = z.string().trim().toUpperCase().regex(/^VX-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/).safeParse(req.query.code);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid student code." });
    return;
  }
  const student = db.prepare(
    "SELECT user_code AS userCode, name, grade FROM users WHERE user_code = ? AND role = 'student' AND active = 1",
  ).get(parsed.data) as { userCode: string; name: string; grade: string } | undefined;
  res.json({ student: student ?? null });
});

app.get("/api/resources/:id/file", authRequired, roleRequired("student"), async (req: AuthRequest, res, next) => {
  try {
    const resource = db.prepare(`
      SELECT r.storage_key AS storageKey, r.original_filename AS filename
      FROM learning_resources r JOIN subjects s ON s.id = r.subject_id
      WHERE r.id = ? AND r.status = 'published' AND s.grade = ?
        AND EXISTS (SELECT 1 FROM student_subject_registrations sr WHERE sr.user_id = ? AND sr.subject_id = s.id)
    `).get(routeId(req, "id"), req.user!.grade, req.user!.id) as { storageKey: string | null; filename: string | null } | undefined;
    if (!resource?.storageKey || !resource.filename) {
      res.status(404).json({ error: "This resource is not available for your account." });
      return;
    }
    const content = await readFile(resolve(resourceStoragePath, resource.storageKey));
    const filename = resource.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(content);
  } catch (error) {
    if (isMissingFile(error)) {
      res.status(404).json({ error: "The PDF file is missing. Please contact the school administrator." });
      return;
    }
    next(error);
  }
});

app.get("/api/dashboard", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const user = req.user!;
  const registration = db.prepare("SELECT curriculum_registered AS complete, pathway FROM users WHERE id = ?")
    .get(user.id) as { complete: number; pathway: string | null } | undefined;
  const courseRows = db.prepare(`
    SELECT s.id, s.name, s.topic, s.icon, s.color,
      (SELECT COUNT(*) FROM user_lesson_completions c JOIN lessons l ON l.id = c.lesson_id
        WHERE c.user_id = ? AND l.subject_id = s.id) AS completed_lessons,
      (SELECT COUNT(*) FROM lessons l WHERE l.subject_id = s.id) AS total_lessons
    FROM subjects s
    JOIN student_subject_registrations sr ON sr.subject_id = s.id AND sr.user_id = ?
    WHERE s.grade = ?
    ORDER BY s.sort_order
  `).all(user.id, user.id, user.grade) as Array<{ id: string; name: string; topic: string; icon: string; color: string; completed_lessons: number; total_lessons: number }>;

  const courses = courseRows.map((row) => ({
    ...row,
    progress: row.total_lessons ? Math.round((row.completed_lessons / row.total_lessons) * 100) : 0,
    lessons: `${row.completed_lessons} of ${row.total_lessons} lessons`,
  }));
  const upcomingExams = db.prepare(`
    SELECT a.id, a.title, a.kind, a.duration_minutes, a.opens_at, s.name AS subject_name
    FROM assessments a JOIN subjects s ON s.id = a.subject_id
    WHERE a.published = 1 AND a.opens_at >= ?
      AND s.grade = ?
      AND EXISTS (SELECT 1 FROM student_subject_registrations sr WHERE sr.user_id = ? AND sr.subject_id = s.id)
      AND NOT EXISTS (
        SELECT 1 FROM attempts t WHERE t.assessment_id = a.id AND t.user_id = ? AND t.status != 'in_progress'
      )
    ORDER BY a.opens_at LIMIT 8
  `).all(new Date().toISOString(), user.grade, user.id, user.id);
  const attemptStats = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status IN ('submitted', 'marked') THEN 1 ELSE 0 END) AS completed
    FROM attempts WHERE user_id = ?
  `).get(user.id) as { in_progress: number | null; completed: number | null };

  const lessons = courses.reduce((sum, course) => sum + course.completed_lessons, 0);
  const lessonTotal = courses.reduce((sum, course) => sum + course.total_lessons, 0);
  const resources = db.prepare(`
    SELECT r.id, r.title, r.description, r.topic, r.term, r.category,
      r.original_filename AS filename, r.size_bytes AS sizeBytes,
      s.id AS subjectId, s.name AS subjectName, s.grade
    FROM learning_resources r
    JOIN subjects s ON s.id = r.subject_id
    WHERE r.status = 'published' AND s.grade = ?
      AND EXISTS (SELECT 1 FROM student_subject_registrations sr WHERE sr.user_id = ? AND sr.subject_id = s.id)
    ORDER BY r.updated_at DESC, r.title COLLATE NOCASE
  `).all(user.grade, user.id);
  res.json({
    student: user,
    curriculumRegistration: {
      complete: Boolean(registration?.complete),
      pathway: registration?.pathway ?? null,
      grade: user.grade,
    },
    courses,
    upcomingExams,
    resources,
    stats: {
      lessonsCompleted: lessons,
      lessonsTotal: lessonTotal,
      learningProgress: lessonTotal ? Math.round((lessons / lessonTotal) * 100) : 0,
      streakDays: 0,
      completedExams: attemptStats.completed ?? 0,
      examsInProgress: attemptStats.in_progress ?? 0,
    },
  });
});

app.get("/api/subjects/:id/lessons", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const subjectId = routeId(req, "id");
  const subject = db.prepare(`
    SELECT s.id, s.name, s.grade FROM subjects s
    JOIN student_subject_registrations sr ON sr.subject_id = s.id AND sr.user_id = ?
    WHERE s.id = ?
  `).get(req.user!.id, subjectId) as { id: string; name: string; grade: string } | undefined;
  if (!subject || subject.grade !== req.user!.grade) {
    res.status(404).json({ error: "This learning area is not available." });
    return;
  }
  const lessons = db.prepare(`
    SELECT l.id, l.title, l.summary, l.content, l.sort_order,
      CASE WHEN c.lesson_id IS NULL THEN 0 ELSE 1 END AS completed
    FROM lessons l LEFT JOIN user_lesson_completions c ON c.lesson_id = l.id AND c.user_id = ?
    WHERE l.subject_id = ? ORDER BY l.sort_order
  `).all(req.user!.id, subject.id);
  res.json({ subject: { id: subject.id, name: subject.name }, lessons });
});

app.post("/api/lessons/:id/complete", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const lessonId = routeId(req, "id");
  const lesson = db.prepare(`
    SELECT l.id, l.subject_id, s.grade FROM lessons l
    JOIN subjects s ON s.id = l.subject_id
    JOIN student_subject_registrations sr ON sr.subject_id = s.id AND sr.user_id = ?
    WHERE l.id = ?
  `).get(req.user!.id, lessonId) as { id: string; subject_id: string; grade: string } | undefined;
  if (!lesson || lesson.grade !== req.user!.grade) {
    res.status(404).json({ error: "This lesson is not available." });
    return;
  }
  db.prepare(`
    INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, lesson_id) DO NOTHING
  `).run(req.user!.id, lesson.id, new Date().toISOString());
  res.json({ completed: true, lessonId: lesson.id });
});

app.get("/api/exams", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const exams = db.prepare(`
    SELECT a.id, a.title, a.kind, a.duration_minutes, a.opens_at, s.name AS subject_name,
      t.id AS attempt_id, t.status AS attempt_status, t.score, t.total_points
    FROM assessments a JOIN subjects s ON s.id = a.subject_id
    LEFT JOIN attempts t ON t.assessment_id = a.id AND t.user_id = ?
    WHERE a.published = 1 AND s.grade = ?
      AND EXISTS (SELECT 1 FROM student_subject_registrations sr WHERE sr.user_id = ? AND sr.subject_id = s.id)
    ORDER BY a.opens_at
  `).all(req.user!.id, req.user!.grade, req.user!.id);
  res.json({ exams });
});

app.post("/api/exams/:id/start", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const assessment = db.prepare(`
    SELECT a.id, a.duration_minutes, a.opens_at, s.grade
    FROM assessments a JOIN subjects s ON s.id = a.subject_id
    JOIN student_subject_registrations sr ON sr.subject_id = s.id AND sr.user_id = ?
    WHERE a.id = ? AND a.published = 1
  `).get(req.user!.id, routeId(req, "id")) as { id: string; duration_minutes: number; opens_at: string; grade: string } | undefined;
  if (!assessment || assessment.grade !== req.user!.grade) {
    res.status(404).json({ error: "This examination is not available." });
    return;
  }
  if (new Date(assessment.opens_at).getTime() > Date.now()) {
    res.status(409).json({ error: "This examination is not open yet." });
    return;
  }

  let attempt = db.prepare("SELECT id, status, started_at FROM attempts WHERE user_id = ? AND assessment_id = ?")
    .get(req.user!.id, assessment.id) as { id: string; status: string; started_at: string } | undefined;
  if (!attempt) {
    const id = createId();
    const questions = db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM questions WHERE assessment_id = ?")
      .get(assessment.id) as { total: number };
    db.prepare(
      "INSERT INTO attempts (id, user_id, assessment_id, status, started_at, total_points) VALUES (?, ?, ?, 'in_progress', ?, ?)",
    ).run(id, req.user!.id, assessment.id, new Date().toISOString(), questions.total);
    attempt = { id, status: "in_progress", started_at: new Date().toISOString() };
  }
  if (attempt.status !== "in_progress") {
    res.status(409).json({ error: "This examination has already been submitted." });
    return;
  }
  const expiresAt = new Date(new Date(attempt.started_at).getTime() + assessment.duration_minutes * 60_000).toISOString();
  if (Date.now() > new Date(expiresAt).getTime()) {
    db.prepare("UPDATE attempts SET status = 'submitted', submitted_at = ? WHERE id = ?")
      .run(new Date().toISOString(), attempt.id);
    res.status(409).json({ error: "The time for this attempt has ended." });
    return;
  }
  const questions = db.prepare(`
    SELECT q.id, q.prompt, q.options_json, q.points, a.selected_option
    FROM questions q LEFT JOIN answers a ON a.question_id = q.id AND a.attempt_id = ?
    WHERE q.assessment_id = ? ORDER BY q.sort_order
  `).all(attempt.id, assessment.id) as Array<{ id: string; prompt: string; options_json: string; points: number; selected_option: number | null }>;
  res.json({
    attemptId: attempt.id,
    expiresAt,
    questions: questions.map(({ options_json, ...question }) => ({ ...question, options: JSON.parse(options_json) as string[] })),
  });
});

app.put("/api/attempts/:id/answers", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const input = validateBody(z.object({
    questionId:     z.string().min(1).max(80),
    selectedOption: z.number().int().min(0).max(19),
  }), req, res);
  if (!input) return;

  const attempt = db.prepare(`
    SELECT t.id, t.status, t.started_at, a.duration_minutes
    FROM attempts t JOIN assessments a ON a.id = t.assessment_id
    WHERE t.id = ? AND t.user_id = ?
  `).get(routeId(req, "id"), req.user!.id) as { id: string; status: string; started_at: string; duration_minutes: number } | undefined;
  if (!attempt || attempt.status !== "in_progress") {
    res.status(404).json({ error: "This active examination attempt was not found." });
    return;
  }
  if (Date.now() > new Date(attempt.started_at).getTime() + attempt.duration_minutes * 60_000) {
    db.prepare("UPDATE attempts SET status = 'submitted', submitted_at = ? WHERE id = ?")
      .run(new Date().toISOString(), attempt.id);
    res.status(409).json({ error: "The examination time has ended; answers can no longer be changed." });
    return;
  }
  const belongs = db.prepare("SELECT options_json FROM questions WHERE id = ? AND assessment_id = (SELECT assessment_id FROM attempts WHERE id = ?)")
    .get(input.questionId, attempt.id);
  if (!belongs) {
    res.status(404).json({ error: "That question does not belong to this attempt." });
    return;
  }
  if (input.selectedOption >= (JSON.parse((belongs as { options_json: string }).options_json) as string[]).length) {
    res.status(400).json({ error: "Choose one of the available answer options." });
    return;
  }
  db.prepare(`
    INSERT INTO answers (attempt_id, question_id, selected_option, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_id, question_id) DO UPDATE SET selected_option = excluded.selected_option, updated_at = excluded.updated_at
  `).run(attempt.id, input.questionId, input.selectedOption, new Date().toISOString());
  res.json({ saved: true, savedAt: new Date().toISOString() });
});

app.post("/api/attempts/:id/submit", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const attempt = db.prepare("SELECT id, status FROM attempts WHERE id = ? AND user_id = ?")
    .get(routeId(req, "id"), req.user!.id) as { id: string; status: string } | undefined;
  if (!attempt) {
    res.status(404).json({ error: "This examination attempt was not found." });
    return;
  }
  if (attempt.status !== "in_progress") {
    res.status(409).json({ error: "This examination has already been submitted." });
    return;
  }
  const result = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN ans.selected_option = q.correct_option THEN q.points ELSE 0 END), 0) AS score
    FROM questions q LEFT JOIN answers ans ON ans.question_id = q.id AND ans.attempt_id = ?
    WHERE q.assessment_id = (SELECT assessment_id FROM attempts WHERE id = ?)
  `).get(attempt.id, attempt.id) as { score: number };
  const now = new Date().toISOString();
  db.prepare("UPDATE attempts SET status = 'submitted', submitted_at = ?, score = ? WHERE id = ? AND status = 'in_progress'")
    .run(now, result.score, attempt.id);
  const total = db.prepare("SELECT total_points FROM attempts WHERE id = ?").get(attempt.id) as { total_points: number };
  res.json({ submitted: true, score: result.score, totalPoints: total.total_points, submittedAt: now });
});

app.get("/api/results", authRequired, roleRequired("student"), (req: AuthRequest, res) => {
  const results = db.prepare(`
    SELECT t.id AS attempt_id, a.title, s.name AS subject_name, t.status,
      t.score, t.total_points, t.submitted_at
    FROM attempts t JOIN assessments a ON a.id = t.assessment_id
    JOIN subjects s ON s.id = a.subject_id
    WHERE t.user_id = ? AND t.status IN ('submitted', 'marked')
    ORDER BY t.submitted_at DESC
  `).all(req.user!.id);
  res.json({ results });
});

app.get("/api/admin/overview", authRequired, roleRequired("admin"), (_req, res) => {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'student') AS registeredStudents,
      (SELECT COUNT(*) FROM users WHERE role = 'student' AND active = 1 AND last_seen_at >= ?) AS activeStudents,
      (SELECT COUNT(*) FROM attempts WHERE status = 'in_progress') AS examsInProgress,
      (SELECT COUNT(*) FROM attempts WHERE status IN ('submitted', 'marked')) AS examsSubmitted,
      (SELECT COUNT(*) FROM assessments WHERE published = 1) AS publishedAssessments
  `).get(new Date(Date.now() - 5 * 60_000).toISOString());
  res.json({ generatedAt: new Date().toISOString(), counts });
});

app.get("/api/admin/students", authRequired, roleRequired("admin"), (_req, res) => {
  const students = db.prepare(`
    SELECT id, name, username, user_code AS userCode, grade, active, email_verified AS emailVerified, created_at AS createdAt, last_seen_at AS lastSeenAt
    FROM users
    WHERE role = 'student'
    ORDER BY created_at DESC, name COLLATE NOCASE
  `).all();
  res.json({ students });
});

app.delete("/api/admin/students/:id", authRequired, roleRequired("admin"), (req: AuthRequest, res) => {
  const id = routeId(req, "id");
  const target = db.prepare("SELECT id, role, name FROM users WHERE id = ?").get(id) as { id: string; role: string; name: string } | undefined;
  if (!target) {
    res.status(404).json({ error: "This learner account was not found." });
    return;
  }
  if (target.role !== "student") {
    res.status(400).json({ error: "Only student accounts can be deleted from the learner directory." });
    return;
  }
  if (target.id === req.user!.id) {
    res.status(400).json({ error: "You cannot delete the currently signed-in administrator account." });
    return;
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.status(204).end();
});

app.get("/api/admin/audit-log", authRequired, roleRequired("admin"), (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).default(50).safeParse(req.query.limit ?? 50);
  if (!limit.success) {
    res.status(400).json({ error: "Audit log limit must be between 1 and 100." });
    return;
  }
  const events = db.prepare(`
    SELECT l.id, l.action, l.entity_type AS entityType, l.entity_id AS entityId,
      l.details_json AS details, l.created_at AS createdAt,
      u.name AS adminName, u.username AS adminUsername
    FROM admin_audit_logs l JOIN users u ON u.id = l.admin_id
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ?
  `).all(limit.data);
  res.json({ events });
});

app.get("/api/admin/catalog", authRequired, roleRequired("admin"), (_req, res) => {
  const subjects = db.prepare("SELECT id, name, grade FROM subjects ORDER BY grade, sort_order").all();
  res.json({ subjects });
});

app.get("/api/admin/resources", authRequired, roleRequired("admin"), (_req, res) => {
  const resources = db.prepare(`
    SELECT r.id, r.subject_id AS subjectId, s.name AS subjectName, s.grade,
      r.title, r.description, r.topic, r.term, r.category, r.status,
      r.original_filename AS filename, r.size_bytes AS sizeBytes,
      r.created_at AS createdAt, r.updated_at AS updatedAt
    FROM learning_resources r JOIN subjects s ON s.id = r.subject_id
    ORDER BY r.updated_at DESC, r.title COLLATE NOCASE
  `).all();
  res.json({ resources });
});

app.post("/api/admin/resources", authRequired, roleRequired("admin"), (req: AuthRequest, res) => {
  const input = validateBody(resourceInputSchema, req, res);
  if (!input) return;
  const subject = db.prepare("SELECT id FROM subjects WHERE id = ?").get(input.subjectId);
  if (!subject) {
    res.status(404).json({ error: "Choose a valid learning area." });
    return;
  }
  const id = createId();
  runInTransaction(() => {
    db.prepare(`
      INSERT INTO learning_resources
        (id, subject_id, title, description, topic, term, category, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.subjectId, input.title, input.description, input.topic, input.term, input.category, req.user!.id);
    recordAdminAction(req.user!.id, "resource_created", "learning_resource", id, { title: input.title });
  });
  res.status(201).json({ id, status: "draft" });
});

app.put("/api/admin/resources/:id", authRequired, roleRequired("admin"), (req: AuthRequest, res) => {
  const input = validateBody(resourceInputSchema, req, res);
  if (!input) return;
  const subject = db.prepare("SELECT id FROM subjects WHERE id = ?").get(input.subjectId);
  if (!subject) {
    res.status(404).json({ error: "Choose a valid learning area." });
    return;
  }
  const id = routeId(req, "id");
  const updated = runInTransaction(() => {
    const result = db.prepare(`
      UPDATE learning_resources
      SET subject_id = ?, title = ?, description = ?, topic = ?, term = ?, category = ?, updated_at = ?
      WHERE id = ?
    `).run(input.subjectId, input.title, input.description, input.topic, input.term, input.category, new Date().toISOString(), id);
    if (result.changes) recordAdminAction(req.user!.id, "resource_updated", "learning_resource", id, { title: input.title });
    return result.changes;
  });
  if (!updated) {
    res.status(404).json({ error: "This learning resource was not found." });
    return;
  }
  res.json({ updated: true });
});

app.put(
  "/api/admin/resources/:id/file",
  authRequired,
  roleRequired("admin"),
  express.raw({ type: "application/pdf", limit: maxResourceBytes }),
  async (req: AuthRequest, res, next) => {
    const id = routeId(req, "id");
    const existing = db.prepare("SELECT storage_key AS storageKey FROM learning_resources WHERE id = ?")
      .get(id) as { storageKey: string | null } | undefined;
    if (!existing) {
      res.status(404).json({ error: "Create a resource draft before uploading its PDF." });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Choose a non-empty PDF file to upload." });
      return;
    }
    if (!req.body.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      res.status(415).json({ error: "The selected file is not a valid PDF document." });
      return;
    }
    let pdfPageCount: number;
    try {
      const pdf = await PDFDocument.load(req.body, { throwOnInvalidObject: true });
      pdfPageCount = pdf.getPageCount();
    } catch {
      res.status(400).json({ error: "The PDF appears to be corrupt or unreadable. Please choose a valid PDF." });
      return;
    }
    if (pdfPageCount < 1) {
      res.status(400).json({ error: "The PDF must contain at least one page." });
      return;
    }
    const encodedFilename = req.header("x-file-name") ?? "learning-resource.pdf";
    let decodedFilename: string;
    try {
      decodedFilename = decodeURIComponent(encodedFilename);
    } catch {
      res.status(400).json({ error: "The selected filename is invalid." });
      return;
    }
    const filename = decodedFilename.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "learning-resource.pdf";
    if (!filename.toLowerCase().endsWith(".pdf")) {
      res.status(415).json({ error: "Only PDF files can be uploaded." });
      return;
    }

    const storageKey = `${id}-${randomBytes(12).toString("hex")}.pdf`;
    const tempPath = resolve(resourceStoragePath, `.${storageKey}.tmp`);
    const filePath = resolve(resourceStoragePath, storageKey);
    try {
      await mkdir(resourceStoragePath, { recursive: true });
      await writeFile(tempPath, req.body, { flag: "wx" });
      await rename(tempPath, filePath);
      try {
        runInTransaction(() => {
          const updated = db.prepare(`
            UPDATE learning_resources
            SET storage_key = ?, original_filename = ?, size_bytes = ?, updated_at = ?
            WHERE id = ?
          `).run(storageKey, filename, req.body.length, new Date().toISOString(), id);
          if (!updated.changes) throw new Error("RESOURCE_NOT_FOUND");
          recordAdminAction(req.user!.id, "resource_pdf_uploaded", "learning_resource", id, {
            filename,
            sizeBytes: req.body.length,
            pageCount: pdfPageCount,
          });
        });
      } catch (error) {
        await unlink(filePath);
        if (error instanceof Error && error.message === "RESOURCE_NOT_FOUND") {
          res.status(404).json({ error: "This learning resource was not found." });
          return;
        }
        throw error;
      }
      if (existing.storageKey) {
        try {
          await unlink(resolve(resourceStoragePath, existing.storageKey));
        } catch (error) {
          console.error("Old learning-resource PDF cleanup failed:", error instanceof Error ? error.name : "Unknown error");
        }
      }
      res.json({ uploaded: true, filename, sizeBytes: req.body.length, pageCount: pdfPageCount });
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch (cleanupError) {
        if (!isMissingFile(cleanupError)) {
          console.error("Temporary PDF cleanup failed:", cleanupError instanceof Error ? cleanupError.name : "Unknown error");
        }
      }
      next(error);
    }
  },
);

app.get("/api/admin/resources/:id/file", authRequired, roleRequired("admin"), async (req, res, next) => {
  try {
    const resource = db.prepare("SELECT storage_key AS storageKey, original_filename AS filename FROM learning_resources WHERE id = ?")
      .get(routeId(req, "id")) as { storageKey: string | null; filename: string | null } | undefined;
    if (!resource?.storageKey || !resource.filename) {
      res.status(404).json({ error: "Upload a PDF to preview this resource." });
      return;
    }
    const content = await readFile(resolve(resourceStoragePath, resource.storageKey));
    const filename = resource.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(content);
  } catch (error) {
    if (isMissingFile(error)) {
      res.status(404).json({ error: "The stored PDF is missing. Upload the file again before sharing this resource." });
      return;
    }
    next(error);
  }
});

app.patch("/api/admin/resources/:id/status", authRequired, roleRequired("admin"), (req: AuthRequest, res) => {
  const input = validateBody(z.object({ status: z.enum(["draft", "published", "archived"]) }), req, res);
  if (!input) return;
  const id = routeId(req, "id");
  const resource = db.prepare("SELECT storage_key AS storageKey FROM learning_resources WHERE id = ?")
    .get(id) as { storageKey: string | null } | undefined;
  if (!resource) {
    res.status(404).json({ error: "This learning resource was not found." });
    return;
  }
  if (input.status === "published" && !resource.storageKey) {
    res.status(409).json({ error: "Upload and preview a valid PDF before publishing this resource." });
    return;
  }
  runInTransaction(() => {
    db.prepare("UPDATE learning_resources SET status = ?, updated_at = ? WHERE id = ?")
      .run(input.status, new Date().toISOString(), id);
    recordAdminAction(req.user!.id, `resource_${input.status}`, "learning_resource", id);
  });
  res.json({ status: input.status });
});

app.delete("/api/admin/resources/:id", authRequired, roleRequired("admin"), async (req: AuthRequest, res, next) => {
  const id = routeId(req, "id");
  const resource = db.prepare("SELECT storage_key AS storageKey FROM learning_resources WHERE id = ?")
    .get(id) as { storageKey: string | null } | undefined;
  if (!resource) {
    res.status(404).json({ error: "This learning resource was not found." });
    return;
  }
  try {
    runInTransaction(() => {
      db.prepare("DELETE FROM learning_resources WHERE id = ?").run(id);
      recordAdminAction(req.user!.id, "resource_deleted", "learning_resource", id);
    });
    if (resource.storageKey) {
      try {
        await unlink(resolve(resourceStoragePath, resource.storageKey));
      } catch (error) {
        if (!isMissingFile(error)) {
          console.error("Deleted resource PDF could not be removed:", error instanceof Error ? error.name : "Unknown error");
          res.status(500).json({ error: "The resource was deleted, but its stored PDF could not be removed. Contact platform support." });
          return;
        }
      }
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/content", authRequired, roleRequired("admin"), (_req, res) => {
  const lessons = db.prepare(`
    SELECT l.id, l.subject_id AS subjectId, s.name AS subjectName, s.grade,
      l.content_type AS type, l.title, l.summary, l.content
    FROM lessons l JOIN subjects s ON s.id = l.subject_id
    ORDER BY s.grade, s.sort_order, l.sort_order, l.title COLLATE NOCASE
  `).all();
  const assessments = db.prepare(`
    SELECT a.id, a.title, a.subject_id AS subjectId, s.name AS subjectName, s.grade,
      a.kind, a.duration_minutes AS durationMinutes, a.opens_at AS opensAt, a.published,
      (SELECT COUNT(*) FROM attempts t WHERE t.assessment_id = a.id) AS attemptCount
    FROM assessments a JOIN subjects s ON s.id = a.subject_id
    ORDER BY s.grade, a.opens_at DESC
  `).all() as Array<{ id: string; [key: string]: unknown }>;
  const getQuestions = db.prepare(`
    SELECT prompt, options_json AS optionsJson, correct_option AS correctOption, points, sort_order AS sortOrder
    FROM questions WHERE assessment_id = ? ORDER BY sort_order
  `);
  res.json({
    lessons,
    assessments: assessments.map((assessment) => ({
      ...assessment,
      questions: (getQuestions.all(assessment.id) as Array<{ prompt: string; optionsJson: string; correctOption: number; points: number; sortOrder: number }>)
        .map(({ optionsJson, ...question }) => ({ ...question, options: JSON.parse(optionsJson) as string[] })),
    })),
  });
});

app.post("/api/admin/lessons", authRequired, roleRequired("admin"), (req, res) => {
  const input = validateBody(lessonInputSchema, req, res);
  if (!input) return;
  const subject = db.prepare("SELECT id FROM subjects WHERE id = ?").get(input.subjectId);
  if (!subject) {
    res.status(404).json({ error: "Choose a valid learning area." });
    return;
  }
  const lessonId = createId();
  db.prepare(`
    INSERT INTO lessons (id, subject_id, content_type, title, summary, content, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM lessons WHERE subject_id = ?), 1))
  `).run(lessonId, input.subjectId, input.type, input.title, input.summary, input.content, input.subjectId);
  res.status(201).json({ lessonId });
});

app.put("/api/admin/lessons/:id", authRequired, roleRequired("admin"), (req, res) => {
  const input = validateBody(lessonInputSchema, req, res);
  if (!input) return;
  const subject = db.prepare("SELECT id FROM subjects WHERE id = ?").get(input.subjectId);
  if (!subject) {
    res.status(404).json({ error: "Choose a valid learning area." });
    return;
  }
  const result = db.prepare(`
    UPDATE lessons SET subject_id = ?, content_type = ?, title = ?, summary = ?, content = ?
    WHERE id = ?
  `).run(input.subjectId, input.type, input.title, input.summary, input.content, routeId(req, "id"));
  if (!result.changes) {
    res.status(404).json({ error: "This lesson or note was not found." });
    return;
  }
  res.json({ updated: true });
});

app.post("/api/admin/assessments", authRequired, roleRequired("admin"), (req: AuthRequest, res) => {
  const input = validateBody(assessmentInputSchema, req, res);
  if (!input) return;
  const subject = db.prepare("SELECT id FROM subjects WHERE id = ?").get(input.subjectId);
  if (!subject) {
    res.status(404).json({ error: "Choose a valid learning area." });
    return;
  }
  const assessmentId = createId();
  const addAssessment = () => runInTransaction(() => {
    db.prepare(`
      INSERT INTO assessments (id, title, subject_id, kind, duration_minutes, opens_at, published, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(assessmentId, input.title, input.subjectId, input.kind, input.durationMinutes, input.opensAt, input.publish ? 1 : 0, req.user!.id);
    const insertQuestion = db.prepare(`
      INSERT INTO questions (id, assessment_id, prompt, options_json, correct_option, points, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    input.questions.forEach((question, index) => {
      insertQuestion.run(createId(), assessmentId, question.prompt, JSON.stringify(question.options), question.correctOption, question.points, index + 1);
    });
  });
  addAssessment();
  res.status(201).json({ assessmentId, questionCount: input.questions.length, published: input.publish });
});

app.put("/api/admin/assessments/:id", authRequired, roleRequired("admin"), (req, res) => {
  const input = validateBody(assessmentInputSchema, req, res);
  if (!input) return;
  const assessmentId = routeId(req, "id");
  const assessment = db.prepare("SELECT id FROM assessments WHERE id = ?").get(assessmentId);
  if (!assessment) {
    res.status(404).json({ error: "This assessment was not found." });
    return;
  }
  const subject = db.prepare("SELECT id FROM subjects WHERE id = ?").get(input.subjectId);
  if (!subject) {
    res.status(404).json({ error: "Choose a valid learning area." });
    return;
  }
  const attempts = db.prepare("SELECT 1 FROM attempts WHERE assessment_id = ? LIMIT 1").get(assessmentId);
  if (attempts) {
    res.status(409).json({ error: "This assessment already has learner attempts and can no longer be edited." });
    return;
  }
  runInTransaction(() => {
    db.prepare(`
      UPDATE assessments SET title = ?, subject_id = ?, kind = ?, duration_minutes = ?, opens_at = ?, published = ?
      WHERE id = ?
    `).run(input.title, input.subjectId, input.kind, input.durationMinutes, input.opensAt, input.publish ? 1 : 0, assessmentId);
    db.prepare("DELETE FROM questions WHERE assessment_id = ?").run(assessmentId);
    const insertQuestion = db.prepare(`
      INSERT INTO questions (id, assessment_id, prompt, options_json, correct_option, points, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    input.questions.forEach((question, index) => {
      insertQuestion.run(createId(), assessmentId, question.prompt, JSON.stringify(question.options), question.correctOption, question.points, index + 1);
    });
  });
  res.json({ updated: true, questionCount: input.questions.length, published: input.publish });
});

app.post("/api/admin/invitations", authRequired, roleRequired("admin"), (req: AuthRequest, res) => {
  const input = validateBody(z.object({
    grade: z.string().regex(/^Grade (?:[1-9]|1[0-2])$/),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  }), req, res);
  if (!input) return;
  const code = createInvitationCode();
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
  db.prepare("INSERT INTO invitations (code_hash, grade, created_by, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashInvitation(code), input.grade, req.user!.id, expiresAt);
  res.status(201).json({ code, grade: input.grade, expiresAt });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (typeof error === "object" && error !== null && "status" in error && error.status === 413) {
    res.status(413).json({ error: "The PDF is larger than the 20 MB upload limit." });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "The server could not complete that request." });
});

app.listen(port, host, () => {
  console.log(`Jifunze API listening on http://${host}:${port}`);
});
