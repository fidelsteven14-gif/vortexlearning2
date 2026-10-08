import { ArrowRight, BookOpen, Check, ClipboardCheck, Download, Eye, FileText, GraduationCap, Info, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { seniorCompulsorySubjects, seniorPathways } from "../shared/curriculum";
import { apiFileRequest, apiRequest, supportEmail, type Course, type LearningResource, type UpcomingExam } from "./api";

type PublishedLesson = {
  id: string;
  title: string;
  summary: string;
  content: string;
  sort_order: number;
  completed: number;
};

function LearningPages({
  activeNav,
  activeGrade,
  enrolledGrade,
  curriculumRegistration,
  courses,
  upcomingExams,
  resources,
  onCourseSelect,
  onExamSelect,
  onNavigate,
}: {
  activeNav: string;
  activeGrade: string;
  enrolledGrade: string;
  curriculumRegistration?: { complete: boolean; pathway: string | null; grade: string | null };
  courses: Course[];
  upcomingExams: UpcomingExam[];
  resources: LearningResource[];
  onCourseSelect: (course: Course) => void;
  onExamSelect: (exam: UpcomingExam) => void;
  onNavigate: (page: string) => void;
}) {
  const [resourceSearch, setResourceSearch] = useState("");
  const [resourcePreview, setResourcePreview] = useState<{ url: string; title: string } | null>(null);
  const [resourceError, setResourceError] = useState("");
  const [publishedLessons, setPublishedLessons] = useState<Array<PublishedLesson & { course: Course }>>([]);
  const [publishedLessonsLoading, setPublishedLessonsLoading] = useState(false);
  const [publishedLessonsError, setPublishedLessonsError] = useState("");
  const gradeNumber = Number(activeGrade.replace("Grade ", ""));
  const gradeCourses = activeGrade === enrolledGrade ? courses : [];
  const registeredPathway = seniorPathways.find((pathway) => pathway.id === curriculumRegistration?.pathway);
  const seniorCoreCourses = gradeCourses.filter((course) => seniorCompulsorySubjects.includes(course.name as typeof seniorCompulsorySubjects[number]));
  const pathwayCourses = gradeCourses.filter((course) => !seniorCompulsorySubjects.includes(course.name as typeof seniorCompulsorySubjects[number]));
  const visibleResources = useMemo(() => resources.filter((resource) =>
    `${resource.title} ${resource.description} ${resource.topic} ${resource.term} ${resource.category} ${resource.subjectName}`
      .toLowerCase().includes(resourceSearch.trim().toLowerCase()),
  ), [resources, resourceSearch]);

  useEffect(() => {
    if (activeNav !== "Published learning content") return;
    let cancelled = false;
    setPublishedLessonsLoading(true);
    setPublishedLessonsError("");
    Promise.all(courses.map(async (course) => {
      const result = await apiRequest<{ lessons: PublishedLesson[] }>(`/api/subjects/${course.id}/lessons`);
      return result.lessons.map((lesson) => ({ ...lesson, course }));
    })).then((groups) => {
      if (!cancelled) setPublishedLessons(groups.flat());
    }).catch((error: unknown) => {
      if (!cancelled) setPublishedLessonsError(error instanceof Error ? error.message : "Published learning content could not be loaded.");
    }).finally(() => {
      if (!cancelled) setPublishedLessonsLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeNav, courses]);

  useEffect(() => () => {
    if (resourcePreview?.url) URL.revokeObjectURL(resourcePreview.url);
  }, [resourcePreview]);

  async function openResource(resource: LearningResource) {
    setResourceError("");
    try {
      const file = await apiFileRequest(`/api/resources/${resource.id}/file`);
      setResourcePreview({ url: URL.createObjectURL(file), title: resource.title });
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : "This PDF could not be opened.");
    }
  }

  async function downloadResource(resource: LearningResource) {
    setResourceError("");
    try {
      const file = await apiFileRequest(`/api/resources/${resource.id}/file?download=1`);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = resource.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : "This PDF could not be downloaded.");
    }
  }

  return (
    <>
    <main className="learning-page">
      <header className="learning-page-heading">
        <span className="section-kicker">VORTEX LEARNING · KENYA CBC</span>
        <h1>{activeNav === "All grades" && activeGrade
          ? gradeNumber <= 3 ? `${activeGrade} Learning Areas` : `${activeGrade} Subjects`
          : activeNav}</h1>
        <p>
          {activeNav === "All grades"
            ? `You are viewing the curriculum registered for ${activeGrade}.`
            : activeNav === "Lessons & notes"
              ? "Open lessons and study notes for your enrolled subjects."
              : activeNav === "Published learning content"
                ? "Browse lessons and notes published for your registered learning areas."
                : activeNav === "PDF learning resources"
                  ? "Preview and download published PDF resources for your registered subjects."
                  : activeNav === "Quizzes & assessments"
                    ? "Practice with quizzes and assessments published for your grade."
                : activeNav === "About Us"
                  ? "A welcoming learning space for curious minds across Kenya."
                  : activeNav === "Help & Contact"
                    ? "Find support for your account and learning journey."
                    : "Your enrolled subjects, lesson progress, and next steps."}
        </p>
      </header>

      {activeNav === "All grades" && (
        <>
          {gradeNumber >= 10 ? (
            <>
              <section className="curriculum-panel">
                <div className="curriculum-panel-heading">
                  <span className="learning-page-icon"><GraduationCap size={19} /></span>
                  <div><span className="section-kicker">{activeGrade} · SENIOR SCHOOL</span><h2>{registeredPathway?.name ?? "Your selected pathway"}</h2></div>
                </div>
                <p className="curriculum-intro">Your registered pathway and subjects are shown below. Subject combinations depend on what your school offers.</p>
                <div className="learning-area-grid">
                  {pathwayCourses.map((course) => (
                    <article className="learning-area-card" key={course.id}>
                      <span className={`course-icon course-${course.color}`}><span>{course.icon}</span></span>
                      <strong>{course.name}</strong>
                      <button className="area-action" onClick={() => onCourseSelect(course)}>Open available lessons <ArrowRight size={14} /></button>
                    </article>
                  ))}
                </div>
                {!pathwayCourses.length && <p className="curriculum-intro">No pathway subjects have been registered yet.</p>}
              </section>
              <section className="curriculum-panel">
                <div className="curriculum-panel-heading"><span className="learning-page-icon"><Check size={18} /></span><div><span className="section-kicker">COMPULSORY LEARNING AREAS</span><h2>Common subjects and activities</h2></div></div>
                <div className="learning-area-grid">
                  {seniorCoreCourses.map((course) => (
                    <article className="learning-area-card" key={course.id}>
                      <span className="area-symbol">✓</span><strong>{course.name}</strong>
                      <button className="area-action" onClick={() => onCourseSelect(course)}>Open available lessons <ArrowRight size={14} /></button>
                    </article>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <section className="curriculum-panel">
              <div className="curriculum-panel-heading">
                <span className="learning-page-icon"><GraduationCap size={19} /></span>
              <div><span className="section-kicker">{gradeNumber <= 3 ? "LOWER PRIMARY" : gradeNumber <= 6 ? "UPPER PRIMARY" : "JUNIOR SCHOOL"}</span><h2>{gradeNumber <= 3 ? `Your ${activeGrade} learning areas` : `${activeGrade} subject registration`}</h2></div>
              </div>
              {gradeNumber <= 3 && <p className="curriculum-intro">Lessons for Grades 1–3 work best with age-appropriate pictures, audio, songs, games, and simple activities.</p>}
              <div className="learning-area-grid">
              {gradeCourses.map((course) => (
                <article className="learning-area-card" key={course.id}>
                  <span className={`course-icon course-${course.color}`}><span>{course.icon}</span></span>
                  <strong>{course.name}</strong>
                  <button className="area-action" onClick={() => onCourseSelect(course)}>Open available lessons <ArrowRight size={14} /></button>
                </article>
              ))}
              {!gradeCourses.length && <p className="curriculum-intro">No subjects are registered for this grade.</p>}
              </div>
            </section>
          )}
          <aside className="curriculum-note"><Info size={16} /><span>This is a learning-area overview, not an official grade-by-grade subject combination. Confirm current labels and offerings in the <a href="https://kicd.ac.ke/cbc-materials/curriculum-designs/" target="_blank" rel="noreferrer">KICD curriculum designs</a>.</span></aside>
        </>
      )}

      {activeNav === "My learning" && (
        <section className="curriculum-panel">
          <div className="curriculum-panel-heading"><span className="learning-page-icon"><BookOpen size={19} /></span><div><span className="section-kicker">{activeGrade.toUpperCase()}</span><h2>Your enrolled subjects</h2></div></div>
          {courses.length ? (
            <div className="resource-list">
              {courses.map((course) => (
                <article className="resource-row" key={course.id}>
                  <span className={`course-icon course-${course.color}`}><span>{course.icon}</span></span>
                  <span className="resource-copy"><strong>{course.name}</strong><small>{course.topic} · {course.completed_lessons} of {course.total_lessons} lessons complete</small><span className="resource-progress"><span style={{ width: `${course.progress}%` }} /></span></span>
                  <button className="primary-button" onClick={() => onCourseSelect(course)}>Open lessons <ArrowRight size={14} /></button>
                </article>
              ))}
            </div>
          ) : <EmptyState title="No subjects are enrolled yet" detail="When your school administrator assigns subjects, they will appear here." />}
        </section>
      )}

      {activeNav === "Lessons & notes" && (
        <section className="curriculum-panel resource-page">
          <div className="curriculum-panel-heading"><span className="learning-page-icon learning-page-icon-green"><BookOpen size={18} /></span><div><span className="section-kicker">YOUR LEARNING AREAS</span><h2>Lessons &amp; notes</h2></div></div>
          <p className="curriculum-intro">Choose a learning area to open its lessons and study notes.</p>
          {courses.length ? (
            <div className="resource-list">
              {courses.map((course) => (
                <article className="resource-row" key={course.id}>
                  <span className={`course-icon course-${course.color}`}><span>{course.icon}</span></span>
                  <span className="resource-copy"><strong>{course.name}</strong><small>{course.topic} · {course.total_lessons} learning {course.total_lessons === 1 ? "resource" : "resources"}</small></span>
                  <button className="quiet-button" onClick={() => onCourseSelect(course)}>Open lessons &amp; notes <ArrowRight size={14} /></button>
                </article>
              ))}
            </div>
          ) : <EmptyState title="No learning areas are available yet" detail="Lessons and notes will appear after subjects are registered for your account." />}
        </section>
      )}

      {activeNav === "Published learning content" && (
        <section className="curriculum-panel">
          <div className="curriculum-panel-heading"><span className="learning-page-icon learning-page-icon-green"><FileText size={18} /></span><div><span className="section-kicker">PUBLISHED FOR YOUR GRADE</span><h2>Lessons and notes</h2></div></div>
          {publishedLessonsLoading && <div className="dashboard-loading">Loading published learning content…</div>}
          {publishedLessonsError && <div className="dashboard-error" role="alert">{publishedLessonsError}</div>}
          {!publishedLessonsLoading && !publishedLessonsError && (publishedLessons.length ? (
            <div className="resource-list">
              {publishedLessons.map((lesson) => (
                <article className="resource-row published-lesson-row" key={lesson.id}>
                  <span className={`course-icon course-${lesson.course.color}`}><span>{lesson.course.icon}</span></span>
                  <span className="resource-copy">
                    <strong>{lesson.title}</strong>
                    <small>{lesson.course.name} · {lesson.course.topic}{lesson.completed ? " · Completed" : ""}</small>
                    <small>{lesson.summary}</small>
                    <details className="published-lesson-details"><summary>Read lesson</summary><p>{lesson.content}</p></details>
                  </span>
                </article>
              ))}
            </div>
          ) : <EmptyState title="No published lessons yet" detail="New lesson and note content will appear here when it is published for your subjects." />)}
        </section>
      )}

      {activeNav === "PDF learning resources" && (
        <section className="curriculum-panel resource-page">
          <div className="published-pdf-section">
            <div className="published-pdf-heading"><div><span className="section-kicker">GRADE-MATCHED DOCUMENTS</span><h2>PDF learning resources</h2></div><label className="resource-search"><Search size={15} /><input aria-label="Search PDF resources" value={resourceSearch} onChange={(event) => setResourceSearch(event.target.value)} placeholder="Search title, topic, or subject" /></label></div>
            {resourceError && <div className="dashboard-error" role="alert">{resourceError}</div>}
            {visibleResources.length ? <div className="resource-list">
              {visibleResources.map((resource) => (
                <article className="resource-row pdf-resource-row" key={resource.id}>
                  <span className="learning-page-icon learning-page-icon-green"><FileText size={18} /></span>
                  <span className="resource-copy"><strong>{resource.title}</strong><small>{resource.subjectName} · {resource.topic} · {resource.term} · {resource.category.split("-").join(" ")}</small>{resource.description && <small>{resource.description}</small>}</span>
                  <div className="pdf-resource-actions"><button className="quiet-button" onClick={() => void openResource(resource)}><Eye size={14} /> Preview</button><button className="primary-button" onClick={() => void downloadResource(resource)}><Download size={14} /> Download</button></div>
                </article>
              ))}
            </div> : <EmptyState title={resources.length ? "No matching PDFs found" : "No PDF resources are published yet"} detail={resources.length ? "Try another title, subject, or topic." : "Published study documents for your grade will appear here."} />}
          </div>
        </section>
      )}

      {activeNav === "Quizzes & assessments" && (
        <section className="curriculum-panel">
          <div className="curriculum-panel-heading"><span className="learning-page-icon learning-page-icon-green"><ClipboardCheck size={18} /></span><div><span className="section-kicker">PRACTICE & ASSESSMENT</span><h2>Quizzes &amp; assessments</h2></div></div>
          {upcomingExams.length ? (
            <div className="resource-list">
              {upcomingExams.map((exam) => {
                const opensAt = new Date(exam.opens_at);
                const isOpen = opensAt.getTime() <= Date.now();
                return (
                  <article className="resource-row" key={exam.id}>
                    <span className="learning-page-icon"><ClipboardCheck size={18} /></span>
                    <span className="resource-copy"><strong>{exam.title}</strong><small>{exam.subject_name} · {exam.duration_minutes} minutes · {isOpen ? "Available now" : `Opens ${opensAt.toLocaleDateString("en-KE")}`}</small></span>
                    <button className="primary-button" disabled={!isOpen} onClick={() => onExamSelect(exam)}>{isOpen ? "Start assessment" : "Not open yet"} <ArrowRight size={14} /></button>
                  </article>
                );
              })}
            </div>
          ) : <EmptyState title="No assessments are scheduled" detail="Published quizzes and practice assessments will appear here." />}
        </section>
      )}

      {activeNav === "About Us" && (
        <section className="curriculum-panel about-panel">
          <div className="curriculum-panel-heading"><span className="learning-page-icon"><Info size={18} /></span><div><span className="section-kicker">OUR PURPOSE</span><h2>Learning made for curious minds</h2></div></div>
          <p>Vortex Learning helps learners explore their subjects, follow lessons, and practise with assessments in a supportive digital space. The grade explorer is a guide to learning areas; official curriculum designs and school subject offerings remain the source of truth.</p>
          <button className="primary-button" onClick={() => onNavigate("All grades")}>Explore all grades <ArrowRight size={14} /></button>
        </section>
      )}

      {activeNav === "Help & Contact" && (
        <section className="curriculum-panel about-panel">
          <div className="curriculum-panel-heading"><span className="learning-page-icon learning-page-icon-green"><Info size={18} /></span><div><span className="section-kicker">SUPPORT</span><h2>Need a hand?</h2></div></div>
          <p>If you cannot sign in, find a lesson, or open an assessment, ask your school administrator for help. For platform support, email us and include your grade and a short description of the issue.</p>
          <a className="primary-button support-link" href={`mailto:${supportEmail}?subject=${encodeURIComponent("Vortex Learning support")}`}>Email platform support <ArrowRight size={14} /></a>
          <div className="faq-list">
            <h3>Frequently asked questions</h3>
            <details><summary>Why can’t I open a subject from another grade?</summary><p>Lessons and assessments are limited to your enrolled grade. Ask your school administrator if your grade is incorrect.</p></details>
            <details><summary>Where can I find notes and downloadable files?</summary><p>Open Lessons &amp; notes for study content, Published learning content for lessons, or PDF learning resources for downloadable files.</p></details>
            <details><summary>Who can help with my account?</summary><p>Your school administrator can help with school account details. For technical issues, contact platform support above.</p></details>
          </div>
        </section>
      )}
    </main>
    {resourcePreview && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setResourcePreview(null); }}><section className="modal-card learner-pdf-modal" role="dialog" aria-modal="true" aria-label={`PDF preview: ${resourcePreview.title}`}><div className="modal-head"><div><span className="section-kicker">LEARNING RESOURCE</span><h2>{resourcePreview.title}</h2></div><button className="icon-button" onClick={() => setResourcePreview(null)} aria-label="Close PDF preview"><X size={19} /></button></div><iframe src={resourcePreview.url} title={`PDF preview: ${resourcePreview.title}`} /></section></div>}
    </>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="learning-empty"><Search size={20} /><strong>{title}</strong><span>{detail}</span></div>;
}

export default LearningPages;
