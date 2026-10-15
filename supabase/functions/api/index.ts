import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2.4.3";
import { PDFDocument, rgb } from "npm:pdf-lib@1.17.1";
import { z } from "npm:zod@3.24.1";
import { gradeNumber, seniorCompulsorySubjects, seniorPathways } from "../_shared/curriculum.ts";
import { kenyaCounties } from "../_shared/kenya-counties.ts";

type Role = "student" | "teacher" | "class_coordinator" | "school_admin" | "super_admin" | "admin";
type Profile = {
  id: string;
  name: string;
  username: string | null;
  email: string;
  email_verified: boolean;
  user_code: string | null;
  role: Role;
  grade: string | null;
  school_id: string | null;
  class_id: string | null;
  assessment_number: string | null;
  stream: string | null;
  phone_number: string | null;
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

const passwordSchema = z.string().min(6).max(72);
const gradeSchema = z.string().regex(/^Grade (?:[1-9]|1[0-2])$/);
const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());

const resendEmailSchema = z.object({
  email: emailSchema,
});

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20).max(1000),
});

const forgotPasswordSchema = z.object({
  email: emailSchema,
});

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(8192),
  refreshToken: z.string().min(20).max(8192),
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
}).refine((input) => input.password === input.passwordConfirmation, {
  message: "Passwords do not match.",
  path: ["passwordConfirmation"],
});
const schoolAdminInvitationCodeSchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/),
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
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
const schoolNameSchema = z.string().trim().min(2).max(160).refine((value) => !/[%_*]/.test(value));
const phoneSchema = z.string().trim().min(7).max(24).transform((value) => {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 && digits.startsWith("0") ? `254${digits.slice(1)}` : digits;
}).refine((value) => /^\d{9,15}$/.test(value), "Enter a valid phone number.");
const kenyanPhoneSchema = z.string().trim().min(7).max(24).transform((value) => {
  const digits = value.replace(/\D/g, "");
  const local = digits.startsWith("254") ? digits.slice(3) : digits.startsWith("0") ? digits.slice(1) : "";
  return local ? `254${local}` : digits;
}).refine((value) => /^254(?:[17]\d{8}|[2-5]\d{7,8})$/.test(value), "Enter a valid Kenyan telephone number.");
const schoolCategorySchema = z.enum(["Primary", "Junior", "Senior", "Combined"]);
const schoolOwnershipSchema = z.enum(["Public", "Private"]);
const schoolInputSchema = z.object({
  name: schoolNameSchema,
  examinationCode: z.string().trim().min(2).max(40),
  category: schoolCategorySchema,
  ownership: schoolOwnershipSchema,
  county: z.string().refine((value) => (kenyaCounties as readonly string[]).includes(value), "Choose one of Kenya's 47 counties."),
  subCounty: z.string().trim().min(2).max(120),
  location: z.string().trim().min(2).max(200),
  telephone: kenyanPhoneSchema,
  email: emailSchema,
  poBox: z.string().trim().max(80).optional(),
  website: z.string().trim().url().max(255).optional().or(z.literal("")),
  grades: z.array(gradeSchema).min(1).max(12).refine((grades) => new Set(grades).size === grades.length, "Remove duplicate grades."),
}).strict();
const schoolAdministratorInputSchema = z.object({
  administratorName: z.string().trim().min(2).max(160),
  administratorEmail: emailSchema,
  administratorPhone: kenyanPhoneSchema,
  administratorDesignation: z.string().trim().min(2).max(100).default("School Administrator"),
}).strict();
const schoolEmailVerificationSchema = z.object({
  schoolId: z.string().uuid(),
  accessToken: z.string().min(20).max(8192),
  refreshToken: z.string().min(20).max(8192),
});
const teacherInvitationVerificationSchema = z.object({
  schoolName: schoolNameSchema,
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/),
});
const activateTeacherAccountSchema = z.object({
  accessToken: z.string().min(20).max(8192),
  refreshToken: z.string().min(20).max(8192),
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
}).refine((input) => input.password === input.passwordConfirmation, {
  message: "Passwords do not match.",
  path: ["passwordConfirmation"],
});
const schoolVerificationStatusSchema = z.enum(["pending", "verified", "rejected"]);
const schoolOperationalStatusSchema = z.enum(["active", "suspended", "archived"]);
const schoolStatusInputSchema = z.object({
  verificationStatus: schoolVerificationStatusSchema.optional(),
  operationalStatus: schoolOperationalStatusSchema.optional(),
}).refine((input) => input.verificationStatus !== undefined || input.operationalStatus !== undefined, {
  message: "Choose a school status to update.",
});
const schoolClassInputSchema = z.object({
  grade: gradeSchema,
  stream: z.string().trim().min(1).max(20),
  classTeacherId: z.string().uuid().optional(),
  coordinatorId: z.string().uuid().optional(),
});
const schoolSubjectInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  maxMarks: z.number().positive().max(100_000).default(100),
});
const schoolStudentInputSchema = z.object({
  classId: z.string().uuid(),
  fullName: z.string().trim().min(2).max(160),
  assessmentNumber: z.string().trim().min(2).max(40),
  guardianPhone: phoneSchema,
  subjectIds: z.array(z.string().uuid()).min(1).max(40),
});
const schoolTeacherInputSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: emailSchema,
  phoneNumber: phoneSchema,
  accountRole: z.enum(["teacher", "class_coordinator"]).default("teacher"),
  departmentHead: z.string().trim().max(100).optional(),
  subjectHead: z.string().trim().max(100).optional(),
  assignments: z.array(z.object({
    classId: z.string().uuid(),
    subjectId: z.string().uuid(),
  })).min(1).max(80),
});
const resultWindowInputSchema = z.object({
  grade: gradeSchema,
  term: z.number().int().min(1).max(3),
  half: z.enum(["mid-term", "end-term"]),
  opensAt: z.string().datetime(),
  deadline: z.string().datetime(),
}).refine((value) => new Date(value.deadline) > new Date(value.opensAt), {
  message: "The results deadline must be after the opening time.",
  path: ["deadline"],
});
const studentResultInputSchema = z.object({
  result: z.union([z.number().min(0).max(100_000), z.literal("Y")]),
  reason: z.string().trim().min(3).max(500).optional(),
}).superRefine((value, context) => {
  if (value.result === "Y" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Add a short reason when awarding Y." });
  }
});
const reportReleaseSchema = z.object({
  principalRemarks: z.string().trim().max(1500).default(""),
  classTeacherRemarks: z.string().trim().max(1500).default(""),
});
const subjectRemarkSchema = z.object({
  remark: z.string().trim().max(1500),
});
const studentLookupSchema = z.object({
  schoolName: schoolNameSchema,
  assessmentNumber: z.string().trim().min(2).max(40),
  guardianPhone: phoneSchema,
});
const studentSignupSchema = studentLookupSchema.extend({
  email: emailSchema,
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
}).refine((value) => value.password === value.passwordConfirmation, {
  message: "Passwords do not match.",
  path: ["passwordConfirmation"],
});
const teacherSignupSchema = z.object({
  schoolName: schoolNameSchema,
  activationCode: z.string().trim().regex(/^[0-9a-f]{16}$/i),
  email: emailSchema,
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
}).refine((value) => value.password === value.passwordConfirmation, {
  message: "Passwords do not match.",
  path: ["passwordConfirmation"],
});
const schoolLoginSchema = z.object({
  role: z.enum(["student", "teacher"]),
  schoolName: schoolNameSchema.optional(),
  identifier: z.string().trim().min(2).max(254),
  password: z.string().min(1).max(72),
});
const onboardingVerifySchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
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
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    userCode: user.user_code,
    role: user.role,
    grade: user.grade,
    schoolId: profile.school_id,
    classId: profile.class_id,
    assessmentNumber: profile.assessment_number,
    stream: profile.stream,
  };
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
  if (!profile.email_verified && data.user.email_confirmed_at) {
    const { error: verificationError } = await service.from("profiles").update({ email_verified: true }).eq("id", profile.id);
    if (verificationError) throw new Error(verificationError.message);
    profile.email_verified = true;
  }
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

function schoolAdminInviteRedirect(request: Request): string {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.has(origin)) {
    return "https://fidelsteven14-gif.github.io/vortexlearning2/";
  }
  return origin === "https://fidelsteven14-gif.github.io"
    ? `${origin}/vortexlearning2/`
    : `${origin}/`;
}

function schoolEmailVerificationRedirect(request: Request, schoolId: string): string {
  return `${schoolAdminInviteRedirect(request)}?schoolEmailVerification=${encodeURIComponent(schoolId)}`;
}

function staffActivationRedirect(request: Request): string {
  return `${schoolAdminInviteRedirect(request)}?activateStaff=1`;
}

async function sendSchoolEmailVerification(
  request: Request,
  school: { id: string; name: string; email: string; emailVerifiedAt: string | null; verificationUserId: string | null },
): Promise<{ sent: boolean; message: string }> {
  if (school.emailVerifiedAt) return { sent: false, message: "The school email address is already verified." };
  if (school.verificationUserId) {
    const { data: existingUser, error: lookupError } = await service.auth.admin.getUserById(school.verificationUserId);
    if (lookupError && !lookupError.message.toLowerCase().includes("not found")) {
      console.error("Pending school email verification lookup failed:", lookupError.name);
      return { sent: false, message: "The previous school email verification could not be checked. Contact support before sending another link." };
    }
    if (existingUser.user) {
      const { error } = await service.auth.admin.deleteUser(school.verificationUserId);
      if (error) {
        console.error("Pending school email verification cleanup failed:", error.name);
        return { sent: false, message: "The previous school email verification is still pending. Contact support before sending another link." };
      }
    }
  }

  const { data, error } = await service.auth.admin.inviteUserByEmail(school.email, {
    data: { name: school.name, schoolEmailVerificationId: school.id },
    redirectTo: schoolEmailVerificationRedirect(request, school.id),
  });
  if (error || !data.user) {
    if (error) console.error("School email verification invitation failed:", {
      name: error.name,
      status: error.status,
      code: error.code,
    });
    const { error: statusError } = await service.from("schools").update({
      email_verification_status: "failed",
      email_verification_user_id: null,
    }).eq("id", school.id);
    if (statusError) throw new Error(statusError.message);
    return {
      sent: false,
      message: "The school was saved, but its verification link could not be sent. Check the school email and Supabase email delivery settings, then retry.",
    };
  }

  let linkQuery = service.from("schools").update({
    email_verification_status: "sent",
    email_verification_user_id: data.user.id,
  }).eq("id", school.id).is("email_verified_at", null);
  linkQuery = school.verificationUserId
    ? linkQuery.eq("email_verification_user_id", school.verificationUserId)
    : linkQuery.is("email_verification_user_id", null);
  const { data: linked, error: updateError } = await linkQuery.select("id").maybeSingle();
  if (updateError) {
    console.error("School email verification link could not be linked:", updateError.code);
    const { error: deleteError } = await service.auth.admin.deleteUser(data.user.id);
    if (deleteError) console.error("Unlinked school verification account cleanup failed:", deleteError.name);
    throw new Error("The school was saved, but its verification link could not be linked. Contact support before retrying.");
  }
  if (!linked) {
    const { error: deleteError } = await service.auth.admin.deleteUser(data.user.id);
    if (deleteError) throw new Error("A superseded school email verification account could not be removed.");
    return { sent: false, message: "The school's email verification changed during this request. Refresh the school profile before trying again." };
  }
  return {
    sent: true,
    message: `Supabase accepted the verification email request for ${school.email}. Check the inbox and spam folder; delivery is not confirmed. If it does not arrive, review the custom SMTP provider's delivery logs.`,
  };
}

async function schoolLogoUrl(storageKey: string | null): Promise<string | null> {
  if (!storageKey) return null;
  const { data, error } = await service.storage.from("school-documents").createSignedUrl(storageKey, 3600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

async function schoolStorageObjects(schoolId: string): Promise<string[]> {
  const directories = [schoolId];
  const files: string[] = [];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await service.storage.from("school-documents")
        .list(directory, { limit: 1000, offset });
      if (error) throw new Error(error.message);
      for (const entry of data) {
        const key = `${directory}/${entry.name}`;
        if (entry.id === null) directories.push(key);
        else files.push(key);
      }
      if (data.length < 1000) break;
    }
  }
  return files;
}

async function offeredGradesForSchool(schoolId: string): Promise<string[]> {
  const { data, error } = await service.from("schools").select("grades").eq("id", schoolId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("The school linked to this account could not be found.");
  return (data.grades as string[] | null) ?? [];
}

async function sendSchoolAdminInvitation(
  request: Request,
  administrator: {
    id: string;
    schoolId: string;
    name: string;
    email: string;
    phone: string;
    designation: string;
    profileId: string | null;
    invitationStatus: string;
  },
): Promise<{ sent: boolean; message: string }> {
  const markFailed = async () => {
    const { error } = await service.from("teacher_records").update({ invitation_status: "failed" }).eq("id", administrator.id);
    if (error) throw new Error(error.message);
  };

  if (administrator.invitationStatus === "accepted") {
    return { sent: false, message: "This School Administrator account is already active." };
  }

  if (administrator.profileId) {
    const { data: existingProfile, error: profileError } = await service.from("profiles")
      .select("id,active,email").eq("id", administrator.profileId).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!existingProfile || existingProfile.email !== administrator.email) {
      return { sent: false, message: "The administrator invitation could not be safely matched to its account. Contact support." };
    }
    if (existingProfile.active) return { sent: false, message: "This School Administrator account is already active." };
    const { error } = await service.auth.resend({
      type: "signup",
      email: administrator.email,
      options: { emailRedirectTo: staffActivationRedirect(request) },
    });
    if (error) {
      console.error("School Administrator invitation resend failed:", error.name);
      await markFailed();
      return { sent: false, message: "The invitation email could not be resent. Check Supabase email delivery settings and retry." };
    }
    const { error: statusError } = await service.from("teacher_records")
      .update({ invitation_status: "sent" }).eq("id", administrator.id);
    if (statusError) throw new Error(statusError.message);
    return {
      sent: true,
      message: `A new activation link has been sent to ${administrator.email}. Open the email button to activate the account.`,
    };
  }

  const { data, error } = await service.auth.admin.inviteUserByEmail(administrator.email, {
    data: { name: administrator.name },
    redirectTo: schoolAdminInviteRedirect(request),
  });
  if (error || !data.user) {
    if (error) console.error("School Administrator invitation failed:", error.name);
    await markFailed();
    return {
      sent: false,
      message: "The school was saved, but the administrator invitation was not sent. Check the email address and Supabase email delivery settings, then retry.",
    };
  }

  const { data: profile, error: profileError } = await service.from("profiles").insert({
    id: data.user.id,
    name: administrator.name,
    username: null,
    email: administrator.email,
    email_verified: false,
    user_code: null,
    role: "school_admin",
    school_id: administrator.schoolId,
    phone_number: administrator.phone,
    active: false,
  }).select("id").maybeSingle();
  if (profileError || !profile) {
    console.error("School Administrator profile setup failed:", profileError?.code ?? "profile-missing");
    const { error: deleteError } = await service.auth.admin.deleteUser(data.user.id);
    if (deleteError) console.error("Unlinked School Administrator cleanup failed:", deleteError.name);
    await markFailed();
    return {
      sent: false,
      message: "The school was saved, but the administrator account could not be linked. Contact support before retrying.",
    };
  }

  const { data: linked, error: linkError } = await service.from("teacher_records").update({
    profile_id: data.user.id,
    invitation_status: "sent",
  }).eq("id", administrator.id).is("profile_id", null).select("id").maybeSingle();
  if (linkError || !linked) {
    console.error("School Administrator account link failed:", linkError?.code ?? "record-already-linked");
    const { error: deleteError } = await service.auth.admin.deleteUser(data.user.id);
    if (deleteError) console.error("Unlinked School Administrator cleanup failed:", deleteError.name);
    await markFailed();
    return {
      sent: false,
      message: "The school was saved, but the administrator account could not be linked. Contact support before retrying.",
    };
  }
  return { sent: true, message: "An account activation invitation has been sent to the School Administrator." };
}

