import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  ClipboardCheck,
  Copy,
  FileText,
  Flame,
  GraduationCap,
  Headphones,
  Home,
  Menu,
  MessageCircle,
  MoreHorizontal,
  LogOut,
  Search,
  Settings2,
  Sparkles,
  Target,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import AuthScreen from "./AuthScreen";
import OwnerDashboard from "./OwnerDashboard";
import { apiRequest, clearToken, getToken, supportEmail, type Course, type DashboardData, type UpcomingExam, type User } from "./api";
import Brand from "./Brand";
import LearningPages from "./LearningPages";
import SubjectRegistration from "./SubjectRegistration";

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");

const navItems = [
  { label: "Overview", icon: Home },
  { label: "My learning", icon: BookOpen },
  { label: "Subject registration", icon: ClipboardCheck },
  { label: "All grades", icon: GraduationCap },
  { label: "Lessons & notes", icon: BookOpen },
  { label: "Published learning content", icon: FileText },
  { label: "PDF learning resources", icon: FileText },
  { label: "Quizzes & assessments", icon: Target },
];

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const adminRoute = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const resetRoute = window.location.pathname === "/reset-password"
    || searchParams.has("token")
    || searchParams.has("resetToken")
    || searchParams.has("access_token")
    || searchParams.get("type") === "recovery"
    || hashParams.get("type") === "recovery"
    || hashParams.has("access_token");

  useEffect(() => {
    if (resetRoute) {
      clearToken();
      setCheckingSession(false);
      return;
    }
    if (!getToken()) {
      setCheckingSession(false);
      return;
    }
    apiRequest<{ user: User }>("/api/me")
      .then((response) => setUser(response.user))
      .catch(() => clearToken())
      .finally(() => setCheckingSession(false));
  }, []);

  if (checkingSession) return <div className="auth-loading"><span className="loading-mark"><GraduationCap size={22} /></span><span>Opening your learning space…</span></div>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  if (user.role === "admin") return <OwnerDashboard user={user} onLogout={() => { clearToken(); setUser(null); }} />;
  if (adminRoute) return <AdminAccessNotice onLogout={() => { clearToken(); setUser(null); }} />;
  if (user.role !== "student") return <RoleNotice user={user} onLogout={() => { clearToken(); setUser(null); }} />;
  return <StudentDashboard key={user.id} user={user} onLogout={() => { clearToken(); setUser(null); }} />;
}

function AdminAccessNotice({ onLogout }: { onLogout: () => void }) {
  return (
    <main className="auth-loading">
      <span className="loading-mark"><GraduationCap size={22} /></span>
      <strong>Administrator access required</strong>
      <span>This account cannot open the administrator dashboard.</span>
      <button className="quiet-button" onClick={onLogout}>Sign out</button>
      <a href={import.meta.env.BASE_URL}>Go to student sign in</a>
    </main>
  );
}

function StudentDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [activeNav, setActiveNav] = useState("Overview");
  const [activeGrade, setActiveGrade] = useState(user.grade ?? "");
  const [search, setSearch] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [studentName, setStudentName] = useState(user.name);
  const [studentGrade, setStudentGrade] = useState(user.grade ?? "");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState("");
  const [activeExam, setActiveExam] = useState<ExamAttempt | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showRoom, setShowRoom] = useState(false);
  const [activeCourse, setActiveCourse] = useState<Course | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [toast, setToast] = useState("");

  const visibleCourses = useMemo(
    () =>
      (dashboard?.courses ?? []).filter((course) =>
        `${course.name} ${course.topic}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [search, dashboard],
  );
  const firstName = studentName.trim().split(/\s+/)[0] || "learner";
  const displayDate = new Intl.DateTimeFormat("en-KE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date()).toUpperCase();

  const refreshDashboard = () =>
    apiRequest<DashboardData>("/api/dashboard")
      .then((data) => {
        setDashboard(data);
        setStudentName(data.student.name);
        setStudentGrade(data.student.grade ?? "");
        setActiveGrade(data.student.grade ?? "");
        setDashboardError("");
      })
      .catch((error: unknown) => setDashboardError(error instanceof Error ? error.message : "Could not load your learning data."));

  useEffect(() => {
    void refreshDashboard();
    void apiRequest("/api/presence", { method: "POST" });
    const refreshInterval = window.setInterval(() => void refreshDashboard(), 30_000);
    const heartbeatInterval = window.setInterval(() => {
      void apiRequest("/api/presence", { method: "POST" });
    }, 60_000);
    return () => {
      window.clearInterval(refreshInterval);
      window.clearInterval(heartbeatInterval);
    };
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  };

  const chooseNav = (label: string) => {
    setActiveNav(label);
    setMobileMenu(false);
    if (label === "Study circles") setShowRoom(true);
  };

  async function startExam(exam: UpcomingExam) {
    try {
      const attempt = await apiRequest<Omit<ExamAttempt, "title">>(`/api/exams/${exam.id}/start`, { method: "POST" });
      setActiveExam({ ...attempt, title: exam.title });
    } catch (error) {
      notify(error instanceof Error ? error.message : "This examination could not be started.");
    }
  }

  async function saveGradeForRegistration(grade: string) {
    const result = await apiRequest<{ user: User }>("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ name: studentName, grade }),
    });
    setStudentGrade(result.user.grade ?? "");
    setActiveGrade(result.user.grade ?? "");
  }

  const registrationPage = () => (
    <SubjectRegistration
      onGradeSaved={saveGradeForRegistration}
      onComplete={async () => {
        await refreshDashboard();
        setActiveNav("Overview");
      }}
    />
  );

  if (!dashboard && !dashboardError) {
    return <div className="auth-loading"><span className="loading-mark"><GraduationCap size={22} /></span><span>Loading your learning data…</span></div>;
  }
  if (dashboard && !dashboard.curriculumRegistration.complete) {
    return registrationPage();
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <Brand />

        <div className="school-pill">
          <span className="school-avatar">CBC</span>
          <span className="school-copy"><strong>{studentGrade}</strong><small>My learning space</small></span>
          <ChevronDown size={15} />
        </div>

        <div className="nav-label">LEARN</div>
        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button
              className={`nav-link ${activeNav === label ? "nav-active" : ""}`}
              key={label}
              onClick={() => chooseNav(label)}
            >
              <Icon size={18} strokeWidth={1.9} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="nav-label nav-label-spaced">YOUR SPACE</div>
        <nav className="main-nav" aria-label="Personal navigation">
          <button className="nav-link" onClick={() => setShowRoom(true)}>
            <MessageCircle size={18} strokeWidth={1.9} />
            <span>Messages</span>
            <span className="message-dot" />
          </button>
          <button className="nav-link" onClick={() => setShowProfile(true)}>
            <Settings2 size={18} strokeWidth={1.9} />
            <span>My profile</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-orbit"><CircleHelp size={18} /></div>
            <strong>Need a hand?</strong>
            <p>We’re here to help you keep learning.</p>
            <a href={`mailto:${supportEmail}?subject=${encodeURIComponent("VORTEX LEARNING student support")}`}>Email support <ArrowRight size={14} /></a>
          </div>
          <button className="profile-mini" onClick={() => setShowProfile(true)}>
            <span className="avatar avatar-student">{initials(studentName)}</span>
            <span className="profile-mini-copy"><strong>{studentName}</strong><small>Student account</small></span>
            <MoreHorizontal size={18} />
          </button>
          <button className="logout-button" onClick={onLogout}><LogOut size={15} /> Sign out</button>
        </div>
      </aside>

      {mobileMenu && <button className="scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu-button icon-button" aria-label="Open navigation" onClick={() => setMobileMenu(true)}>
            <Menu size={20} />
          </button>
          <div className="breadcrumb"><span>My space</span><ChevronRight size={14} /><strong>{activeNav}</strong></div>
          <div className="topbar-actions">
            <label className={`search-box ${searchExpanded ? "search-expanded" : ""}`} onClick={() => { if (window.innerWidth <= 650) setSearchExpanded(true); }}>
              <Search size={16} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} onBlur={() => { if (!search) setSearchExpanded(false); }} placeholder="Search your learning..." aria-label="Search courses" />
            </label>
            <div className="notification-wrap">
              <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setShowNotifications(!showNotifications)}>
                <Bell size={18} />
                <span className="notification-dot" />
              </button>
              {showNotifications && (
                <div className="popover notification-popover">
                  <div className="popover-heading"><strong>Notifications</strong><button onClick={() => setShowNotifications(false)} aria-label="Close"><X size={16} /></button></div>
                  {(dashboard?.upcomingExams ?? []).slice(0, 2).map((exam) => <div className="notice-item" key={exam.id}><span className="notice-icon notice-lilac"><CalendarDays size={16} /></span><span><strong>{exam.title}</strong><small>{new Date(exam.opens_at).toLocaleDateString("en-KE")}</small></span></div>)}
                  {dashboard?.upcomingExams.length === 0 && <div className="notice-empty">No upcoming assessments right now.</div>}
                </div>
              )}
            </div>
            <button className="top-profile" onClick={() => setShowProfile(true)} aria-label="Open profile">
              <span className="avatar avatar-student">{initials(studentName)}</span><ChevronDown size={14} />
            </button>
          </div>
        </header>

        <div className="page-content">
          {dashboardError && <div className="dashboard-error" role="alert">{dashboardError}<button onClick={() => void refreshDashboard()}>Retry</button></div>}
          {!dashboard && !dashboardError && <div className="dashboard-loading">Loading your learning data…</div>}
          {activeNav === "Subject registration" && dashboard && registrationPage()}
          {activeNav !== "Overview" && activeNav !== "Subject registration" && (
            <LearningPages
              activeNav={activeNav}
              activeGrade={activeGrade}
              enrolledGrade={studentGrade}
              curriculumRegistration={dashboard?.curriculumRegistration}
              courses={dashboard?.courses ?? []}
              upcomingExams={dashboard?.upcomingExams ?? []}
              resources={dashboard?.resources ?? []}
              onCourseSelect={setActiveCourse}
              onExamSelect={(exam) => void startExam(exam)}
              onNavigate={chooseNav}
            />
          )}
          {activeNav === "Overview" && <>
          <section className="welcome-row">
            <div>
              <div className="date-line"><span className="date-spark"><Sparkles size={13} /></span> {displayDate}</div>
              <h1>Habari za leo, {firstName} <span className="wave">✳</span></h1>
              <p className="welcome-subtitle">A little progress each day adds up to <strong>big results.</strong></p>
            </div>
            <button className="outline-button" onClick={() => setShowProfile(true)}><span className="avatar avatar-small avatar-student">{initials(studentName)}</span> My profile <ChevronRight size={15} /></button>
          </section>

          <section className="hero-card">
            <div className="hero-content">
              <div className="hero-eyebrow"><span className="hero-eyebrow-dot" /> YOUR LEARNING JOURNEY</div>
              <h2>Curious minds<br />go <em>places.</em></h2>
              <p>You’re building brilliant habits, one lesson at a time. Keep that lovely momentum going.</p>
              <button className="hero-button" onClick={() => chooseNav("My learning")}>Continue learning <ArrowRight size={16} /></button>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="sun-shape" />
              <div className="art-doodle doodle-one">✳</div>
              <div className="art-doodle doodle-two">✧</div>
              <div className="floating-note note-top"><span className="note-icon">✦</span><span><b>You're on a roll!</b><small>3 lessons this week</small></span></div>
              <div className="book book-back" />
              <div className="book book-mid" />
              <div className="book book-front"><div className="book-cover"><span>THE</span><strong>BIG<br />IDEAS</strong><i>✳</i></div></div>
              <div className="plant-pot"><span className="plant-leaf leaf-a" /><span className="plant-leaf leaf-b" /><span className="plant-leaf leaf-c" /><i /></div>
              <div className="floating-note note-bottom"><span className="tiny-avatar">S</span><span><b>Study together</b><small>Study rooms coming soon</small></span></div>
              <div className="art-floor" />
            </div>
          </section>

          <section className="stats-grid" aria-label="Your learning statistics">
            <article className="stat-card">
              <div className="stat-top"><span className="stat-icon streak-icon"><Flame size={18} /></span><span className="stat-trend trend-up"><ArrowDownRight size={13} /> Keep it up</span></div>
              <div className="stat-value">{dashboard?.stats.streakDays ?? 0} <span>days</span></div>
              <div className="stat-label">Learning streak</div>
              <div className="week-dots" aria-label="5 of 7 days completed">
                {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span className={index < 5 ? "week-day week-done" : "week-day"} key={`${day}-${index}`}>{index < 5 ? <Check size={11} /> : day}</span>)}
              </div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span className="stat-icon progress-icon"><Target size={18} /></span><span className="stat-trend trend-positive">This term</span></div>
              <div className="stat-value">{dashboard?.stats.learningProgress ?? 0}<span>%</span></div>
              <div className="stat-label">Learning progress</div>
              <div className="progress-track"><span style={{ width: `${dashboard?.stats.learningProgress ?? 0}%` }} /></div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span className="stat-icon lesson-icon"><BookOpen size={18} /></span><span className="stat-trend">This week</span></div>
              <div className="stat-value">{dashboard?.stats.lessonsCompleted ?? 0} <span>of {dashboard?.stats.lessonsTotal ?? 0}</span></div>
              <div className="stat-label">Lessons completed</div>
              <div className="mini-bars" aria-label="Weekly activity chart">
                {[34, 55, 43, 80, 61, 92, 48].map((height, index) => <span className={index === 5 ? "bar bar-today" : "bar"} style={{ height: `${height}%` }} key={index} />)}
              </div>
            </article>
          </section>

          <section className="learning-layout">
            <div className="courses-section">
              <div className="section-heading">
                <div><span className="section-kicker">PICK UP WHERE YOU LEFT OFF</span><h2>Your learning</h2></div>
                <button className="text-link" onClick={() => chooseNav("My learning")}>All subjects <ArrowRight size={15} /></button>
              </div>
              <div className="course-list">
                {visibleCourses.map((course: Course) => (
                  <article className="course-card" key={course.name}>
                    <div className={`course-icon course-${course.color}`}><span>{course.icon}</span></div>
                    <div className="course-info">
                      <div className="course-name-row"><h3>{course.name}</h3><button className="dots-button" aria-label={`More ${course.name} options`} onClick={() => notify(`${course.name} options coming soon.`)}><MoreHorizontal size={18} /></button></div>
                      <p>{course.topic}</p>
                      <div className="course-progress-row"><div className="course-track"><span className={`track-${course.color}`} style={{ width: `${course.progress}%` }} /></div><span>{course.progress}%</span></div>
                      <div className="course-foot"><span>{course.lessons}</span><button onClick={() => setActiveCourse(course)}>Continue <ArrowRight size={14} /></button></div>
                    </div>
                  </article>
                ))}
                {visibleCourses.length === 0 && dashboard && <div className="no-results"><Search size={20} /><strong>No subjects found</strong><span>Try searching for another subject or topic.</span></div>}
              </div>
            </div>

            <aside className="right-column">
              <section className="panel exam-panel">
                <div className="panel-heading"><div><span className="section-kicker">UP NEXT</span><h2>Coming up</h2></div><button className="round-more" aria-label="More examination options" onClick={() => chooseNav("Quizzes & assessments")}><MoreHorizontal size={19} /></button></div>
                {(dashboard?.upcomingExams ?? []).slice(0, 4).map((exam, index) => {
                  const date = new Date(exam.opens_at);
                  const isOpen = date.getTime() <= Date.now();
                  return <div className="exam-item" key={exam.id}>
                    <div className={`exam-date ${index % 2 ? "exam-date-green" : ""}`}><strong>{new Intl.DateTimeFormat("en-KE", { day: "2-digit" }).format(date)}</strong><span>{new Intl.DateTimeFormat("en-KE", { month: "short" }).format(date).toUpperCase()}</span></div>
                    <div className="exam-copy"><strong>{exam.title}</strong><span><Clock3 size={13} /> {exam.duration_minutes} min · {exam.subject_name}</span></div>
                    <button className={`exam-tag exam-start ${index % 2 ? "exam-tag-green" : ""}`} disabled={!isOpen} onClick={() => void startExam(exam)}>{isOpen ? "START" : exam.kind}</button>
                  </div>;
                })}
                {dashboard && dashboard.upcomingExams.length === 0 && <div className="exams-empty">You’re all caught up. New assessments will appear here.</div>}
                <button className="panel-footer-link" onClick={() => chooseNav("Quizzes & assessments")}>See all assessments <ArrowRight size={14} /></button>
              </section>

              <section className="study-card">
                <div className="study-card-top"><span className="live-pill"><span /> COMING SOON</span><span className="room-count"><UsersRound size={14} /> Study circles</span></div>
                <h3>Revise together</h3>
                <p>Group chat and supervised voice/video rooms are planned for a later release.</p>
                <button className="join-button" onClick={() => setShowRoom(true)}><Video size={15} /> Learn about study rooms <ArrowRight size={15} /></button>
              </section>
            </aside>
          </section>
          </>}

          <footer className="page-footer">
            <span>Made for curious minds <span className="footer-heart">✳</span> Kenya CBC</span>
            <span className="page-footer-links">
              <button onClick={() => chooseNav("About Us")}>About Us</button>
              <button onClick={() => chooseNav("Help & Contact")}>Help & Contact</button>
            </span>
            <span className="preview-status"><span className="sync-dot" /> Connected to your learning account</span>
          </footer>
        </div>
      </main>

      {showProfile && <ProfileModal name={studentName} grade={studentGrade} userCode={user.userCode} onClose={() => setShowProfile(false)} onCopyCode={async (code) => {
        try {
          await navigator.clipboard.writeText(code);
          notify("Your student code was copied.");
        } catch {
          notify("Copy is unavailable in this browser. Select and copy your student code.");
        }
      }} onSave={async (name, grade) => {
        try {
          const result = await apiRequest<{ user: User }>("/api/profile", { method: "PATCH", body: JSON.stringify({ name, grade }) });
          setStudentName(result.user.name);
          setStudentGrade(result.user.grade ?? grade);
          setActiveGrade(result.user.grade ?? grade);
          void refreshDashboard();
          setShowProfile(false);
          notify("Your profile and grade were updated.");
        } catch (error) {
          notify(error instanceof Error ? error.message : "Profile could not be updated.");
        }
      }} />}
      {showRoom && <StudyModal onClose={() => setShowRoom(false)} />}
      {activeExam && <ExamModal attempt={activeExam} onClose={() => setActiveExam(null)} onSubmitted={() => { setActiveExam(null); void refreshDashboard(); notify("Your answers were submitted."); }} onError={(message) => notify(message)} />}
      {activeCourse && <CourseLessonsModal course={activeCourse} onClose={() => setActiveCourse(null)} onCompleted={() => void refreshDashboard()} />}
      {toast && <div className="toast"><span className="toast-check"><Check size={14} /></span>{toast}</div>}
    </div>
  );
}

function ProfileModal({ name, grade, userCode, onClose, onCopyCode, onSave }: { name: string; grade: string; userCode: string | null; onClose: () => void; onCopyCode: (code: string) => void | Promise<void>; onSave: (name: string, grade: string) => void | Promise<void> }) {
  const [editedName, setEditedName] = useState(name);
  const [editedGrade, setEditedGrade] = useState(grade);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="modal-head"><div><span className="section-kicker">YOUR ACCOUNT</span><h2 id="profile-title">My profile</h2></div><button className="icon-button" onClick={onClose} aria-label="Close profile"><X size={19} /></button></div>
        <div className="profile-edit-avatar"><span className="avatar avatar-student avatar-large">{initials(editedName || name)}</span><span><strong>{editedName || name}</strong><small>{editedGrade} learner</small></span></div>
        <div className="student-code-card"><span><small>YOUR STUDENT CODE</small><strong>{userCode ?? "Code unavailable"}</strong></span>{userCode && <button className="copy-button" onClick={() => void onCopyCode(userCode)} aria-label="Copy your student code"><Copy size={16} /></button>}</div>
        <label className="form-label">Display name<input value={editedName} onChange={(event) => setEditedName(event.target.value)} maxLength={60} /></label>
        <label className="form-label">Learning level<select value={editedGrade} onChange={(event) => setEditedGrade(event.target.value)}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1}>Grade {index + 1}</option>)}</select></label>
        <div className="privacy-hint"><span><Settings2 size={15} /></span>Share your student code only with learners you want to find you for a study discussion. Your email stays private.</div>
        <div className="modal-actions"><button className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!editedName.trim()} onClick={() => void onSave(editedName.trim(), editedGrade)}>Save changes</button></div>
      </section>
    </div>
  );
}

function StudyModal({ onClose }: { onClose: () => void }) {
  const [studentCode, setStudentCode] = useState("");
  const [foundStudent, setFoundStudent] = useState<{ userCode: string; name: string; grade: string } | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [searching, setSearching] = useState(false);

  async function findStudent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearching(true);
    setLookupError("");
    setFoundStudent(null);
    try {
      const result = await apiRequest<{ student: { userCode: string; name: string; grade: string } | null }>(
        `/api/students/lookup?code=${encodeURIComponent(studentCode.trim())}`,
      );
      if (result.student) setFoundStudent(result.student);
      else setLookupError("No active learner was found with that code. Check the code and try again.");
    } catch (error) {
      setLookupError(error instanceof Error ? error.message : "The student code could not be checked.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card study-modal" role="dialog" aria-modal="true" aria-labelledby="study-title">
        <div className="modal-head"><div><span className="section-kicker">FIND LEARNERS</span><h2 id="study-title">Study circles</h2></div><button className="icon-button" onClick={onClose} aria-label="Close study circles"><X size={19} /></button></div>
        <div className="student-lookup">
          <h3>Find a learner by student code</h3>
          <p>Ask them to share their code, then search to confirm who you want to study with.</p>
          <form className="student-lookup-form" onSubmit={(event) => void findStudent(event)}>
            <label className="form-label">Student code<input value={studentCode} onChange={(event) => setStudentCode(event.target.value.toUpperCase())} minLength={11} maxLength={11} placeholder="VX-XXXXXXXX" required /></label>
            <button className="primary-button" type="submit" disabled={searching}>{searching ? "Searching…" : "Find learner"}</button>
          </form>
          {lookupError && <div className="auth-error" role="alert">{lookupError}</div>}
          {foundStudent && <div className="found-student"><span className="avatar avatar-student">{initials(foundStudent.name)}</span><span><strong>{foundStudent.name}</strong><small>{foundStudent.grade} · {foundStudent.userCode}</small></span></div>}
        </div>
        <div className="room-preview"><div className="room-preview-icon"><Headphones size={25} /></div><span className="room-online">PLANNED FEATURE</span><strong>Study together, safely</strong><p>Study circles, chat, and live voice/video rooms are not connected yet. Safeguarding, room access, and moderation will be added before calls are launched.</p></div>
        <div className="safety-note"><CircleHelp size={17} /><span>Looking up a code does not start or share a discussion. Group chat and study rooms are not live yet; no email addresses are shown.</span></div>
        <div className="modal-actions"><button className="quiet-button" onClick={onClose}>Close</button></div>
      </section>
    </div>
  );
}

function RoleNotice({ user, onLogout }: { user: User; onLogout: () => void }) {
  return <main className="auth-loading"><span className="loading-mark"><GraduationCap size={22} /></span><strong>Welcome, {user.name}</strong><span>This account role does not have a dashboard in this version.</span><button className="quiet-button" onClick={onLogout}>Sign out</button></main>;
}

type ExamQuestion = {
  id: string;
  prompt: string;
  options: string[];
  points: number;
  selected_option: number | null;
};
type Lesson = {
  id: string;
  title: string;
  summary: string;
  content: string;
  sort_order: number;
  completed: number;
};

function CourseLessonsModal({ course, onClose, onCompleted }: { course: Course; onClose: () => void; onCompleted: () => void }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiRequest<{ lessons: Lesson[] }>(`/api/subjects/${course.id}/lessons`)
      .then((result) => setLessons(result.lessons))
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Lessons could not be loaded."));
  }, [course.id]);

  async function completeLesson() {
    const lesson = lessons[selectedIndex];
    if (!lesson || lesson.completed) return;
    setSaving(true);
    setError("");
    try {
      await apiRequest(`/api/lessons/${lesson.id}/complete`, { method: "POST" });
      setLessons((current) => current.map((item) => item.id === lesson.id ? { ...item, completed: 1 } : item));
      onCompleted();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Your lesson progress could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const lesson = lessons[selectedIndex];
  return (
    <div className="modal-backdrop">
      <section className="modal-card lesson-modal" role="dialog" aria-modal="true" aria-labelledby="lesson-title">
        <div className="modal-head"><div><span className="section-kicker">{course.name.toUpperCase()} · LESSON {lessons.length ? selectedIndex + 1 : ""}{lessons.length ? ` OF ${lessons.length}` : ""}</span><h2 id="lesson-title">{course.topic}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close lessons"><X size={19} /></button></div>
        {lesson ? <div className="lesson-body"><div className="lesson-summary">{lesson.summary}</div><h3>{lesson.title}</h3><p>{lesson.content}</p><div className="lesson-progress-copy">{lesson.completed ? <><Check size={14} /> Lesson completed</> : "Take your time to read, then mark the lesson complete."}</div></div> : <div className="lesson-loading">{error || "Loading lessons…"}</div>}
        {error && lesson && <div className="auth-error" role="alert">{error}</div>}
        <div className="modal-actions"><button className="quiet-button" onClick={onClose}>Close</button>{selectedIndex > 0 && <button className="quiet-button" onClick={() => setSelectedIndex((index) => index - 1)}>Previous</button>}{lesson && !lesson.completed && <button className="primary-button" disabled={saving} onClick={() => void completeLesson()}>{saving ? "Saving…" : "Mark complete"} <Check size={14} /></button>}{selectedIndex < lessons.length - 1 && <button className="primary-button" onClick={() => setSelectedIndex((index) => index + 1)}>Next <ArrowRight size={14} /></button>}</div>
      </section>
    </div>
  );
}

type ExamAttempt = {
  attemptId: string;
  expiresAt: string;
  questions: ExamQuestion[];
  title: string;
};

function ExamModal({
  attempt,
  onClose,
  onSubmitted,
  onError,
}: {
  attempt: ExamAttempt;
  onClose: () => void;
  onSubmitted: () => void;
  onError: (message: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>(() =>
    Object.fromEntries(attempt.questions.flatMap((question) => question.selected_option === null ? [] : [[question.id, question.selected_option]])),
  );
  const [saving, setSaving] = useState("");
  const [remainingSeconds, setRemainingSeconds] = useState(() => Math.max(0, Math.floor((Date.parse(attempt.expiresAt) - Date.now()) / 1000)));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submitAttempt = useCallback(async () => {
    if (submitting || submitted) return;
    setSubmitting(true);
    try {
      const result = await apiRequest<{ submitted: boolean; score: number; totalPoints: number }>(
        `/api/attempts/${attempt.attemptId}/submit`,
        { method: "POST" },
      );
      setSubmitted(true);
      onSubmitted();
      onError(`Submitted. Score: ${result.score} of ${result.totalPoints}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : "The exam could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }, [attempt.attemptId, onError, onSubmitted, submitted, submitting]);

  useEffect(() => {
    if (submitted) return;
    const interval = window.setInterval(() => {
      const remaining = Math.max(0, Math.floor((Date.parse(attempt.expiresAt) - Date.now()) / 1000));
      setRemainingSeconds(remaining);
      if (remaining === 0) void submitAttempt();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [attempt.expiresAt, submitAttempt, submitted]);

  async function saveAnswer(questionId: string, selectedOption: number) {
    setAnswers((current) => ({ ...current, [questionId]: selectedOption }));
    setSaving(questionId);
    try {
      await apiRequest(`/api/attempts/${attempt.attemptId}/answers`, {
        method: "PUT",
        body: JSON.stringify({ questionId, selectedOption }),
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : "Your answer could not be saved.");
    } finally {
      setSaving((current) => current === questionId ? "" : current);
    }
  }

  const timeText = `${Math.floor(remainingSeconds / 60).toString().padStart(2, "0")}:${(remainingSeconds % 60).toString().padStart(2, "0")}`;
  return (
    <div className="modal-backdrop exam-backdrop">
      <section className="modal-card exam-modal" role="dialog" aria-modal="true" aria-labelledby="exam-title">
        <div className="modal-head"><div><span className="section-kicker">ASSESSMENT IN PROGRESS</span><h2 id="exam-title">{attempt.title}</h2></div><div className="exam-timer"><Clock3 size={15} /> {timeText}</div></div>
        <div className="exam-question-list">
          {attempt.questions.map((question, index) => (
            <article className="exam-question" key={question.id}>
              <div className="question-label"><span>QUESTION {index + 1}</span><span>{question.points} {question.points === 1 ? "mark" : "marks"}</span></div>
              <h3>{question.prompt}</h3>
              <div className="question-options">
                {question.options.map((option, optionIndex) => (
                  <button key={`${question.id}-${optionIndex}`} className={`question-option ${answers[question.id] === optionIndex ? "question-option-selected" : ""}`} onClick={() => void saveAnswer(question.id, optionIndex)}>
                    <span>{String.fromCharCode(65 + optionIndex)}</span>{option}{answers[question.id] === optionIndex && saving !== question.id && <Check size={15} />}
                  </button>
                ))}
              </div>
              <span className="answer-save-status">{saving === question.id ? "Saving answer…" : answers[question.id] !== undefined ? "Answer saved" : "Choose one answer"}</span>
            </article>
          ))}
        </div>
        <div className="modal-actions"><button className="quiet-button" onClick={onClose}>Close for now</button><button className="primary-button" disabled={submitting} onClick={() => void submitAttempt()}>{submitting ? "Submitting…" : "Submit exam"} <ArrowRight size={15} /></button></div>
      </section>
    </div>
  );
}

export default App;
