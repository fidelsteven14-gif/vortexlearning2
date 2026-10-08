import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = resolve(process.env.DATABASE_PATH ?? "data/vortex-learning.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

export function runInTransaction<T>(operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    auth_version INTEGER NOT NULL DEFAULT 0,
    user_code TEXT,
    role TEXT NOT NULL CHECK (role IN ('student', 'admin')),
    grade TEXT,
    curriculum_registered INTEGER NOT NULL DEFAULT 0,
    pathway TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL DEFAULT 'lesson' CHECK (content_type IN ('lesson', 'note')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_lesson_completions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (user_id, lesson_id)
  );

  CREATE TABLE IF NOT EXISTS learning_resources (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL,
    term TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('revision-paper', 'study-guide', 'syllabus', 'topic-summary', 'reference-document')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    original_filename TEXT,
    storage_key TEXT,
    size_bytes INTEGER,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invitations (
    code_hash TEXT PRIMARY KEY,
    grade TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_verifications (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    topic TEXT NOT NULL,
    icon TEXT NOT NULL,
    color TEXT NOT NULL,
    grade TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_subject_progress (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    completed_lessons INTEGER NOT NULL DEFAULT 0,
    total_lessons INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, subject_id)
  );

  CREATE TABLE IF NOT EXISTS student_subject_registrations (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, subject_id)
  );

  CREATE TABLE IF NOT EXISTS assessments (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    kind TEXT NOT NULL DEFAULT 'PRACTICE',
    duration_minutes INTEGER NOT NULL,
    opens_at TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    options_json TEXT NOT NULL,
    correct_option INTEGER NOT NULL,
    points INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assessment_id TEXT NOT NULL REFERENCES assessments(id),
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted', 'marked')),
    started_at TEXT NOT NULL,
    submitted_at TEXT,
    score INTEGER,
    total_points INTEGER NOT NULL,
    UNIQUE (user_id, assessment_id)
  );

  CREATE TABLE IF NOT EXISTS answers (
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    selected_option INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (attempt_id, question_id)
  );

  CREATE INDEX IF NOT EXISTS idx_assessments_opens ON assessments(published, opens_at);
  CREATE INDEX IF NOT EXISTS idx_attempts_user_status ON attempts(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);
  CREATE INDEX IF NOT EXISTS idx_lessons_subject_order ON lessons(subject_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_learning_resources_grade_status ON learning_resources(status, subject_id);
  CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs(created_at DESC);
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
const lessonColumns = db.prepare("PRAGMA table_info(lessons)").all() as Array<{ name: string }>;
if (!lessonColumns.some((column) => column.name === "content_type")) {
  db.exec("ALTER TABLE lessons ADD COLUMN content_type TEXT NOT NULL DEFAULT 'lesson'");
}
if (!userColumns.some((column) => column.name === "last_seen_at")) db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
if (!userColumns.some((column) => column.name === "email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
if (!userColumns.some((column) => column.name === "email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
if (!userColumns.some((column) => column.name === "auth_version")) db.exec("ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0");
if (!userColumns.some((column) => column.name === "user_code")) db.exec("ALTER TABLE users ADD COLUMN user_code TEXT");
if (!userColumns.some((column) => column.name === "curriculum_registered")) db.exec("ALTER TABLE users ADD COLUMN curriculum_registered INTEGER NOT NULL DEFAULT 0");
if (!userColumns.some((column) => column.name === "pathway")) db.exec("ALTER TABLE users ADD COLUMN pathway TEXT");
const legacyTeacherRows = db.prepare("SELECT id FROM users WHERE role = 'teacher'").all() as Array<{ id: string }>;
if (legacyTeacherRows.length > 0) {
  db.prepare("UPDATE users SET active = 0, role = 'student' WHERE role = 'teacher'").run();
}
const studentsWithoutCode = db.prepare("SELECT id FROM users WHERE role = 'student' AND user_code IS NULL").all() as Array<{ id: string }>;
const assignUserCode = db.prepare("UPDATE users SET user_code = ? WHERE id = ?");
for (const student of studentsWithoutCode) {
  let code = createStudentCode();
  while (db.prepare("SELECT 1 FROM users WHERE user_code = ?").get(code)) code = createStudentCode();
  assignUserCode.run(code, student.id);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_code_unique ON users(user_code) WHERE user_code IS NOT NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_users_activity ON users(role, active, last_seen_at)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email COLLATE NOCASE) WHERE email IS NOT NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, expires_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_email_verifications_expiry ON email_verifications(expires_at)");
db.prepare("UPDATE subjects SET color = 'teal' WHERE color = 'violet'").run();

export function createStudentCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const random = randomBytes(8);
  return `VX-${Array.from(random, (value) => alphabet[value % alphabet.length]).join("")}`;
}

export function hashInvitation(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function createInvitationCode(): string {
  return randomBytes(6).toString("hex").toUpperCase();
}

export function createId(): string {
  return randomUUID();
}

export function seedCurriculum(): void {
  const gradeSubjectMap: Record<string, Array<[string, string, string, string, string]>> = {
    "Grade 1": [
      ["english", "English Language Activities", "Listening, speaking, reading and writing", "Aa", "navy"],
      ["kiswahili", "Kiswahili Language Activities", "Listening and speaking in Kiswahili", "Kw", "teal"],
      ["mathematics", "Mathematics Activities", "Numbers and basic operations", "∑", "gold"],
      ["environment", "Environmental Activities", "Nature, health and safety", "✳", "green"],
      ["creative", "Creative Activities", "Drawing, music and movement", "✦", "navy"],
      ["religious", "Religious Education Activities", "Faith, values and morality", "☼", "teal"],
      ["indigenous", "Indigenous Languages", "Local language and cultural identity", "語", "gold"],
    ],
    "Grade 2": [
      ["english", "English Language Activities", "Reading fluency and sentence building", "Aa", "navy"],
      ["kiswahili", "Kiswahili Language Activities", "Vocabulary and communication", "Kw", "teal"],
      ["mathematics", "Mathematics Activities", "Addition, subtraction and patterns", "∑", "gold"],
      ["environment", "Environmental Activities", "People, plants and weather", "✳", "green"],
      ["creative", "Creative Activities", "Art and imagination", "✦", "navy"],
      ["religious", "Religious Education Activities", "Values and respectful living", "☼", "teal"],
      ["indigenous", "Indigenous Languages", "Local language and culture", "語", "gold"],
    ],
    "Grade 3": [
      ["english", "English Language Activities", "Comprehension and storytelling", "Aa", "navy"],
      ["kiswahili", "Kiswahili Language Activities", "Listening, writing and confidence", "Kw", "teal"],
      ["mathematics", "Mathematics Activities", "Place value and problem solving", "∑", "gold"],
      ["environment", "Environmental Activities", "Our environment and everyday life", "✳", "green"],
      ["creative", "Creative Activities", "Art, music and physical play", "✦", "navy"],
      ["religious", "Religious Education Activities", "Good conduct and character", "☼", "teal"],
      ["indigenous", "Indigenous Languages", "Culture, stories and identity", "語", "gold"],
    ],
    "Grade 4": [
      ["english", "English", "Reading, writing and grammar", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Communication and grammar", "Kw", "teal"],
      ["mathematics", "Mathematics", "Operations and problem solving", "∑", "gold"],
      ["science", "Science and Technology", "Scientific thinking and innovation", "✳", "green"],
      ["social", "Social Studies", "People, communities and citizenship", "◌", "navy"],
      ["agriculture", "Agriculture", "Crops, plants and food production", "❋", "green"],
      ["home-science", "Home Science", "Family, hygiene and life skills", "⌂", "gold"],
      ["creative-arts", "Creative Arts", "Arts, craft and expression", "✦", "navy"],
      ["religious", "Religious Education", "Values and faith practice", "☼", "teal"],
    ],
    "Grade 5": [
      ["english", "English", "Reading and writing for meaning", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Vocabulary, listening and speaking", "Kw", "teal"],
      ["mathematics", "Mathematics", "Number fluency and reasoning", "∑", "gold"],
      ["science", "Science and Technology", "Investigations and technology", "✳", "green"],
      ["social", "Social Studies", "Governance and geography", "◌", "navy"],
      ["agriculture", "Agriculture", "Soil, crops and animal care", "❋", "green"],
      ["home-science", "Home Science", "Nutrition and household skills", "⌂", "gold"],
      ["creative-arts", "Creative Arts", "Music, drawing and performance", "✦", "navy"],
      ["religious", "Religious Education", "Values and community responsibility", "☼", "teal"],
    ],
    "Grade 6": [
      ["english", "English", "Language, comprehension and composition", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Language use and communication", "Kw", "teal"],
      ["mathematics", "Mathematics", "Fractions, decimals and data", "∑", "gold"],
      ["science", "Science and Technology", "Systems, energy and innovation", "✳", "green"],
      ["social", "Social Studies", "History, citizenship and environment", "◌", "navy"],
      ["agriculture", "Agriculture", "Food systems and crop production", "❋", "green"],
      ["home-science", "Home Science", "Nutrition and home management", "⌂", "gold"],
      ["creative-arts", "Creative Arts", "Art, music and sports", "✦", "navy"],
      ["religious", "Religious Education", "Spiritual values and ethics", "☼", "teal"],
    ],
    "Grade 7": [
      ["english", "English", "Reading and language analysis", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Oral, written and grammatical skills", "Kw", "teal"],
      ["mathematics", "Mathematics", "Algebra, geometry and measures", "∑", "gold"],
      ["integrated-science", "Integrated Science", "Life, physical and earth science", "✳", "green"],
      ["social-studies", "Social Studies", "Citizenship, history and geography", "◌", "navy"],
      ["agriculture-nutrition", "Agriculture and Nutrition", "Production and healthy living", "❋", "green"],
      ["pre-technical", "Pre-Technical Studies", "Design, technology and safety", "⚙", "gold"],
      ["creative-arts-sports", "Creative Arts and Sports", "Expression and physical wellness", "✦", "navy"],
      ["religious", "Religious Education", "Values, ethics and community life", "☼", "teal"],
    ],
    "Grade 8": [
      ["english", "English", "Literature, grammar and communication", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Language fluency and composition", "Kw", "teal"],
      ["mathematics", "Mathematics", "Numbers, equations and geometry", "∑", "gold"],
      ["integrated-science", "Integrated Science", "Scientific inquiry and applications", "✳", "green"],
      ["social-studies", "Social Studies", "Societies and governance", "◌", "navy"],
      ["agriculture-nutrition", "Agriculture and Nutrition", "Food security and healthy habits", "❋", "green"],
      ["pre-technical", "Pre-Technical Studies", "Materials and making", "⚙", "gold"],
      ["creative-arts-sports", "Creative Arts and Sports", "Creativity, sport and teamwork", "✦", "navy"],
      ["religious", "Religious Education", "Ethics and cultural understanding", "☼", "teal"],
    ],
    "Grade 9": [
      ["english", "English", "Advanced language and literature", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Language complexity and expression", "Kw", "teal"],
      ["mathematics", "Mathematics", "Algebra, probability and geometry", "∑", "gold"],
      ["integrated-science", "Integrated Science", "Research and problem solving", "✳", "green"],
      ["social-studies", "Social Studies", "Citizenship and national identity", "◌", "navy"],
      ["agriculture-nutrition", "Agriculture and Nutrition", "Sustainability and health", "❋", "green"],
      ["pre-technical", "Pre-Technical Studies", "Practical problem solving", "⚙", "gold"],
      ["creative-arts-sports", "Creative Arts and Sports", "Performance and wellbeing", "✦", "navy"],
      ["religious", "Religious Education", "Ethics, service and belief", "☼", "teal"],
    ],
    "Grade 10": [
      ["english", "English", "Communication and literary analysis", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Language and expression", "Kw", "teal"],
      ["mathematics", "Mathematics", "Core quantitative reasoning", "∑", "gold"],
      ["biology", "Biology", "Cell and organism systems", "Bio", "green"],
      ["chemistry", "Chemistry", "Matter and reactions", "Ch", "teal"],
      ["physics", "Physics", "Energy and motion", "Phy", "navy"],
      ["computer-studies", "Computer Studies", "Digital literacy and computing", "💻", "gold"],
      ["agriculture", "Agriculture", "Production and agribusiness", "❋", "green"],
      ["geography", "Geography", "Earth and environmental systems", "Geo", "navy"],
      ["history-citizenship", "History and Citizenship", "Kenya, society and governance", "Hist", "teal"],
      ["business-studies", "Business Studies", "Entrepreneurship and commerce", "Biz", "gold"],
      ["economics", "Economics", "Resources and decision making", "Eco", "green"],
      ["music", "Music and Dance", "Performance and cultural arts", "♫", "navy"],
      ["visual-arts", "Visual Arts", "Art, design and creativity", "✦", "gold"],
      ["physical-education", "Physical Education and Sports", "Wellbeing and sportsmanship", "⚽", "teal"],
      ["religious", "Religious Education", "Faith, values and service", "☼", "navy"],
      ["community-service", "Community Service Learning", "Service and civic engagement", "◎", "green"],
      ["ict-skills", "ICT Skills", "Digital literacy, communication and responsible technology use", "ICT", "teal"],
    ],
    "Grade 11": [
      ["english", "English", "Advanced writing and analysis", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Language mastery and literature", "Kw", "teal"],
      ["mathematics", "Mathematics", "Functions, sequences and applications", "∑", "gold"],
      ["biology", "Biology", "Human systems and life science", "Bio", "green"],
      ["chemistry", "Chemistry", "Organic and inorganic chemistry", "Ch", "teal"],
      ["physics", "Physics", "Mechanics, electricity and waves", "Phy", "navy"],
      ["computer-studies", "Computer Studies", "Programming and systems", "💻", "gold"],
      ["agriculture", "Agriculture", "Crop science and agribusiness", "❋", "green"],
      ["geography", "Geography", "Humans and the environment", "Geo", "navy"],
      ["history-citizenship", "History and Citizenship", "Governance and society", "Hist", "teal"],
      ["business-studies", "Business Studies", "Finance and enterprise", "Biz", "gold"],
      ["economics", "Economics", "Economic systems and development", "Eco", "green"],
      ["music", "Music and Dance", "Performance and expression", "♫", "navy"],
      ["theatre", "Theatre and Film", "Drama, media and storytelling", "🎭", "gold"],
      ["visual-arts", "Visual Arts", "Creative production", "✦", "navy"],
      ["physical-education", "Physical Education and Sports", "Fitness and team sport", "⚽", "teal"],
      ["religious", "Religious Education", "Ethics and social responsibility", "☼", "navy"],
      ["community-service", "Community Service Learning", "Service and community action", "◎", "green"],
      ["ict-skills", "ICT Skills", "Digital systems, information and responsible technology use", "ICT", "teal"],
    ],
    "Grade 12": [
      ["english", "English", "Critical reading and writing", "Aa", "navy"],
      ["kiswahili", "Kiswahili", "Advanced literature and language", "Kw", "teal"],
      ["mathematics", "Mathematics", "Applications and analytical reasoning", "∑", "gold"],
      ["biology", "Biology", "Genetics and ecosystems", "Bio", "green"],
      ["chemistry", "Chemistry", "Chemical systems and analysis", "Ch", "teal"],
      ["physics", "Physics", "Modern physics and applications", "Phy", "navy"],
      ["computer-studies", "Computer Studies", "Systems design and digital problem solving", "💻", "gold"],
      ["agriculture", "Agriculture", "Agribusiness and sustainability", "❋", "green"],
      ["geography", "Geography", "Resource use and development", "Geo", "navy"],
      ["history-citizenship", "History and Citizenship", "Law, identity and citizenship", "Hist", "teal"],
      ["business-studies", "Business Studies", "Enterprise and management", "Biz", "gold"],
      ["economics", "Economics", "Markets, policy and growth", "Eco", "green"],
      ["music", "Music and Dance", "Performance and cultural practice", "♫", "navy"],
      ["theatre", "Theatre and Film", "Production and storytelling", "🎭", "gold"],
      ["visual-arts", "Visual Arts", "Portfolio and design practice", "✦", "navy"],
      ["physical-education", "Physical Education and Sports", "Performance and leadership", "⚽", "teal"],
      ["religious", "Religious Education", "Leadership and values", "☼", "navy"],
      ["community-service", "Community Service Learning", "Public service and reflection", "◎", "green"],
      ["ict-skills", "ICT Skills", "Digital systems, information and responsible technology use", "ICT", "teal"],
    ],
  };

  const subjectRows = Object.entries(gradeSubjectMap).flatMap(([grade, subjects]) =>
    subjects.map(([id, name, topic, icon, color], index) => [
      `${grade.toLowerCase().replace(/\s+/g, "-")}-${id}`,
      name,
      topic,
      icon,
      color,
      grade,
      index + 1,
    ] as const),
  );
  const insertSubject = db.prepare(
    "INSERT OR IGNORE INTO subjects (id, name, topic, icon, color, grade, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertAssessment = db.prepare(
    "INSERT OR IGNORE INTO assessments (id, title, subject_id, kind, duration_minutes, opens_at, published, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
  );
  const insertQuestion = db.prepare(
    "INSERT OR IGNORE INTO questions (id, assessment_id, prompt, options_json, correct_option, points, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertLesson = db.prepare(
    "INSERT OR IGNORE INTO lessons (id, subject_id, title, summary, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const inFiveDays = new Date(Date.now() + 5 * 86_400_000).toISOString();

  const seed = () => runInTransaction(() => {
    for (const row of subjectRows) insertSubject.run(...row);

    const lessonRows = [
      ["maths-fractions", "grade-6-mathematics", "Understanding fractions", "See how equal parts make a whole.", "A fraction names equal parts of a whole. The top number counts the parts you have; the bottom number counts the equal parts in the whole. For example, 3/4 means three of four equal parts.", 1],
      ["maths-equivalent", "grade-6-mathematics", "Equivalent fractions", "Different fractions can show the same amount.", "Equivalent fractions have the same value. Multiply or divide both the numerator and denominator by the same number. For example, 1/2 and 2/4 describe the same amount.", 2],
      ["maths-decimals", "grade-6-mathematics", "Fractions as decimals", "Connect tenths and hundredths to decimal notation.", "A decimal point separates whole numbers from parts of a whole. One tenth is 0.1 and one hundredth is 0.01. You can use place value to compare decimal numbers.", 3],
      ["science-habitats", "grade-6-science", "Habitats and living things", "Explore how habitats support organisms.", "A habitat is the place where an organism lives. It provides resources such as food, water, shelter, and space. Different organisms are suited to different habitats.", 1],
      ["science-food-chains", "grade-6-science", "Food chains", "Follow how energy moves between living things.", "A food chain shows how energy passes from one organism to another. Green plants make their own food, herbivores eat plants, and predators may eat other animals.", 2],
      ["science-care", "grade-6-science", "Caring for our environment", "Identify practical ways to protect habitats.", "People can care for habitats by reducing litter, using resources responsibly, planting suitable native plants, and protecting places where living things feed and reproduce.", 3],
      ["english-description", "grade-6-english", "Writing a description", "Use specific words to help a reader imagine a place.", "A clear description uses details gathered through the senses. Choose precise nouns and verbs, then add a few details about colour, sound, texture, or movement.", 1],
      ["english-story", "grade-6-english", "Planning a short story", "Give a story a beginning, a problem, and a resolution.", "Before writing, decide who the story is about, where it happens, and what challenge the character faces. A simple plan helps events follow a clear order.", 2],
      ["english-edit", "grade-6-english", "Reviewing your writing", "Make a draft clearer with a careful review.", "Read your work slowly. Check that each sentence is complete, ideas follow a sensible order, punctuation helps the reader, and spelling is checked for familiar words.", 3],
    ] as const;
    for (const lesson of lessonRows) insertLesson.run(...lesson);

    const ownerId = "system-curriculum";
    db.prepare(
      "INSERT OR IGNORE INTO users (id, name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 'admin', 0)",
    ).run(ownerId, "System Curriculum", "system-curriculum", "disabled");

    const assessments = [
      { id: "maths-practice", title: "Mathematics practice", subject: "grade-6-mathematics", kind: "PRACTICE", date: inTwoDays, prompts: [["What is 1/2 + 1/4?", ["1/6", "3/4", "2/6", "1"], 1], ["Which decimal is equal to 3/4?", ["0.25", "0.5", "0.75", "1.25"], 2]] },
      { id: "science-check", title: "Science quick check", subject: "grade-6-science", kind: "QUIZ", date: inFiveDays, prompts: [["Which part of a plant absorbs water?", ["Flower", "Leaf", "Root", "Fruit"], 2]] },
    ] as const;

    for (const assessment of assessments) {
      insertAssessment.run(assessment.id, assessment.title, assessment.subject, assessment.kind, 20, assessment.date, ownerId);
      assessment.prompts.forEach(([prompt, options, correct], index) => {
        insertQuestion.run(
          `${assessment.id}-q${index + 1}`,
          assessment.id,
          prompt,
          JSON.stringify(options),
          correct,
          1,
          index + 1,
        );
      });
    }
  });
  seed();
}

seedCurriculum();