async function sendSchoolStaffInvitation(
  request: Request,
  teacher: {
    id: string;
    schoolId: string;
    name: string;
    email: string;
    phone: string;
    role: "teacher" | "class_coordinator";
    profileId: string | null;
  },
): Promise<{ sent: boolean; message: string }> {
  const setInvitationStatus = async (status: "sent" | "failed") => {
    const { error } = await service.from("teacher_records")
      .update({ invitation_status: status }).eq("id", teacher.id);
    if (error) throw new Error(error.message);
  };

  if (teacher.profileId) {
    const { data: profile, error: profileError } = await service.from("profiles")
      .select("id,email,active,role,school_id").eq("id", teacher.profileId).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile || profile.email !== teacher.email || profile.school_id !== teacher.schoolId || profile.role !== teacher.role) {
      return { sent: false, message: "The invitation does not match this teacher's school and email. Contact support." };
    }
    if (profile.active) return { sent: false, message: "This teacher account is already active." };
    const { error } = await service.auth.resend({
      type: "signup",
      email: teacher.email,
      options: { emailRedirectTo: staffActivationRedirect(request) },
    });
    if (error) {
      console.error("School staff invitation resend failed:", error.name);
      await setInvitationStatus("failed");
      return { sent: false, message: "The verification code could not be resent. Check Supabase email delivery settings and retry." };
    }
    await setInvitationStatus("sent");
    return { sent: true, message: `A new activation email has been sent to ${teacher.email}. Open its secure button to activate the account.` };
  }

  const temporaryPassword = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { data, error } = await authClient().auth.signUp({
    email: teacher.email,
    password: temporaryPassword,
    options: {
      data: { name: teacher.name },
      emailRedirectTo: staffActivationRedirect(request),
    },
  });
  if (error || !data.user || data.user.identities?.length === 0) {
    if (error) console.error("School staff invitation failed:", error.name);
    if (data.user && data.user.identities?.length !== 0) {
      const { error: deleteError } = await service.auth.admin.deleteUser(data.user.id);
      if (deleteError) console.error("Unlinked school staff account cleanup failed:", deleteError.name);
    }
    await setInvitationStatus("failed");
    return { sent: false, message: "The teacher record was saved, but its verification email was not sent. Correct the email delivery issue and resend the invitation." };
  }

  const { data: linkedProfile, error: profileError } = await service.from("profiles").insert({
    id: data.user.id,
    name: teacher.name,
    username: null,
    email: teacher.email,
    email_verified: false,
    user_code: null,
    role: teacher.role,
    grade: null,
    school_id: teacher.schoolId,
    class_id: null,
    phone_number: teacher.phone,
    active: false,
  }).select("id").maybeSingle();
  if (profileError || !linkedProfile) {
    console.error("School staff profile setup failed:", profileError?.code ?? "profile-missing");
    const { error: deleteError } = await service.auth.admin.deleteUser(data.user.id);
    if (deleteError) console.error("Unlinked school staff account cleanup failed:", deleteError.name);
    await setInvitationStatus("failed");
    return { sent: false, message: "The teacher record was saved, but its invitation could not be linked. Contact support before retrying." };
  }

  const { data: linkedTeacher, error: linkError } = await service.from("teacher_records").update({
    profile_id: data.user.id,
    invitation_status: "sent",
  }).eq("id", teacher.id).is("profile_id", null).select("id").maybeSingle();
  if (linkError || !linkedTeacher) {
    console.error("School staff account link failed:", linkError?.code ?? "record-already-linked");
    const { error: deleteError } = await service.auth.admin.deleteUser(data.user.id);
    if (deleteError) console.error("Unlinked school staff account cleanup failed:", deleteError.name);
    await setInvitationStatus("failed");
    return { sent: false, message: "The teacher record was saved, but its invitation could not be linked. Contact support before retrying." };
  }
  return { sent: true, message: `An activation email with a one-time code and secure button has been sent to ${teacher.email}.` };
}

function randomId(): string {
  return crypto.randomUUID();
}

async function appSession(session: { access_token: string; refresh_token: string }, userId: string): Promise<Record<string, unknown>> {
  const profile = await profileById(userId);
  if (!profile || !profile.active) throw new Error("The verified account profile is unavailable. Please contact support.");
  if (!profile.email_verified) throw new Error("Verify your email before signing in. You can request a new verification code below.");
  return { token: session.access_token, refreshToken: session.refresh_token, user: userForClient(profile) };
}

async function authRoutes(request: Request, path: string): Promise<Response | null> {
  const limited = async (limit: number, seconds: number): Promise<boolean> =>
    await rateAllowed(request, path, limit, seconds);

  if (request.method === "POST" && path === "/api/auth/verify-school-email") {
    if (!await limited(8, 900)) return fail("Too many school email verification attempts. Please wait and try again.", 429);
    const parsed = schoolEmailVerificationSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const client = authClient();
    const { data: session, error: sessionError } = await client.auth.setSession({
      access_token: parsed.data.accessToken,
      refresh_token: parsed.data.refreshToken,
    });
    if (sessionError || !session.user?.email || !session.user.email_confirmed_at) {
      return fail("This school email link is invalid or expired. Ask the Super Admin to resend it.", 400);
    }
    const { data: school, error: schoolError } = await service.from("schools")
      .select("id,email,email_verification_required,email_verified_at,email_verification_user_id")
      .eq("id", parsed.data.schoolId).maybeSingle();
    if (schoolError) throw new Error(schoolError.message);
    if (!school || !school.email_verification_required || school.email !== session.user.email.toLowerCase()) {
      return fail("This link is not valid for the registered school email address.", 403);
    }
    if (school.email_verified_at) {
      return json({ message: "The school email address is already verified." });
    }
    if (school.email_verification_user_id !== session.user.id) {
      return fail("This school email link is no longer active. Ask the Super Admin to resend it.", 403);
    }
    const { error: deleteError } = await service.auth.admin.deleteUser(session.user.id);
    if (deleteError) {
      console.error("Temporary school email verification account cleanup failed:", deleteError.name);
      return fail("The email was confirmed, but the verification could not be completed. Please try the link again.", 500);
    }
    const { data: verifiedSchool, error: updateError } = await service.from("schools").update({
      email_verified_at: new Date().toISOString(),
      email_verification_status: "verified",
      email_verification_user_id: null,
      operational_status: "active",
      active: true,
    }).eq("id", school.id).eq("email_verification_user_id", session.user.id)
      .is("email_verified_at", null).select("id").maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (!verifiedSchool) return fail("The school email verification was already completed or the link has expired.", 409);
    return json({ message: "The school email address is verified. The Super Admin can now create the School Administrator account." });
  }

  if (request.method === "POST" && path === "/api/auth/resend-verification") {
    if (!await limited(5, 3600)) return fail("Too many verification requests. Please wait and try again.", 429);
    const parsed = resendEmailSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const { error } = await authClient().auth.resend({ type: "signup", email: parsed.data.email });
    if (error) console.error("Supabase verification resend failed:", error.name);
    return json({ message: "If this account needs verification, a new code has been sent." }, 202);
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

  if (request.method === "POST" && path === "/api/auth/accept-school-invitation") {
    if (!await limited(10, 900)) return fail("Too many invitation attempts. Please wait and try again.", 429);
    const parsed = resetPasswordSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const client = authClient();
    const { data, error } = await client.auth.setSession({
      access_token: parsed.data.token,
      refresh_token: parsed.data.refreshToken,
    });
    if (error || !data.session || !data.user?.email) return fail("This invitation is invalid or has expired. Ask your School Administrator to resend it.", 400);

    const { data: profile, error: profileError } = await service.from("profiles")
      .select("id,email,role,active,school_id")
      .eq("id", data.user.id).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile || !["school_admin", "teacher", "class_coordinator"].includes(profile.role)
      || profile.active || profile.email !== data.user.email.toLowerCase()) {
      return fail("This invitation is not valid for this school staff account.", 403);
    }
    if (!data.user.email_confirmed_at) {
      return fail("Confirm your email using the invitation link before choosing a password.", 400);
    }
    const { data: staffRecord, error: staffError } = await service.from("teacher_records")
      .select("id,school_id,teacher_email,administrator_email,account_role,invitation_status")
      .eq("profile_id", data.user.id).maybeSingle();
    if (staffError) throw new Error(staffError.message);
    const recordEmail = profile.role === "school_admin" ? staffRecord?.administrator_email : staffRecord?.teacher_email;
    if (!staffRecord || staffRecord.school_id !== profile.school_id || recordEmail !== profile.email
      || staffRecord.account_role !== profile.role || !["sent", "verified"].includes(staffRecord.invitation_status)) {
      return fail("This invitation is not linked to a pending account at your school.", 403);
    }

    const { error: passwordError } = await client.auth.updateUser({ password: parsed.data.password });
    if (passwordError) return fail("Your password could not be set. Ask the person who registered your account to resend the invitation.", 400);
    const { data: activated, error: activateError } = await service.from("profiles").update({
      active: true,
      email_verified: true,
    }).eq("id", data.user.id).eq("role", profile.role).eq("active", false).select("id").maybeSingle();
    if (activateError) throw new Error(activateError.message);
    if (!activated) return fail("The invitation was already used or has expired. Sign in or ask for a new invitation.", 409);
    const { error: invitationUpdateError } = await service.from("teacher_records")
      .update({ invitation_status: "accepted" }).eq("id", staffRecord.id);
    if (invitationUpdateError) throw new Error(invitationUpdateError.message);
    return json({
      ...await appSession(data.session, data.user.id),
      message: "Your email is confirmed and your account is active.",
    });
  }

  if (request.method === "POST" && path === "/api/auth/accept-school-invitation-code") {
    if (!await limited(8, 900)) return fail("Too many invitation attempts. Please wait and try again.", 429);
    const parsed = schoolAdminInvitationCodeSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const { data, error } = await authClient().auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.code,
      type: "signup",
    });
    if (error || !data.user?.email || !data.session) return fail("That verification code is invalid or expired. Ask the Super Admin to resend your invitation.", 400);
    const { data: profile, error: profileError } = await service.from("profiles")
      .select("id,email,role,active,school_id").eq("id", data.user.id).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile || profile.role !== "school_admin" || profile.active || profile.email !== parsed.data.email) {
      return fail("This invitation is not valid for a pending School Administrator account.", 403);
    }
    const { data: administrator, error: administratorError } = await service.from("teacher_records")
      .select("id,school_id").eq("profile_id", data.user.id).eq("account_role", "school_admin").maybeSingle();
    if (administratorError) throw new Error(administratorError.message);
    if (!administrator || administrator.school_id !== profile.school_id) {
      return fail("This invitation is not linked to a school administrator record.", 403);
    }
    const client = authClient();
    const { error: sessionError } = await client.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    if (sessionError) return fail("Your email was confirmed but the account could not be activated. Ask the Super Admin to resend your invitation.", 400);
    const { error: passwordError } = await client.auth.updateUser({ password: parsed.data.password });
    if (passwordError) return fail("Your password could not be set. Ask the Super Admin to resend your invitation.", 400);
    const { data: activated, error: activateError } = await service.from("profiles").update({
      active: true,
      email_verified: true,
    }).eq("id", data.user.id).eq("role", "school_admin").eq("active", false).select("id").maybeSingle();
    if (activateError) throw new Error(activateError.message);
    if (!activated) return fail("The invitation was already used or has expired. Sign in or ask for a new invitation.", 409);
    const { error: invitationUpdateError } = await service.from("teacher_records")
      .update({ invitation_status: "accepted" }).eq("id", administrator.id);
    if (invitationUpdateError) throw new Error(invitationUpdateError.message);
    return json({ message: "Your email is confirmed and your School Administrator account is ready. You can now sign in." });
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

async function schoolByName(name: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await service.from("schools").select("id,name")
    .ilike("name", name.trim()).eq("active", true).maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; name: string } | null;
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createTeacherActivationCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function studentRosterMatch(input: z.infer<typeof studentLookupSchema>) {
  const school = await schoolByName(input.schoolName);
  if (!school) return null;
  const assessmentNumber = input.assessmentNumber.trim().toUpperCase();
  const { data, error } = await service.from("student_rosters")
    .select("id,school_id,assessment_number,full_name,guardian_phone_hash,profile_id,school_classes!inner(id,grade,stream),student_roster_subjects(school_subjects!inner(id,name))")
    .eq("school_id", school.id)
    .eq("assessment_number", assessmentNumber)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const roster = data as {
    id: string;
    school_id: string;
    assessment_number: string;
    full_name: string;
    guardian_phone_hash: string;
    profile_id: string | null;
    school_classes: { id: string; grade: string; stream: string };
    student_roster_subjects: Array<{ school_subjects: { id: string; name: string } }>;
  } | null;
  if (!roster || roster.profile_id || !await bcrypt.compare(input.guardianPhone, roster.guardian_phone_hash)) return null;
  return {
    roster,
    school,
    student: {
      name: roster.full_name,
      assessmentNumber: roster.assessment_number,
      grade: roster.school_classes.grade,
      stream: roster.school_classes.stream,
      subjects: roster.student_roster_subjects.map(({ school_subjects }) => ({ id: school_subjects.id, name: school_subjects.name })),
    },
  };
}

