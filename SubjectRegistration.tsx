import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, GraduationCap } from "lucide-react";
import Brand from "./Brand";
import { apiRequest, type CurriculumPathway, type CurriculumRegistration } from "./api";

const gradeOptions = Array.from({ length: 12 }, (_, index) => `Grade ${index + 1}`);

export default function SubjectRegistration({
  onGradeSaved,
  onComplete,
}: {
  onGradeSaved: (grade: string) => Promise<void>;
  onComplete: () => Promise<void>;
}) {
  const [curriculum, setCurriculum] = useState<CurriculumRegistration | null>(null);
  const [pathwayId, setPathwayId] = useState<CurriculumPathway["id"]>("stem");
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>([]);
  const [gradeChoice, setGradeChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiRequest<CurriculumRegistration>("/api/curriculum/registration")
      .then((result) => {
        if (cancelled) return;
        setCurriculum(result);
        if (result.pathway) setPathwayId(result.pathway);
        const savedIds = result.selectedSubjectIds.filter((id) =>
          result.subjects.some((subject) => subject.id === id)
          || result.pathways.some((pathway) => pathway.subjects.some((subject) => subject.id === id)),
        );
        setSelectedSubjectIds(savedIds.length
          ? savedIds
          : result.needsGrade
            ? []
            : result.subjects.length
              ? result.subjects.map((subject) => subject.id)
              : result.pathways.find((pathway) => pathway.id === (result.pathway ?? "stem"))?.subjects.map((subject) => subject.id) ?? []);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : "The curriculum could not be loaded.");
      });
    return () => { cancelled = true; };
  }, []);

  const selectedPathway = useMemo(
    () => curriculum?.pathways.find((pathway) => pathway.id === pathwayId),
    [curriculum, pathwayId],
  );
  const subjectsToChoose = curriculum?.needsGrade
    ? []
    : curriculum?.pathways.length
      ? selectedPathway?.subjects ?? []
      : curriculum?.subjects ?? [];
  const gradeNumber = Number(curriculum?.grade?.replace("Grade ", ""));

  function choosePathway(id: CurriculumPathway["id"]) {
    setPathwayId(id);
    const pathway = curriculum?.pathways.find((candidate) => candidate.id === id);
    setSelectedSubjectIds(pathway?.subjects.map((subject) => subject.id) ?? []);
  }

  function toggleSubject(subjectId: string) {
    setSelectedSubjectIds((current) => current.includes(subjectId)
      ? current.filter((id) => id !== subjectId)
      : [...current, subjectId]);
  }

  async function saveGrade() {
    if (!gradeChoice) return;
    setError("");
    setBusy(true);
    try {
      await onGradeSaved(gradeChoice);
      const result = await apiRequest<CurriculumRegistration>("/api/curriculum/registration");
      setCurriculum(result);
      setSelectedSubjectIds(result.subjects.map((subject) => subject.id));
      setNotice(`Your profile is set to ${gradeChoice}. Choose your subjects below.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Your grade could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function submitRegistration() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await apiRequest("/api/curriculum/registration", {
        method: "POST",
        body: JSON.stringify({
          pathway: curriculum?.pathways.length ? pathwayId : null,
          subjectIds: selectedSubjectIds,
        }),
      });
      await onComplete();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Your subject registration could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="subject-registration-page">
      <header className="subject-registration-header">
        <Brand />
        <span className="section-kicker">YOUR LEARNING JOURNEY</span>
        <h1>{curriculum?.grade
          ? `Register Your ${curriculum.grade} ${gradeNumber <= 3 ? "Learning Areas" : "Subjects"}`
          : "Subject registration"}</h1>
        <p>{curriculum?.grade ? `${curriculum.grade} Student · Choose the subjects you will study.` : "Select your grade first so we can show the right curriculum."}</p>
      </header>

      <section className="subject-registration-panel">
        {(!curriculum || curriculum.needsGrade) ? (
          <div className="subject-registration-grade">
            <span className="learning-page-icon"><GraduationCap size={19} /></span>
            <div>
              <h2>We need to know your grade</h2>
              <p>We need to know your grade before we can register your subjects.</p>
            </div>
            <label className="form-label">Select your grade
              <select value={gradeChoice} onChange={(event) => setGradeChoice(event.target.value)}>
                <option value="">Choose your grade</option>
                {gradeOptions.map((grade) => <option key={grade}>{grade}</option>)}
              </select>
            </label>
            <button className="primary-button" type="button" disabled={busy || !gradeChoice} onClick={() => void saveGrade()}>
              {busy ? "Saving…" : "Continue"} <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <>
            {curriculum.pathways.length > 0 ? (
              <>
                <div className="curriculum-panel-heading">
                  <span className="learning-page-icon"><GraduationCap size={19} /></span>
                  <div><span className="section-kicker">{curriculum.grade} · SENIOR SCHOOL</span><h2>Compulsory learning areas</h2></div>
                </div>
                <p className="curriculum-intro">These learning areas are included automatically for every Senior School learner.</p>
                <div className="registration-subject-grid">
                  {curriculum.compulsory.map((subject) => (
                    <article className="registration-subject registration-subject-locked" key={subject.id}>
                      <span className="registration-check"><Check size={15} /></span>
                      <span><strong>{subject.name}</strong><small>{subject.topic}</small></span>
                    </article>
                  ))}
                </div>
                <div className="curriculum-panel-heading registration-path-heading">
                  <span className="learning-page-icon"><GraduationCap size={19} /></span>
                  <div><span className="section-kicker">CHOOSE ONE PATHWAY</span><h2>Your pathway</h2></div>
                </div>
                <div className="registration-pathways" role="radiogroup" aria-label="Senior School pathway">
                  {curriculum.pathways.map((pathway) => (
                    <button
                      aria-checked={pathway.id === pathwayId}
                      className={`registration-pathway ${pathway.id === pathwayId ? "registration-pathway-active" : ""}`}
                      key={pathway.id}
                      onClick={() => choosePathway(pathway.id)}
                      role="radio"
                      type="button"
                    >
                      <strong>{pathway.shortName}</strong><span>{pathway.name}</span>
                    </button>
                  ))}
                </div>
                <div className="curriculum-panel-heading registration-path-heading">
                  <span className="learning-page-icon"><GraduationCap size={19} /></span>
                  <div><span className="section-kicker">{selectedPathway?.shortName ?? "PATHWAY"} SUBJECTS</span><h2>Choose your subjects</h2></div>
                </div>
                <p className="curriculum-intro">{selectedPathway?.description} Select the subjects offered by your school. Confirm the approved combination with your school.</p>
              </>
            ) : (
              <>
                <div className="curriculum-panel-heading">
                  <span className="learning-page-icon"><GraduationCap size={19} /></span>
                  <div><span className="section-kicker">{curriculum.grade} STUDENT</span><h2>{gradeNumber <= 3 ? `Your ${curriculum.grade} learning areas` : `${curriculum.grade} subject registration`}</h2></div>
                </div>
                <p className="curriculum-intro">{gradeNumber <= 3
                  ? "Choose the learning areas for your grade. Lessons for Grades 1–3 should use age-appropriate pictures, audio, songs and activities."
                  : "Choose from learning areas available for your grade."}</p>
              </>
            )}

            {subjectsToChoose.length ? (
              <div className="registration-subject-grid">
                {subjectsToChoose.map((subject) => (
                  <label className="registration-subject" key={subject.id}>
                    <input type="checkbox" checked={selectedSubjectIds.includes(subject.id)} onChange={() => toggleSubject(subject.id)} />
                    <span><strong>{subject.name}</strong><small>{subject.topic}</small></span>
                  </label>
                ))}
              </div>
            ) : <p className="curriculum-intro" role="status">No pathway subjects are currently configured for this grade. Please contact your school administrator.</p>}
            <aside className="curriculum-note"><GraduationCap size={16} /><span>Subject availability and approved combinations can vary by school. Confirm current options against the <a href="https://kicd.ac.ke/cbc-materials/curriculum-designs/" target="_blank" rel="noreferrer">KICD curriculum designs</a> and your school offering.</span></aside>
          </>
        )}
        {error && <div className="auth-error" role="alert">{error}</div>}
        {notice && <div className="auth-notice" role="status">{notice}</div>}
        {curriculum && !curriculum.needsGrade && <button
          className="primary-button registration-save-button"
          type="button"
          disabled={busy || !selectedSubjectIds.length || subjectsToChoose.length === 0}
          onClick={() => void submitRegistration()}
        >
          {busy ? "Saving registration…" : curriculum.complete ? "Update my subject registration" : "Save subject registration"} <ArrowRight size={14} />
        </button>}
      </section>
    </section>
  );
}
