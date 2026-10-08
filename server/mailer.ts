import nodemailer from "nodemailer";
import { resolve } from "node:path";

const mailHost = process.env.MAIL_HOST ?? "smtp.gmail.com";
const mailPort = Number(process.env.MAIL_PORT ?? 587);
const mailUser = process.env.MAIL_USER ?? "vortexlearning0@gmail.com";
const mailPassword = process.env.MAIL_PASSWORD?.replace(/\s/g, "");
const mailFrom = process.env.MAIL_FROM ?? "vortexlearning0@gmail.com";
const supportEmail = process.env.SUPPORT_EMAIL ?? "vortexlearning0@gmail.com";
const appUrl = (process.env.APP_URL ?? "http://127.0.0.1:4173").replace(/\/+$/, "");
const logoPath = resolve(process.cwd(), "public/vortex-learning-mark.png");
const logoCid = "vortex-learning-mark@vortexlearning";

export const supportAddress = supportEmail;
export const emailDeliveryConfigured = Boolean(mailHost && mailPort && mailUser && mailPassword && mailFrom);

function createTransporter() {
  if (!mailPassword) {
    throw new Error("Email delivery is not configured. Add the mailbox app password to the server-side MAIL_PASSWORD environment variable.");
  }

  return nodemailer.createTransport({
    host: mailHost,
    port: mailPort,
    secure: mailPort === 465,
    auth: { user: mailUser, pass: mailPassword },
  });
}

function emailFrame(title: string, content: string): string {
  return `<!doctype html><html lang="en"><body style="margin:0;padding:28px 12px;background:#F8FAFC;color:#1E293B;font-family:Arial,Helvetica,sans-serif">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:580px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px">
      <tr><td style="padding:30px 32px 8px;text-align:center"><img src="cid:${logoCid}" width="176" alt="VORTEX LEARNING" style="display:block;width:176px;max-width:100%;height:auto;margin:0 auto"></td></tr>
      <tr><td style="padding:20px 32px 28px"><h1 style="margin:0 0 18px;color:#172554;font-size:25px;line-height:1.25">${title}</h1>${content}</td></tr>
      <tr><td style="border-top:1px solid #E2E8F0;padding:18px 32px 24px;text-align:center;color:#64748B;font-size:12px;line-height:1.7"><strong style="color:#172554">VORTEX LEARNING Support</strong><br>Learn. Grow. Achieve.<br><a href="mailto:${supportEmail}" style="color:#0F766E;text-decoration:underline">${supportEmail}</a></td></tr>
    </table>
  </body></html>`;
}

function brandLogoAttachment() {
  return { filename: "vortex-learning-mark.png", path: logoPath, cid: logoCid };
}