async function onboardingRoutes(request: Request, path: string): Promise<Response | null> {
  if (path === "/api/onboarding/student/lookup" && request.method === "POST") {
    if (!await rateAllowed(request, path, 8, 900)) return fail("Too many activation attempts. Please wait and try again.", 429);
    const parsed = studentLookupSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const match = await studentRosterMatch(parsed.data);
    if (!match) return fail("We could not verify those details. Check them with your school and try again.", 400);
    return json({ student: match.student });
  }

  if (path === "/api/onboarding/register-student" && request.method === "POST") {
    if (!await rateAllowed(request, path, 5, 3600)) return fail("Too many activation attempts. Please wait and try again.", 429);
    const parsed = studentSignupSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const input = parsed.data;
    if (!await studentRosterMatch(input)) return fail("We could not verify those details. Check them with your school and try again.", 400);
    const { data, error } = await authClient().auth.signUp({ email: input.email, password: input.password });
    if (error || !data.user || data.user.identities?.length === 0) {
      if (error) console.error("Student account signup failed:", error.name);
      return fail("The account could not be created. Verify the email is unused, then try again.", 409);
    }
    const match = await studentRosterMatch(input);
    if (!match) {
      await service.auth.admin.deleteUser(data.user.id);
      return fail("We could not verify those details. Check them with your school and try again.", 400);
    }
    const { error: claimError } = await service.from("pending_account_claims").insert({
      user_id: data.user.id,
      account_type: "student",
      roster_id: match.roster.id,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    if (claimError) {
      await service.auth.admin.deleteUser(data.user.id);
      if (claimError.code === "23505") return fail("This student record is already being activated or has an account.", 409);
      throw new Error(claimError.message);
    }
    return json({ message: `A verification code has been sent to ${input.email}.`, email: input.email }, 201);
  }

  if (path === "/api/onboarding/verify-teacher-invitation" && request.method === "POST") {
    if (!await rateAllowed(request, path, 8, 900)) return fail("Too many verification attempts. Please wait and try again.", 429);
    const parsed = teacherInvitationVerificationSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const school = await schoolByName(parsed.data.schoolName);
    if (!school) return fail("The school or activation details could not be verified.", 400);
    const { data: teacherRow, error: teacherError } = await service.from("teacher_records")
      .select("id,school_id,teacher_email,phone_number,profile_id,account_role,invitation_status")
      .eq("school_id", school.id).eq("teacher_email", parsed.data.email).maybeSingle();
    if (teacherError) throw new Error(teacherError.message);
    const teacher = teacherRow as {
      id: string; school_id: string; teacher_email: string; phone_number: string; profile_id: string | null;
      account_role: "teacher" | "class_coordinator"; invitation_status: string;
    } | null;
    if (!teacher || !teacher.profile_id || !["sent", "verified"].includes(teacher.invitation_status)) {
      return fail("The code does not match the email address registered for this teacher. Check both and try again.", 400);
    }
    const { data, error } = await authClient().auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.code,
      type: "signup",
    });
    if (error || !data.user?.email || !data.session) {
      return fail("The code is invalid or expired, or it was sent to a different email address. Check the registered email or ask the School Administrator to resend it.", 400);
    }
    if (data.user.id !== teacher.profile_id || data.user.email.toLowerCase() !== teacher.teacher_email) {
      return fail("This verification code does not belong to the teacher email registered by the School Administrator.", 403);
    }
    const { data: profile, error: profileError } = await service.from("profiles")
      .select("id,role,school_id,active").eq("id", teacher.profile_id).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile || profile.role !== teacher.account_role || profile.school_id !== teacher.school_id || profile.active) {
      return fail("This teacher invitation is no longer pending.", 409);
    }
    const { error: statusError } = await service.from("teacher_records")
      .update({ invitation_status: "verified" }).eq("id", teacher.id).eq("profile_id", teacher.profile_id);
    if (statusError) throw new Error(statusError.message);
    return json({
      message: "Email verified. Now create your password to finish activating your account.",
      email: teacher.teacher_email,
      phoneNumber: teacher.phone_number,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    });
  }

  if (path === "/api/onboarding/activate-teacher-account" && request.method === "POST") {
    if (!await rateAllowed(request, path, 8, 900)) return fail("Too many activation attempts. Please wait and try again.", 429);
    const parsed = activateTeacherAccountSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const client = authClient();
    const { data: session, error: sessionError } = await client.auth.setSession({
      access_token: parsed.data.accessToken,
      refresh_token: parsed.data.refreshToken,
    });
    if (sessionError || !session.user?.email) return fail("Your verified session expired. Verify the emailed code again.", 401);
    const { data: teacherRow, error: teacherError } = await service.from("teacher_records")
      .select("id,school_id,teacher_email,profile_id,invitation_status")
      .eq("profile_id", session.user.id).maybeSingle();
    if (teacherError) throw new Error(teacherError.message);
    const teacher = teacherRow as {
      id: string; school_id: string; teacher_email: string; profile_id: string; invitation_status: string;
    } | null;
    if (!teacher || teacher.invitation_status !== "verified" || teacher.teacher_email !== session.user.email.toLowerCase()
      || !session.user.email_confirmed_at) {
      return fail("Verify the invitation using the same email address recorded by the School Administrator before setting a password.", 403);
    }
    const { error: passwordError } = await client.auth.updateUser({ password: parsed.data.password });
    if (passwordError) return fail("The password could not be saved. Verify your email again and retry.", 400);
    const { data: activated, error: activationError } = await service.from("profiles").update({
      email_verified: true,
      active: true,
    }).eq("id", teacher.profile_id).eq("school_id", teacher.school_id).eq("active", false)
      .select("id").maybeSingle();
    if (activationError) throw new Error(activationError.message);
    if (!activated) return fail("This teacher account was already activated. Sign in with your new password.", 409);
    const { error: statusError } = await service.from("teacher_records")
      .update({ invitation_status: "accepted" }).eq("id", teacher.id).eq("profile_id", teacher.profile_id);
    if (statusError) throw new Error(statusError.message);
    return json({ message: "Your password is set and your account is active. Sign in to open your school dashboard." });
  }

  if (path === "/api/onboarding/register-teacher" && request.method === "POST") {
    if (!await rateAllowed(request, path, 5, 3600)) return fail("Too many activation attempts. Please wait and try again.", 429);
    const parsed = teacherSignupSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const input = parsed.data;
    const school = await schoolByName(input.schoolName);
    if (!school) return fail("The school or activation code could not be verified.", 400);
    const codeHash = await digestHex(input.activationCode.toLowerCase());
    const { data: codeRow, error: codeError } = await service.from("teacher_activation_codes")
      .select("id,teacher_id,expires_at,used_at,teacher_records!inner(id,school_id,profile_id)")
      .eq("code_hash", codeHash).eq("teacher_records.school_id", school.id).maybeSingle();
    if (codeError) throw new Error(codeError.message);
    const activation = codeRow as {
      id: string;
      teacher_id: string;
      expires_at: string;
      used_at: string | null;
      teacher_records: { id: string; school_id: string; profile_id: string | null };
    } | null;
    if (!activation || activation.used_at || new Date(activation.expires_at).getTime() <= Date.now() || activation.teacher_records.profile_id) {
      return fail("The school or activation code could not be verified.", 400);
    }
    const { data, error } = await authClient().auth.signUp({ email: input.email, password: input.password });
    if (error || !data.user || data.user.identities?.length === 0) {
      if (error) console.error("Teacher account signup failed:", error.name);
      return fail("The account could not be created. Verify the email is unused, then try again.", 409);
    }
    const { error: claimError } = await service.from("pending_account_claims").insert({
      user_id: data.user.id,
      account_type: "teacher",
      teacher_id: activation.teacher_id,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    if (claimError) {
      await service.auth.admin.deleteUser(data.user.id);
      if (claimError.code === "23505") return fail("This teacher record is already being activated or has an account.", 409);
      throw new Error(claimError.message);
    }
    return json({ message: `A verification code has been sent to ${input.email}.`, email: input.email }, 201);
  }

  if (path === "/api/onboarding/verify-email" && request.method === "POST") {
    if (!await rateAllowed(request, path, 8, 900)) return fail("Too many verification attempts. Please wait and try again.", 429);
    const parsed = onboardingVerifySchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const { data, error } = await authClient().auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.code,
      type: "signup",
    });
    if (error || !data.user?.email) return fail("That verification code is invalid or expired. Request a new code and try again.", 400);
    const { data: claimData, error: claimError } = await service.from("pending_account_claims")
      .select("user_id,account_type,roster_id,teacher_id,expires_at")
      .eq("user_id", data.user.id).maybeSingle();
    if (claimError) throw new Error(claimError.message);
    const claim = claimData as {
      user_id: string;
      account_type: "student" | "teacher";
      roster_id: string | null;
      teacher_id: string | null;
      expires_at: string;
    } | null;
    if (!claim || new Date(claim.expires_at).getTime() <= Date.now()) {
      await service.from("pending_account_claims").delete().eq("user_id", data.user.id);
      return fail("This activation has expired. Start activation again using your school details.", 410);
    }

    if (claim.account_type === "student" && claim.roster_id) {
      const { data: rosterData, error: rosterError } = await service.from("student_rosters")
        .select("id,school_id,assessment_number,full_name,class_id,school_classes!inner(grade,stream)")
        .eq("id", claim.roster_id).is("profile_id", null).maybeSingle();
      if (rosterError) throw new Error(rosterError.message);
      const roster = rosterData as {
        id: string; school_id: string; assessment_number: string; full_name: string; class_id: string;
        school_classes: { grade: string; stream: string };
      } | null;
      if (!roster) return fail("This student record has already been activated. Contact the school if you need help.", 409);
      const { error: profileError } = await service.from("profiles").insert({
        id: data.user.id, name: roster.full_name, username: null, email: data.user.email.toLowerCase(),
        email_verified: true, user_code: null, role: "student", grade: roster.school_classes.grade,
        school_id: roster.school_id, class_id: roster.class_id, assessment_number: roster.assessment_number,
        stream: roster.school_classes.stream, curriculum_registered: true, active: true,
      });
      if (profileError) {
        if (profileError.code === "23505") return fail("This student record or email is already associated with an account.", 409);
        throw new Error(profileError.message);
      }
      const { data: linked, error: linkError } = await service.from("student_rosters").update({ profile_id: data.user.id })
        .eq("id", roster.id).is("profile_id", null).select("id").maybeSingle();
      if (linkError) throw new Error(linkError.message);
      if (!linked) {
        await service.from("profiles").delete().eq("id", data.user.id);
        return fail("This student record has already been activated. Contact the school if you need help.", 409);
      }
    } else if (claim.account_type === "teacher" && claim.teacher_id) {
      const { data: teacherData, error: teacherError } = await service.from("teacher_records")
        .select("id,school_id,full_name,phone_number,phone_normalized,profile_id,account_role")
        .eq("id", claim.teacher_id).is("profile_id", null).maybeSingle();
      if (teacherError) throw new Error(teacherError.message);
      const teacher = teacherData as {
        id: string; school_id: string; full_name: string; phone_number: string; phone_normalized: string; profile_id: string | null;
        account_role: "teacher" | "class_coordinator";
      } | null;
      if (!teacher) return fail("This teacher record has already been activated. Contact the School Administrator.", 409);
      const { error: profileError } = await service.from("profiles").insert({
        id: data.user.id, name: teacher.full_name, username: null, email: data.user.email.toLowerCase(),
        email_verified: true, user_code: null, role: teacher.account_role, grade: null, school_id: teacher.school_id,
        phone_number: teacher.phone_number, active: true,
      });
      if (profileError) {
        if (profileError.code === "23505") return fail("This email is already associated with an account.", 409);
        throw new Error(profileError.message);
      }
      const { data: linked, error: linkError } = await service.from("teacher_records").update({ profile_id: data.user.id })
        .eq("id", teacher.id).is("profile_id", null).select("id").maybeSingle();
      if (linkError) throw new Error(linkError.message);
      if (!linked) {
        await service.from("profiles").delete().eq("id", data.user.id);
        return fail("This teacher record has already been activated. Contact the School Administrator.", 409);
      }
      const { error: codeError } = await service.from("teacher_activation_codes")
        .update({ used_at: new Date().toISOString() }).eq("teacher_id", teacher.id).is("used_at", null);
      if (codeError) throw new Error(codeError.message);
    }
    const { error: deleteClaimError } = await service.from("pending_account_claims").delete().eq("user_id", data.user.id);
    if (deleteClaimError) throw new Error(deleteClaimError.message);
    return json({ message: "Your email is verified. You can now sign in with your school details." });
  }

  if (path === "/api/auth/school-login" && request.method === "POST") {
    if (!await rateAllowed(request, path, 20, 900)) return fail("Too many sign-in attempts. Please wait and try again.", 429);
    const parsed = schoolLoginSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const input = parsed.data;
    const platformSchoolName = input.schoolName?.trim().replace(/\s+/g, "").toLowerCase() === "vortexlearning";
    const isPlatformAdminLogin = input.role === "teacher" && (!input.schoolName || platformSchoolName);
    const school = input.schoolName && !platformSchoolName ? await schoolByName(input.schoolName) : null;
    if (input.role === "student" && !school) return fail("School, account number, or password is incorrect.", 401);
    let email: string | null = null;
    if (isPlatformAdminLogin) {
      const normalizedEmail = emailSchema.safeParse(input.identifier);
      if (normalizedEmail.success) {
        const { data, error } = await service.from("profiles").select("email,active,email_verified,role")
          .eq("email", normalizedEmail.data).in("role", ["super_admin", "admin"])
          .maybeSingle();
        if (error) throw new Error(error.message);
        const profile = data as { email: string; active: boolean; email_verified: boolean } | null;
        if (profile?.active && profile.email_verified) email = profile.email;
      } else {
        const normalizedPhone = phoneSchema.safeParse(input.identifier);
        if (normalizedPhone.success) {
          const phoneCandidates = [...new Set([
            normalizedPhone.data,
            `+${normalizedPhone.data}`,
            input.identifier.replace(/\D/g, ""),
          ])];
          const { data, error } = await service.from("profiles").select("email,active,email_verified,role")
            .in("phone_number", phoneCandidates).in("role", ["super_admin", "admin"]).maybeSingle();
          if (error) throw new Error(error.message);
          const profile = data as { email: string; active: boolean; email_verified: boolean } | null;
          if (profile?.active && profile.email_verified) email = profile.email;
        }
      }
    } else if (input.role === "student") {
      const { data, error } = await service.from("profiles").select("email,active,email_verified")
        .eq("school_id", school!.id).eq("assessment_number", input.identifier.trim().toUpperCase())
        .eq("role", "student").maybeSingle();
      if (error) throw new Error(error.message);
      const profile = data as { email: string; active: boolean; email_verified: boolean } | null;
      if (profile?.active && profile.email_verified) email = profile.email;
    } else if (school) {
      const normalizedEmail = emailSchema.safeParse(input.identifier);
      if (normalizedEmail.success) {
        const { data, error } = await service.from("profiles").select("email,active,email_verified,role")
          .eq("school_id", school.id).eq("email", normalizedEmail.data)
          .in("role", ["teacher", "class_coordinator", "school_admin"]).maybeSingle();
        if (error) throw new Error(error.message);
        const profile = data as { email: string; active: boolean; email_verified: boolean } | null;
        if (profile?.active && profile.email_verified) email = profile.email;
      } else {
        const normalizedPhone = phoneSchema.safeParse(input.identifier);
        if (normalizedPhone.success) {
          const { data, error } = await service.from("teacher_records").select("profiles!inner(email,active,email_verified,role)")
            .eq("school_id", school.id).eq("phone_normalized", normalizedPhone.data)
            .in("profiles.role", ["teacher", "class_coordinator", "school_admin"]).maybeSingle();
          if (error) throw new Error(error.message);
          const profile = (data as { profiles: { email: string; active: boolean; email_verified: boolean; role: string } } | null)?.profiles;
          if (profile?.active && profile.email_verified) email = profile.email;
        }
      }
    }
    if (!email) return fail("School, account number, or password is incorrect.", 401);
    const { data, error } = await authClient().auth.signInWithPassword({ email, password: input.password });
    if (error || !data.session || !data.user) return fail("School, account number, or password is incorrect.", 401);
    if (!data.user.email_confirmed_at) return fail("Verify your email before signing in. Check your inbox.", 403);
    const { error: verifyError } = await service.from("profiles").update({ email_verified: true })
      .eq("id", data.user.id).eq("email_verified", false);
    if (verifyError) throw new Error(verifyError.message);
    const output = await appSession(data.session, data.user.id);
    await service.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", data.user.id);
    return json(output);
  }

  return null;
}

