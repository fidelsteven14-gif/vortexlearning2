import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Download, LogOut, RefreshCw, School, ShieldCheck, Users } from "lucide-react";
import { apiRequest, supportEmail, type User } from "./api";
import Brand from "./Brand";

type SchoolRecord = {
  id: string;
  name: string;
  examination_code: string;
  location: string;
  classCount: number;
  studentCount: number;
  teacherCount: number;
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
  subjectId: string; subjectName: string; maxMarks: number;
  result?: { id: string; mark: number | null; result_code: string };
};
type SchoolOverview = {
  school: { name: string; examination_code: string; location: string; email: string | null; po_box: string | null };
  counts: { classes: number; students: number; teachers?: number };
  classes: ClassRecord[];
};
type StudentOverview = {
  student: { name: string; assessmentNumber: string | null; grade: string; stream: string };
  school: { name: string; email: string | null; po_box: string | null };
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

function SuperAdminPortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [schools, setSchools] = useState<SchoolRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [schoolLogo, setSchoolLogo] = useState<File | null>(null);
  const [principalSignature, setPrincipalSignature] = useState<File | null>(null);
  const [form, setForm] = useState({
    name: "", examinationCode: "", location: "", email: "", poBox: "", principalName: "",
    principalEmail: "", administratorName: "", administratorEmail: "",
  });
  const refresh = useCallback(() => apiRequest<{ schools: SchoolRecord[] }>("/api/super-admin/schools")
    .then(({ schools: rows }) => { setSchools(rows); setError(""); })
    .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Schools could not be loaded.")), []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function createSchool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await apiRequest<{ school: { id: string } }>("/api/super-admin/schools", {
        method: "POST", body: JSON.stringify(form),
      });
      setForm({ name: "", examinationCode: "", location: "", email: "", poBox: "", principalName: "", principalEmail: "", administratorName: "", administratorEmail: "" });
      const uploadIssues: string[] = [];
      for (const [asset, file] of [["logo", schoolLogo], ["principal-signature", principalSignature]] as const) {
        if (!file) continue;
        const data = new FormData();
        data.set("file", file);
        try {
          await apiRequest(`/api/super-admin/schools/${created.school.id}/assets/${asset}`, { method: "PUT", body: data });
        } catch (uploadError) {
          uploadIssues.push(uploadError instanceof Error ? uploadError.message : `${asset} upload failed.`);
        }
      }
      setSchoolLogo(null);
      setPrincipalSignature(null);
      setNotice(uploadIssues.length
        ? `School registered and invitation sent. Branding upload needs attention: ${uploadIssues.join(" ")}`
        : "School registered, invitation sent, and selected branding images uploaded.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The school could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return <PortalShell title="Platform administration" subtitle={`Super Admin · ${user.name}`} onLogout={onLogout}>
    <section className="school-portal-grid">
      <article className="school-portal-card">
        <div className="school-portal-card-heading"><School size={20} /><div><h2>Onboard a school</h2><p>Register the school and invite its first School Administrator.</p></div></div>
        <form className="school-portal-form" onSubmit={(event) => void createSchool(event)}>
          <label>School name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label>Official examination code<input required value={form.examinationCode} onChange={(event) => setForm({ ...form, examinationCode: event.target.value })} /></label>
          <label>Location<input required value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
          <label>School email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
          <label>P.O. Box<input value={form.poBox} onChange={(event) => setForm({ ...form, poBox: event.target.value })} /></label>
          <label>Principal / head teacher name<input value={form.principalName} onChange={(event) => setForm({ ...form, principalName: event.target.value })} /></label>
          <label>Principal email<input type="email" value={form.principalEmail} onChange={(event) => setForm({ ...form, principalEmail: event.target.value })} /></label>
          <label>School logo (PNG or JPEG, up to 2 MB)<input type="file" accept="image/png,image/jpeg" onChange={(event) => setSchoolLogo(event.target.files?.[0] ?? null)} /></label>
          <label>Principal signature (PNG or JPEG, up to 2 MB)<input type="file" accept="image/png,image/jpeg" onChange={(event) => setPrincipalSignature(event.target.files?.[0] ?? null)} /></label>
          <label>School Administrator full name<input required value={form.administratorName} onChange={(event) => setForm({ ...form, administratorName: event.target.value })} /></label>
          <label>School Administrator email<input type="email" required value={form.administratorEmail} onChange={(event) => setForm({ ...form, administratorEmail: event.target.value })} /></label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          {notice && <p className="auth-notice" role="status">{notice}</p>}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Registering…" : "Register school"} <ArrowRight size={15} /></button>
        </form>
      </article>
      <article className="school-portal-card">
        <div className="school-portal-card-heading"><Users size={20} /><div><h2>Schools</h2><p>School-level progress overview</p></div><button className="icon-button" onClick={() => void refresh()} aria-label="Refresh schools"><RefreshCw size={16} /></button></div>
        {schools.map((school) => <div className="school-list-row" key={school.id}>
          <div><strong>{school.name}</strong><small>{school.examination_code} · {school.location}</small></div>
          <div className="school-counts"><span>{school.studentCount} students</span><span>{school.teacherCount} teachers</span><span>{school.classCount} classes</span></div>
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
  const [timetables, setTimetables] = useState<TimetableRecord[]>([]);
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
    apiRequest<{ results: ResultEntry[] }>(`/api/school/result-windows/${selectedWindowId}`)
      .then(({ results: rows }) => {
        setResults(rows);
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
    {activationCode && <div className="teacher-activation-code"><ShieldCheck size={18} /><span><strong>Teacher activation code</strong><code>{activationCode}</code><small>Shown once. Give it to the teacher in person. It expires in seven days.</small></span></div>}
    <section className="school-stat-grid">
      <div><strong>{overview?.counts.students ?? "—"}</strong><span>Students in your access</span></div>
      <div><strong>{overview?.counts.classes ?? "—"}</strong><span>Classes in your access</span></div>
      <div><strong>{overview?.counts.teachers ?? "—"}</strong><span>Teachers in school</span></div>
    </section>
    <section className="school-portal-grid">
      {(isSchoolAdmin) && <article className="school-portal-card">
        <h2>Create a class</h2><form className="school-portal-form compact" onSubmit={(event) => void createClass(event)}>
          <label>Grade<select value={grade} onChange={(event) => setGrade(event.target.value)}>{Array.from({ length: 12 }, (_, index) => <option key={index}>Grade {index + 1}</option>)}</select></label>
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
      {user.role === "class_coordinator" && <article className="school-portal-card"><h2>Grade analysis</h2><p>Results analysis and printable grade reports will appear here after the school opens an exam results window.</p></article>}
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
      <section className="student-school-summary"><div><span>ASSESSMENT NUMBER</span><strong>{data.student.assessmentNumber}</strong></div><div><span>GRADE AND STREAM</span><strong>{data.student.grade} {data.student.stream}</strong></div><div><span>SUBJECTS</span><strong>{data.subjects.length}</strong></div></section>
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
