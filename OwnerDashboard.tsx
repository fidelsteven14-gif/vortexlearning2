import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Archive, ArrowRight, BookOpen, Check, ClipboardCheck, Clock3, Copy, Eye, FileUp, GraduationCap, LogOut, Plus, RefreshCw, Trash2, UsersRound, X } from "lucide-react";
import { apiFileRequest, apiRequest, type User } from "./api";
import Brand from "./Brand";

type Overview = {
  generatedAt: string;
  counts: {
    registeredStudents: number;
    activeStudents: number;
    examsInProgress: number;
    examsSubmitted: number;
    publishedAssessments: number;
  };
};
type Invitation = { code: string; grade: string; expiresAt: string };
type Subject = { id: string; name: string; grade: string };
type StudentRecord = {
  id: string;
  name: string;
  username: string;
  userCode: string;
  grade: string | null;
  active: number;
  emailVerified: number;
  createdAt: string;
  lastSeenAt: string | null;
};
type ContentLesson = {
  id: string;
  subjectId: string;
  subjectName: string;
  grade: string;
  type: "lesson" | "note";
  title: string;
  summary: string;
  content: string;
};
type ContentQuestion = { prompt: string; options: string[]; correctOption: number; points: number };
type ManagedAssessment = {
  id: string;
  title: string;
  subjectId: string;
  subjectName: string;
  grade: string;
  kind: "PRACTICE" | "QUIZ" | "EXAM";
  durationMinutes: number;
  opensAt: string;
  published: number;
  attemptCount: number;
  questions: ContentQuestion[];
};
type ManagedResource = {
  id: string;
  subjectId: string;
  subjectName: string;
  grade: string;
  title: string;
  description: string;
  topic: string;
  term: string;
  category: LearningResourceCategory;
  status: "draft" | "published" | "archived";
  filename: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
};
type LearningResourceCategory = "revision-paper" | "study-guide" | "syllabus" | "topic-summary" | "reference-document";