async function schoolManagementRoutes(request: Request, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/super-admin/") && !path.startsWith("/api/school/")) return null;
  const auth = await authenticate(request);
  if (!isAuthContext(auth)) return auth;
  const profile = auth.profile;
  const isSuperAdmin = profile.role === "super_admin" || profile.role === "admin";

  if (path.startsWith("/api/school/") && profile.school_id) {
    const { data: school, error } = await service.from("schools").select("active")
      .eq("id", profile.school_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!school?.active) return fail("This school is suspended or archived. Contact the platform administrator.", 403);
  }

  const activeWindowIds = async (schoolId: string, grade?: string) => {
    const query = service.from("result_windows").select("id,grade,term,half,deadline,status")
      .eq("school_id", schoolId).in("status", ["scheduled", "open", "closed", "coordinator_review", "admin_review", "released"]);
    const { data, error } = grade ? await query.eq("grade", grade).order("term").order("half") : await query.order("term").order("half");
    if (error) throw new Error(error.message);
    const windows = data as Array<{ id: string; grade: string; term: number; half: string; deadline: string; status: string }>;
    for (const window of windows) {
      if (window.status === "scheduled") {
        const { data: rawWindow, error: rawWindowError } = await service.from("result_windows").select("opens_at").eq("id", window.id).single();
        if (rawWindowError) throw new Error(rawWindowError.message);
        if (new Date(rawWindow.opens_at).getTime() <= Date.now()) {
          const { error: openError } = await service.from("result_windows").update({ status: "open" }).eq("id", window.id).eq("status", "scheduled");
          if (openError) throw new Error(openError.message);
          window.status = "open";
        }
      }
      if (window.status === "open" && new Date(window.deadline).getTime() <= Date.now()) {
        const { error: finalizeError } = await service.from("student_results").update({
          result_code: "X",
          mark: null,
          updated_at: new Date().toISOString(),
        }).eq("window_id", window.id).eq("result_code", "pending");
        if (finalizeError) throw new Error(finalizeError.message);
        const { error: windowError } = await service.from("result_windows")
          .update({ status: "coordinator_review" }).eq("id", window.id).eq("status", "open");
        if (windowError) throw new Error(windowError.message);
        window.status = "coordinator_review";
      }
    }
    return windows;
  };

  const teacherAssignments = async (teacherId: string) => {
    const { data, error } = await service.from("teacher_class_subjects").select("class_id,subject_id")
      .eq("teacher_id", teacherId);
    if (error) throw new Error(error.message);
    return data as Array<{ class_id: string; subject_id: string }>;
  };

  const currentTeacher = async () => {
    const { data, error } = await service.from("teacher_records").select("id,department_head")
      .eq("profile_id", profile.id).eq("school_id", profile.school_id!).maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; department_head: string | null } | null;
  };

  if (path === "/api/school/student-overview" && request.method === "GET") {
    if (profile.role !== "student" || !profile.school_id || !profile.class_id) {
      return fail("This student account is not assigned to an active school class.", 403);
    }
    const [schoolResult, classResult, rosterResult, timetableResult] = await Promise.all([
      service.from("schools").select("name,logo_storage_key,email,po_box").eq("id", profile.school_id).single(),
      service.from("school_classes").select("grade,stream").eq("id", profile.class_id).single(),
      service.from("student_rosters").select("id,student_roster_subjects(school_subjects!inner(id,name,max_marks))")
        .eq("profile_id", profile.id).maybeSingle(),
      service.from("school_timetables").select("id,grade,original_filename,storage_key,expires_at")
        .eq("school_id", profile.school_id).eq("grade", profile.grade ?? "")
        .gt("expires_at", new Date().toISOString()).order("sent_at", { ascending: false }),
    ]);
    for (const result of [schoolResult, classResult, rosterResult, timetableResult]) {
      if (result.error) throw new Error(result.error.message);
    }
    if (!classResult.data) return fail("Your assigned class could not be found.", 404);
    const roster = rosterResult.data as {
      id: string;
      student_roster_subjects: Array<{ school_subjects: Array<{ id: string; name: string; max_marks: number }> }>;
    } | null;
    if (!roster) return fail("Your school roster is unavailable. Contact your Class Teacher.", 404);
    const [noticesResult, reportsResult] = await Promise.all([
      service.from("student_notices").select("id,window_id,message,created_at")
        .eq("roster_id", roster.id).order("created_at", { ascending: false }),
      service.from("student_report_copies").select("id,window_id,storage_key,generated_at,expires_at")
        .eq("roster_id", roster.id).is("deleted_at", null).gt("expires_at", new Date().toISOString())
        .order("generated_at", { ascending: false }),
    ]);
    if (noticesResult.error) throw new Error(noticesResult.error.message);
    if (reportsResult.error) throw new Error(reportsResult.error.message);
    const reportRows = reportsResult.data as Array<{
      id: string; window_id: string; storage_key: string; generated_at: string; expires_at: string;
    }>;
    const reportWindowIds = [...new Set(reportRows.map(({ window_id }) => window_id))];
    const resultCodeResult = reportWindowIds.length
      ? await service.from("student_results").select("window_id,result_code")
        .eq("roster_id", roster.id).in("window_id", reportWindowIds).in("result_code", ["X", "Y"])
      : { data: [], error: null };
    if (resultCodeResult.error) throw new Error(resultCodeResult.error.message);
    const withheldWindowIds = new Set((resultCodeResult.data as Array<{ window_id: string }>).map(({ window_id }) => window_id));
    const reports = await Promise.all(reportRows.filter(({ window_id }) => !withheldWindowIds.has(window_id)).map(async (report) => {
      const expiresIn = Math.max(1, Math.min(900, Math.floor((new Date(report.expires_at).getTime() - Date.now()) / 1000)));
      const { data, error } = await service.storage.from("school-documents").createSignedUrl(report.storage_key, expiresIn);
      if (error) throw new Error(error.message);
      return { id: report.id, windowId: report.window_id, generatedAt: report.generated_at, expiresAt: report.expires_at, downloadUrl: data.signedUrl };
    }));
    const timetables = await Promise.all((timetableResult.data as Array<{
      id: string; grade: string; original_filename: string; storage_key: string; expires_at: string;
    }>).map(async (timetable) => {
      const expiresIn = Math.max(1, Math.min(900, Math.floor((new Date(timetable.expires_at).getTime() - Date.now()) / 1000)));
      const { data, error } = await service.storage.from("school-documents").createSignedUrl(timetable.storage_key, expiresIn);
      if (error) throw new Error(error.message);
      return { id: timetable.id, grade: timetable.grade, filename: timetable.original_filename, expiresAt: timetable.expires_at, downloadUrl: data.signedUrl };
    }));
    const school = schoolResult.data as Record<string, unknown> & { logo_storage_key: string | null };
    return json({
      student: { name: profile.name, assessmentNumber: profile.assessment_number, grade: classResult.data.grade, stream: classResult.data.stream },
      school: { ...school, logoUrl: await schoolLogoUrl(school.logo_storage_key) },
      subjects: roster.student_roster_subjects.flatMap(({ school_subjects }) => school_subjects),
      notices: noticesResult.data,
      reports,
      timetables,
    });
  }

  const schoolAssetRoute = path.match(/^\/api\/super-admin\/schools\/([^/]+)\/assets\/(logo|principal-signature)$/);
  if (schoolAssetRoute && request.method === "PUT") {
    if (!isSuperAdmin) return fail("You do not have permission to update school branding.", 403);
    if (!await rateAllowed(request, path, 12, 900)) return fail("Too many school image uploads. Please wait and try again.", 429);
    const schoolId = decodeURIComponent(schoolAssetRoute[1]);
    const assetName = schoolAssetRoute[2] === "logo" ? "logo_storage_key" : "principal_signature_storage_key";
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 8 || file.size > 2 * 1024 * 1024) {
      return fail("Choose a school image no larger than 2 MB.", 413);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPng = bytes.length >= 45
      && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
      && String.fromCharCode(...bytes.slice(12, 16)) === "IHDR"
      && bytes.slice(-8, -4).every((byte, index) => byte === [73, 69, 78, 68][index]);
    const isJpeg = bytes.length >= 4
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    const isWebp = bytes.length >= 20
      && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
      && ["VP8 ", "VP8L", "VP8X"].includes(String.fromCharCode(...bytes.slice(12, 16)))
      && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length;
    const extension = isPng ? "png" : isJpeg ? "jpg" : isWebp ? "webp" : "";
    const contentType = extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : extension === "webp" ? "image/webp" : "";
    if (!extension || contentType !== file.type || (schoolAssetRoute[2] === "principal-signature" && isWebp)) {
      return fail(schoolAssetRoute[2] === "logo"
        ? "Upload a valid JPEG, PNG, or WebP image no larger than 2 MB."
        : "Upload a valid PNG or JPEG signature image no larger than 2 MB.", 415);
    }
    const { data: current, error: currentError } = await service.from("schools")
      .select("logo_storage_key,principal_signature_storage_key").eq("id", schoolId).maybeSingle();
    if (currentError) throw new Error(currentError.message);
    if (!current) return fail("This school was not found.", 404);
    const oldKey = (current as Record<string, string | null>)[assetName];
    const storageKey = `${schoolId}/branding/${schoolAssetRoute[2]}-${randomId()}.${extension}`;
    const { error: uploadError } = await service.storage.from("school-documents").upload(storageKey, bytes, {
      contentType, upsert: false,
    });
    if (uploadError) throw new Error(uploadError.message);
    const { data: updated, error: updateError } = await service.from("schools")
      .update({ [assetName]: storageKey }).eq("id", schoolId).select("id").maybeSingle();
    if (updateError || !updated) {
      const { error: cleanupError } = await service.storage.from("school-documents").remove([storageKey]);
      if (cleanupError) console.error("New school image cleanup failed:", cleanupError.name);
      if (updateError) throw new Error(updateError.message);
      return fail("This school was not found.", 404);
    }
    if (oldKey) {
      const { error: cleanupError } = await service.storage.from("school-documents").remove([oldKey]);
      if (cleanupError) {
        console.error("Previous school image cleanup failed:", cleanupError.name);
        return fail("The new school image was saved, but the previous image could not be removed.", 500);
      }
    }
    await recordAdminAction(profile.id, "school_branding_updated", "school", schoolId, { asset: schoolAssetRoute[2] });
    return json({ updated: true });
  }

  const schoolStatusRoute = path.match(/^\/api\/super-admin\/schools\/([^/]+)\/status$/);
  if (schoolStatusRoute && request.method === "PATCH") {
    if (!isSuperAdmin) return fail("You do not have permission to change school status.", 403);
    const parsed = schoolStatusInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const schoolId = decodeURIComponent(schoolStatusRoute[1]);
    const { data: current, error: currentError } = await service.from("schools")
      .select("verification_status,operational_status,email_verification_required,email_verified_at")
      .eq("id", schoolId).maybeSingle();
    if (currentError) throw new Error(currentError.message);
    if (!current) return fail("This school was not found.", 404);
    const verificationStatus = parsed.data.verificationStatus ?? current.verification_status;
    const operationalStatus = parsed.data.operationalStatus ?? current.operational_status;
    if (current.email_verification_required && !current.email_verified_at
      && (verificationStatus === "verified" || operationalStatus === "active")) {
      return fail("Verify the school's official email before approving or activating the school.", 409);
    }
    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await service.from("schools").update({
      verification_status: verificationStatus,
      operational_status: operationalStatus,
      active: operationalStatus === "active",
      status_updated_by: profile.id,
      status_updated_at: now,
      updated_at: now,
    }).eq("id", schoolId).select("id").maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (!updated) return fail("This school was not found.", 404);
    await recordAdminAction(profile.id, "school_status_updated", "school", schoolId, {
      verificationStatus,
      operationalStatus,
    });
    return json({ verificationStatus, operationalStatus });
  }

  const schoolDatabaseRoute = path.match(/^\/api\/super-admin\/schools\/([^/]+)\/database\/(students|teachers)$/);
  if (schoolDatabaseRoute && request.method === "GET") {
    if (!isSuperAdmin) return fail("You do not have permission to view school databases.", 403);
    const schoolId = decodeURIComponent(schoolDatabaseRoute[1]);
    const database = schoolDatabaseRoute[2];
    const { data: school, error: schoolError } = await service.from("schools")
      .select("id,name").eq("id", schoolId).maybeSingle();
    if (schoolError) throw new Error(schoolError.message);
    if (!school) return fail("This school was not found.", 404);
    if (database === "students") {
      const { data, error } = await service.from("student_rosters")
        .select("id,full_name,assessment_number,profile_id,created_at,school_classes!inner(grade,stream),profiles(active,email_verified)")
        .eq("school_id", schoolId).order("full_name");
      if (error) throw new Error(error.message);
      return json({ school, students: data });
    }
    const { data, error } = await service.from("teacher_records")
      .select("id,profile_id,account_role,full_name,teacher_email,phone_number,department_head,subject_head,invitation_status,created_at,profiles(active,email_verified),teacher_class_subjects(school_classes(grade,stream),school_subjects(name))")
      .eq("school_id", schoolId).order("full_name");
    if (error) throw new Error(error.message);
    return json({ school, teachers: data });
  }

  const permanentDeleteRoute = path.match(/^\/api\/super-admin\/schools\/([^/]+)$/);
  if (permanentDeleteRoute && request.method === "DELETE") {
    if (!isSuperAdmin) return fail("You do not have permission to delete schools.", 403);
    if (!await rateAllowed(request, path, 3, 3600)) return fail("Too many school deletion requests. Please wait and try again.", 429);
    const parsed = z.object({ confirmationName: schoolNameSchema }).safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const schoolId = decodeURIComponent(permanentDeleteRoute[1]);
    const { data: school, error: schoolError } = await service.from("schools")
      .select("id,name,operational_status,email_verification_user_id").eq("id", schoolId).maybeSingle();
    if (schoolError) throw new Error(schoolError.message);
    if (!school) return fail("This school was not found.", 404);
    if (school.operational_status !== "archived") {
      return fail("Archive the school first. Permanent deletion is available only for archived schools.", 409);
    }
    if (parsed.data.confirmationName !== school.name) {
      return fail("Type the exact school name to confirm permanent deletion.", 400);
    }
    const { error: auditError } = await service.from("admin_audit_logs").insert({
      admin_id: profile.id,
      action: "school_permanent_deletion_requested",
      entity_type: "school",
      entity_id: schoolId,
      details_json: { name: school.name },
    });
    if (auditError) throw new Error(auditError.message);
    if (school.email_verification_user_id) {
      const { error: verificationUserError } = await service.auth.admin.deleteUser(school.email_verification_user_id);
      if (verificationUserError) throw new Error(`The temporary school verification account could not be removed: ${verificationUserError.message}`);
    }
    const storageObjects = await schoolStorageObjects(schoolId);
    const { error: deleteError } = await service.rpc("delete_school_permanently", { p_school_id: schoolId });
    if (deleteError) throw new Error(deleteError.message);
    let storageWarning = "";
    if (storageObjects.length) {
      const { error: storageError } = await service.storage.from("school-documents").remove(storageObjects);
      if (storageError) {
        console.error("School storage cleanup after permanent deletion failed:", storageError.name);
        storageWarning = " School records were deleted, but some private files could not be removed.";
      }
    }
    return json({ deleted: true, message: `School ${school.name} and its school records were permanently deleted.${storageWarning}` });
  }

  const invitationRoute = path.match(/^\/api\/super-admin\/schools\/([^/]+)\/administrator-invitation$/);
  if (invitationRoute && request.method === "POST") {
    if (!isSuperAdmin) return fail("You do not have permission to manage School Administrator invitations.", 403);
    if (!await rateAllowed(request, path, 5, 3600)) return fail("Too many invitation requests. Please wait and try again.", 429);
    const schoolId = decodeURIComponent(invitationRoute[1]);
    const { data: row, error } = await service.from("teacher_records")
      .select("id,school_id,full_name,administrator_email,phone_number,designation,profile_id,invitation_status")
      .eq("school_id", schoolId).eq("account_role", "school_admin").maybeSingle();
    if (error) throw new Error(error.message);
    if (!row || !row.administrator_email) return fail("This school has no School Administrator invitation to retry.", 404);
    const administrator = row as {
      id: string; school_id: string; full_name: string; administrator_email: string; phone_number: string;
      designation: string | null; profile_id: string | null; invitation_status: string;
    };
    const result = await sendSchoolAdminInvitation(request, {
      id: administrator.id,
      schoolId: administrator.school_id,
      name: administrator.full_name,
      email: administrator.administrator_email,
      phone: administrator.phone_number,
      designation: administrator.designation || "School Administrator",
      profileId: administrator.profile_id,
      invitationStatus: administrator.invitation_status,
    });
    if (result.sent) {
      await recordAdminAction(profile.id, "school_admin_invitation_resent", "school", schoolId, { email: administrator.administrator_email });
    }
    return json({ invitationStatus: result.sent ? "sent" : "failed", message: result.message }, result.sent ? 200 : 202);
  }

  if (path === "/api/super-admin/schools" && request.method === "GET") {
    if (!isSuperAdmin) return fail("You do not have permission to view platform schools.", 403);
    const { data, error } = await service.from("schools")
      .select("id,name,examination_code,category,ownership,county,sub_county,location,telephone,logo_storage_key,email,email_verification_required,email_verified_at,email_verification_status,po_box,website,grades,verification_status,operational_status,active,created_at")
      .order("name");
    if (error) throw new Error(error.message);
    const schools = data as Array<Record<string, unknown> & { id: string }>;
    const [classResult, studentResult, teacherResult, administratorResult] = await Promise.all([
      schools.length ? service.from("school_classes").select("school_id") : Promise.resolve({ data: [], error: null }),
      schools.length ? service.from("student_rosters").select("school_id") : Promise.resolve({ data: [], error: null }),
      schools.length ? service.from("teacher_records").select("school_id") : Promise.resolve({ data: [], error: null }),
      schools.length ? service.from("teacher_records")
        .select("id,school_id,full_name,administrator_email,profile_id,invitation_status")
        .eq("account_role", "school_admin") : Promise.resolve({ data: [], error: null }),
    ]);
    if (classResult.error) throw new Error(classResult.error.message);
    if (studentResult.error) throw new Error(studentResult.error.message);
    if (teacherResult.error) throw new Error(teacherResult.error.message);
    if (administratorResult.error) throw new Error(administratorResult.error.message);
    const countBySchool = (rows: Array<{ school_id: string }>) => {
      const counts = new Map<string, number>();
      rows.forEach(({ school_id }) => counts.set(school_id, (counts.get(school_id) ?? 0) + 1));
      return counts;
    };
    const classes = countBySchool(classResult.data as Array<{ school_id: string }>);
    const students = countBySchool(studentResult.data as Array<{ school_id: string }>);
    const teachers = countBySchool(teacherResult.data as Array<{ school_id: string }>);
    const administrators = new Map((administratorResult.data as Array<{
      id: string; school_id: string; full_name: string; administrator_email: string | null;
      profile_id: string | null; invitation_status: string;
    }>).map((row) => [row.school_id, row]));
    const profilesById = new Map<string, { active: boolean; email_verified: boolean }>();
    const profileIds = [...administrators.values()].flatMap((row) => row.profile_id ? [row.profile_id] : []);
    if (profileIds.length) {
      const { data: profileRows, error: profileError } = await service.from("profiles")
        .select("id,active,email_verified").in("id", profileIds);
      if (profileError) throw new Error(profileError.message);
      (profileRows as Array<{ id: string; active: boolean; email_verified: boolean }>).forEach((row) => {
        profilesById.set(row.id, { active: row.active, email_verified: row.email_verified });
      });
    }
    return json({ schools: await Promise.all(schools.map(async (school) => {
      const administrator = administrators.get(school.id);
      const linkedProfile = administrator?.profile_id ? profilesById.get(administrator.profile_id) : undefined;
      const invitationStatus = linkedProfile?.active && linkedProfile.email_verified
        ? "accepted"
        : administrator?.invitation_status ?? "not_invited";
      return {
        ...school,
        logoUrl: await schoolLogoUrl(school.logo_storage_key as string | null),
        administrator: administrator ? {
          name: administrator.full_name,
          email: administrator.administrator_email,
          invitationStatus,
        } : null,
        classCount: classes.get(school.id) ?? 0,
        studentCount: students.get(school.id) ?? 0,
        teacherCount: teachers.get(school.id) ?? 0,
      };
    })) });
  }

  if (path === "/api/super-admin/schools" && request.method === "POST") {
    if (!isSuperAdmin) return fail("You do not have permission to onboard schools.", 403);
    const parsed = schoolInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const input = parsed.data;
    const { data: schoolId, error } = await service.rpc("create_school_registration", {
      p_name: input.name,
      p_examination_code: input.examinationCode,
      p_category: input.category,
      p_ownership: input.ownership,
      p_county: input.county,
      p_sub_county: input.subCounty,
      p_location: input.location,
      p_telephone: input.telephone,
      p_email: input.email || "",
      p_po_box: input.poBox || "",
      p_website: input.website || "",
      p_grades: input.grades,
      p_created_by: profile.id,
    });
    if (error?.code === "23505") return fail("A school with that name, registration number, or official email is already registered.", 409);
    if (error) throw new Error(error.message);
    if (typeof schoolId !== "string") throw new Error("School registration completed without returning the created school ID.");
    const { data: registeredSchool, error: schoolError } = await service.from("schools")
      .select("id,name,email,email_verified_at,email_verification_user_id")
      .eq("id", schoolId).single();
    if (schoolError) throw new Error(schoolError.message);
    if (!registeredSchool.email) throw new Error("School registration completed without its required official email address.");
    const verification = await sendSchoolEmailVerification(request, {
      id: registeredSchool.id,
      name: registeredSchool.name,
      email: registeredSchool.email,
      emailVerifiedAt: registeredSchool.email_verified_at,
      verificationUserId: registeredSchool.email_verification_user_id,
    });
    await recordAdminAction(profile.id, "school_created", "school", schoolId, {
      name: input.name,
      emailVerificationStatus: verification.sent ? "sent" : "failed",
    });
    const { data: school, error: schoolFetchError } = await service.from("schools")
      .select("id,name,examination_code,verification_status,operational_status,email,email_verification_required,email_verified_at,email_verification_status")
      .eq("id", schoolId).single();
    if (schoolFetchError) throw new Error(schoolFetchError.message);
    return json({
      school,
      emailVerificationStatus: verification.sent ? "sent" : "failed",
      emailVerificationMessage: verification.message,
    }, verification.sent ? 201 : 202);
  }

  const schoolEmailVerificationRoute = path.match(/^\/api\/super-admin\/schools\/([^/]+)\/email-verification$/);
  if (schoolEmailVerificationRoute && request.method === "POST") {
    if (!isSuperAdmin) return fail("You do not have permission to manage school email verification.", 403);
    if (!await rateAllowed(request, path, 5, 900)) return fail("Too many school email verification requests. Please wait and try again.", 429);
    const schoolId = decodeURIComponent(schoolEmailVerificationRoute[1]);
    const { data: row, error } = await service.from("schools")
      .select("id,name,email,email_verification_required,email_verified_at,email_verification_user_id")
      .eq("id", schoolId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!row || !row.email_verification_required || !row.email) return fail("This school has no email address requiring verification.", 404);
    const result = await sendSchoolEmailVerification(request, {
      id: row.id,
      name: row.name,
      email: row.email,
      emailVerifiedAt: row.email_verified_at,
      verificationUserId: row.email_verification_user_id,
    });
    return json({
      emailVerificationStatus: result.sent ? "sent" : row.email_verified_at ? "verified" : "failed",
      message: result.message,
    }, result.sent || row.email_verified_at ? 200 : 202);
  }

  const schoolAdministratorRoute = path.match(/^\/api\/super-admin\/schools\/([^/]+)\/administrator$/);
  if (schoolAdministratorRoute && request.method === "POST") {
    if (!isSuperAdmin) return fail("You do not have permission to onboard School Administrators.", 403);
    if (!await rateAllowed(request, path, 8, 900)) return fail("Too many School Administrator registrations. Please wait and try again.", 429);
    const parsed = schoolAdministratorInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const schoolId = decodeURIComponent(schoolAdministratorRoute[1]);
    const { data: school, error: schoolError } = await service.from("schools")
      .select("id,name,email,email_verification_required,email_verified_at,email_verification_user_id")
      .eq("id", schoolId).maybeSingle();
    if (schoolError) throw new Error(schoolError.message);
    if (!school) return fail("This school was not found.", 404);
    if (school.email_verification_required && !school.email_verified_at) {
      return fail("Verify the school's official email before creating its School Administrator account.", 409);
    }
    const { data: existingAdministrator, error: existingError } = await service.from("teacher_records")
      .select("id").eq("school_id", schoolId).eq("account_role", "school_admin").maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existingAdministrator) return fail("This school already has a School Administrator record.", 409);
    const { data: existingProfile, error: profileError } = await service.from("profiles")
      .select("id").eq("email", parsed.data.administratorEmail).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (existingProfile) return fail("That email address already belongs to an account. Use a different administrator email.", 409);
    const { data: administrator, error: insertError } = await service.from("teacher_records").insert({
      school_id: school.id,
      account_role: "school_admin",
      full_name: parsed.data.administratorName,
      phone_number: parsed.data.administratorPhone,
      phone_normalized: parsed.data.administratorPhone,
      administrator_email: parsed.data.administratorEmail,
      designation: parsed.data.administratorDesignation,
      invitation_status: "pending",
      created_by: profile.id,
    }).select("id,school_id,full_name,administrator_email,phone_number,designation,profile_id,invitation_status").single();
    if (insertError?.code === "23505") return fail("That email or phone number is already registered for a school account.", 409);
    if (insertError) throw new Error(insertError.message);
    const invitation = await sendSchoolAdminInvitation(request, {
      id: administrator.id,
      schoolId: administrator.school_id,
      name: administrator.full_name,
      email: administrator.administrator_email,
      phone: administrator.phone_number,
      designation: administrator.designation,
      profileId: administrator.profile_id,
      invitationStatus: administrator.invitation_status,
    });
    await recordAdminAction(profile.id, "school_admin_onboarded", "school", school.id, {
      email: administrator.administrator_email,
      invitationStatus: invitation.sent ? "sent" : "failed",
    });
    return json({
      administratorInvitationStatus: invitation.sent ? "sent" : "failed",
      message: invitation.message,
    }, invitation.sent ? 201 : 202);
  }

  if (path === "/api/school/overview" && request.method === "GET") {
    if (!profile.school_id || !["school_admin", "class_coordinator", "teacher"].includes(profile.role)) {
      return fail("You do not have permission to view this school dashboard.", 403);
    }
    const [schoolResult, classResult, studentResult, teacherResult] = await Promise.all([
      service.from("schools").select("id,name,examination_code,category,ownership,county,sub_county,location,telephone,logo_storage_key,email,po_box,website,grades")
        .eq("id", profile.school_id).single(),
      service.from("school_classes").select("id,grade,stream,class_teacher_id,coordinator_id")
        .eq("school_id", profile.school_id).order("grade").order("stream"),
      service.from("student_rosters").select("id,class_id").eq("school_id", profile.school_id),
      service.from("teacher_records").select("id").eq("school_id", profile.school_id),
    ]);
    for (const result of [schoolResult, classResult, studentResult, teacherResult]) {
      if (result.error) throw new Error(result.error.message);
    }
    const allClasses = classResult.data as Array<{ id: string; grade: string; stream: string; class_teacher_id: string | null; coordinator_id: string | null }>;
    let visibleClasses = allClasses;
    if (profile.role === "class_coordinator") {
      visibleClasses = allClasses.filter((row) => row.coordinator_id === profile.id);
    } else if (profile.role === "teacher") {
      const { data: teacherRecord, error: teacherError } = await service.from("teacher_records").select("id")
        .eq("profile_id", profile.id).maybeSingle();
      if (teacherError) throw new Error(teacherError.message);
      const assignmentClassIds = teacherRecord
        ? await service.from("teacher_class_subjects").select("class_id").eq("teacher_id", teacherRecord.id)
        : { data: [], error: null };
      if (assignmentClassIds.error) throw new Error(assignmentClassIds.error.message);
      const assigned = new Set((assignmentClassIds.data as Array<{ class_id: string }>).map(({ class_id }) => class_id));
      visibleClasses = allClasses.filter((row) => row.class_teacher_id === profile.id || assigned.has(row.id));
    }
    const visibleClassIds = new Set(visibleClasses.map(({ id }) => id));
    const students = (studentResult.data as Array<{ id: string; class_id: string }>)
      .filter((row) => visibleClassIds.has(row.class_id));
    const school = schoolResult.data as Record<string, unknown> & { logo_storage_key: string | null };
    return json({
      school: { ...school, logoUrl: await schoolLogoUrl(school.logo_storage_key) },
      counts: {
        classes: visibleClasses.length,
        students: students.length,
        teachers: profile.role === "school_admin" ? (teacherResult.data?.length ?? 0) : undefined,
      },
      classes: visibleClasses.map((classRow) => ({
        ...classRow,
        studentCount: students.filter((student) => student.class_id === classRow.id).length,
      })),
    });
  }

  if (path.startsWith("/api/school/") && (!profile.school_id || !["student", "school_admin", "class_coordinator", "teacher"].includes(profile.role))) {
    return fail("You do not have permission to access school records.", 403);
  }

  if (path === "/api/school/classes" && request.method === "GET") {
    const { data, error } = await service.from("school_classes")
      .select("id,grade,stream,class_teacher_id,coordinator_id")
      .eq("school_id", profile.school_id!).order("grade").order("stream");
    if (error) throw new Error(error.message);
    if (profile.role === "school_admin") return json({ classes: data });
    const classRows = data as Array<{ id: string; class_teacher_id: string | null; coordinator_id: string | null }>;
    if (profile.role === "class_coordinator") {
      return json({ classes: classRows.filter((row) => row.coordinator_id === profile.id) });
    }
    const { data: teacherRecord, error: teacherError } = await service.from("teacher_records").select("id")
      .eq("profile_id", profile.id).maybeSingle();
    if (teacherError) throw new Error(teacherError.message);
    const assignedResult = teacherRecord
      ? await service.from("teacher_class_subjects").select("class_id").eq("teacher_id", teacherRecord.id)
      : { data: [], error: null };
    if (assignedResult.error) throw new Error(assignedResult.error.message);
    const assigned = new Set((assignedResult.data as Array<{ class_id: string }>).map(({ class_id }) => class_id));
    return json({ classes: classRows.filter((row) => row.class_teacher_id === profile.id || assigned.has(row.id)) });
  }

  if (path === "/api/school/classes" && request.method === "POST") {
    if (profile.role !== "school_admin") return fail("Only the School Administrator can create classes.", 403);
    const parsed = schoolClassInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const offeredGrades = await offeredGradesForSchool(profile.school_id!);
    if (offeredGrades.length && !offeredGrades.includes(parsed.data.grade)) {
      return fail("Choose a grade that this school selected as offered during registration.", 400);
    }
    const assignmentIds = [parsed.data.classTeacherId, parsed.data.coordinatorId].filter((id): id is string => Boolean(id));
    if (assignmentIds.length) {
      const { data: assignedProfiles, error: assignmentError } = await service.from("profiles")
        .select("id,role,school_id").in("id", assignmentIds).eq("school_id", profile.school_id!);
      if (assignmentError) throw new Error(assignmentError.message);
      const profileById = new Map((assignedProfiles as Array<{ id: string; role: string }>).map((assigned) => [assigned.id, assigned]));
      if (parsed.data.classTeacherId && profileById.get(parsed.data.classTeacherId)?.role !== "teacher") {
        return fail("Choose an active teacher from this school as the Class Teacher.", 400);
      }
      if (parsed.data.coordinatorId && profileById.get(parsed.data.coordinatorId)?.role !== "class_coordinator") {
        return fail("Choose an authorized Class Coordinator from this school.", 400);
      }
    }
    const { data, error } = await service.from("school_classes").insert({
      school_id: profile.school_id,
      grade: parsed.data.grade,
      stream: parsed.data.stream,
      class_teacher_id: parsed.data.classTeacherId ?? null,
      coordinator_id: parsed.data.coordinatorId ?? null,
    }).select("id,grade,stream").single();
    if (error?.code === "23505") return fail("That grade and stream already exist in this school.", 409);
    if (error) throw new Error(error.message);
    await recordAdminAction(profile.id, "class_created", "school_class", data.id, { grade: data.grade, stream: data.stream });
    return json({ class: data }, 201);
  }

  if (path === "/api/school/subjects" && request.method === "GET") {
    const { data, error } = await service.from("school_subjects").select("id,name,max_marks")
      .eq("school_id", profile.school_id!).order("name");
    if (error) throw new Error(error.message);
    return json({ subjects: data });
  }

  if (path === "/api/school/subjects" && request.method === "POST") {
    if (profile.role !== "school_admin") return fail("Only the School Administrator can manage subjects.", 403);
    const parsed = schoolSubjectInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const { data, error } = await service.from("school_subjects").insert({
      school_id: profile.school_id,
      name: parsed.data.name,
      max_marks: parsed.data.maxMarks,
    }).select("id,name,max_marks").single();
    if (error?.code === "23505") return fail("That subject already exists in this school.", 409);
    if (error) throw new Error(error.message);
    await recordAdminAction(profile.id, "subject_created", "school_subject", data.id, { name: data.name });
    return json({ subject: data }, 201);
  }

  if (path === "/api/school/students" && request.method === "GET") {
    let classIds: string[] = [];
    if (profile.role === "school_admin") {
      const { data, error } = await service.from("school_classes").select("id").eq("school_id", profile.school_id!);
      if (error) throw new Error(error.message);
      classIds = (data as Array<{ id: string }>).map(({ id }) => id);
    } else if (profile.role === "class_coordinator") {
      const { data, error } = await service.from("school_classes").select("id")
        .eq("school_id", profile.school_id!).eq("coordinator_id", profile.id);
      if (error) throw new Error(error.message);
      classIds = (data as Array<{ id: string }>).map(({ id }) => id);
    } else {
      const [{ data: teacherRecord, error: teacherError }, { data: classTeacherRows, error: classError }] = await Promise.all([
        service.from("teacher_records").select("id").eq("profile_id", profile.id).maybeSingle(),
        service.from("school_classes").select("id").eq("school_id", profile.school_id!).eq("class_teacher_id", profile.id),
      ]);
      if (teacherError) throw new Error(teacherError.message);
      if (classError) throw new Error(classError.message);
      const { data: assignmentRows, error: assignmentError } = teacherRecord
        ? await service.from("teacher_class_subjects").select("class_id").eq("teacher_id", teacherRecord.id)
        : { data: [], error: null };
      if (assignmentError) throw new Error(assignmentError.message);
      classIds = [...new Set([
        ...(classTeacherRows as Array<{ id: string }>).map(({ id }) => id),
        ...(assignmentRows as Array<{ class_id: string }>).map(({ class_id }) => class_id),
      ])];
    }
    if (!classIds.length) return json({ students: [] });
    const { data, error } = await service.from("student_rosters")
      .select("id,full_name,assessment_number,profile_id,class_id,school_classes!inner(grade,stream)")
      .eq("school_id", profile.school_id!).in("class_id", classIds).order("full_name");
    if (error) throw new Error(error.message);
    return json({ students: data });
  }

  if (path === "/api/school/teachers" && request.method === "GET") {
    if (profile.role !== "school_admin" && profile.role !== "teacher") return fail("Only school staff can view the teacher directory.", 403);
    const { data, error } = await service.from("teacher_records")
      .select("id,profile_id,account_role,full_name,teacher_email,phone_number,department_head,subject_head,invitation_status,teacher_class_subjects(class_id,subject_id)")
      .eq("school_id", profile.school_id!).order("full_name");
    if (error) throw new Error(error.message);
    const rows = data as Array<{
      id: string; profile_id: string | null; account_role: string; full_name: string; teacher_email: string | null; phone_number: string;
      department_head: string | null; subject_head: string | null; invitation_status: string;
      teacher_class_subjects: Array<{ class_id: string; subject_id: string }>;
    }>;
    if (profile.role === "school_admin") return json({ teachers: rows });
    const current = await currentTeacher();
    if (!current?.department_head) return json({ teachers: [] });
    return json({ teachers: rows.filter((row) => row.department_head === current.department_head).map((row) => ({
      id: row.id, full_name: row.full_name, department_head: row.department_head,
      assignments: row.teacher_class_subjects,
    })) });
  }

  const teacherInvitationRoute = path.match(/^\/api\/school\/teachers\/([^/]+)\/invitation$/);
  if (teacherInvitationRoute && request.method === "POST") {
    if (profile.role !== "school_admin") return fail("Only the School Administrator can resend teacher invitations.", 403);
    if (!await rateAllowed(request, path, 5, 900)) return fail("Too many invitation requests. Please wait and try again.", 429);
    const teacherId = decodeURIComponent(teacherInvitationRoute[1]);
    const { data: row, error } = await service.from("teacher_records")
      .select("id,school_id,full_name,teacher_email,phone_number,account_role,profile_id,invitation_status")
      .eq("id", teacherId).eq("school_id", profile.school_id!).maybeSingle();
    if (error) throw new Error(error.message);
    const teacher = row as {
      id: string; school_id: string; full_name: string; teacher_email: string | null; phone_number: string;
      account_role: "teacher" | "class_coordinator"; profile_id: string | null; invitation_status: string;
    } | null;
    if (!teacher || !teacher.teacher_email) return fail("This teacher record has no email address for an invitation.", 404);
    if (teacher.account_role !== "teacher" && teacher.account_role !== "class_coordinator") {
      return fail("This account cannot receive a teacher invitation.", 409);
    }
    const invitation = await sendSchoolStaffInvitation(request, {
      id: teacher.id,
      schoolId: teacher.school_id,
      name: teacher.full_name,
      email: teacher.teacher_email,
      phone: teacher.phone_number,
      role: teacher.account_role,
      profileId: teacher.profile_id,
    });
    return json({
      invitationStatus: invitation.sent ? "sent" : "failed",
      message: invitation.message,
    }, invitation.sent ? 200 : 202);
  }

  const schoolSubjectUpdate = path.match(/^\/api\/school\/subjects\/([^/]+)$/);
  if (schoolSubjectUpdate && request.method === "PUT") {
    if (!["school_admin", "class_coordinator"].includes(profile.role)) {
      return fail("Only the School Administrator or Class Coordinator can update subject maximum marks.", 403);
    }
    const parsed = schoolSubjectInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const subjectId = decodeURIComponent(schoolSubjectUpdate[1]);
    const { data, error } = await service.from("school_subjects")
      .update({ name: parsed.data.name, max_marks: parsed.data.maxMarks })
      .eq("id", subjectId).eq("school_id", profile.school_id!)
      .select("id,name,max_marks").maybeSingle();
    if (error?.code === "23505") return fail("That subject name already exists in this school.", 409);
    if (error) throw new Error(error.message);
    if (!data) return fail("This school subject was not found.", 404);
    await recordAdminAction(profile.id, "subject_maximum_updated", "school_subject", subjectId, {
      name: data.name,
      maxMarks: data.max_marks,
    });
    return json({ subject: data });
  }

  if (path === "/api/school/students" && request.method === "POST") {
    const input = schoolStudentInputSchema.safeParse(await bodyJson(request));
    if (!input.success) return invalidBody(input);
    const classResult = await service.from("school_classes").select("id,class_teacher_id")
      .eq("id", input.data.classId).eq("school_id", profile.school_id!).maybeSingle();
    if (classResult.error) throw new Error(classResult.error.message);
    if (!classResult.data) return fail("Choose a class in your school.", 404);
    if (profile.role !== "school_admin" && (profile.role !== "teacher" || classResult.data.class_teacher_id !== profile.id)) {
      return fail("Only the assigned Class Teacher or School Administrator can add students to this class.", 403);
    }
    const { data: subjects, error: subjectsError } = await service.from("school_subjects").select("id")
      .eq("school_id", profile.school_id!).in("id", input.data.subjectIds);
    if (subjectsError) throw new Error(subjectsError.message);
    if ((subjects as Array<{ id: string }>).length !== new Set(input.data.subjectIds).size) {
      return fail("Choose only subjects configured for this school.", 400);
    }
    const { data, error } = await service.from("student_rosters").insert({
      school_id: profile.school_id,
      class_id: input.data.classId,
      assessment_number: input.data.assessmentNumber.trim().toUpperCase(),
      full_name: input.data.fullName,
      guardian_phone_hash: await bcrypt.hash(input.data.guardianPhone, 12),
      created_by: profile.id,
    }).select("id,assessment_number,full_name,class_id").single();
    if (error?.code === "23505") return fail("That assessment number is already registered in this school.", 409);
    if (error) throw new Error(error.message);
    const { error: registrationError } = await service.from("student_roster_subjects").insert(
      input.data.subjectIds.map((subjectId) => ({ roster_id: data.id, subject_id: subjectId })),
    );
    if (registrationError) {
      await service.from("student_rosters").delete().eq("id", data.id);
      throw new Error(registrationError.message);
    }
    await recordAdminAction(profile.id, "student_rostered", "student_roster", data.id, { assessmentNumber: data.assessment_number });
    return json({ student: data }, 201);
  }

  if (path === "/api/school/teachers" && request.method === "POST") {
    if (profile.role !== "school_admin") return fail("Only the School Administrator can onboard teachers.", 403);
    const input = schoolTeacherInputSchema.safeParse(await bodyJson(request));
    if (!input.success) return invalidBody(input);
    const classIds = [...new Set(input.data.assignments.map(({ classId }) => classId))];
    const subjectIds = [...new Set(input.data.assignments.map(({ subjectId }) => subjectId))];
    const [classesResult, subjectsResult] = await Promise.all([
      service.from("school_classes").select("id").eq("school_id", profile.school_id!).in("id", classIds),
      service.from("school_subjects").select("id").eq("school_id", profile.school_id!).in("id", subjectIds),
    ]);
    if (classesResult.error) throw new Error(classesResult.error.message);
    if (subjectsResult.error) throw new Error(subjectsResult.error.message);
    if (classesResult.data.length !== classIds.length || subjectsResult.data.length !== subjectIds.length) {
      return fail("All teacher assignments must belong to this school.", 400);
    }
    const { data: existingProfile, error: profileLookupError } = await service.from("profiles")
      .select("id").eq("email", input.data.email).maybeSingle();
    if (profileLookupError) throw new Error(profileLookupError.message);
    if (existingProfile) return fail("That email already belongs to an account. Ask the School Administrator to use the existing account assignment workflow.", 409);
    const { data: teacher, error } = await service.from("teacher_records").insert({
      school_id: profile.school_id,
      account_role: input.data.accountRole,
      full_name: input.data.fullName,
      teacher_email: input.data.email,
      phone_number: input.data.phoneNumber,
      phone_normalized: input.data.phoneNumber,
      department_head: input.data.departmentHead || null,
      subject_head: input.data.subjectHead || null,
      created_by: profile.id,
    }).select("id,school_id,full_name,teacher_email,phone_number,department_head,subject_head,account_role").single();
    if (error?.code === "23505") return fail("That email or phone number is already registered for a teacher in this school.", 409);
    if (error) throw new Error(error.message);
    const { error: assignmentsError } = await service.from("teacher_class_subjects").insert(input.data.assignments.map((assignment) => ({
      teacher_id: teacher.id,
      class_id: assignment.classId,
      subject_id: assignment.subjectId,
    })));
    if (assignmentsError) {
      await service.from("teacher_records").delete().eq("id", teacher.id);
      throw new Error(assignmentsError.message);
    }
    const invitation = await sendSchoolStaffInvitation(request, {
      id: teacher.id,
      schoolId: teacher.school_id,
      name: teacher.full_name,
      email: teacher.teacher_email,
      phone: teacher.phone_number,
      role: teacher.account_role,
      profileId: null,
    });
    await recordAdminAction(profile.id, "teacher_onboarded", "teacher_record", teacher.id, {
      name: teacher.full_name,
      invitationStatus: invitation.sent ? "sent" : "failed",
    });
    return json({
      teacher: { ...teacher, invitation_status: invitation.sent ? "sent" : "failed" },
      invitationStatus: invitation.sent ? "sent" : "failed",
      message: invitation.message,
    }, 201);
  }

  if (path === "/api/school/my-signature" && request.method === "PUT") {
    if (profile.role !== "teacher") return fail("Only a teacher can upload their own signature.", 403);
    const teacher = await currentTeacher();
    if (!teacher) return fail("Your school teacher record could not be found.", 404);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 8 || file.size > 2 * 1024 * 1024) {
      return fail("Choose a signature image no larger than 2 MB.", 413);
    }
    if (!["image/png", "image/jpeg"].includes(file.type)) return fail("Signatures must be PNG or JPEG images.", 415);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if ((file.type === "image/png" && !png) || (file.type === "image/jpeg" && !jpg)) {
      return fail("The selected file does not match its declared image type.", 415);
    }
    const { data: teacherRow, error: teacherError } = await service.from("teacher_records")
      .select("class_teacher_signature_storage_key").eq("id", teacher.id).single();
    if (teacherError) throw new Error(teacherError.message);
    const storageKey = `${profile.school_id}/signatures/${teacher.id}-${randomId()}.${file.type === "image/png" ? "png" : "jpg"}`;
    const { error: uploadError } = await service.storage.from("school-documents").upload(storageKey, bytes, {
      contentType: file.type, upsert: false,
    });
    if (uploadError) throw new Error(uploadError.message);
    const { error: updateError } = await service.from("teacher_records")
      .update({ class_teacher_signature_storage_key: storageKey }).eq("id", teacher.id);
    if (updateError) {
      const { error: cleanupError } = await service.storage.from("school-documents").remove([storageKey]);
      if (cleanupError) console.error("New signature cleanup failed:", cleanupError.message);
      throw new Error(updateError.message);
    }
    if (teacherRow.class_teacher_signature_storage_key) {
      const { error: cleanupError } = await service.storage.from("school-documents")
        .remove([teacherRow.class_teacher_signature_storage_key]);
      if (cleanupError) {
        console.error("Previous signature cleanup failed:", cleanupError.message);
        return fail("Your signature was updated, but the previous file could not be removed.", 500);
      }
    }
    await recordAdminAction(profile.id, "teacher_signature_updated", "teacher_record", teacher.id);
    return json({ updated: true });
  }

  if (path === "/api/school/result-windows" && request.method === "GET") {
    const windows = await activeWindowIds(profile.school_id!);
    return json({ windows });
  }

  const classRemarkRoute = path.match(/^\/api\/school\/result-windows\/([^/]+)\/classes\/([^/]+)\/remarks$/);
  if (classRemarkRoute && request.method === "PUT") {
    if (profile.role !== "teacher") return fail("Only the assigned Class Teacher can record class remarks.", 403);
    const parsed = subjectRemarkSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const windowId = decodeURIComponent(classRemarkRoute[1]);
    const classId = decodeURIComponent(classRemarkRoute[2]);
    const [windowResult, classResult] = await Promise.all([
      service.from("result_windows").select("id,grade,status,deadline").eq("id", windowId)
        .eq("school_id", profile.school_id!).maybeSingle(),
      service.from("school_classes").select("id,grade,class_teacher_id").eq("id", classId)
        .eq("school_id", profile.school_id!).maybeSingle(),
    ]);
    if (windowResult.error) throw new Error(windowResult.error.message);
    if (classResult.error) throw new Error(classResult.error.message);
    if (!windowResult.data || !classResult.data || windowResult.data.grade !== classResult.data.grade) {
      return fail("This class does not belong to the selected results window.", 404);
    }
    if (classResult.data.class_teacher_id !== profile.id) return fail("You are not the Class Teacher for this class.", 403);
    if (!["open", "coordinator_review"].includes(windowResult.data.status)) return fail("Class remarks can no longer be changed.", 409);
    const { error } = await service.from("class_teacher_remarks").upsert({
      window_id: windowId, class_id: classId, teacher_id: profile.id, remark: parsed.data.remark,
      updated_at: new Date().toISOString(),
    }, { onConflict: "window_id,class_id" });
    if (error) throw new Error(error.message);
    return json({ saved: true });
  }

  const subjectRemarkRoute = path.match(/^\/api\/school\/result-windows\/([^/]+)\/classes\/([^/]+)\/subjects\/([^/]+)\/remarks$/);
  if (subjectRemarkRoute && request.method === "PUT") {
    if (profile.role !== "teacher") return fail("Only an assigned subject teacher can record subject remarks.", 403);
    const parsed = subjectRemarkSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const windowId = decodeURIComponent(subjectRemarkRoute[1]);
    const classId = decodeURIComponent(subjectRemarkRoute[2]);
    const subjectId = decodeURIComponent(subjectRemarkRoute[3]);
    const teacher = await currentTeacher();
    if (!teacher) return fail("Your school teacher record could not be found.", 404);
    const assignment = (await teacherAssignments(teacher.id))
      .some((item) => item.class_id === classId && item.subject_id === subjectId);
    if (!assignment) return fail("You are not assigned to this class and subject.", 403);
    const [windowResult, classResult] = await Promise.all([
      service.from("result_windows").select("id,grade,status").eq("id", windowId)
        .eq("school_id", profile.school_id!).maybeSingle(),
      service.from("school_classes").select("id,grade").eq("id", classId)
        .eq("school_id", profile.school_id!).maybeSingle(),
    ]);
    if (windowResult.error) throw new Error(windowResult.error.message);
    if (classResult.error) throw new Error(classResult.error.message);
    if (!windowResult.data || !classResult.data || windowResult.data.grade !== classResult.data.grade) {
      return fail("This class does not belong to the selected results window.", 404);
    }
    if (!["open", "coordinator_review"].includes(windowResult.data.status)) return fail("Subject remarks can no longer be changed.", 409);
    const { error } = await service.from("subject_teacher_remarks").upsert({
      window_id: windowId, class_id: classId, subject_id: subjectId, teacher_id: profile.id,
      remark: parsed.data.remark, updated_at: new Date().toISOString(),
    }, { onConflict: "window_id,class_id,subject_id" });
    if (error) throw new Error(error.message);
    return json({ saved: true });
  }

  const resultWindowMatch = path.match(/^\/api\/school\/result-windows\/([^/]+)(?:\/(submit|release))?$/);
  if (resultWindowMatch && request.method === "GET" && !resultWindowMatch[2]) {
    const windowId = decodeURIComponent(resultWindowMatch[1]);
    const { data: window, error } = await service.from("result_windows")
      .select("id,grade,term,half,deadline,status")
      .eq("id", windowId).eq("school_id", profile.school_id!).maybeSingle();
    if (error) throw new Error(error.message);
    if (!window) return fail("This results window was not found.", 404);
    const [classesResult, teacherRecord] = await Promise.all([
      service.from("school_classes").select("id,class_teacher_id,coordinator_id,stream")
        .eq("school_id", profile.school_id!).eq("grade", window.grade),
      profile.role === "teacher" ? currentTeacher() : Promise.resolve(null),
    ]);
    if (classesResult.error) throw new Error(classesResult.error.message);
    const classes = classesResult.data as Array<{ id: string; class_teacher_id: string | null; coordinator_id: string | null; stream: string }>;
    let visibleClassIds = classes.map(({ id }) => id);
    let classTeacherClassIds = new Set<string>();
    let allowedAssignmentKeys: Set<string> | null = null;
    if (profile.role === "class_coordinator") {
      visibleClassIds = classes.filter(({ coordinator_id }) => coordinator_id === profile.id).map(({ id }) => id);
    } else if (profile.role === "teacher") {
      const classTeacherIds = classes.filter(({ class_teacher_id }) => class_teacher_id === profile.id).map(({ id }) => id);
      const assignments = teacherRecord ? await teacherAssignments(teacherRecord.id) : [];
      classTeacherClassIds = new Set(classTeacherIds);
      const classIds = [...new Set([...classTeacherIds, ...assignments.map(({ class_id }) => class_id)])];
      visibleClassIds = classIds.filter((id) => classes.some((row) => row.id === id));
      allowedAssignmentKeys = new Set(assignments.map(({ class_id, subject_id }) => `${class_id}:${subject_id}`));
    } else if (profile.role !== "school_admin") {
      return fail("You do not have permission to view these results.", 403);
    }
    if (!visibleClassIds.length) return json({ window, classRemarks: [], subjectRemarks: [], results: [] });
    const [classRemarkResult, subjectRemarkResult] = await Promise.all([
      service.from("class_teacher_remarks").select("class_id,remark").eq("window_id", windowId).in("class_id", visibleClassIds),
      service.from("subject_teacher_remarks").select("class_id,subject_id,remark").eq("window_id", windowId).in("class_id", visibleClassIds),
    ]);
    if (classRemarkResult.error) throw new Error(classRemarkResult.error.message);
    if (subjectRemarkResult.error) throw new Error(subjectRemarkResult.error.message);
    const { data: rosterRows, error: rosterError } = await service.from("student_rosters")
      .select("id,full_name,assessment_number,class_id,student_roster_subjects(school_subjects!inner(id,name,max_marks))")
      .in("class_id", visibleClassIds);
    if (rosterError) throw new Error(rosterError.message);
    const rosters = rosterRows as Array<{
      id: string; full_name: string; assessment_number: string; class_id: string;
      student_roster_subjects: Array<{ school_subjects: Array<{ id: string; name: string; max_marks: number }> }>;
    }>;
    const { data: resultRows, error: resultsError } = await service.from("student_results")
      .select("id,roster_id,subject_id,mark,result_code,entered_by")
      .eq("window_id", windowId).in("roster_id", rosters.map(({ id }) => id));
    if (resultsError) throw new Error(resultsError.message);
    const rows = resultRows as Array<{ id: string; roster_id: string; subject_id: string; mark: number | null; result_code: string; entered_by: string | null }>;
    return json({
      window,
      classRemarks: classRemarkResult.data,
      subjectRemarks: subjectRemarkResult.data,
      results: rosters.flatMap((roster) => {
      const classRow = classes.find(({ id }) => id === roster.class_id);
      return roster.student_roster_subjects.flatMap(({ school_subjects }) => school_subjects)
        .filter((schoolSubject) => !allowedAssignmentKeys
          || profile.role === "school_admin" || profile.role === "class_coordinator"
          || classTeacherClassIds.has(roster.class_id)
          || allowedAssignmentKeys.has(`${roster.class_id}:${schoolSubject.id}`))
        .map((school_subjects) => ({
          rosterId: roster.id,
          studentName: roster.full_name,
          assessmentNumber: roster.assessment_number,
          classId: roster.class_id,
          stream: classRow?.stream ?? "",
          subjectId: school_subjects.id,
          subjectName: school_subjects.name,
          maxMarks: school_subjects.max_marks,
          canEditSubjectRemark: profile.role === "teacher"
            && Boolean(allowedAssignmentKeys?.has(`${roster.class_id}:${school_subjects.id}`)),
          ...(rows.find((row) => row.roster_id === roster.id && row.subject_id === school_subjects.id)
            ? { result: rows.find((row) => row.roster_id === roster.id && row.subject_id === school_subjects.id) }
            : {}),
        }));
      }),
    });
  }

  const resultEntry = path.match(/^\/api\/school\/result-windows\/([^/]+)\/students\/([^/]+)\/subjects\/([^/]+)$/);
  if (resultEntry && request.method === "PUT") {
    if (profile.role !== "teacher") return fail("Only an assigned subject teacher can enter marks.", 403);
    const parsed = studentResultInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const windowId = decodeURIComponent(resultEntry[1]);
    const rosterId = decodeURIComponent(resultEntry[2]);
    const subjectId = decodeURIComponent(resultEntry[3]);
    const teacher = await currentTeacher();
    if (!teacher) return fail("Your teacher record is not active.", 403);
    const assignments = await teacherAssignments(teacher.id);
    if (!assignments.some(({ subject_id }) => subject_id === subjectId)) return fail("You are not assigned to this subject.", 403);
    const { data: window, error: windowError } = await service.from("result_windows")
      .select("id,grade,deadline,status").eq("id", windowId).eq("school_id", profile.school_id!).maybeSingle();
    if (windowError) throw new Error(windowError.message);
    if (!window || window.status !== "open" || new Date(window.deadline).getTime() <= Date.now()) {
      return fail("This results-entry window is not open.", 409);
    }
    const { data: roster, error: rosterError } = await service.from("student_rosters")
      .select("id,class_id,school_classes!inner(grade,school_id)")
      .eq("id", rosterId).eq("school_id", profile.school_id!).maybeSingle();
    if (rosterError) throw new Error(rosterError.message);
    const rosterClass = (roster?.school_classes as Array<{ grade: string; school_id: string }> | undefined)?.[0];
    if (!roster || !rosterClass || rosterClass.grade !== window.grade) {
      return fail("This student is outside the results window's grade.", 403);
    }
    if (!assignments.some(({ class_id, subject_id: assignedSubject }) => class_id === roster.class_id && assignedSubject === subjectId)) {
      return fail("You are not assigned to this class and subject.", 403);
    }
    const { data: registeredSubject, error: subjectError } = await service.from("student_roster_subjects")
      .select("roster_id").eq("roster_id", rosterId).eq("subject_id", subjectId).maybeSingle();
    if (subjectError) throw new Error(subjectError.message);
    if (!registeredSubject) return fail("This subject is not part of the student's school record.", 400);
    const { data: subject, error: marksError } = await service.from("school_subjects")
      .select("max_marks").eq("id", subjectId).eq("school_id", profile.school_id!).single();
    if (marksError) throw new Error(marksError.message);
    if (typeof parsed.data.result === "number" && parsed.data.result > subject.max_marks) {
      return fail(`The mark cannot exceed this subject's maximum of ${subject.max_marks}.`, 400);
    }
    const { data, error } = await service.from("student_results").update({
      mark: typeof parsed.data.result === "number" ? parsed.data.result : null,
      result_code: parsed.data.result === "Y" ? "Y" : "mark",
      reason: parsed.data.reason ?? null,
      entered_by: profile.id,
      entered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("window_id", windowId).eq("roster_id", rosterId).eq("subject_id", subjectId)
      .eq("result_code", "pending").select("id,result_code,mark").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail("This result was already entered or is no longer editable.", 409);
    await recordAdminAction(profile.id, parsed.data.result === "Y" ? "student_result_disqualified" : "student_result_entered",
      "student_result", data.id, {
        subjectId,
        rosterId,
        result: parsed.data.result,
        reason: parsed.data.reason ?? null,
      });
    return json({ result: data });
  }

  if (path === "/api/school/result-windows" && request.method === "POST") {
    if (profile.role !== "school_admin") return fail("Only the School Administrator can open results entry.", 403);
    const parsed = resultWindowInputSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const offeredGrades = await offeredGradesForSchool(profile.school_id!);
    if (offeredGrades.length && !offeredGrades.includes(parsed.data.grade)) {
      return fail("Choose a grade that this school selected as offered during registration.", 400);
    }
    const classesResult = await service.from("school_classes").select("id")
      .eq("school_id", profile.school_id!).eq("grade", parsed.data.grade);
    if (classesResult.error) throw new Error(classesResult.error.message);
    const classIds = (classesResult.data as Array<{ id: string }>).map(({ id }) => id);
    if (!classIds.length) return fail("Create the grade and its streams before opening results entry.", 409);
    const { data: existing, error: existingError } = await service.from("result_windows").select("id")
      .eq("school_id", profile.school_id!).eq("grade", parsed.data.grade).eq("term", parsed.data.term).eq("half", parsed.data.half).maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing) return fail("A results window already exists for this grade, term, and half-term.", 409);
    const windowId = randomId();
    const { error: windowError } = await service.from("result_windows").insert({
      id: windowId,
      school_id: profile.school_id,
      grade: parsed.data.grade,
      term: parsed.data.term,
      half: parsed.data.half,
      opens_at: parsed.data.opensAt,
      deadline: parsed.data.deadline,
      status: new Date(parsed.data.opensAt).getTime() <= Date.now() ? "open" : "scheduled",
      opened_by: profile.id,
    });
    if (windowError) throw new Error(windowError.message);
    const { data: rosterRows, error: rosterError } = await service.from("student_rosters")
      .select("id,student_roster_subjects(subject_id)").in("class_id", classIds);
    if (rosterError) throw new Error(rosterError.message);
    const results = (rosterRows as Array<{ id: string; student_roster_subjects: Array<{ subject_id: string }> }>)
      .flatMap((roster) => roster.student_roster_subjects.map(({ subject_id }) => ({
        window_id: windowId,
        roster_id: roster.id,
        subject_id,
        result_code: "pending",
      })));
    if (results.length) {
      const { error } = await service.from("student_results").insert(results);
      if (error) {
        await service.from("result_windows").delete().eq("id", windowId);
        throw new Error(error.message);
      }
    }
    await recordAdminAction(profile.id, "results_window_opened", "result_window", windowId, {
      grade: parsed.data.grade, term: parsed.data.term, half: parsed.data.half,
    });
    return json({ windowId, resultCount: results.length }, 201);
  }

  if (resultWindowMatch && request.method === "POST" && resultWindowMatch[2] === "submit") {
    const windowId = decodeURIComponent(resultWindowMatch[1]);
    if (profile.role !== "class_coordinator") return fail("Only a Class Coordinator can submit grade analysis.", 403);
    const { data: resultWindow, error } = await service.from("result_windows").select("id,school_id,grade,status")
      .eq("id", windowId).eq("school_id", profile.school_id!).maybeSingle();
    if (error) throw new Error(error.message);
    if (!resultWindow) return fail("This results window was not found.", 404);
    if (resultWindow.status !== "coordinator_review") return fail("This results window is not ready for coordinator submission.", 409);
    const { data: classes, error: classesError } = await service.from("school_classes").select("id")
      .eq("school_id", profile.school_id!).eq("grade", resultWindow.grade).eq("coordinator_id", profile.id);
    if (classesError) throw new Error(classesError.message);
    if (!classes?.length) return fail("You are not assigned as coordinator for this grade.", 403);
    const { error: updateError } = await service.from("result_windows").update({ status: "admin_review" }).eq("id", windowId);
    if (updateError) throw new Error(updateError.message);
    await recordAdminAction(profile.id, "grade_results_submitted", "result_window", windowId);
    return json({ submitted: true });
  }

  if (resultWindowMatch && request.method === "POST" && resultWindowMatch[2] === "release") {
    if (profile.role !== "school_admin") return fail("Only the School Administrator can generate and send student reports.", 403);
    const parsed = reportReleaseSchema.safeParse(await bodyJson(request));
    if (!parsed.success) return invalidBody(parsed);
    const windowId = decodeURIComponent(resultWindowMatch[1]);
    const { data: resultWindow, error: windowError } = await service.from("result_windows")
      .select("id,school_id,grade,term,half,status,principal_remarks")
      .eq("id", windowId).eq("school_id", profile.school_id!).maybeSingle();
    if (windowError) throw new Error(windowError.message);
    if (!resultWindow) return fail("This results window was not found.", 404);
    if (resultWindow.status !== "admin_review") return fail("The Class Coordinator must submit the grade results before reports can be generated.", 409);
    const classesResult = await service.from("school_classes").select("id,stream,class_teacher_id")
      .eq("school_id", profile.school_id!).eq("grade", resultWindow.grade);
    if (classesResult.error) throw new Error(classesResult.error.message);
    const classes = classesResult.data as Array<{ id: string; stream: string; class_teacher_id: string | null }>;
    const classIds = classes.map(({ id }) => id);
    if (!classIds.length) return fail("No classes are configured for this grade.", 409);
    const allRosterResults = await Promise.all(classIds.map((classId) => service.from("student_rosters")
      .select("id,full_name,assessment_number,class_id,profile_id,student_roster_subjects(school_subjects!inner(id,name,max_marks))")
      .eq("school_id", profile.school_id!).eq("class_id", classId)));
    if (allRosterResults.some((result) => result.error)) throw new Error(allRosterResults.find((result) => result.error)?.error?.message ?? "Student rosters could not be read.");
    const rosters = allRosterResults.flatMap((result) => result.data as Array<{
      id: string; full_name: string; assessment_number: string; class_id: string; profile_id: string | null;
      student_roster_subjects: Array<{ school_subjects: Array<{ id: string; name: string; max_marks: number }> }>;
    }>);
    const historicalResult = await service.from("student_results")
      .select("roster_id,subject_id,mark,result_code,result_windows!inner(term,half)")
      .in("roster_id", rosters.map(({ id }) => id)).neq("window_id", windowId);
    if (historicalResult.error) throw new Error(historicalResult.error.message);
    const historical = historicalResult.data as Array<{
      roster_id: string; subject_id: string; mark: number | null; result_code: string;
      result_windows: Array<{ term: number; half: string }>;
    }>;
    const currentResult = await service.from("student_results").select("roster_id,subject_id,mark,result_code")
      .eq("window_id", windowId);
    if (currentResult.error) throw new Error(currentResult.error.message);
    const current = currentResult.data as Array<{ roster_id: string; subject_id: string; mark: number | null; result_code: string }>;
    const byRosterSubject = new Map(current.map((result) => [`${result.roster_id}:${result.subject_id}`, result]));
    const schoolResult = await service.from("schools").select("name,examination_code,logo_storage_key,principal_signature_storage_key,email,po_box,principal_name")
      .eq("id", profile.school_id!).single();
    if (schoolResult.error) throw new Error(schoolResult.error.message);
    const school = schoolResult.data as {
      name: string; examination_code: string; logo_storage_key: string | null;
      principal_signature_storage_key: string | null; email: string | null; po_box: string | null; principal_name: string | null;
    };
    const classTeacherIds = [...new Set(classes.map(({ class_teacher_id }) => class_teacher_id).filter((id): id is string => Boolean(id)))];
    const [classRemarkResult, subjectRemarkResult, classTeacherResult] = await Promise.all([
      service.from("class_teacher_remarks").select("class_id,remark").eq("window_id", windowId).in("class_id", classIds),
      service.from("subject_teacher_remarks").select("class_id,subject_id,remark").eq("window_id", windowId).in("class_id", classIds),
      classTeacherIds.length
        ? service.from("teacher_records").select("profile_id,full_name,class_teacher_signature_storage_key").in("profile_id", classTeacherIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (classRemarkResult.error) throw new Error(classRemarkResult.error.message);
    if (subjectRemarkResult.error) throw new Error(subjectRemarkResult.error.message);
    if (classTeacherResult.error) throw new Error(classTeacherResult.error.message);
    const classRemarks = new Map((classRemarkResult.data as Array<{ class_id: string; remark: string }>).map((row) => [row.class_id, row.remark]));
    const subjectRemarks = new Map((subjectRemarkResult.data as Array<{ class_id: string; subject_id: string; remark: string }>).map((row) => [`${row.class_id}:${row.subject_id}`, row.remark]));
    const classTeachers = new Map((classTeacherResult.data as Array<{
      profile_id: string; full_name: string; class_teacher_signature_storage_key: string | null;
    }>).map((row) => [row.profile_id, row]));
    const deniedCount = { count: 0 };
    const performances = rosters.flatMap((roster) => {
      const rosterSubjects = roster.student_roster_subjects.flatMap(({ school_subjects }) => school_subjects);
      const marks = rosterSubjects.map((schoolSubject) =>
        byRosterSubject.get(`${roster.id}:${schoolSubject.id}`));
      if (!marks.length || marks.some((result) => !result || result.result_code !== "mark" || result.mark === null)) return [];
      const score = marks.reduce((total, result) => total + (result?.mark ?? 0), 0);
      const maxScore = rosterSubjects.reduce((total, schoolSubject) => total + schoolSubject.max_marks, 0);
      return [{ rosterId: roster.id, classId: roster.class_id, score, maxScore, percent: maxScore ? score / maxScore * 100 : 0 }];
    });
    for (const roster of rosters) {
      if (!roster.profile_id) continue;
      const subjectResults = roster.student_roster_subjects.flatMap(({ school_subjects }) => school_subjects.map((subject) => ({
        subject,
        current: byRosterSubject.get(`${roster.id}:${subject.id}`),
      })));
      const hasMissingCode = subjectResults.some(({ current: result }) => !result || result.result_code === "pending");
      const disqualifying = subjectResults.some(({ current: result }) => result?.result_code === "X" || result?.result_code === "Y");
      if (hasMissingCode) return fail("Some marks are still pending. Complete results entry before releasing reports.", 409);
      if (disqualifying) {
        const markedCodes = subjectResults.filter(({ current: result }) => result?.result_code === "X" || result?.result_code === "Y");
        const reason = markedCodes.some(({ current: result }) => result?.result_code === "Y")
          ? "YOU DID NOT RECEIVE YOUR REPORT BECAUSE A SUBJECT TEACHER RECORDED Y FOR AN EXAMINATION. SPEAK WITH YOUR SCHOOL, LEARN FROM THIS EXPERIENCE, AND MAKE A BETTER CHOICE NEXT TIME."
          : "YOU DID NOT RECEIVE YOUR REPORT BECAUSE YOU DID NOT SIT ONE OR MORE EXAMINATIONS. SPEAK WITH YOUR SCHOOL AND MAKE EVERY EFFORT TO SIT YOUR EXAMINATIONS NEXT TIME.";
        const { error } = await service.from("student_notices").upsert({
          roster_id: roster.id, window_id: windowId, message: reason,
        }, { onConflict: "roster_id,window_id" });
        if (error) throw new Error(error.message);
        deniedCount.count += 1;
        continue;
      }

      const classRecord = classes.find(({ id }) => id === roster.class_id);
      const latestScores = subjectResults.map(({ subject, current: result }) => {
        const prior = historical.filter((row) => row.roster_id === roster.id && row.subject_id === subject.id
          && row.result_code === "mark" && row.mark !== null)
          .sort((a, b) => a.result_windows[0].term - b.result_windows[0].term
            || (a.result_windows[0].half === "mid-term" ? -1 : 1) - (b.result_windows[0].half === "mid-term" ? -1 : 1));
        const previous = prior[prior.length - 1]?.mark ?? null;
        return { subject, result, previous, deviation: result?.mark != null && previous != null ? result.mark - previous : null };
      });
      const rows = latestScores.map(({ subject, result, previous, deviation }) =>
        `${subject.name}: ${result?.mark ?? 0}/${subject.max_marks} | Previous: ${previous ?? "-"} | Change: ${deviation === null ? "N/A" : `${deviation > 0 ? "+" : ""}${deviation}`}`);
      const ownPerformance = performances.find(({ rosterId }) => rosterId === roster.id);
      const streamPosition = ownPerformance
        ? performances.filter((entry) => entry.classId === roster.class_id && entry.percent > ownPerformance.percent).length + 1
        : null;
      const gradePosition = ownPerformance
        ? performances.filter((entry) => entry.percent > ownPerformance.percent).length + 1
        : null;
      const history = historical.filter((row) => row.roster_id === roster.id)
        .sort((a, b) => a.result_windows[0].term - b.result_windows[0].term
          || (a.result_windows[0].half === "mid-term" ? -1 : 1) - (b.result_windows[0].half === "mid-term" ? -1 : 1))
        .map((row) => {
          const subject = roster.student_roster_subjects.flatMap(({ school_subjects }) => school_subjects).find((item) => item.id === row.subject_id)?.name ?? "Subject";
          return `Term ${row.result_windows[0].term} ${row.result_windows[0].half}: ${subject} ${row.mark ?? row.result_code}`;
        });
      const pdf = await PDFDocument.create();
      pdf.setTitle(`${school.name} report - ${roster.full_name}`);
      pdf.setAuthor("Vortex Learning");
      let page = pdf.addPage([595, 842]);
      const coverPage = page;
      const font = await pdf.embedFont("Helvetica");
      let y = 805;
      const draw = (text: string, size = 10, color = rgb(0.12, 0.2, 0.23)) => {
        const lines = text.match(/.{1,88}(?:\s|$)|.{1,88}/g) ?? [text];
        for (const line of lines) {
          if (y < 48) { page = pdf.addPage([595, 842]); y = 805; }
          page.drawText(line.trim(), { x: 48, y, size, font, color });
          y -= size + 5;
        }
      };
      draw(school.name, 18);
      draw(`${school.email ?? ""}  ${school.po_box ?? ""}`);
      draw(`TERM ${resultWindow.term.toString().toUpperCase()} · ${resultWindow.half.toUpperCase()} · ${resultWindow.grade} ${classRecord?.stream ?? ""}`, 12);
      draw(`Student: ${roster.full_name} | Assessment: ${roster.assessment_number}`);
      draw(`Stream position: ${streamPosition ?? "N/A"} | Grade position: ${gradePosition ?? "N/A"} | Total: ${ownPerformance?.score ?? 0}/${ownPerformance?.maxScore ?? 0}`);
      draw("SUBJECT RESULTS", 12);
      for (const row of rows) draw(row);
      for (const { subject } of subjectResults) {
        const remark = subjectRemarks.get(`${roster.class_id}:${subject.id}`);
        if (remark) draw(`${subject.name} teacher's remarks: ${remark}`, 8);
      }
      draw("PERFORMANCE GRAPH", 12);
      const chartX = 64;
      const chartY = Math.max(80, y - 100);
      const chartWidth = 460;
      const chartHeight = 74;
      page.drawLine({ start: { x: chartX, y: chartY }, end: { x: chartX + chartWidth, y: chartY }, thickness: 1, color: rgb(0.5, 0.6, 0.62) });
      page.drawLine({ start: { x: chartX, y: chartY }, end: { x: chartX, y: chartY + chartHeight }, thickness: 1, color: rgb(0.5, 0.6, 0.62) });
      const points = latestScores.map(({ subject, result }) => ({
        label: subject.name.slice(0, 8),
        score: result?.mark != null ? Math.max(0, Math.min(100, result.mark / subject.max_marks * 100)) : 0,
      }));
      const pointX = (index: number) => chartX + 14 + index * (chartWidth - 28) / Math.max(1, points.length - 1);
      const pointY = (score: number) => chartY + score / 100 * chartHeight;
      points.forEach((point, index) => {
        page.drawCircle({ x: pointX(index), y: pointY(point.score), size: 3, color: rgb(0.05, 0.48, 0.43) });
        page.drawText(point.label, { x: pointX(index) - 12, y: chartY - 14, size: 7, font });
        if (index > 0) page.drawLine({
          start: { x: pointX(index - 1), y: pointY(points[index - 1].score) },
          end: { x: pointX(index), y: pointY(point.score) },
          thickness: 1.4,
          color: rgb(0.05, 0.48, 0.43),
        });
      });
      y = chartY - 36;
      draw("PREVIOUS TERMS", 12);
      for (const item of history) draw(item, 8);
      draw(`Principal's remarks: ${parsed.data.principalRemarks}`, 9);
      draw(`Class teacher's remarks: ${classRemarks.get(roster.class_id) || parsed.data.classTeacherRemarks}`, 9);
      draw(`Principal: ${school.principal_name ?? "________________"}  Signature: __________________`, 9);
      const principalSignaturePage = page;
      const principalSignatureY = y + 5;
      const classTeacher = classTeachers.get(classRecord?.class_teacher_id ?? "");
      draw(`Class Teacher: ${classTeacher?.full_name ?? "________________"}  Signature: __________________`, 9);
      const classTeacherSignaturePage = page;
      const classTeacherSignatureY = y + 5;
      coverPage.drawText("VORTEX LEARNING", { x: 48, y: 28, size: 8, font, color: rgb(0.12, 0.2, 0.23) });
      const embedSchoolImage = async (storageKey: string) => {
        const { data: imageData, error: imageError } = await service.storage.from("school-documents").download(storageKey);
        if (imageError) throw new Error(imageError.message);
        const imageBytes = new Uint8Array(await imageData.arrayBuffer());
        return storageKey.toLowerCase().endsWith(".png")
          ? await pdf.embedPng(imageBytes)
          : await pdf.embedJpg(imageBytes);
      };
      if (school.logo_storage_key) {
        const logo = await embedSchoolImage(school.logo_storage_key);
        coverPage.drawImage(logo, { x: 485, y: 770, width: 64, height: 48 });
      }
      if (school.principal_signature_storage_key) {
        const signature = await embedSchoolImage(school.principal_signature_storage_key);
        principalSignaturePage.drawImage(signature, { x: 458, y: principalSignatureY, width: 80, height: 24 });
      }
      if (classTeacher?.class_teacher_signature_storage_key) {
        const signature = await embedSchoolImage(classTeacher.class_teacher_signature_storage_key);
        classTeacherSignaturePage.drawImage(signature, { x: 458, y: classTeacherSignatureY, width: 80, height: 24 });
      }
      const pdfBytes = await pdf.save();
      const storageKey = `${profile.school_id}/${windowId}/${roster.id}/${randomId()}.pdf`;
      const { error: uploadError } = await service.storage.from("school-documents").upload(storageKey, pdfBytes, {
        contentType: "application/pdf", upsert: false,
      });
      if (uploadError) throw new Error(uploadError.message);
      const generatedAt = new Date();
      const expiresAt = new Date(generatedAt.getTime() + 30 * 24 * 60 * 60_000);
      const { error: copyError } = await service.from("student_report_copies").upsert({
        window_id: windowId, roster_id: roster.id, storage_key: storageKey,
        generated_by: profile.id, generated_at: generatedAt.toISOString(), expires_at: expiresAt.toISOString(), deleted_at: null,
      }, { onConflict: "window_id,roster_id" });
      if (copyError) {
        await service.storage.from("school-documents").remove([storageKey]);
        throw new Error(copyError.message);
      }
    }
    const { error: releaseError } = await service.from("result_windows").update({
      status: "released",
      principal_remarks: parsed.data.principalRemarks,
      class_teacher_remarks: parsed.data.classTeacherRemarks,
    }).eq("id", windowId);
    if (releaseError) throw new Error(releaseError.message);
    await recordAdminAction(profile.id, "student_reports_released", "result_window", windowId, { withheldStudents: deniedCount.count });
    return json({ released: true, withheldStudents: deniedCount.count });
  }

  const reportCopyDelete = path.match(/^\/api\/school\/reports\/([^/]+)$/);
  if (path === "/api/school/reports" && request.method === "GET") {
    if (!["school_admin", "class_coordinator"].includes(profile.role)) return fail("Only school administrators and coordinators can manage report copies.", 403);
    let classQuery = service.from("school_classes").select("id,grade,stream")
      .eq("school_id", profile.school_id!);
    if (profile.role === "class_coordinator") classQuery = classQuery.eq("coordinator_id", profile.id);
    const { data: classRows, error: classError } = await classQuery;
    if (classError) throw new Error(classError.message);
    const classes = classRows as Array<{ id: string; grade: string; stream: string }>;
    const classIds = classes.map(({ id }) => id);
    if (!classIds.length) return json({ reports: [] });
    const { data: rosterRows, error: rosterError } = await service.from("student_rosters")
      .select("id,full_name,class_id").eq("school_id", profile.school_id!).in("class_id", classIds);
    if (rosterError) throw new Error(rosterError.message);
    const rosters = rosterRows as Array<{ id: string; full_name: string; class_id: string }>;
    if (!rosters.length) return json({ reports: [] });
    const { data: reportRows, error: reportError } = await service.from("student_report_copies")
      .select("id,roster_id,window_id,storage_key,generated_at,expires_at")
      .in("roster_id", rosters.map(({ id }) => id)).is("deleted_at", null)
      .order("generated_at", { ascending: false });
    if (reportError) throw new Error(reportError.message);
    const reports = reportRows as Array<{
      id: string; roster_id: string; window_id: string; storage_key: string; generated_at: string; expires_at: string;
    }>;
    const { data: windowRows, error: windowError } = reports.length
      ? await service.from("result_windows").select("id,term,half").in("id", [...new Set(reports.map(({ window_id }) => window_id))])
      : { data: [], error: null };
    if (windowError) throw new Error(windowError.message);
    const windowsById = new Map((windowRows as Array<{ id: string; term: number; half: string }>).map((row) => [row.id, row]));
    const rostersById = new Map(rosters.map((row) => [row.id, row]));
    const classesById = new Map(classes.map((row) => [row.id, row]));
    return json({
      reports: await Promise.all(reports.map(async (report) => {
        const expiresAt = new Date(report.expires_at);
        let downloadUrl: string | null = null;
        if (expiresAt.getTime() > Date.now()) {
          const { data: signed, error: signedError } = await service.storage.from("school-documents").createSignedUrl(
            report.storage_key, Math.max(1, Math.min(900, Math.floor((expiresAt.getTime() - Date.now()) / 1000))),
          );
          if (signedError) throw new Error(signedError.message);
          downloadUrl = signed.signedUrl;
        }
        return {
          id: report.id, studentName: rostersById.get(report.roster_id)?.full_name ?? "Student",
          grade: classesById.get(rostersById.get(report.roster_id)?.class_id ?? "")?.grade ?? "",
          stream: classesById.get(rostersById.get(report.roster_id)?.class_id ?? "")?.stream ?? "",
          term: windowsById.get(report.window_id)?.term ?? null,
          half: windowsById.get(report.window_id)?.half ?? "",
          generatedAt: report.generated_at, expiresAt: report.expires_at, downloadUrl,
        };
      })),
    });
  }

  if (reportCopyDelete && request.method === "DELETE") {
    if (!["school_admin", "class_coordinator"].includes(profile.role)) return fail("You do not have permission to delete report copies.", 403);
    const id = decodeURIComponent(reportCopyDelete[1]);
    let query = service.from("student_report_copies").select("id,storage_key,window_id,roster_id").eq("id", id).is("deleted_at", null);
    if (profile.role === "school_admin") query = query;
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(error.message);
    const report = data as { id: string; storage_key: string; window_id: string; roster_id: string } | null;
    if (!report) return fail("This report copy was not found.", 404);
    const { data: roster, error: rosterError } = await service.from("student_rosters").select("school_id,class_id")
      .eq("id", report.roster_id).maybeSingle();
    if (rosterError) throw new Error(rosterError.message);
    if (!roster || roster.school_id !== profile.school_id) return fail("You do not have permission to delete this report.", 403);
    if (profile.role === "class_coordinator") {
      const { data: classRow, error: classError } = await service.from("school_classes").select("grade,coordinator_id")
        .eq("id", roster.class_id).maybeSingle();
      if (classError) throw new Error(classError.message);
      if (!classRow || classRow.coordinator_id !== profile.id) return fail("This report is outside your assigned grade.", 403);
    }
    const { error: deleteError } = await service.from("student_report_copies")
      .update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (deleteError) throw new Error(deleteError.message);
    const { error: storageError } = await service.storage.from("school-documents").remove([report.storage_key]);
    if (storageError) throw new Error(storageError.message);
    await recordAdminAction(profile.id, "student_report_deleted", "student_report", id);
    return empty();
  }

  if (path === "/api/school/timetables" && request.method === "GET") {
    let grades: string[] = [];
    if (profile.role === "school_admin") {
      const { data, error } = await service.from("school_classes").select("grade").eq("school_id", profile.school_id!);
      if (error) throw new Error(error.message);
      grades = [...new Set((data as Array<{ grade: string }>).map(({ grade }) => grade))];
    } else if (profile.role === "student") {
      grades = profile.grade ? [profile.grade] : [];
    } else if (profile.role === "class_coordinator") {
      const { data, error } = await service.from("school_classes").select("grade")
        .eq("school_id", profile.school_id!).eq("coordinator_id", profile.id);
      if (error) throw new Error(error.message);
      grades = [...new Set((data as Array<{ grade: string }>).map(({ grade }) => grade))];
    } else {
      const teacher = await currentTeacher();
      const assignments = teacher ? await teacherAssignments(teacher.id) : [];
      const classIds = [...new Set(assignments.map(({ class_id }) => class_id))];
      const { data, error } = classIds.length
        ? await service.from("school_classes").select("grade").eq("school_id", profile.school_id!).in("id", classIds)
        : { data: [], error: null };
      if (error) throw new Error(error.message);
      grades = [...new Set((data as Array<{ grade: string }>).map(({ grade }) => grade))];
    }
    if (!grades.length) return json({ timetables: [] });
    const { data, error } = await service.from("school_timetables")
      .select("id,grade,original_filename,storage_key,expires_at")
      .eq("school_id", profile.school_id!).in("grade", grades).gt("expires_at", new Date().toISOString())
      .order("sent_at", { ascending: false });
    if (error) throw new Error(error.message);
    const timetables = await Promise.all((data as Array<{
      id: string; grade: string; original_filename: string; storage_key: string; expires_at: string;
    }>).map(async (item) => {
      const expiresIn = Math.max(1, Math.min(900, Math.floor((new Date(item.expires_at).getTime() - Date.now()) / 1000)));
      const { data: signed, error: signedError } = await service.storage.from("school-documents").createSignedUrl(item.storage_key, expiresIn);
      if (signedError) throw new Error(signedError.message);
      return { id: item.id, grade: item.grade, filename: item.original_filename, expiresAt: item.expires_at, downloadUrl: signed.signedUrl };
    }));
    return json({ timetables });
  }

  if (path === "/api/school/timetables" && request.method === "POST") {
    if (profile.role !== "school_admin") return fail("Only the School Administrator can share a timetable.", 403);
    const form = await request.formData();
    const grade = gradeSchema.safeParse(form.get("grade"));
    const file = form.get("file");
    if (!grade.success || !(file instanceof File)) return fail("Choose a grade and a timetable file.", 400);
    if (file.size < 8 || file.size > maxResourceBytes) return fail("Timetable files must be no larger than 20 MB.", 413);
    const extension = file.name.toLowerCase().split(".").pop() ?? "";
    const allowedTypes: Record<string, { mime: string; signature: (bytes: Uint8Array) => boolean }> = {
      pdf: { mime: "application/pdf", signature: (bytes) => bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 },
      png: { mime: "image/png", signature: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
      jpg: { mime: "image/jpeg", signature: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
      jpeg: { mime: "image/jpeg", signature: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
      webp: { mime: "image/webp", signature: (bytes) => String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" },
    };
    const spec = allowedTypes[extension];
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!spec || !spec.signature(bytes) || (file.type && file.type !== spec.mime)) {
      return fail("Upload a valid PDF, PNG, JPEG, or WebP timetable.", 400);
    }
    const { data: classRows, error: classError } = await service.from("school_classes").select("id")
      .eq("school_id", profile.school_id!).eq("grade", grade.data);
    if (classError) throw new Error(classError.message);
    if (!classRows?.length) return fail("There are no classes configured for this grade.", 409);
    const storageKey = `${profile.school_id}/timetables/${randomId()}.${extension}`;
    const { error: uploadError } = await service.storage.from("school-documents").upload(storageKey, bytes, {
      contentType: spec.mime, upsert: false,
    });
    if (uploadError) throw new Error(uploadError.message);
    const sentAt = new Date();
    const expiresAt = new Date(sentAt.getTime() + 7 * 24 * 60 * 60_000);
    const { data, error } = await service.from("school_timetables").insert({
      school_id: profile.school_id,
      grade: grade.data,
      storage_key: storageKey,
      original_filename: file.name.slice(0, 200),
      created_by: profile.id,
      sent_at: sentAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    }).select("id,grade,original_filename,expires_at").single();
    if (error) {
      await service.storage.from("school-documents").remove([storageKey]);
      throw new Error(error.message);
    }
    await recordAdminAction(profile.id, "school_timetable_shared", "school_timetable", data.id, { grade: grade.data });
    return json({ timetable: data }, 201);
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
    if (user.school_id) return fail("School-managed student details can only be changed by authorized school staff.", 403);
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
      subjects: subjects.filter((subject) => new Set<string>(pathway.subjects).has(subject.name) && !seniorCompulsorySubjects.includes(subject.name as typeof seniorCompulsorySubjects[number])),
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
    if (user.school_id) return fail("Your school manages your grade and subject registration.", 403);
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
    const pathwayNames = new Set<string>(seniorPathways.find((pathway) => pathway.id === parsed.data.pathway)?.subjects ?? []);
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
    const attemptMap = new Map((attempts as Array<{
      id: string; assessment_id: string; status: Attempt["status"]; score: number | null; total_points: number | null;
    }>).map((attempt) => [attempt.assessment_id, attempt]));
    return json({
      exams: (exams as Array<{
        id: string; title: string; kind: string; duration_minutes: number; opens_at: string; subject_id: string;
        subjects: Array<{ name: string; grade: string }>;
      }>).map((exam) => {
        const attempt = attemptMap.get(exam.id);
        return {
          id: exam.id, title: exam.title, kind: exam.kind, duration_minutes: exam.duration_minutes,
          opens_at: exam.opens_at, subject_name: exam.subjects[0].name,
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
    const assessment = exam as {
      id: string; duration_minutes: number; opens_at: string; subject_id: string;
      subjects: Array<{ grade: string }>;
    };
    const { data: registration, error: registrationError } = await service.from("student_subject_registrations")
      .select("subject_id").eq("user_id", user.id).eq("subject_id", assessment.subject_id).maybeSingle();
    if (registrationError) throw new Error(registrationError.message);
    if (!registration) return fail("This examination is not available.", 404);
    if (!assessment.subjects.length || new Date(assessment.opens_at).getTime() > Date.now()) return fail("This examination is not open yet.", 409);
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
    const current = attempt as {
      id: string; status: Attempt["status"]; started_at: string; assessment_id: string;
      assessments: Array<{ duration_minutes: number }>;
    } | null;
    if (!current || current.status !== "in_progress" || !current.assessments.length) return fail("This active examination attempt was not found.", 404);
    if (Date.now() > new Date(current.started_at).getTime() + current.assessments[0].duration_minutes * 60_000) {
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
      results: (attempts as Array<{
        id: string; status: Attempt["status"]; score: number | null; total_points: number | null; submitted_at: string | null;
        assessments: Array<{ title: string; subjects: Array<{ name: string }> }>;
      }>).map((attempt) => ({
        attempt_id: attempt.id,
        title: attempt.assessments[0].title,
        subject_name: attempt.assessments[0].subjects[0].name,
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
        created_at: string; updated_at: string; subjects: Array<{ name: string; grade: string }>;
      }>).map((resource) => ({
        id: resource.id,
        subjectId: resource.subject_id,
        subjectName: resource.subjects[0].name,
        grade: resource.subjects[0].grade,
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
    const assessments = assessmentResult.data as Array<Assessment & {
      subjects: Array<{ name: string; grade: string; sort_order: number }>;
    }>;
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
      lessons: (lessonResult.data as Array<{
        id: string; subject_id: string; content_type: string; title: string; summary: string; content: string;
        subjects: Array<{ name: string; grade: string; sort_order: number }>;
      }>).map((lesson) => ({
        id: lesson.id,
        subjectId: lesson.subject_id,
        subjectName: lesson.subjects[0].name,
        grade: lesson.subjects[0].grade,
        type: lesson.content_type,
        title: lesson.title,
        summary: lesson.summary,
        content: lesson.content,
      })),
      assessments: assessments.map((assessment) => ({
        id: assessment.id,
        title: assessment.title,
        subjectId: assessment.subject_id,
        subjectName: assessment.subjects[0].name,
        grade: assessment.subjects[0].grade,
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
    const onboardingResponse = await onboardingRoutes(request, path);
    if (onboardingResponse) return addCors(onboardingResponse, origin);
    const authResponse = await authRoutes(request, path);
    if (authResponse) return addCors(authResponse, origin);
    const schoolResponse = await schoolManagementRoutes(request, path);
    if (schoolResponse) return addCors(schoolResponse, origin);
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
