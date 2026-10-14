import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Check, Download, Image, LogOut, RefreshCw, School, ShieldCheck, Upload, Users, X } from "lucide-react";
import { apiRequest, supportEmail, type User } from "./api";
import Brand from "./Brand";
import { kenyaCounties } from "../supabase/functions/_shared/kenya-counties";

type SchoolRecord = {
  id: string;
  name: string;
  examination_code: string;
  category: string | null;
  ownership: string | null;
  county: string;
  sub_county: string;
  location: string;
  telephone: string;
  email: string | null;
  po_box: string | null;
  website: string | null;
  grades: string[];
  logoUrl: string | null;
  verification_status: "pending" | "verified" | "rejected";
  operational_status: "active" | "suspended" | "archived";
  administrator: { name: string; email: string | null; invitationStatus: string } | null;
  classCount: number;
  studentCount: number;
  teacherCount: number;
};
type SchoolForm = {
  name: string;
  examinationCode: string;
  category: "Primary" | "Junior" | "Senior" | "Combined";
  ownership: "Public" | "Private";
  county: string;
  subCounty: string;
  location: string;
  telephone: string;
  email: string;
  poBox: string;
  website: string;
  grades: string[];
  administratorName: string;
  administratorEmail: string;
  administratorPhone: string;
  administratorDesignation: string;
};
type RegistrationResult = {
  school: { id: string; name: string; verification_status: string; operational_status: string };
  administratorInvitationStatus: "sent" | "failed";
  administratorInvitationMessage: string;
};
type ClassRecord = { id: string; grade: string; stream: string; class_teacher_id?: string | null; coordinator_id?: string | null; studentCount?: number };
type SubjectRecord = { id: string; name: string; max_marks: number };
type StudentRecord = { id: string; full_name: string; assessment_number: string; class_id: string; school_classes: { grade: string; stream: string } };
type TeacherRecord = { id: string; profile_id: string | null; account_role: string; full_name: string; phone_number: string; department_head: string | null; subject_head: string | null };
type DepartmentTeacher = { id: string; full_name: string; department_head: string; assignments: Array<{ class_id: string; subject_id: string }> };
type ManagedReport = {
  id: string; studentName: string; grade: string; stream: string; term: number | null; half: string;
  generatedAt: string; expiresAt: string; downloadUrl: string | null;
};
type ResultWindow = { id: string; grade: string; term: number; half: string; deadline: string; status: string };
type ResultEntry = {
  rosterId: string; studentName: string; assessmentNumber: string; classId: string; stream: string;
  subjectId: string; subjectName: string; maxMarks: number; canEditSubjectRemark?: boolean;
  result?: { id: string; mark: number | null; result_code: string };
};
type ResultWindowDetail = {
  window: ResultWindow;
  results: ResultEntry[];
  classRemarks: Array<{ class_id: string; remark: string }>;
  subjectRemarks: Array<{ class_id: string; subject_id: string; remark: string }>;
};
type SchoolOverview = {
  school: {
    name: string; examination_code: string; location: string; email: string | null; po_box: string | null;
    category: string; ownership: string; county: string; sub_county: string; grades: string[]; logoUrl: string | null;
  };
  counts: { classes: number; students: number; teachers?: number };
  classes: ClassRecord[];
};
type StudentOverview = {
  student: { name: string; assessmentNumber: string | null; grade: string; stream: string };
  school: { name: string; email: string | null; po_box: string | null; logoUrl: string | null };
  subjects: SubjectRecord[];
  notices: Array<{ id: string; message: string; created_at: string }>;
  reports: Array<{ id: string; downloadUrl: string; expiresAt: string }>;
  timetables: Array<{ id: string; filename: string; downloadUrl: string; expiresAt: string }>;
};
type TimetableRecord = { id: string; grade: string; filename: string; downloadUrl: string; expiresAt: string };

export default function SchoolPortals({ user, onLogout }: { user: User; onLogout: () => void }) {
  if (user.role === "super_admin" || user.role === "admin") return <SuperAdminPortal user={user} onLogout={onLogout} />;
  if (user.role === "student") return <StudentPortal user={user} onLogout={onLogout} />;
  return <StaffPortal user={user} onLogout={onLogout} />;
}

function PortalShell({ title, subtitle, onLogout, children }: { title: string; subtitle: string; onLogout: () => void; children: ReactNode }) {
  return <main className="school-portal">
    <header className="school-portal-header"><Brand /><div><h1>{title}</h1><p>{subtitle}</p></div><button className="quiet-button" onClick={onLogout}><LogOut size={15} /> Sign out</button></header>
    {children}
    <footer className="school-portal-footer">Need help? <a href={`mailto:${supportEmail}`}>{supportEmail}</a></footer>
  </main>;
}

function emptySchoolForm(): SchoolForm {
  return {
    name: "",
    examinationCode: "",
    category: "Combined",
    ownership: "Public",
    county: "",
    subCounty: "",
    location: "",
    telephone: "",
    email: "",
    poBox: "",
    website: "",
    grades: [],
    administratorName: "",
    administratorEmail: "",
    administratorPhone: "",
    administratorDesignation: "School Administrator",
  };
}

function SuperAdminPortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [schools, setSchools] = useState<SchoolRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<SchoolForm>(emptySchoolForm);
  const [schoolLogo, setSchoolLogo] = useState<File | null>(null);
  const [logoError, setLogoError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [registration, setRegistration] = useState<RegistrationResult | null>(null);
  const [logoUploadError, setLogoUploadError] = useState("");
  const [updatingSchoolId, setUpdatingSchoolId] = useState("");
  const [updatingLogoSchoolId, setUpdatingLogoSchoolId] = useState("");
  const logoPreviewUrl = useMemo(() => schoolLogo ? URL.createObjectURL(schoolLogo) : "", [schoolLogo]);
  const refresh = useCallback(() => apiRequest<{ schools: SchoolRecord[] }>("/api/super-admin/schools")
    .then(({ schools: rows }) => { setSchools(rows); setError(""); })
    .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Schools could not be loaded.")), []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl); }, [logoPreviewUrl]);

  function updateForm<Key extends keyof SchoolForm>(key: Key, value: SchoolForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function uploadSchoolLogo(schoolId: string, file: File) {
    const data = new FormData();
    data.set("file", file);
    await apiRequest(`/api/super-admin/schools/${schoolId}/assets/logo`, { method: "PUT", body: data });
  }

  async function registerSchool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!reviewing) {
      if (!form.grades.length) {
        setError("Select at least one grade the school currently offers.");
        return;
      }
      setReviewing(true);
      return;
    }
    setBusy(true);
    try {
      const created = await apiRequest<RegistrationResult>("/api/super-admin/schools", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setRegistration(created);
      setForm(emptySchoolForm());
      setReviewing(false);
      setLogoUploadError("");
      if (schoolLogo) {
        try {
          await uploadSchoolLogo(created.school.id, schoolLogo);
          setSchoolLogo(null);
        } catch (uploadError) {
          setLogoUploadError(uploadError instanceof Error ? uploadError.message : "The school was saved, but its logo could not be uploaded.");
        }
      }
      setNotice("The school record has been saved. Its verification status is pending.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The school could not be registered.");
    } finally {
      setBusy(false);
    }
  }

  async function retryLogoUpload() {
    if (!registration || !schoolLogo) return;
    setBusy(true);
    setLogoUploadError("");
    try {
      await uploadSchoolLogo(registration.school.id, schoolLogo);
      setSchoolLogo(null);
      await refresh();
    } catch (uploadError) {
      setLogoUploadError(uploadError instanceof Error ? uploadError.message : "The school logo could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  async function replaceDirectoryLogo(schoolId: string, file: File) {
    setUpdatingLogoSchoolId(schoolId);
    setError("");
    try {
      await uploadSchoolLogo(schoolId, file);
      await refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The school logo could not be updated.");
    } finally {
      setUpdatingLogoSchoolId("");
    }
  }

  async function retryAdministratorInvitation(schoolId = registration?.school.id) {
    if (!schoolId) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ invitationStatus: "sent" | "failed"; message: string }>(
        `/api/super-admin/schools/${schoolId}/administrator-invitation`,
        { method: "POST" },
      );
      setRegistration((current) => current?.school.id === schoolId
        ? { ...current, administratorInvitationStatus: result.invitationStatus, administratorInvitationMessage: result.message }
        : current);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The invitation could not be retried.");
    } finally {
      setBusy(false);
    }
  }

  async function updateSchoolStatus(school: SchoolRecord, field: "verificationStatus" | "operationalStatus", value: string) {
    setUpdatingSchoolId(school.id);
    setError("");
    try {
      await apiRequest(`/api/super-admin/schools/${school.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: value }),
      });
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The school status could not be updated.");
    } finally {
      setUpdatingSchoolId("");
    }
  }

  const grades = Array.from({ length: 12 }, (_, index) => `Grade ${index + 1}`);
  const phonePattern = "(?:\\+?254|0)(?:[17]\\d{8}|[2-5]\\d{7,8})";

  return <PortalShell title="Platform administration" subtitle={`Super Admin · ${user.name}`} onLogout={onLogout}>
    <section className="school-portal-grid school-admin-grid">
      <article className="school-portal-card">
        <div className="school-portal-card-heading"><School size={20} /><div><h2>Register a new school</h2><p>Save official school details and invite its first School Administrator.</p></div></div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        {registration && <div className="school-registration-result" role="status">
          <div className="school-result-heading"><Check size={18} /><strong>{registration.school.name} is registered</strong></div>
          <p>Internal school ID: <code>{registration.school.id}</code></p>
          <p>Verification status: <strong>{registration.school.verification_status}</strong></p>
          <p>Administrator invitation: <strong>{registration.administratorInvitationStatus === "sent" ? "Sent — awaiting activation" : "Not sent — retry required"}</strong></p>
          <p>{registration.administratorInvitationMessage}</p>
          {registration.administratorInvitationStatus !== "sent" && <button className="quiet-button" type="button" onClick={() => void retryAdministratorInvitation()} disabled={busy}>
            <RefreshCw size={15} /> Retry administrator invitation
          </button>}
          {logoUploadError && <div className="school-upload-recovery"><p>{logoUploadError}</p>
            {schoolLogo && <button className="quiet-button" type="button" onClick={() => void retryLogoUpload()} disabled={busy}><Upload size={15} /> Retry logo upload</button>}
          </div>}
        </div>}
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        <form className="school-portal-form school-registration-form" onSubmit={(event) => void registerSchool(event)}>
          <section className="school-form-section">
            <h3>Section A: School Information</h3>
            {!reviewing ? <>
              <label>Official school name <span aria-hidden="true">*</span><input required minLength={2} maxLength={160} value={form.name} onChange={(event) => updateForm("name", event.target.value)} /></label>
              <label>Registration number / official school code <span aria-hidden="true">*</span><input required minLength={2} maxLength={40} value={form.examinationCode} onChange={(event) => updateForm("examinationCode", event.target.value)} /></label>
              <label>School category <span aria-hidden="true">*</span><select required value={form.category} onChange={(event) => updateForm("category", event.target.value as SchoolForm["category"])}>
                <option value="Primary">Primary</option><option value="Junior">Junior</option><option value="Senior">Senior</option><option value="Combined">Combined</option>
              </select></label>
              <label>Ownership <span aria-hidden="true">*</span><select required value={form.ownership} onChange={(event) => updateForm("ownership", event.target.value as SchoolForm["ownership"])}>
                <option value="Public">Public</option><option value="Private">Private</option>
              </select></label>
              <label>County <span aria-hidden="true">*</span><select required value={form.county} onChange={(event) => { updateForm("county", event.target.value); updateForm("subCounty", ""); }}>
                <option value="">Choose county</option>{kenyaCounties.map((county) => <option key={county} value={county}>{county}</option>)}
              </select></label>
              <label>Sub-County <span aria-hidden="true">*</span><input required minLength={2} maxLength={120} value={form.subCounty} onChange={(event) => updateForm("subCounty", event.target.value)} placeholder={form.county ? `Enter the Sub-County in ${form.county}` : "Choose a county first"} disabled={!form.county} /></label>
              <label>Physical location <span aria-hidden="true">*</span><input required minLength={2} maxLength={200} value={form.location} onChange={(event) => updateForm("location", event.target.value)} placeholder="Town, ward, or locality" /></label>
              <label>Official school telephone <span aria-hidden="true">*</span><input type="tel" required pattern={phonePattern} title="Enter a valid Kenyan phone number, such as 0712345678 or +254712345678." value={form.telephone} onChange={(event) => updateForm("telephone", event.target.value)} /></label>
              <label>Official school email <span className="optional-label">(optional)</span><input type="email" maxLength={254} value={form.email} onChange={(event) => updateForm("email", event.target.value)} /></label>
              <label>Postal address <span className="optional-label">(optional)</span><input maxLength={80} value={form.poBox} onChange={(event) => updateForm("poBox", event.target.value)} /></label>
              <label>School website <span className="optional-label">(optional)</span><input type="url" maxLength={255} value={form.website} onChange={(event) => updateForm("website", event.target.value)} placeholder="https://" /></label>
              <fieldset className="school-grade-picker">
                <legend>Grades offered <span aria-hidden="true">*</span></legend>
                <p>Select only grades currently offered by this school.</p>
                <div>{grades.map((grade) => <label className="school-checkbox" key={grade}>
                  <input type="checkbox" checked={form.grades.includes(grade)} onChange={(event) => updateForm("grades", event.target.checked ? [...form.grades, grade] : form.grades.filter((selected) => selected !== grade))} />{grade}
                </label>)}</div>
              </fieldset>
            </> : <dl className="school-review-grid">
              <div><dt>School</dt><dd>{form.name}</dd></div><div><dt>Official registration number</dt><dd>{form.examinationCode}</dd></div>
              <div><dt>Category and ownership</dt><dd>{form.category} · {form.ownership}</dd></div><div><dt>County / Sub-County</dt><dd>{form.county} · {form.subCounty}</dd></div>
              <div><dt>Location and telephone</dt><dd>{form.location} · {form.telephone}</dd></div><div><dt>School email</dt><dd>{form.email || "Not provided"}</dd></div>
              <div><dt>Postal address / website</dt><dd>{form.poBox || "—"} · {form.website || "—"}</dd></div><div><dt>Grades offered</dt><dd>{form.grades.join(", ")}</dd></div>
            </dl>}
          </section>
          <section className="school-form-section">
            <h3>Section B: School Logo</h3>
            <div className="school-logo-picker">
              <div className="school-logo-preview">{logoPreviewUrl ? <img src={logoPreviewUrl} alt="Selected school logo preview" /> : <Image size={32} aria-hidden="true" />}</div>
              <div><strong>{schoolLogo ? schoolLogo.name : "No logo selected"}</strong><p>JPEG, PNG, or WebP · maximum 2 MB. The logo is stored privately and shown only through time-limited links.</p>
                {!reviewing && <label className="school-upload-button"><Upload size={15} /> Upload School Logo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setLogoError("");
                  if (file && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
                    setLogoError("Choose a JPEG, PNG, or WebP image.");
                    event.target.value = "";
                    return;
                  }
                  if (file && file.size > 2 * 1024 * 1024) {
                    setLogoError("The logo must be no larger than 2 MB.");
                    event.target.value = "";
                    return;
                  }
                  setSchoolLogo(file);
                }} /></label>}
                {schoolLogo && !reviewing && <button className="school-remove-logo" type="button" onClick={() => setSchoolLogo(null)}><X size={14} /> Remove logo</button>}
              </div>
            </div>
            {logoError && <p className="auth-error" role="alert">{logoError}</p>}
          </section>
          <section className="school-form-section">
            <h3>Section C: School Administrator Information</h3>
            {!reviewing ? <>
              <label>Administrator's full name <span aria-hidden="true">*</span><input required minLength={2} maxLength={160} value={form.administratorName} onChange={(event) => updateForm("administratorName", event.target.value)} /></label>
              <label>Administrator's email <span aria-hidden="true">*</span><input type="email" required maxLength={254} value={form.administratorEmail} onChange={(event) => updateForm("administratorEmail", event.target.value)} /></label>
              <label>Administrator's telephone <span aria-hidden="true">*</span><input type="tel" required pattern={phonePattern} title="Enter a valid Kenyan phone number, such as 0712345678 or +254712345678." value={form.administratorPhone} onChange={(event) => updateForm("administratorPhone", event.target.value)} /></label>
              <label>Job title / designation <span aria-hidden="true">*</span><input required minLength={2} maxLength={100} value={form.administratorDesignation} onChange={(event) => updateForm("administratorDesignation", event.target.value)} /></label>
            </> : <dl className="school-review-grid">
              <div><dt>Administrator</dt><dd>{form.administratorName}</dd></div><div><dt>Email invitation</dt><dd>{form.administratorEmail}</dd></div>
              <div><dt>Telephone</dt><dd>{form.administratorPhone}</dd></div><div><dt>Job title</dt><dd>{form.administratorDesignation}</dd></div>
            </dl>}
            <p className="school-onboarding-note">Principal, teachers, and other school personnel are onboarded later by the School Administrator.</p>
          </section>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <div className="school-form-actions">
            {reviewing && <button className="quiet-button" type="button" onClick={() => setReviewing(false)} disabled={busy}>Edit details</button>}
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving school and sending invitation…" : reviewing ? "Confirm and register school" : "Review registration"} <ArrowRight size={15} /></button>
          </div>
        </form>
      </article>
      <article className="school-portal-card school-directory-card">
        <div className="school-portal-card-heading"><Users size={20} /><div><h2>School directory</h2><p>School identity, verification, and account status</p></div><button className="icon-button" onClick={() => void refresh()} aria-label="Refresh schools"><RefreshCw size={16} /></button></div>
        {schools.map((school) => <div className="school-directory-row" key={school.id}>
          <div className="school-directory-heading">
            {school.logoUrl ? <img className="school-directory-logo" src={school.logoUrl} alt={`${school.name} logo`} /> : <div className="school-directory-logo school-directory-placeholder"><School size={20} aria-hidden="true" /></div>}
            <div><strong>{school.name}</strong><small>{school.examination_code} · {school.category ?? "Category not recorded"} · {school.ownership ?? "Ownership not recorded"}</small><small>{school.county}{school.sub_county ? `, ${school.sub_county}` : ""} · {school.location}</small></div>
          </div>
          <div className="school-directory-details">
            <span>Grades: {school.grades?.length ? school.grades.join(", ") : "Not configured"}</span>
            <span>Administrator: {school.administrator?.name ?? "Not assigned"} · {school.administrator?.invitationStatus === "sent" ? "Invitation sent · awaiting activation" : school.administrator?.invitationStatus ?? "not invited"}</span>
            <details className="school-directory-profile"><summary>View school profile</summary>
              <span>Official telephone: {school.telephone || "Not recorded"}</span>
              <span>Official email: {school.email || "Not provided"}</span>
              <span>Postal address: {school.po_box || "Not provided"}</span>
              <span>Website: {school.website || "Not provided"}</span>
              {school.administrator?.email && <span>Administrator email: {school.administrator.email}</span>}
            </details>
            <div className="school-directory-selects">
              <label>Verification<select disabled={updatingSchoolId === school.id} value={school.verification_status} onChange={(event) => void updateSchoolStatus(school, "verificationStatus", event.target.value)}>
                <option value="pending">Pending verification</option><option value="verified">Verified</option><option value="rejected">Rejected</option>
              </select></label>
              <label>Operations<select disabled={updatingSchoolId === school.id} value={school.operational_status} onChange={(event) => void updateSchoolStatus(school, "operationalStatus", event.target.value)}>
                <option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option>
              </select></label>
            </div>
            <label className="school-logo-update"><Upload size={14} /> {updatingLogoSchoolId === school.id ? "Updating logo…" : "Update school logo"}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={updatingLogoSchoolId === school.id} onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
                setError("Choose a valid JPEG, PNG, or WebP school logo no larger than 2 MB.");
                return;
              }
              void replaceDirectoryLogo(school.id, file);
            }} /></label>
            {(school.administrator?.invitationStatus === "failed" || school.administrator?.invitationStatus === "sent") && <button className="quiet-button" type="button" disabled={busy} onClick={() => void retryAdministratorInvitation(school.id)}><RefreshCw size={14} /> Resend invitation</button>}
            <div className="school-counts"><span>{school.studentCount} students</span><span>{school.teacherCount} staff</span><span>{school.classCount} classes</span></div>
          </div>
        </div>)}
        {!schools.length && !error && <p className="school-empty">No schools registered yet.</p>}
      </article>
    </section>
  </PortalShell>;
}

function StaffPortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [overview, setOverview] = useState<SchoolOverview | null>(null);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [departmentTeachers, setDepartmentTeachers] = useState<DepartmentTeacher[]>([]);
  const [managedReports, setManagedReports] = useState<ManagedReport[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState("");
  const [grade, setGrade] = useState("Grade 1");
  const [subjectName, setSubjectName] = useState("");
  const [maxMarks, setMaxMarks] = useState("100");
  const [studentForm, setStudentForm] = useState({ classId: "", fullName: "", assessmentNumber: "", guardianPhone: "" });
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([]);
  const [windows, setWindows] = useState<ResultWindow[]>([]);
  const [selectedWindowId, setSelectedWindowId] = useState("");
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [resultMarks, setResultMarks] = useState<Record<string, string>>({});
  const [deadline, setDeadline] = useState("");
  const [timetableFile, setTimetableFile] = useState<File | null>(null);
  const [signatureFile, setSignatureFile] = useState<File | null>(null);
  const [timetables, setTimetables] = useState<TimetableRecord[]>([]);
  const [classRemarks, setClassRemarks] = useState<Record<string, string>>({});
  const [subjectRemarks, setSubjectRemarks] = useState<Record<string, string>>({});
  const [principalRemarks, setPrincipalRemarks] = useState("");
  const [classTeacherRemarks, setClassTeacherRemarks] = useState("");
  const [teacherForm, setTeacherForm] = useState({
    fullName: "", phoneNumber: "", departmentHead: "", subjectHead: "", accountRole: "teacher",
    assignments: [{ classId: "", subjectId: "" }],
  });

  const refresh = useCallback(async () => {
    try {
      const [summary, classResult, subjectResult, windowResult, timetableResult] = await Promise.all([
        apiRequest<SchoolOverview>("/api/school/overview"),
        apiRequest<{ classes: ClassRecord[] }>("/api/school/classes"),
        apiRequest<{ subjects: SubjectRecord[] }>("/api/school/subjects"),
        apiRequest<{ windows: ResultWindow[] }>("/api/school/result-windows"),
        apiRequest<{ timetables: TimetableRecord[] }>("/api/school/timetables"),
      ]);
      setOverview(summary);
      setGrade((current) => summary.school.grades.includes(current) ? current : summary.school.grades[0] ?? "Grade 1");
      setClasses(classResult.classes);
      setSubjects(subjectResult.subjects);
      setWindows(windowResult.windows);
      setTimetables(timetableResult.timetables);
      setSelectedWindowId((current) => current || windowResult.windows[0]?.id || "");
      setStudentForm((current) => ({ ...current, classId: current.classId || classResult.classes[0]?.id || "" }));
      setTeacherForm((current) => ({
        ...current,
        assignments: current.assignments.map((assignment) => ({
          classId: assignment.classId || classResult.classes[0]?.id || "",
          subjectId: assignment.subjectId || subjectResult.subjects[0]?.id || "",
        })),
      }));
      if (user.role === "school_admin") {
        const [studentResult, teacherResult, reportResult] = await Promise.all([
          apiRequest<{ students: StudentRecord[] }>("/api/school/students"),
          apiRequest<{ teachers: TeacherRecord[] }>("/api/school/teachers"),
          apiRequest<{ reports: ManagedReport[] }>("/api/school/reports"),
        ]);
        setStudents(studentResult.students);
        setTeachers(teacherResult.teachers);
        setManagedReports(reportResult.reports);
      } else if (user.role === "teacher" || user.role === "class_coordinator") {
        const studentResult = await apiRequest<{ students: StudentRecord[] }>("/api/school/students");
        setStudents(studentResult.students);
        if (user.role === "teacher") {
          const departmentResult = await apiRequest<{ teachers: DepartmentTeacher[] }>("/api/school/teachers");
          setDepartmentTeachers(departmentResult.teachers);
        } else {
          const reportResult = await apiRequest<{ reports: ManagedReport[] }>("/api/school/reports");
          setManagedReports(reportResult.reports);
        }
      }
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "School information could not be loaded.");
    }
  }, [user.role]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!selectedWindowId || !["teacher", "class_coordinator", "school_admin"].includes(user.role)) return;
    apiRequest<ResultWindowDetail>(`/api/school/result-windows/${selectedWindowId}`)
      .then(({ results: rows, classRemarks: classRemarkRows, subjectRemarks: subjectRemarkRows }) => {
        setResults(rows);
        setClassRemarks(Object.fromEntries(classRemarkRows.map((row) => [row.class_id, row.remark])));
        setSubjectRemarks(Object.fromEntries(subjectRemarkRows.map((row) => [`${row.class_id}:${row.subject_id}`, row.remark])));
        setResultMarks(Object.fromEntries(rows.map((row) => [`${row.rosterId}:${row.subjectId}`, row.result?.mark == null ? "" : String(row.result.mark)])));
      })
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Results could not be loaded."));
  }, [selectedWindowId, user.role]);

  async function openResults(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    const formData = new FormData(event.currentTarget);
    try {
      const response = await apiRequest<{ windowId: string }>("/api/school/result-windows", {
        method: "POST",
        body: JSON.stringify({
          grade: String(formData.get("grade")),
          term: Number(formData.get("term")),
          half: String(formData.get("half")),
          opensAt: new Date().toISOString(),
          deadline: new Date(deadline).toISOString(),
        }),
      });
      setSelectedWindowId(response.windowId);
      setNotice("Results entry is open for the selected grade.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The results window could not be opened.");
    } finally { setBusy(false); }
  }

  async function submitMark(row: ResultEntry, value: string, reason?: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/api/school/result-windows/${selectedWindowId}/students/${row.rosterId}/subjects/${row.subjectId}`, {
        method: "PUT",
        body: JSON.stringify({ result: value === "Y" ? "Y" : Number(value), ...(reason ? { reason } : {}) }),
      });
      setNotice(`Saved ${row.subjectName} result for ${row.studentName}.`);
      const updated = await apiRequest<{ results: ResultEntry[] }>(`/api/school/result-windows/${selectedWindowId}`);
      setResults(updated.results);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The result could not be saved.");
    } finally { setBusy(false); }
  }

  async function submitGrade() {
    if (!selectedWindowId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/api/school/result-windows/${selectedWindowId}/submit`, { method: "POST" });
      setNotice("Grade results submitted to the School Administrator.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Grade results could not be submitted.");
    } finally { setBusy(false); }
  }

  async function releaseReports() {
    if (!selectedWindowId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await apiRequest<{ released: boolean; withheldStudents: number }>(`/api/school/result-windows/${selectedWindowId}/release`, {
        method: "POST",
        body: JSON.stringify({ principalRemarks, classTeacherRemarks }),
      });
      setNotice(`Reports sent. ${response.withheldStudents} student(s) received a notice instead of a report.`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Reports could not be generated.");
    } finally { setBusy(false); }
  }

  async function shareTimetable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!timetableFile) {
      setError("Choose a timetable PDF or image.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    const form = new FormData(event.currentTarget);
    form.set("file", timetableFile);
    try {
      await apiRequest("/api/school/timetables", { method: "POST", body: form });
      setTimetableFile(null);
      setNotice("Timetable shared with students and teachers in the selected grade for one week.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The timetable could not be shared.");
    } finally { setBusy(false); }
  }

  async function saveClassRemark(classId: string) {
    if (!selectedWindowId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/api/school/result-windows/${selectedWindowId}/classes/${classId}/remarks`, {
        method: "PUT", body: JSON.stringify({ remark: classRemarks[classId] ?? "" }),
      });
      setNotice("Class teacher remarks saved.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Class teacher remarks could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSubjectRemark(classId: string, subjectId: string) {
    if (!selectedWindowId) return;
    const key = `${classId}:${subjectId}`;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/api/school/result-windows/${selectedWindowId}/classes/${classId}/subjects/${subjectId}/remarks`, {
        method: "PUT", body: JSON.stringify({ remark: subjectRemarks[key] ?? "" }),
      });
      setNotice("Subject teacher remarks saved.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Subject teacher remarks could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadSignature() {
    if (!signatureFile) return;
    const form = new FormData();
    form.set("file", signatureFile);
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest("/api/school/my-signature", { method: "PUT", body: form });
      setSignatureFile(null);
      setNotice("Your signature has been saved for reports in your assigned class.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Your signature could not be saved.");
    } finally { setBusy(false); }
  }

  async function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const formData = new FormData(event.currentTarget);
      await apiRequest("/api/school/classes", {
        method: "POST",
        body: JSON.stringify({
          grade, stream,
          classTeacherId: String(formData.get("classTeacherId") || "") || undefined,
          coordinatorId: String(formData.get("coordinatorId") || "") || undefined,
        }),
      });
      setStream("");
      setNotice("Class created.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Class could not be created.");
    } finally { setBusy(false); }
  }

  async function saveSubject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest("/api/school/subjects", { method: "POST", body: JSON.stringify({ name: subjectName, maxMarks: Number(maxMarks) }) });
      setSubjectName(""); setNotice("Subject added to the school catalog."); await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Subject could not be added.");
    } finally { setBusy(false); }
  }

  async function editSubjectMaximum(subject: SubjectRecord) {
    const value = window.prompt(`Maximum marks for ${subject.name}`, String(subject.max_marks));
    if (value === null) return;
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) {
      setError("Enter a valid maximum mark greater than zero.");
      return;
    }

    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/api/school/subjects/${subject.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: subject.name, maxMarks: next }),
      });
      setNotice(`Maximum marks for ${subject.name} updated.`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The subject maximum could not be updated.");
    } finally { setBusy(false); }
  }

  async function deleteReport(report: ManagedReport) {
    if (!window.confirm(`Delete ${report.studentName}'s report copy?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/api/school/reports/${report.id}`, { method: "DELETE" });
      setManagedReports((current) => current.filter((item) => item.id !== report.id));
      setNotice("Report copy deleted.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The report copy could not be deleted.");
    } finally { setBusy(false); }
  }

  async function addStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest("/api/school/students", { method: "POST", body: JSON.stringify({ ...studentForm, subjectIds: selectedSubjects }) });
      setStudentForm((current) => ({ ...current, fullName: "", assessmentNumber: "", guardianPhone: "" }));
      setSelectedSubjects([]);
      setNotice("Student added to the school roster. Give the student their school name, assessment number, and recorded guardian phone for activation.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Student could not be added.");
    } finally { setBusy(false); }
  }

  async function addTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice(""); setActivationCode("");
    try {
      const result = await apiRequest<{ activationCode: string }>("/api/school/teachers", {
        method: "POST",
        body: JSON.stringify({
          fullName: teacherForm.fullName,
          phoneNumber: teacherForm.phoneNumber,
          accountRole: teacherForm.accountRole,
          departmentHead: teacherForm.departmentHead,
          subjectHead: teacherForm.subjectHead,
          assignments: teacherForm.assignments,
        }),
      });
      setActivationCode(result.activationCode);
      setTeacherForm((current) => ({ ...current, fullName: "", phoneNumber: "", departmentHead: "", subjectHead: "" }));
      setNotice("Teacher record created. Share this single-use activation code with the teacher in person.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Teacher could not be onboarded.");
    } finally { setBusy(false); }
  }

  const isSchoolAdmin = user.role === "school_admin";
  const canOnboardStudents = isSchoolAdmin || (user.role === "teacher" && classes.some((item) => item.id === studentForm.classId));
  return <PortalShell title={overview?.school.name ?? "School portal"} subtitle={`${user.role.replaceAll("_", " ")} · ${user.name}`} onLogout={onLogout}>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {notice && <p className="auth-notice" role="status">{notice}</p>}
    {overview && <div className="school-brand-banner">
      {overview.school.logoUrl ? <img src={overview.school.logoUrl} alt={`${overview.school.name} logo`} /> : <div><School size={23} aria-hidden="true" /></div>}
      <span><strong>{overview.school.name}</strong><small>{overview.school.category || "Category not recorded"} · {overview.school.county}, {overview.school.sub_county} · Grades offered: {overview.school.grades.join(", ") || "Not configured"}</small></span>
    </div>}
    {activationCode && <div className="teacher-activation-code"><ShieldCheck size={18} /><span><strong>Teacher activation code</strong><code>{activationCode}</code><small>Shown once. Give it to the teacher in person. It expires in seven days.</small></span></div>}
    <section className="school-stat-grid">
      <div><strong>{overview?.counts.students ?? "—"}</strong><span>Students in your access</span></div>
      <div><strong>{overview?.counts.classes ?? "—"}</strong><span>Classes in your access</span></div>
      <div><strong>{overview?.counts.teachers ?? "—"}</strong><span>Teachers in school</span></div>
    </section>
    <section className="school-portal-grid">
      {(isSchoolAdmin) && <article className="school-portal-card">
        <h2>Create a class</h2>
        <form className="school-portal-form compact" onSubmit={(event) => void createClass(event)}>
          <label>Grade<select value={grade} onChange={(event) => setGrade(event.target.value)}>{(overview?.school.grades.length ? overview.school.grades : Array.from({ length: 12 }, (_, index) => `Grade ${index + 1}`)).map((schoolGrade) => <option key={schoolGrade}>{schoolGrade}</option>)}</select></label>
          <label>Stream<input required value={stream} onChange={(event) => setStream(event.target.value)} placeholder="A, B, East…" /></label>
          <label>Class Teacher<select name="classTeacherId"><option value="">Not assigned</option>{teachers.filter((teacher) => teacher.profile_id && teacher.account_role === "teacher").map((teacher) => <option key={teacher.id} value={teacher.profile_id!}>{teacher.full_name}</option>)}</select></label>
          <label>Class Coordinator<select name="coordinatorId"><option value="">Not assigned</option>{teachers.filter((teacher) => teacher.profile_id && teacher.account_role === "class_coordinator").map((teacher) => <option key={teacher.id} value={teacher.profile_id!}>{teacher.full_name}</option>)}</select></label>
          <button className="primary-button" disabled={busy}>Add class</button>
        </form>
      </article>}
      {isSchoolAdmin && <article className="school-portal-card">
        <h2>Add a subject</h2><form className="school-portal-form compact" onSubmit={(event) => void saveSubject(event)}>
          <label>Subject name<input required value={subjectName} onChange={(event) => setSubjectName(event.target.value)} /></label>
          <label>Maximum marks<input required type="number" min="1" step="0.01" value={maxMarks} onChange={(event) => setMaxMarks(event.target.value)} /></label>
          <button className="primary-button" disabled={busy}>Add subject</button>
        </form>
      </article>}
      {isSchoolAdmin && <article className="school-portal-card">
        <h2>Open results entry</h2><form className="school-portal-form compact" onSubmit={(event) => void openResults(event)}>
          <label>Grade<select name="grade" required>{Array.from(new Set(classes.map((item) => item.grade))).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Term<select name="term"><option value="1">Term 1</option><option value="2">Term 2</option><option value="3">Term 3</option></select></label>
          <label>Exam period<select name="half"><option value="mid-term">Mid-term</option><option value="end-term">End-term</option></select></label>
          <label>Deadline<input type="datetime-local" required value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
          <button className="primary-button" disabled={busy || !classes.length}>Open result window</button>
        </form>
      </article>}
      {isSchoolAdmin && <article className="school-portal-card">
        <h2>Share a timetable</h2><form className="school-portal-form compact" onSubmit={(event) => void shareTimetable(event)}>
          <label>Grade<select name="grade" required>{Array.from(new Set(classes.map((item) => item.grade))).map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>PDF or image<input required type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => setTimetableFile(event.target.files?.[0] ?? null)} /></label>
          <button className="primary-button" disabled={busy || !timetableFile}>Send timetable to grade</button>
        </form>
      </article>}
      {(user.role === "teacher" || user.role === "class_coordinator") && <article className="school-portal-card">
        <h2>Class timetables</h2>{timetables.map((item) => <div className="school-list-row" key={item.id}><div><strong>{item.grade} · {item.filename}</strong><small>Available until {new Date(item.expiresAt).toLocaleDateString()}</small></div><a className="primary-button" href={item.downloadUrl} download><Download size={15} /> Download</a></div>)}{!timetables.length && <p className="school-empty">No current timetable has been shared.</p>}
      </article>}
      {user.role === "teacher" && <article className="school-portal-card">
        <h2>Report signature</h2><p>Upload a PNG or JPEG signature image. It appears on reports for classes where you are assigned as Class Teacher.</p>
        <label className="school-portal-form compact">Signature image<input type="file" accept="image/png,image/jpeg" onChange={(event) => setSignatureFile(event.target.files?.[0] ?? null)} /></label>
        <button className="primary-button" disabled={busy || !signatureFile} onClick={() => void uploadSignature()}>Save signature</button>
      </article>}
      {canOnboardStudents && <article className="school-portal-card">
        <h2>Onboard a student</h2><form className="school-portal-form compact" onSubmit={(event) => void addStudent(event)}>
          <label>Class<select required value={studentForm.classId} onChange={(event) => setStudentForm({ ...studentForm, classId: event.target.value })}>{classes.map((item) => <option key={item.id} value={item.id}>{item.grade} {item.stream}</option>)}</select></label>
          <label>Student full name<input required value={studentForm.fullName} onChange={(event) => setStudentForm({ ...studentForm, fullName: event.target.value })} /></label>
          <label>Assessment number<input required value={studentForm.assessmentNumber} onChange={(event) => setStudentForm({ ...studentForm, assessmentNumber: event.target.value })} /></label>
          <label>Guardian phone number<input required type="tel" value={studentForm.guardianPhone} onChange={(event) => setStudentForm({ ...studentForm, guardianPhone: event.target.value })} /></label>
          <fieldset><legend>Student subjects</legend>{subjects.map((subject) => <label className="school-checkbox" key={subject.id}><input type="checkbox" checked={selectedSubjects.includes(subject.id)} onChange={(event) => setSelectedSubjects((current) => event.target.checked ? [...current, subject.id] : current.filter((id) => id !== subject.id))} />{subject.name}</label>)}</fieldset>
          <button className="primary-button" disabled={busy || !studentForm.classId || !selectedSubjects.length}>Add student</button>
        </form>
      </article>}
      {isSchoolAdmin && <article className="school-portal-card">
        <h2>Onboard a teacher</h2><form className="school-portal-form compact" onSubmit={(event) => void addTeacher(event)}>
          <label>Teacher full name<input required value={teacherForm.fullName} onChange={(event) => setTeacherForm({ ...teacherForm, fullName: event.target.value })} /></label>
          <label>Phone number<input required type="tel" value={teacherForm.phoneNumber} onChange={(event) => setTeacherForm({ ...teacherForm, phoneNumber: event.target.value })} /></label>
          <label>Portal role<select value={teacherForm.accountRole} onChange={(event) => setTeacherForm({ ...teacherForm, accountRole: event.target.value })}><option value="teacher">Teacher</option><option value="class_coordinator">Class Coordinator</option></select></label>
          {teacherForm.assignments.map((assignment, index) => <div className="school-assignment-row" key={index}>
            <label>Class<select required value={assignment.classId} onChange={(event) => setTeacherForm((current) => ({ ...current, assignments: current.assignments.map((item, itemIndex) => itemIndex === index ? { ...item, classId: event.target.value } : item) }))}>{classes.map((item) => <option key={item.id} value={item.id}>{item.grade} {item.stream}</option>)}</select></label>
            <label>Subject<select required value={assignment.subjectId} onChange={(event) => setTeacherForm((current) => ({ ...current, assignments: current.assignments.map((item, itemIndex) => itemIndex === index ? { ...item, subjectId: event.target.value } : item) }))}>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            {teacherForm.assignments.length > 1 && <button type="button" className="quiet-button" onClick={() => setTeacherForm((current) => ({ ...current, assignments: current.assignments.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button>}
          </div>)}
          <button type="button" className="quiet-button" onClick={() => setTeacherForm((current) => ({ ...current, assignments: [...current.assignments, { classId: classes[0]?.id ?? "", subjectId: subjects[0]?.id ?? "" }] }))} disabled={!classes.length || !subjects.length}>Add class and subject</button>
          <label>Department led (optional)<input value={teacherForm.departmentHead} onChange={(event) => setTeacherForm({ ...teacherForm, departmentHead: event.target.value })} /></label>
          <label>Subject led (optional)<input value={teacherForm.subjectHead} onChange={(event) => setTeacherForm({ ...teacherForm, subjectHead: event.target.value })} /></label>
          <button className="primary-button" disabled={busy || !teacherForm.assignments.every((assignment) => assignment.classId && assignment.subjectId)}>Create teacher and activation code</button>
        </form>
      </article>}
      <article className="school-portal-card">
        <h2>Classes and streams</h2>
        {classes.map((item) => <div className="school-list-row" key={item.id}><strong>{item.grade} {item.stream}</strong><span>{item.studentCount ?? ""} students</span></div>)}
        {!classes.length && <p className="school-empty">No classes are assigned to this account yet.</p>}
      </article>
      {(isSchoolAdmin || user.role === "class_coordinator") && <article className="school-portal-card">
        <h2>School subjects and maximum marks</h2>
        {subjects.map((subject) => <div className="school-list-row" key={subject.id}>
          <strong>{subject.name}</strong>
          <span>Maximum: {subject.max_marks} <button type="button" className="quiet-button" disabled={busy} onClick={() => void editSubjectMaximum(subject)}>Edit</button></span>
        </div>)}
      </article>}
      {user.role === "school_admin" && <article className="school-portal-card">
        <h2>Teachers</h2>{teachers.map((teacher) => <div className="school-list-row" key={teacher.id}><div><strong>{teacher.full_name}</strong><small>{teacher.department_head ? `Head of ${teacher.department_head}` : teacher.subject_head ? `Head of ${teacher.subject_head}` : "Teacher"}</small></div><span>{teacher.phone_number}</span></div>)}
      </article>}
      {user.role === "teacher" && departmentTeachers.length > 0 && <article className="school-portal-card">
        <h2>{departmentTeachers[0].department_head} department</h2>
        {departmentTeachers.map((teacher) => <div className="school-list-row" key={teacher.id}><strong>{teacher.full_name}</strong><span>{teacher.assignments.length} class/subject assignments</span></div>)}
      </article>}
      {(isSchoolAdmin || user.role === "class_coordinator") && <article className="school-portal-card">
        <h2>Student report copies</h2>
        {managedReports.map((report) => <div className="school-list-row" key={report.id}>
          <div><strong>{report.studentName}</strong><small>{report.grade} {report.stream} · Term {report.term ?? "?"} {report.half} · expires {new Date(report.expiresAt).toLocaleDateString()}</small></div>
          <span>{report.downloadUrl && <a className="quiet-button" href={report.downloadUrl} download>Download</a>}<button type="button" className="quiet-button" disabled={busy} onClick={() => void deleteReport(report)}>Delete</button></span>
        </div>)}
        {!managedReports.length && <p className="school-empty">No report copies are currently available.</p>}
      </article>}
      {user.role !== "school_admin" && <article className="school-portal-card">
        <h2>Assigned students</h2>{students.map((record) => <div className="school-list-row" key={record.id}><div><strong>{record.full_name}</strong><small>{record.school_classes.grade} {record.school_classes.stream}</small></div><span>{record.assessment_number}</span></div>)}
        {!students.length && <p className="school-empty">No students are assigned to your classes.</p>}
      </article>}
      {user.role === "class_coordinator" && windows.find(({ id }) => id === selectedWindowId) && <article className="school-portal-card">
        <h2>Grade analysis · {windows.find(({ id }) => id === selectedWindowId)?.grade}</h2>
        <p>{new Set(results.map((row) => row.rosterId)).size} students · {new Set(results.filter((row) => row.result?.result_code === "mark").map((row) => `${row.rosterId}:${row.subjectId}`)).size} marks entered</p>
        {[...new Map(results.map((row) => [row.subjectId, row])).values()].map((subject) => {
          const rows = results.filter((row) => row.subjectId === subject.subjectId);
          const marked = rows.filter((row) => row.result?.result_code === "mark" && row.result.mark !== null);
          const averagePercent = marked.length
            ? marked.reduce((total, row) => total + ((row.result?.mark ?? 0) / row.maxMarks * 100), 0) / marked.length
            : null;
          return <div className="school-list-row" key={subject.subjectId}>
            <div><strong>{subject.subjectName}</strong><small>{marked.length}/{rows.length} marks · {rows.filter((row) => row.result?.result_code === "X").length} X · {rows.filter((row) => row.result?.result_code === "Y").length} Y · {rows.filter((row) => !row.result).length} pending</small></div>
            <span>Mean {averagePercent === null ? "N/A" : `${averagePercent.toFixed(1)}%`}</span>
          </div>;
        })}
      </article>}
      {user.role === "teacher" && <article className="school-portal-card"><h2>Teaching workspace</h2><p>Choose one of your assigned classes above to work with its students. Results entry, assignments, and class announcements are school-scoped.</p></article>}
      {windows.length > 0 && (user.role === "school_admin" || user.role === "class_coordinator" || user.role === "teacher") && <article className="school-portal-card school-results-card">
        <div className="school-portal-card-heading"><div><h2>Examination results</h2><p>Entry deadlines and review progress</p></div>
          <select aria-label="Select results window" value={selectedWindowId} onChange={(event) => setSelectedWindowId(event.target.value)}>{windows.map((item) => <option key={item.id} value={item.id}>{item.grade} · Term {item.term} · {item.half} · {item.status}</option>)}</select>
        </div>
        {user.role === "school_admin" && windows.find(({ id }) => id === selectedWindowId)?.status === "admin_review" && <>
          <label className="school-remarks-field">Principal's remarks<textarea maxLength={1500} value={principalRemarks} onChange={(event) => setPrincipalRemarks(event.target.value)} /></label>
          <label className="school-remarks-field">Class teacher's remarks<textarea maxLength={1500} value={classTeacherRemarks} onChange={(event) => setClassTeacherRemarks(event.target.value)} /></label>
          <button className="primary-button" disabled={busy} onClick={() => void releaseReports()}>Generate and send student reports</button>
        </>}
        {user.role === "class_coordinator" && windows.find(({ id }) => id === selectedWindowId)?.status === "coordinator_review" && <button className="primary-button" disabled={busy} onClick={() => void submitGrade()}>Submit grade analysis to school administrator</button>}
        {user.role === "teacher" && ["open", "coordinator_review"].includes(windows.find(({ id }) => id === selectedWindowId)?.status ?? "") && classes.filter((classItem) => classItem.class_teacher_id === user.id).map((classItem) => <label className="school-remarks-field" key={classItem.id}>{classItem.grade} {classItem.stream} class teacher's remarks<textarea maxLength={1500} value={classRemarks[classItem.id] ?? ""} onChange={(event) => setClassRemarks({ ...classRemarks, [classItem.id]: event.target.value })} /><button type="button" className="quiet-button" disabled={busy} onClick={() => void saveClassRemark(classItem.id)}>Save class remarks</button></label>)}
        {user.role === "teacher" && ["open", "coordinator_review"].includes(windows.find(({ id }) => id === selectedWindowId)?.status ?? "") && [...new Map(results.filter((row) => row.canEditSubjectRemark).map((row) => [`${row.classId}:${row.subjectId}`, row])).values()].map((row) => <label className="school-remarks-field" key={`${row.classId}:${row.subjectId}`}>{row.stream} · {row.subjectName} teacher's remarks<textarea maxLength={1500} value={subjectRemarks[`${row.classId}:${row.subjectId}`] ?? ""} onChange={(event) => setSubjectRemarks({ ...subjectRemarks, [`${row.classId}:${row.subjectId}`]: event.target.value })} /><button type="button" className="quiet-button" disabled={busy} onClick={() => void saveSubjectRemark(row.classId, row.subjectId)}>Save subject remarks</button></label>)}
        <div className="school-results-list">{results.map((row) => {
          const key = `${row.rosterId}:${row.subjectId}`;
          const editable = user.role === "teacher" && windows.find(({ id }) => id === selectedWindowId)?.status === "open" && !row.result;
          return <div className="school-result-row" key={key}>
            <span><strong>{row.studentName}</strong><small>{row.stream} · {row.subjectName} · max {row.maxMarks}</small></span>
            {editable ? <div className="school-result-entry"><input aria-label={`${row.studentName} ${row.subjectName} mark`} type="number" min="0" max={row.maxMarks} step="0.01" value={resultMarks[key] ?? ""} onChange={(event) => setResultMarks({ ...resultMarks, [key]: event.target.value })} /><button type="button" className="quiet-button" disabled={busy || !resultMarks[key]} onClick={() => void submitMark(row, resultMarks[key])}>Save</button><button type="button" className="quiet-button" disabled={busy} onClick={() => { const reason = window.prompt("Award Y for this student's subject result? Enter a brief reason for the audit record."); if (reason?.trim()) void submitMark(row, "Y", reason.trim()); }}>Award Y</button></div>
              : <strong>{row.result?.result_code === "mark" ? row.result.mark : row.result?.result_code ?? "Pending"}</strong>}
          </div>;
        })}{!results.length && <p className="school-empty">No result rows are available in this window.</p>}</div>
      </article>}
    </section>
  </PortalShell>;
}

function StudentPortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [data, setData] = useState<StudentOverview | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => apiRequest<StudentOverview>("/api/school/student-overview")
    .then(setData).catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Your school information could not be loaded.")), []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <PortalShell title={data?.school.name ?? "Student portal"} subtitle={`${user.name} · ${data ? `${data.student.grade} ${data.student.stream}` : "Student"}`} onLogout={onLogout}>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {data && <>
      <section className="student-school-summary">
        {data.school.logoUrl && <img className="student-school-logo" src={data.school.logoUrl} alt={`${data.school.name} logo`} />}
        <div><span>ASSESSMENT NUMBER</span><strong>{data.student.assessmentNumber}</strong></div><div><span>GRADE AND STREAM</span><strong>{data.student.grade} {data.student.stream}</strong></div><div><span>SUBJECTS</span><strong>{data.subjects.length}</strong></div>
      </section>
      {!!data.notices.length && <section className="student-result-notices" aria-label="Result notices">{data.notices.map((item) => <p key={item.id}>{item.message.toUpperCase()}</p>)}</section>}
      <section className="school-portal-grid">
        <article className="school-portal-card"><h2>My subjects</h2>{data.subjects.map((subject) => <div className="school-list-row" key={subject.id}><strong>{subject.name}</strong><span>Maximum {subject.max_marks}</span></div>)}</article>
        <article className="school-portal-card"><h2>My report forms</h2>{data.reports.map((report) => <div className="school-list-row" key={report.id}><div><strong>School report</strong><small>Available until {new Date(report.expiresAt).toLocaleDateString()}</small></div><a className="primary-button" href={report.downloadUrl} download><Download size={15} /> Download</a></div>)}{!data.reports.length && <p className="school-empty">No report form is currently available.</p>}</article>
        <article className="school-portal-card"><h2>Timetable</h2>{data.timetables.map((item) => <div className="school-list-row" key={item.id}><div><strong>{item.filename}</strong><small>Available until {new Date(item.expiresAt).toLocaleDateString()}</small></div><a className="primary-button" href={item.downloadUrl} download><Download size={15} /> Download</a></div>)}{!data.timetables.length && <p className="school-empty">No current timetable has been shared.</p>}</article>
      </section>
    </>}
    {!data && !error && <p className="school-empty">Loading your school space…</p>}
  </PortalShell>;
}
