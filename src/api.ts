export type User = {
  id: string;
  name: string;
  username: string;
  userCode: string | null;
  role: "student" | "admin";
  grade: string | null;
};

export type Course = {
  id: string;
  name: string;
  topic: string;
  progress: number;
  lessons: string;
  completed_lessons: number;
  total_lessons: number;
  icon: string;
  color: string;
};

export type UpcomingExam = {
  id: string;
  title: string;
  kind: string;
  duration_minutes: number;
  opens_at: string;
  subject_name: string;
};

export type LearningResource = {
  id: string;
  title: string;
  description: string;
  topic: string;
  term: string;
  category: "revision-paper" | "study-guide" | "syllabus" | "topic-summary" | "reference-document";
  filename: string;
  sizeBytes: number;
  subjectId: string;
  subjectName: string;
  grade: string;
};

export type DashboardData = {
  student: User;
  curriculumRegistration: {
    complete: boolean;
    pathway: string | null;
    grade: string | null;
  };
  courses: Course[];
  upcomingExams: UpcomingExam[];
  resources: LearningResource[];
  stats: {
    lessonsCompleted: number;
    lessonsTotal: number;
    learningProgress: number;
    streakDays: number;
    completedExams: number;
    examsInProgress: number;
  };
};

export type CurriculumSubject = {
  id: string;
  name: string;
  topic: string;
  icon: string;
  color: string;
  grade: string;
};

export type CurriculumPathway = {
  id: "stem" | "arts-sports" | "social-sciences";
  name: string;
  shortName: string;
  description: string;
  subjects: CurriculumSubject[];
};

export type CurriculumRegistration = {
  grade: string | null;
  needsGrade: boolean;
  complete: boolean;
  pathway: CurriculumPathway["id"] | null;
  subjects: CurriculumSubject[];
  compulsory: CurriculumSubject[];
  pathways: CurriculumPathway[];
  selectedSubjectIds: string[];
};

const tokenKey = "jifunze.session";
const refreshTokenKey = "jifunze.refresh";
export const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL ?? "vortexlearning0@gmail.com";
const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "");

function apiUrl(path: string): string {
  if (!configuredApiBase) return path;
  let base: URL;
  try {
    base = new URL(configuredApiBase);
  } catch {
    throw new Error("The API address is invalid. Set VITE_API_BASE_URL to the full HTTPS address of the deployed API.");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("The API address must use HTTPS (or HTTP for local development).");
  }
  if (import.meta.env.PROD && base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error("The deployed API must use HTTPS.");
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  return new URL(`${basePath}/${path.replace(/^\/+/, "")}`, base.origin).toString();
}

async function parseApiResponse(response: Response): Promise<{
  data: { error?: string; suggestions?: string[] };
  hasJson: boolean;
}> {
  if (response.status === 204) return { data: {}, hasJson: true };
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { data: {}, hasJson: false };
  }
  try {
    return {
      data: await response.json() as { error?: string; suggestions?: string[] },
      hasJson: true,
    };
  } catch {
    return { data: {}, hasJson: false };
  }
}

function unexpectedApiResponseMessage(): string {
  return import.meta.env.PROD && !configuredApiBase
    ? "The API is not configured for this website. Deploy the backend separately, set VITE_API_BASE_URL to its HTTPS address, and allow this website in the backend's CORS configuration."
    : "The server returned a page instead of an API response. Check the API address and hosting configuration.";
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly suggestions: string[] = []) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function getToken(): string | null {
  return localStorage.getItem(tokenKey);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(refreshTokenKey);
}

export function setToken(token: string, refreshToken?: string): void {
  localStorage.setItem(tokenKey, token);
  if (refreshToken) localStorage.setItem(refreshTokenKey, refreshToken);
  else localStorage.removeItem(refreshTokenKey);
}

export function clearToken(): void {
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(refreshTokenKey);
}

async function refreshSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const response = await fetch(apiUrl("/api/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return false;
    const result = await response.json() as { token?: string; refreshToken?: string };
    if (!result.token || !result.refreshToken) return false;
    setToken(result.token, result.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function requestHeaders(options: RequestInit, token: string | null): Headers {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = apiUrl(path);
  let response: Response;
  try {
    response = await fetch(url, { ...options, headers: requestHeaders(options, getToken()) });
    if (
      response.status === 401
      && getToken()
      && getRefreshToken()
      && !path.startsWith("/api/auth/")
      && !(options.body instanceof ReadableStream)
      && await refreshSession()
    ) {
      response = await fetch(url, { ...options, headers: requestHeaders(options, getToken()) });
    }
  } catch {
    throw new Error(import.meta.env.PROD && !configuredApiBase
      ? unexpectedApiResponseMessage()
      : "The learning service is unavailable. Check the API address, backend status, and allowed website origins.");
  }

  const { data, hasJson } = await parseApiResponse(response);
  if (!hasJson) throw new Error(unexpectedApiResponseMessage());
  if (!response.ok) {
    if (response.status === 401) clearToken();
    throw new ApiRequestError(data.error ?? "The request could not be completed.", data.suggestions ?? []);
  }
  return data as T;
}

export async function apiFileRequest(path: string): Promise<Blob> {
  const url = apiUrl(path);
  let response: Response;
  try {
    response = await fetch(url, { headers: requestHeaders({}, getToken()) });
    if (response.status === 401 && getToken() && getRefreshToken() && await refreshSession()) {
      response = await fetch(url, { headers: requestHeaders({}, getToken()) });
    }
  } catch {
    throw new Error(import.meta.env.PROD && !configuredApiBase
      ? unexpectedApiResponseMessage()
      : "The learning service is unavailable. Check the API address, backend status, and allowed website origins.");
  }
  if (!response.ok) {
    const { data, hasJson } = await parseApiResponse(response);
    if (!hasJson) throw new Error(unexpectedApiResponseMessage());
    if (response.status === 401) clearToken();
    throw new Error(data.error ?? "This learning resource could not be opened.");
  }
  return response.blob();
}
