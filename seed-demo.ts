import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { createId, db } from "../server/database.js";

const username = "amani";
const email = "amani@example.test";
const password = process.env.DEMO_PASSWORD ?? randomBytes(12).toString("base64url");
if (password.length < 6 || password.length > 72) {
  throw new Error("DEMO_PASSWORD must be between 6 and 72 characters.");
}

const existing = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username) as { id: string } | undefined;
const userId = existing?.id ?? "demo-student";
const passwordHash = await bcrypt.hash(password, 12);
if (existing && !process.env.DEMO_PASSWORD) {
  throw new Error("The demo learner already exists. Set DEMO_PASSWORD to reset its password.");
}
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, email = ?, email_verified = 1, active = 1 WHERE id = ?")
    .run(passwordHash, email, existing.id);
} else {
  db.prepare(`
    INSERT INTO users (id, name, username, password_hash, email, email_verified, role, grade, active)
    VALUES (?, 'Amani Otieno', ?, ?, ?, 1, 'student', 'Grade 6', 1)
  `).run(userId, username, passwordHash, email);
}
const student = { id: userId };

const completedLessonIds = ["maths-fractions", "science-habitats", "science-food-chains", "english-description", "english-story"];
const completeLesson = db.prepare(`
  INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id, lesson_id) DO NOTHING
`);
for (const lessonId of completedLessonIds) {
  completeLesson.run(student.id, lessonId, new Date().toISOString());
}

console.log("Demo learner account ready.");
console.log(`Email: ${email}`);
console.log(`Username (profile only): ${username}`);
console.log(`Password: ${password}`);
console.log("For local demonstration use only; change this password before any real deployment.");