export async function sendVerificationEmail(email: string, code: string): Promise<void> {
  const verifyUrl = `${appUrl}/?verifyEmail=${encodeURIComponent(email)}`;
  const content = `<p style="margin:0 0 14px;color:#172554;font-size:16px;font-weight:700">Welcome to VORTEX LEARNING!</p>
    <p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:1.7">Thank you for creating your account. To complete your registration and secure your account, please enter the verification code below on the VORTEX LEARNING website.</p>
    <div style="margin:22px 0;padding:18px 12px;border:1px solid #BFDBFE;border-radius:10px;background:#EFF6FF;text-align:center">
      <span style="display:block;color:#0F766E;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase">Your 5-digit verification code</span>
      <strong style="display:block;margin-top:8px;color:#2563EB;font-size:36px;font-weight:800;letter-spacing:10px;line-height:1.2">${code}</strong>
    </div>
    <p style="margin:0 0 20px;color:#475569;font-size:14px;line-height:1.6">This code expires in 10 minutes and can only be used once.</p>
    <p style="margin:0 0 22px;text-align:center"><a href="${verifyUrl}" style="display:inline-block;padding:13px 24px;border-radius:7px;background:#0F766E;color:#FFFFFF;font-size:15px;font-weight:700;text-decoration:none">Verify My Email</a></p>
    <p style="margin:0;color:#64748B;font-size:13px;line-height:1.7">If you did not create a VORTEX LEARNING account, you can safely ignore this email.</p>`;
  await createTransporter().sendMail({
    from: { name: "VORTEX LEARNING", address: mailFrom },
    to: email,
    replyTo: supportEmail,
    subject: "Verify your VORTEX LEARNING email",
    text: `Welcome to VORTEX LEARNING!\n\nThank you for creating your account. Enter this 5-digit verification code on the VORTEX LEARNING website: ${code}\n\nThe code expires in 10 minutes and can only be used once.\n\nOpen the verification page: ${verifyUrl}\n\nIf you did not create a VORTEX LEARNING account, you can safely ignore this email.\n\nVORTEX LEARNING Support\nLearn. Grow. Achieve.\n${supportEmail}`,
    html: emailFrame("Verify your email address", content),
    attachments: [brandLogoAttachment()],
  });
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const content = `<p style="margin:0 0 14px;color:#475569;font-size:15px;line-height:1.7">We received a request to reset the password for your VORTEX LEARNING account.</p>
    <p style="margin:0 0 22px;color:#475569;font-size:15px;line-height:1.7">If you made this request, click the button below to create a new password.</p>
    <p style="margin:0 0 22px;text-align:center"><a href="${resetUrl}" style="display:inline-block;padding:13px 24px;border-radius:7px;background:#0F766E;color:#FFFFFF;font-size:15px;font-weight:700;text-decoration:none">Reset My Password</a></p>
    <p style="margin:0 0 14px;color:#475569;font-size:14px;line-height:1.7">This password-reset link expires after 30 minutes and can only be used once.</p>
    <div style="margin-top:20px;padding:14px 16px;border-left:4px solid #F59E0B;border-radius:4px;background:#FFFBEB;color:#713F12;font-size:13px;line-height:1.7">If you did not request a password reset, you don't need to take any action. Your password will remain unchanged. For your security, never share your password or password-reset link with anyone.</div>`;
  await createTransporter().sendMail({
    from: { name: "VORTEX LEARNING", address: mailFrom },
    to: email,
    replyTo: supportEmail,
    subject: "Reset your VORTEX LEARNING password",
    text: `We received a request to reset the password for your VORTEX LEARNING account. If you made this request, use this link to create a new password: ${resetUrl}\n\nThis link expires after 30 minutes and can only be used once. If you did not request a password reset, no action is needed; your password will remain unchanged. For your security, never share your password or password-reset link with anyone.\n\nVORTEX LEARNING Support\nLearn. Grow. Achieve.\n${supportEmail}`,
    html: emailFrame("Reset your password", content),
    attachments: [brandLogoAttachment()],
  });
}

export async function sendPasswordChangedEmail(email: string): Promise<void> {
  const contactUrl = `mailto:${supportEmail}`;
  const content = `<div style="margin:0 0 18px;padding:12px 14px;border-radius:8px;background:#F0FDF4;color:#166534;font-size:14px;font-weight:700"><span style="display:inline-block;margin-right:7px;color:#16A34A">●</span>Password changed successfully</div>
    <p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:1.7">Your VORTEX LEARNING password was successfully changed.</p>
    <p style="margin:0 0 20px;color:#475569;font-size:14px;line-height:1.7">If you made this change, no further action is required.</p>
    <div style="margin:0 0 20px;padding:14px 16px;border-left:4px solid #DC2626;border-radius:4px;background:#FEF2F2;color:#7F1D1D;font-size:13px;line-height:1.7">If you did not make this change, contact VORTEX LEARNING Support immediately to secure your account.</div>
    <p style="margin:0;text-align:center"><a href="${contactUrl}" style="display:inline-block;padding:12px 22px;border-radius:7px;background:#0F766E;color:#FFFFFF;font-size:14px;font-weight:700;text-decoration:none">Contact Support</a></p>`;
  await createTransporter().sendMail({
    from: { name: "VORTEX LEARNING", address: mailFrom },
    to: email,
    replyTo: supportEmail,
    subject: "Your VORTEX LEARNING password was changed",
    text: `Password changed successfully.\n\nYour VORTEX LEARNING password was successfully changed. If you made this change, no further action is required.\n\nIf you did not make this change, contact VORTEX LEARNING Support immediately: ${supportEmail}\n\nLearn. Grow. Achieve.`,
    html: emailFrame("Password changed successfully", content),
    attachments: [brandLogoAttachment()],
  });
}