function defaultExamTime(): string {
  const date = new Date(Date.now() + 5 * 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function OwnerDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [activePage, setActivePage] = useState("Learning platform");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [grade, setGrade] = useState("Grade 6");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const gradeOptions = Array.from({ length: 12 }, (_, index) => `Grade ${index + 1}`);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [lessons, setLessons] = useState<ContentLesson[]>([]);
  const [assessments, setAssessments] = useState<ManagedAssessment[]>([]);
  const [resources, setResources] = useState<ManagedResource[]>([]);
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [studentsLoaded, setStudentsLoaded] = useState(false);
  const [studentSearch, setStudentSearch] = useState("");
  const [assessmentTitle, setAssessmentTitle] = useState("");
  const [editingAssessmentId, setEditingAssessmentId] = useState("");
  const [assessmentKind, setAssessmentKind] = useState<ManagedAssessment["kind"]>("PRACTICE");
  const [subjectId, setSubjectId] = useState("");
  const [opensAt, setOpensAt] = useState(defaultExamTime);
  const [duration, setDuration] = useState(20);
  const [questions, setQuestions] = useState([{ prompt: "", options: "", correctOption: "1" }]);
  const [editingLessonId, setEditingLessonId] = useState("");
  const [lessonType, setLessonType] = useState<"lesson" | "note">("lesson");
  const [lessonSubjectId, setLessonSubjectId] = useState("");
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonSummary, setLessonSummary] = useState("");
  const [lessonContent, setLessonContent] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [resourceSubjectId, setResourceSubjectId] = useState("");
  const [resourceTitle, setResourceTitle] = useState("");
  const [resourceDescription, setResourceDescription] = useState("");
  const [resourceTopic, setResourceTopic] = useState("");
  const [resourceTerm, setResourceTerm] = useState("Term 1");
  const [resourceCategory, setResourceCategory] = useState<LearningResourceCategory>("study-guide");
  const [resourceStatus, setResourceStatus] = useState<"draft" | "published">("draft");
  const [resourceFile, setResourceFile] = useState<File | null>(null);
  const resourceFileTooLarge = Boolean(resourceFile && resourceFile.size > 20 * 1024 * 1024);
  const resourcePreviewUrl = useMemo(() => resourceFile ? URL.createObjectURL(resourceFile) : "", [resourceFile]);
  const [pdfPreview, setPdfPreview] = useState<{ url: string; title: string } | null>(null);
  const visibleSubjects = subjects.filter((subject) => subject.grade === grade);

  const refresh = useCallback(() => {
    void Promise.all([
      apiRequest<Overview>("/api/admin/overview"),
      apiRequest<{ students: StudentRecord[] }>("/api/admin/students"),
      apiRequest<{ lessons: ContentLesson[]; assessments: ManagedAssessment[] }>("/api/admin/content"),
      apiRequest<{ resources: ManagedResource[] }>("/api/admin/resources"),
    ]).then(([data, directory, content, resourceData]) => {
      setOverview(data);
      setStudents(directory.students);
      setLessons(content.lessons);
      setAssessments(content.assessments);
      setResources(resourceData.resources);
      setStudentsLoaded(true);
      setError("");
    }).catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Could not load the platform dashboard."));
  }, []);

  useEffect(() => {
    refresh();
    void apiRequest<{ subjects: Subject[] }>("/api/admin/catalog")
      .then(({ subjects: availableSubjects }) => {
        setSubjects(availableSubjects);
        if (!availableSubjects.some((subject) => subject.grade === grade)) {
          setGrade(availableSubjects[0]?.grade || "Grade 6");
          return;
        }
        const nextSelection = availableSubjects.filter((subject) => subject.grade === grade);
        setSubjectId((current) => current && nextSelection.some((subject) => subject.id === current) ? current : nextSelection[0]?.id || "");
        setLessonSubjectId((current) => current && nextSelection.some((subject) => subject.id === current) ? current : nextSelection[0]?.id || "");
        setResourceSubjectId((current) => current && nextSelection.some((subject) => subject.id === current) ? current : nextSelection[0]?.id || "");
      })
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Could not load learning areas."));
    const interval = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(interval);
  }, [grade, refresh]);

  useEffect(() => {
    if (!subjects.length) {
      setSubjectId("");
      setLessonSubjectId("");
      setResourceSubjectId("");
      return;
    }
    const selectedGradeSubjects = subjects.filter((subject) => subject.grade === grade);
    if (!selectedGradeSubjects.length) {
      setGrade(subjects[0].grade);
      return;
    }
    setSubjectId((current) => current && selectedGradeSubjects.some((subject) => subject.id === current) ? current : selectedGradeSubjects[0].id);
    setLessonSubjectId((current) => current && selectedGradeSubjects.some((subject) => subject.id === current) ? current : selectedGradeSubjects[0].id);
    setResourceSubjectId((current) => current && selectedGradeSubjects.some((subject) => subject.id === current) ? current : selectedGradeSubjects[0].id);
  }, [grade, subjects]);

  useEffect(() => () => {
    if (resourcePreviewUrl) URL.revokeObjectURL(resourcePreviewUrl);
  }, [resourcePreviewUrl]);
  useEffect(() => () => {
    if (pdfPreview?.url) URL.revokeObjectURL(pdfPreview.url);
  }, [pdfPreview]);

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest<Invitation>("/api/admin/invitations", {
        method: "POST",
        body: JSON.stringify({ grade, expiresInDays: 7 }),
      });
      setInvitation(result);
      setCopied(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create an invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.code);
      setCopied(true);
    } catch {
      setNotice("Copy is unavailable in this browser. Select and copy the code.");
    }
  }

  async function createAssessment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const inputQuestions = questions.map((question) => ({
        prompt: question.prompt,
        options: question.options.split("|").map((option) => option.trim()).filter(Boolean),
        correctOption: Number(question.correctOption) - 1,
        points: 1,
      }));
      const result = await apiRequest<{ assessmentId?: string; questionCount: number; published: boolean }>(
        editingAssessmentId ? `/api/admin/assessments/${editingAssessmentId}` : "/api/admin/assessments",
        {
        method: editingAssessmentId ? "PUT" : "POST",
        body: JSON.stringify({
          title: assessmentTitle,
          subjectId,
          durationMinutes: duration,
          opensAt: new Date(opensAt).toISOString(),
          kind: assessmentKind,
          publish: true,
          questions: inputQuestions,
        }),
      });
      setNotice(`${editingAssessmentId ? "Assessment updated" : "Assessment published"} with ${result.questionCount} question${result.questionCount === 1 ? "" : "s"}.`);
      setEditingAssessmentId("");
      setAssessmentTitle("");
      setAssessmentKind("PRACTICE");
      setQuestions([{ prompt: "", options: "", correctOption: "1" }]);
      refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create the assessment.");
    } finally {
      setBusy(false);
    }
  }

  function editLesson(lesson: ContentLesson) {
    setEditingLessonId(lesson.id);
    setLessonType(lesson.type);
    setLessonSubjectId(lesson.subjectId);
    setLessonTitle(lesson.title);
    setLessonSummary(lesson.summary);
    setLessonContent(lesson.content);
  }

  function editAssessment(assessment: ManagedAssessment) {
    setEditingAssessmentId(assessment.id);
    setAssessmentTitle(assessment.title);
    setSubjectId(assessment.subjectId);
    setAssessmentKind(assessment.kind);
    setDuration(assessment.durationMinutes);
    const localDate = new Date(assessment.opensAt);
    setOpensAt(new Date(localDate.getTime() - localDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    setQuestions(assessment.questions.map((question) => ({
      prompt: question.prompt,
      options: question.options.join(" | "),
      correctOption: String(question.correctOption + 1),
    })));
    document.getElementById("admin-assessment-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function saveLesson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(
        editingLessonId ? `/api/admin/lessons/${editingLessonId}` : "/api/admin/lessons",
        {
          method: editingLessonId ? "PUT" : "POST",
          body: JSON.stringify({
            subjectId: lessonSubjectId,
            type: lessonType,
            title: lessonTitle,
            summary: lessonSummary,
            content: lessonContent,
          }),
        },
      );
      setNotice(`${lessonType === "note" ? "Note" : "Lesson"} ${editingLessonId ? "updated" : "published"}.`);
      setEditingLessonId("");
      setLessonTitle("");
      setLessonSummary("");
      setLessonContent("");
      refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not save the learning content.");
    } finally {
      setBusy(false);
    }
  }

  function cancelLessonEdit() {
    setEditingLessonId("");
    setLessonTitle("");
    setLessonSummary("");
    setLessonContent("");
  }

  function cancelAssessmentEdit() {
    setEditingAssessmentId("");
    setAssessmentTitle("");
    setAssessmentKind("PRACTICE");
    setQuestions([{ prompt: "", options: "", correctOption: "1" }]);
  }

  function editResource(resource: ManagedResource) {
    setResourceId(resource.id);
    setResourceSubjectId(resource.subjectId);
    setResourceTitle(resource.title);
    setResourceDescription(resource.description);
    setResourceTopic(resource.topic);
    setResourceTerm(resource.term);
    setResourceCategory(resource.category);
    setResourceStatus(resource.status === "published" ? "published" : "draft");
    setResourceFile(null);
    document.getElementById("admin-resource-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetResourceEditor() {
    setResourceId("");
    setResourceTitle("");
    setResourceDescription("");
    setResourceTopic("");
    setResourceTerm("Term 1");
    setResourceCategory("study-guide");
    setResourceStatus("draft");
    setResourceFile(null);
  }

  async function saveResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const metadata = {
        subjectId: resourceSubjectId,
        title: resourceTitle,
        description: resourceDescription,
        topic: resourceTopic,
        term: resourceTerm,
        category: resourceCategory,
      };
      let id = resourceId;
      if (id) {
        await apiRequest(`/api/admin/resources/${id}`, { method: "PUT", body: JSON.stringify(metadata) });
      } else {
        const created = await apiRequest<{ id: string }>("/api/admin/resources", { method: "POST", body: JSON.stringify(metadata) });
        id = created.id;
        setResourceId(id);
      }
      if (resourceFile) {
        await apiRequest(`/api/admin/resources/${id}/file`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/pdf",
            "X-File-Name": encodeURIComponent(resourceFile.name),
          },
          body: resourceFile,
        });
      }
      await apiRequest(`/api/admin/resources/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: resourceStatus }),
      });
      setNotice(`Resource ${resourceStatus === "published" ? "published" : "saved as a draft"}.`);
      resetResourceEditor();
      refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not save the PDF resource.");
    } finally {
      setBusy(false);
    }
  }

  async function changeResourceStatus(resource: ManagedResource, status: ManagedResource["status"]) {
    setError("");
    setNotice("");
    try {
      await apiRequest(`/api/admin/resources/${resource.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setNotice(`“${resource.title}” is now ${status}.`);
      refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not change the resource status.");
    }
  }

  async function deleteResource(resource: ManagedResource) {
    if (!window.confirm(`Permanently delete “${resource.title}” and its PDF? This cannot be undone.`)) return;
    setError("");
    setNotice("");
    try {
      await apiRequest(`/api/admin/resources/${resource.id}`, { method: "DELETE" });
      setNotice(`“${resource.title}” was deleted.`);
      if (resourceId === resource.id) resetResourceEditor();
      refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not delete the resource.");
    }
  }

  async function deleteStudent(student: StudentRecord) {
    if (!window.confirm(`Delete learner “${student.name}” (@${student.username}) from the platform? This action cannot be undone.`)) return;
    setError("");
    setNotice("");
    try {
      await apiRequest(`/api/admin/students/${student.id}`, { method: "DELETE" });
      setNotice(`Learner “${student.name}” was removed.`);
      refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not delete this learner account.");
    }
  }

  async function previewResource(resource: ManagedResource) {
    setError("");
    try {
      const file = await apiFileRequest(`/api/admin/resources/${resource.id}/file`);
      setPdfPreview({ url: URL.createObjectURL(file), title: resource.title });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not preview this PDF.");
    }
  }

  const counts = overview?.counts;
  const ownerPages = [
    { label: "Learning platform", icon: BookOpen },
    { label: "Student directory", icon: UsersRound },
    { label: "Lessons & notes", icon: BookOpen },
    { label: "Published learning content", icon: Check },
    { label: "PDF learning resources", icon: FileUp },
    { label: "Invite a learner", icon: GraduationCap },
    { label: "Quizzes & assessments", icon: ClipboardCheck },
  ];
  const visibleStudents = students.filter((student) =>
    `${student.name} ${student.username} ${student.userCode} ${student.grade ?? ""}`.toLowerCase().includes(studentSearch.trim().toLowerCase()),
  );
  return (
    <main className="owner-shell">
      <header className="owner-topbar">
        <Brand />
        <div className="owner-account"><span className="avatar owner-avatar">{user.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("")}</span><span><strong>{user.name}</strong><small>Platform owner</small></span><button className="logout-button" onClick={onLogout}><LogOut size={15} /> Sign out</button></div>
      </header>
      <div className="owner-content">
        <div className="owner-title-row"><div><span className="section-kicker">PLATFORM CONTROL CENTRE</span><h1>{activePage}</h1><p>{activePage === "Learning platform" ? `Good to see you, ${user.name.split(/\s+/)[0]}. Monitor activity and platform health.` : `Manage ${activePage.toLowerCase()} for the learning platform.`}</p></div><button className="owner-refresh" onClick={refresh}><RefreshCw size={15} /> Refresh</button></div>
        <nav className="owner-nav" aria-label="Platform management pages">
          {ownerPages.map(({ label, icon: Icon }) => (
            <button key={label} type="button" className={`owner-nav-link ${activePage === label ? "owner-nav-active" : ""}`} aria-current={activePage === label ? "page" : undefined} onClick={() => setActivePage(label)}>
              <Icon size={15} />{label}
            </button>
          ))}
        </nav>
        {error && <div className="dashboard-error" role="alert">{error}<button onClick={refresh}>Retry</button></div>}
        {activePage === "Learning platform" && <section className="owner-stats">
          <article className="owner-stat"><span className="owner-stat-icon teal"><UsersRound size={19} /></span><span className="owner-stat-label">Registered learners</span><strong>{counts?.registeredStudents ?? "—"}</strong><small>All student accounts</small></article>
          <article className="owner-stat"><span className="owner-stat-icon green"><span className="owner-online-dot" /></span><span className="owner-stat-label">Active recently</span><strong>{counts?.activeStudents ?? "—"}</strong><small>Seen within the last 5 minutes</small></article>
          <article className="owner-stat"><span className="owner-stat-icon amber"><Clock3 size={19} /></span><span className="owner-stat-label">Exams in progress</span><strong>{counts?.examsInProgress ?? "—"}</strong><small>Current learner attempts</small></article>
          <article className="owner-stat"><span className="owner-stat-icon mint"><Check size={19} /></span><span className="owner-stat-label">Exams submitted</span><strong>{counts?.examsSubmitted ?? "—"}</strong><small>Awaiting / completed marking</small></article>
        </section>}

        {activePage === "Student directory" && <section className="owner-panel owner-student-directory">
          <div className="owner-panel-head"><span className="owner-panel-icon"><UsersRound size={18} /></span><div><h2>Student directory</h2><p>All registered learner accounts, their grade, verification, student code, and recent activity.</p></div></div>
          <label className="owner-student-search">Search learners<input value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} placeholder="Name, username, code, or grade" /></label>
          <div className="owner-student-table-wrap">
            <table className="owner-student-table">
              <thead><tr><th>Learner</th><th>Grade</th><th>Student code</th><th>Registered</th><th>Email verification</th><th>Last seen</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {visibleStudents.map((student) => (
                  <tr key={student.userCode}>
                    <td><strong>{student.name}</strong><small>@{student.username}</small></td>
                    <td>{student.grade ?? "—"}</td>
                    <td><span className="owner-user-code">{student.userCode}</span></td>
                    <td>{new Date(student.createdAt).toLocaleDateString("en-KE")}</td>
                    <td><span className={`owner-student-status ${student.emailVerified ? "owner-student-active" : "owner-student-unverified"}`}>{student.emailVerified ? "Verified" : "Not verified"}</span></td>
                    <td>{student.lastSeenAt ? new Date(student.lastSeenAt).toLocaleString("en-KE") : "Not yet active"}</td>
                    <td><span className={`owner-student-status ${student.active ? "owner-student-active" : ""}`}>{student.active ? "Active" : "Disabled"}</span></td>
                    <td><button className="quiet-button danger-button" type="button" onClick={() => void deleteStudent(student)}><Trash2 size={14} /> Delete</button></td>
                  </tr>
                ))}
                {studentsLoaded && visibleStudents.length === 0 && <tr><td className="owner-student-empty" colSpan={8}>{students.length ? "No learners match your search." : "No student accounts have registered yet."}</td></tr>}
                {!studentsLoaded && <tr><td className="owner-student-empty" colSpan={8}>Loading student directory…</td></tr>}
              </tbody>
            </table>
          </div>
        </section>}

        {activePage === "Lessons & notes" && <section className="owner-panel owner-content-manager">
          <div className="owner-panel-head"><span className="owner-panel-icon owner-panel-green"><BookOpen size={18} /></span><div><h2>Lessons &amp; notes</h2><p>Create and update learning content by grade and learning area.</p></div></div>
          <form className="owner-assessment-form" onSubmit={saveLesson}>
            <div className="assessment-grid">
              <label className="form-label">Content type<select value={lessonType} onChange={(event) => setLessonType(event.target.value as "lesson" | "note")}><option value="lesson">Lesson</option><option value="note">Note / study guide</option></select></label>
              <label className="form-label">Grade<select value={grade} onChange={(event) => setGrade(event.target.value)}>{gradeOptions.map((gradeLabel) => <option key={gradeLabel} value={gradeLabel}>{gradeLabel}</option>)}</select></label>
              <label className="form-label">Learning area<select value={lessonSubjectId} onChange={(event) => setLessonSubjectId(event.target.value)} required>{visibleSubjects.length ? visibleSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>) : <option value="">No subjects available</option>}</select></label>
            </div>
            <label className="form-label">Title<input value={lessonTitle} onChange={(event) => setLessonTitle(event.target.value)} minLength={3} maxLength={120} required placeholder="e.g. Understanding fractions" /></label>
            <label className="form-label">Short description<input value={lessonSummary} onChange={(event) => setLessonSummary(event.target.value)} minLength={3} maxLength={500} required placeholder="What will learners study?" /></label>
            <label className="form-label">Learning content<textarea className="owner-content-textarea" value={lessonContent} onChange={(event) => setLessonContent(event.target.value)} minLength={3} maxLength={20000} required placeholder="Write the lesson, worked examples, or study notes." /></label>
            <div className="assessment-form-actions">
              {editingLessonId && <button className="quiet-button" type="button" onClick={cancelLessonEdit}>Cancel edit</button>}
              <button className="primary-button" type="submit" disabled={busy || !subjects.length}><Plus size={15} /> {busy ? "Saving…" : editingLessonId ? "Save changes" : `Publish ${lessonType}`}</button>
            </div>
          </form>
        </section>}

        {activePage === "Published learning content" && <section className="owner-panel owner-content-manager">
          <div className="owner-panel-head"><span className="owner-panel-icon owner-panel-green"><BookOpen size={18} /></span><div><h2>Published learning content</h2><p>Review and update lessons and notes currently available to learners.</p></div></div>
          <div className="owner-content-list">
            <h3>Published learning content ({lessons.length})</h3>
            {lessons.length ? lessons.map((lesson) => (
              <article className="owner-content-row" key={lesson.id}>
                <div><span className="owner-content-tag">{lesson.type === "note" ? "NOTE" : "LESSON"} · {lesson.grade}</span><strong>{lesson.title}</strong><small>{lesson.subjectName} · {lesson.summary}</small></div>
                <button className="quiet-button" type="button" onClick={() => { setActivePage("Lessons & notes"); editLesson(lesson); }}>Edit</button>
              </article>
            )) : <p className="owner-content-empty">No lessons or notes have been published yet.</p>}
          </div>
        </section>}

        {activePage === "PDF learning resources" && <section className="owner-panel owner-resource-manager">
          <div className="owner-panel-head"><span className="owner-panel-icon owner-panel-green"><FileUp size={18} /></span><div><h2>PDF learning resources</h2><p>Upload revision papers, study guides, syllabuses, and other approved PDFs.</p></div></div>
          <form id="admin-resource-editor" className="owner-assessment-form" onSubmit={saveResource}>
            {resourceId && <p className="owner-editor-notice">Editing resource. Uploading a replacement PDF will keep the current file if validation fails.</p>}
            <div className="assessment-grid">
              <label className="form-label">Grade<select value={grade} onChange={(event) => setGrade(event.target.value)}>{gradeOptions.map((gradeLabel) => <option key={gradeLabel} value={gradeLabel}>{gradeLabel}</option>)}</select></label>
              <label className="form-label">Learning area<select value={resourceSubjectId} onChange={(event) => setResourceSubjectId(event.target.value)} required>{visibleSubjects.length ? visibleSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>) : <option value="">No subjects available</option>}</select></label>
              <label className="form-label">Resource category<select value={resourceCategory} onChange={(event) => setResourceCategory(event.target.value as LearningResourceCategory)}><option value="revision-paper">Revision paper</option><option value="study-guide">Study guide</option><option value="syllabus">Syllabus</option><option value="topic-summary">Topic summary</option><option value="reference-document">Approved reference document</option></select></label>
            </div>
            <div className="assessment-grid">
              <label className="form-label">Resource title<input value={resourceTitle} onChange={(event) => setResourceTitle(event.target.value)} minLength={3} maxLength={120} required placeholder="e.g. Fractions revision paper" /></label>
              <label className="form-label">Topic<input value={resourceTopic} onChange={(event) => setResourceTopic(event.target.value)} minLength={2} maxLength={120} required placeholder="e.g. Fractions and decimals" /></label>
            </div>
            <div className="assessment-grid">
              <label className="form-label">Term<input value={resourceTerm} onChange={(event) => setResourceTerm(event.target.value)} minLength={1} maxLength={40} required placeholder="Term 1" /></label>
              <label className="form-label">Publication status<select value={resourceStatus} onChange={(event) => setResourceStatus(event.target.value as "draft" | "published")}><option value="draft">Save as draft</option><option value="published">Publish to matching grade</option></select></label>
            </div>
            <label className="form-label">Description (optional)<textarea className="owner-content-textarea owner-resource-description" value={resourceDescription} onChange={(event) => setResourceDescription(event.target.value)} maxLength={1000} placeholder="Briefly describe what the resource covers." /></label>
            <label className="form-label">PDF file (maximum 20 MB)<input key={resourceId || "new-resource"} type="file" accept=".pdf,application/pdf" onChange={(event) => setResourceFile(event.target.files?.[0] ?? null)} /></label>
            {resourceFile && <div className="owner-pdf-preview"><strong>Selected: {resourceFile.name}</strong><small>{(resourceFile.size / (1024 * 1024)).toFixed(2)} MB · preview before saving</small>{resourceFileTooLarge && <small className="owner-file-error" role="alert">File exceeds the 20 MB upload limit.</small>}<iframe src={resourcePreviewUrl} title={`Preview ${resourceFile.name}`} /></div>}
            <div className="assessment-form-actions">
              {resourceId && <button className="quiet-button" type="button" onClick={resetResourceEditor}>Cancel edit</button>}
              <button className="primary-button" type="submit" disabled={busy || !subjects.length || resourceFileTooLarge}>{busy ? "Saving…" : resourceId ? "Save resource" : "Create PDF resource"} <ArrowRight size={14} /></button>
            </div>
          </form>
          <div className="owner-content-list">
            <h3>Managed resources ({resources.length})</h3>
            {resources.length ? resources.map((resource) => (
              <article className="owner-content-row" key={resource.id}>
                <div><span className="owner-content-tag">{resource.status.toUpperCase()} · {resource.grade} · {resource.term}</span><strong>{resource.title}</strong><small>{resource.subjectName} · {resource.topic} · {resource.filename ?? "PDF not uploaded"}{resource.sizeBytes ? ` · ${(resource.sizeBytes / (1024 * 1024)).toFixed(2)} MB` : ""}</small></div>
                <div className="owner-resource-actions">
                  {resource.filename && <button className="quiet-button" type="button" onClick={() => void previewResource(resource)} aria-label={`Preview ${resource.title}`}><Eye size={14} /> Preview</button>}
                  <button className="quiet-button" type="button" onClick={() => editResource(resource)}>Edit</button>
                  {resource.status !== "published"
                    ? <button className="quiet-button" type="button" disabled={!resource.filename} onClick={() => void changeResourceStatus(resource, "published")}>Publish</button>
                    : <button className="quiet-button" type="button" onClick={() => void changeResourceStatus(resource, "draft")}>Unpublish</button>}
                  {resource.status !== "archived" && <button className="quiet-button" type="button" onClick={() => void changeResourceStatus(resource, "archived")} aria-label={`Archive ${resource.title}`}><Archive size={14} /> Archive</button>}
                  <button className="quiet-button" type="button" onClick={() => void deleteResource(resource)} aria-label={`Delete ${resource.title}`}><Trash2 size={14} /> Delete</button>
                </div>
              </article>
            )) : <p className="owner-content-empty">No PDF resources have been added yet.</p>}
          </div>
        </section>}

        {activePage === "Invite a learner" && <section className="owner-lower owner-lower-single">
          <article className="owner-panel">
            <div className="owner-panel-head"><span className="owner-panel-icon"><UsersRound size={18} /></span><div><h2>Invite a learner</h2><p>Create a single-use school registration code.</p></div></div>
            <form className="owner-form" onSubmit={createInvitation}>
              <label className="form-label">Learner grade<select value={grade} onChange={(event) => setGrade(event.target.value)}>{gradeOptions.map((gradeLabel) => <option key={gradeLabel} value={gradeLabel}>{gradeLabel}</option>)}</select></label>
              <button className="primary-button" type="submit" disabled={busy}><Plus size={15} /> {busy ? "Creating…" : "Create invitation"}</button>
            </form>
            {invitation && <div className="invite-result"><div><small>Share this code with the learner or guardian · expires {new Date(invitation.expiresAt).toLocaleDateString("en-KE")}</small><strong>{invitation.code}</strong></div><button className="copy-button" onClick={copyCode} aria-label="Copy invitation code">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>}
            {notice && <p className="owner-notice">{notice}</p>}
          </article>
        </section>}
        {activePage === "Learning platform" && <section className="owner-lower owner-lower-single">
          <article className="owner-panel">
            <div className="owner-panel-head"><span className="owner-panel-icon owner-panel-green"><BookOpen size={18} /></span><div><h2>Learning platform</h2><p>Assessment and reporting summary.</p></div></div>
            <div className="owner-summary-row"><span>Published assessments</span><strong>{counts?.publishedAssessments ?? "—"}</strong></div>
            <div className="owner-summary-row"><span>Dashboard refresh</span><strong>{overview ? new Date(overview.generatedAt).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" }) : "Waiting…"}</strong></div>
            <div className="owner-info-note"><Clock3 size={15} /> “Active recently” means a learner sent a presence update in the past five minutes.</div>
            <span className="owner-panel-link">Learning areas and exams <ArrowRight size={14} /></span>
          </article>
        </section>}
        {activePage === "Quizzes & assessments" && <section className="owner-lower owner-lower-single">
          <article className="owner-panel owner-assessment-panel">
            <div className="owner-panel-head"><span className="owner-panel-icon owner-panel-green"><BookOpen size={18} /></span><div><h2>Quizzes &amp; assessments</h2><p>Create and edit multiple-choice practice papers.</p></div></div>
            <div className="owner-content-list">
              <h3>Assessments ({assessments.length})</h3>
              {assessments.length ? assessments.map((assessment) => (
                <article className="owner-content-row" key={assessment.id}>
                  <div><span className="owner-content-tag">{assessment.published ? "PUBLISHED" : "DRAFT"} · {assessment.grade}</span><strong>{assessment.title}</strong><small>{assessment.subjectName} · {assessment.questions.length} questions · {assessment.attemptCount} attempts</small></div>
                  <button className="quiet-button" type="button" disabled={assessment.attemptCount > 0} title={assessment.attemptCount ? "Assessments cannot be edited after a learner starts an attempt" : "Edit assessment"} onClick={() => editAssessment(assessment)}>{assessment.attemptCount ? "Locked" : "Edit"}</button>
                </article>
              )) : <p className="owner-content-empty">No quizzes or assessments have been created yet.</p>}
            </div>
            <form id="admin-assessment-editor" className="owner-assessment-form" onSubmit={createAssessment}>
              {editingAssessmentId && <p className="owner-editor-notice">Editing assessment. It can only be saved while no learner attempts exist.</p>}
              <label className="form-label">Assessment title<input value={assessmentTitle} onChange={(event) => setAssessmentTitle(event.target.value)} minLength={3} maxLength={120} required placeholder="e.g. Fractions revision" /></label>
              <div className="assessment-grid">
                <label className="form-label">Grade<select value={grade} onChange={(event) => setGrade(event.target.value)}>{gradeOptions.map((gradeLabel) => <option key={gradeLabel} value={gradeLabel}>{gradeLabel}</option>)}</select></label>
                <label className="form-label">Learning area<select value={subjectId} onChange={(event) => setSubjectId(event.target.value)} required>{visibleSubjects.length ? visibleSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>) : <option value="">No subjects available</option>}</select></label>
                <label className="form-label">Duration (minutes)<input type="number" min={1} max={240} value={duration} onChange={(event) => setDuration(Number(event.target.value))} required /></label>
              </div>
              <label className="form-label">Assessment type<select value={assessmentKind} onChange={(event) => setAssessmentKind(event.target.value as ManagedAssessment["kind"])}><option value="PRACTICE">Practice</option><option value="QUIZ">Quiz</option><option value="EXAM">Exam</option></select></label>
              <label className="form-label">Opens at<input type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} required /></label>
              {questions.map((question, index) => <div className="assessment-question-builder" key={index}>
                <span>QUESTION {index + 1}</span>
                <label className="form-label">Question<input value={question.prompt} onChange={(event) => setQuestions((current) => current.map((item, position) => position === index ? { ...item, prompt: event.target.value } : item))} minLength={3} maxLength={2000} required placeholder="Write the question" /></label>
                <label className="form-label">Answer choices<input value={question.options} onChange={(event) => setQuestions((current) => current.map((item, position) => position === index ? { ...item, options: event.target.value } : item))} required placeholder="Separate choices with | (e.g. 2 | 3 | 4)" /></label>
                <label className="form-label">Correct choice number<input type="number" min={1} max={8} value={question.correctOption} onChange={(event) => setQuestions((current) => current.map((item, position) => position === index ? { ...item, correctOption: event.target.value } : item))} required /></label>
              </div>)}
              <div className="assessment-form-actions"><button className="quiet-button" type="button" onClick={() => setQuestions((current) => current.length < 100 ? [...current, { prompt: "", options: "", correctOption: "1" }] : current)}><Plus size={14} /> Add question</button><div className="owner-assessment-actions">{editingAssessmentId && <button className="quiet-button" type="button" onClick={cancelAssessmentEdit}>Cancel</button>}<button className="primary-button" type="submit" disabled={busy || !subjects.length}>{busy ? "Saving…" : editingAssessmentId ? "Save assessment" : "Publish assessment"} <ArrowRight size={14} /></button></div></div>
            </form>
          </article>
        </section>}
      </div>
      {pdfPreview && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPdfPreview(null); }}><section className="modal-card owner-pdf-modal" role="dialog" aria-modal="true" aria-label={`Preview ${pdfPreview.title}`}><div className="modal-head"><div><span className="section-kicker">PDF PREVIEW</span><h2>{pdfPreview.title}</h2></div><button className="icon-button" onClick={() => setPdfPreview(null)} aria-label="Close PDF preview"><X size={19} /></button></div><iframe src={pdfPreview.url} title={`Preview ${pdfPreview.title}`} /></section></div>}
    </main>
  );
}
