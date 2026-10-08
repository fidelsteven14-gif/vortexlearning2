import "dotenv/config";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { createId, db } from "../server/database.js";

const name = process.env.ADMIN_NAME?.trim();
const username = process.env.ADMIN_USERNAME?.trim();
const parsedEmail = z.string().trim().email().max(254).safeParse(process.env.ADMIN_EMAIL ?? "");
const email = parsedEmail.success ? parsedEmail.data.toLowerCase() : undefined;
const password = process.env.ADMIN_PASSWORD;

if (!name || !username || !email || !password || password.length < 6 || password.length > 72) {
  throw new Error("Set ADMIN_NAME, ADMIN_USERNAME, ADMIN_EMAIL, and ADMIN_PASSWORD (6–72 characters) before creating a platform owner account.");
}

const passwordHash = await bcrypt.hash(password, 12);
const existing = db.prepare(
  "SELECT id FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1",
).get(username, email) as { id: string } | undefined;
if (existing) {
  db.prepare("UPDATE users SET name = ?, password_hash = ?, email = ?, email_verified = 1, role = 'admin', active = 1 WHERE id = ?")
    .run(name, passwordHash, email, existing.id);
  console.log(`Platform-owner account "${username}" updated. Sign in using the standard learner login page.`);
} else {
  db.prepare("INSERT INTO users (id, name, username, password_hash, email, email_verified, role) VALUES (?, ?, ?, ?, ?, 1, 'admin')")
    .run(createId(), name, username, passwordHash, email);
  console.log(`Platform-owner account "${username}" created. Sign in using the standard learner login page.`);
}
