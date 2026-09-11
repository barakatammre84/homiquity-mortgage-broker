import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { COMPANY_CONFIG } from "../config/company";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || process.env.SENDGRID_API_KEY1;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@homiquity.com";
const FROM_NAME = process.env.FROM_NAME || "Homiquity Mortgage";

const isSendGridConfigured = !!SENDGRID_API_KEY;
const isSmtpConfigured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
const isProduction = process.env.NODE_ENV === "production";

let transporter: Transporter | null = null;

if (isSendGridConfigured) {
  console.log("[Email] SendGrid configured — sending via SendGrid API");
}

if (isSmtpConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  console.log(
    `[Email] SMTP configured: ${SMTP_HOST}:${SMTP_PORT}${isSendGridConfigured ? " (backup for SendGrid)" : ""}`,
  );
}

if (!isSendGridConfigured && !isSmtpConfigured) {
  if (isProduction) {
    // Deliberately console.error, not console.log. Until 2026-08-06 this was an
    // informational line and the console fallback below returned `true`, so an
    // unprovisioned production host looked identical to a healthy one: password
    // resets, verification links, waitlist invites and application notifications
    // were all constructed, dropped, and reported as sent. That was harmless
    // while the site was gated; opening the funnel to the public made it a
    // silent data-loss path with no caller and no log able to detect it.
    console.error(
      "[Email] NO EMAIL PROVIDER CONFIGURED — outbound email is DISABLED in production. " +
        "Password resets, email verification, waitlist invites and application notifications " +
        "will NOT be delivered. Set SENDGRID_API_KEY (or SMTP_HOST/SMTP_USER/SMTP_PASS) on the host. " +
        "Probe from outside with GET /api/health → email.configured.",
    );
  } else {
    console.log("[Email] No email provider configured — emails will be logged to console");
  }
}

/**
 * Which providers this process can actually send through, for `GET /api/health`.
 *
 * Booleans and provider names only — never key material, and never the
 * from-address. The health response body is on `RESPONSE_BODY_LOG_ALLOWLIST`
 * in server/app.ts, so everything returned here is written to the request log
 * on every probe; it has to stay safe to log and safe to serve unauthenticated.
 */
export function emailProviderStatus(): { configured: boolean; providers: string[] } {
  const providers: string[] = [];
  if (isSendGridConfigured) providers.push("sendgrid");
  if (isSmtpConfigured) providers.push("smtp");
  return { configured: providers.length > 0, providers };
}

/**
 * `a****z@example.com` — enough to correlate a dropped send with a support
 * report, not enough to make the production log a borrower-contact dump. The
 * dev-only console fallback prints the address in full; production never does.
 */
function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "[redacted]";
  const local = address.slice(0, at);
  const domain = address.slice(at);
  if (local.length <= 2) return `${local[0]}*${domain}`;
  return `${local[0]}${"*".repeat(local.length - 2)}${local[local.length - 1]}${domain}`;
}

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

async function sendViaSendGrid(options: EmailOptions, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: options.to }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: options.subject,
        // SendGrid requires content ordered plain-text first, then HTML.
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: options.html },
        ],
      }),
    });

    if (res.ok) {
      console.log(`[Email] Sent to ${options.to}: ${options.subject}`);
      return true;
    }

    const body = await res.text();
    console.error(`[Email] SendGrid failed (${res.status}) for ${options.to}: ${body}`);
    return false;
  } catch (error) {
    console.error(`[Email] SendGrid error for ${options.to}:`, error);
    return false;
  }
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  const text = options.text || stripHtml(options.html);

  // Primary provider: SendGrid.
  if (isSendGridConfigured) {
    const sent = await sendViaSendGrid(options, text);
    if (sent) return true;
    if (isSmtpConfigured && transporter) {
      console.warn(`[Email] SendGrid send failed for ${options.to} — falling back to SMTP`);
    } else {
      return false;
    }
  }

  const message = {
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text,
  };

  // Backup provider: SMTP.
  if (isSmtpConfigured && transporter) {
    try {
      await transporter.sendMail(message);
      console.log(`[Email] Sent to ${message.to}: ${message.subject}`);
      return true;
    } catch (error) {
      console.error(`[Email] Failed to send to ${message.to}:`, error);
      return false;
    }
  }

  // No provider configured. In development that's the expected state and the
  // console IS the mailbox, so report success. In production nothing was sent
  // and nothing will retry — returning `true` there is the lie that kept this
  // invisible, so tell the caller the truth and leave a loud, greppable line.
  // The body is never logged in production (it carries borrower names, amounts
  // and single-use reset tokens); the address is masked for the same reason.
  if (isProduction) {
    console.error(
      `[Email] DISCARDED — no provider configured. to=${maskEmail(message.to)} subject="${message.subject}"`,
    );
    return false;
  }

  console.log(`[Email][DEV] To: ${message.to}`);
  console.log(`[Email][DEV] Subject: ${message.subject}`);
  console.log(`[Email][DEV] Body preview: ${(message.text || "").substring(0, 200)}...`);
  return true;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function baseTemplate(content: string, preheader?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Homiquity Mortgage</title>
  ${preheader ? `<span style="display:none;max-height:0;overflow:hidden">${preheader}</span>` : ""}
</head>
<body style="margin:0;padding:0;background-color:#f5f7fa;font-family:'Inter',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f7fa;padding:32px 16px">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
          <tr>
            <td style="background:#0f1729;padding:24px 32px;border-radius:8px 8px 0 0">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px">Homiquity</h1>
              <p style="margin:4px 0 0;color:#94a3b8;font-size:13px">Clear Answers. Confident Approvals.</p>
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;padding:32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:20px 32px;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 8px 8px">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.5">
                This is an automated message from Homiquity Mortgage. Please do not reply directly to this email.
                <br>NMLS #${COMPANY_CONFIG.nmlsId} | Equal Housing Lender
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function statusBadge(text: string, color: string): string {
  return `<span style="display:inline-block;padding:4px 12px;border-radius:4px;background:${color};color:#fff;font-size:13px;font-weight:600">${text}</span>`;
}

export const emailTemplates = {
  /**
   * Speed-to-lead acknowledgment (G-A). Compliance rails: NO rate/payment/APR
   * or cost figures (Reg Z trigger terms) and NO approval/eligibility language
   * (Reg B / Reg N) — this acknowledges an inquiry, nothing more. Enforced by
   * tests/leadNotifications.test.ts; keep copy changes inside those rails.
   */
  leadReceived(firstName?: string | null): EmailOptions {
    return {
      to: "",
      subject: "We received your inquiry — a loan officer will reach out shortly",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Thanks for reaching out</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${firstName || "there"},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          We received your inquiry. A licensed loan officer will contact you shortly
          to talk through your goals and answer your questions — there's nothing you
          need to prepare or send yet.
        </p>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          If you didn't make this request, you can ignore this email and no one will
          contact you again about it.
        </p>
      `, "We received your inquiry and will be in touch shortly"),
    };
  },

  // Sent ONLY when the automated initial review could not complete right away
  // (finalizeIntake threw and the recovery sweep will re-drive it). On the
  // normal path the borrower gets exactly ONE submission email — the decision
  // email from finalizeIntake, which also acknowledges receipt. Two emails
  // seconds apart raced through the provider and routinely arrived reversed.
  applicationSubmitted(borrowerName: string, applicationId: string): EmailOptions {
    return {
      to: "",
      subject: "Your Mortgage Application Has Been Received",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Application Received</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          We've received your mortgage application and it's in line for review. You'll receive an update with your result and next steps shortly.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:6px;padding:16px;margin:16px 0">
          <tr>
            <td style="padding:8px 16px">
              <p style="margin:0;color:#94a3b8;font-size:12px">APPLICATION ID</p>
              <p style="margin:4px 0 0;color:#0f1729;font-size:14px;font-weight:600">${applicationId.substring(0, 8).toUpperCase()}</p>
            </td>
            <td style="padding:8px 16px" align="right">
              ${statusBadge("Received", "#3b82f6")}
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          In the meantime, you can log into your dashboard to track your application status.
        </p>
      `, "Your mortgage application has been received"),
    };
  },

  applicationPreliminaryPlan(borrowerName: string, applicationId: string): EmailOptions {
    return {
      to: "",
      subject: "Your Preliminary Mortgage Plan Is Ready",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Your preliminary plan is ready</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">Hi ${borrowerName},</p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Your self-reported information supports a preliminary mortgage plan. This is a planning result, not a pre-approval. Upload the documents listed in your dashboard so your loan team can verify the figures and move your file forward.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:6px;padding:16px;margin:16px 0">
          <tr>
            <td style="padding:8px 16px">
              <p style="margin:0;color:#94a3b8;font-size:12px">APPLICATION ID</p>
              <p style="margin:4px 0 0;color:#0f1729;font-size:14px;font-weight:600">${applicationId.substring(0, 8).toUpperCase()}</p>
            </td>
            <td style="padding:8px 16px" align="right">
              ${statusBadge("Documents Needed", "#3b82f6")}
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          Open your dashboard for the exact checklist based on how you earn income and the properties you own.
        </p>
      `, "Your preliminary plan is ready. Upload the listed documents to verify your figures."),
    };
  },

  // The single submission email for a file the automated review routed to a
  // human underwriter: acknowledges receipt, says who looks at it next, and
  // points at the dashboard for the specific items. Deliberately names NO
  // review reasons — same rule as document rejections below: reasons never
  // travel over email, the account is where specifics live.
  applicationUnderReview(borrowerName: string, applicationId: string): EmailOptions {
    return {
      to: "",
      subject: "We Received Your Application — Here's What Happens Next",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Application Received</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Your application is in — and a licensed underwriter will personally review it. You don't need to wait to be asked, though: the fastest applications are the ones where documents arrive early.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:6px;padding:16px;margin:16px 0">
          <tr>
            <td style="padding:8px 16px">
              <p style="margin:0;color:#94a3b8;font-size:12px">APPLICATION ID</p>
              <p style="margin:4px 0 0;color:#0f1729;font-size:14px;font-weight:600">${applicationId.substring(0, 8).toUpperCase()}</p>
            </td>
            <td style="padding:8px 16px" align="right">
              ${statusBadge("Under Review", "#3b82f6")}
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0">
          What you can do right now:
        </p>
        <ol style="color:#475569;line-height:1.8;margin:0 0 16px;padding-left:20px">
          <li>Open your dashboard — it shows exactly what our initial review noted and the specific next step for your file</li>
          <li>Upload your recent pay stubs, W-2s, and bank statements — they give your underwriter what's needed to verify your numbers</li>
          <li>Watch for messages from your loan team and reply quickly to keep things moving</li>
        </ol>
        <p style="color:#94a3b8;line-height:1.5;margin:16px 0 0;font-size:12px">
          An application under review is not a credit decision. We'll notify you as soon as your status changes.
        </p>
      `, "We received your application — a licensed underwriter will review it. See your next steps."),
    };
  },

  applicationPreApproved(borrowerName: string, amount: string, applicationId: string): EmailOptions {
    return {
      to: "",
      subject: "Congratulations! You've Been Pre-Approved",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">You're Pre-Approved!</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Great news! Your mortgage application has been pre-approved.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin:16px 0">
          <tr>
            <td style="padding:20px" align="center">
              <p style="margin:0;color:#166534;font-size:13px;text-transform:uppercase;letter-spacing:1px">Pre-Approved Up To</p>
              <p style="margin:8px 0 0;color:#15803d;font-size:32px;font-weight:700">$${amount}</p>
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0">
          Your next steps:
        </p>
        <ol style="color:#475569;line-height:1.8;margin:0 0 16px;padding-left:20px">
          <li>Log into your dashboard to review your loan options</li>
          <li>Upload any required documents</li>
          <li>Download your pre-approval letter</li>
        </ol>
        <p style="color:#94a3b8;line-height:1.5;margin:16px 0 0;font-size:12px">
          This pre-approval is based on the information provided, is subject to the
          conditions listed in your pre-approval letter, and is not a commitment to lend.
        </p>
      `, `You've been pre-approved for up to $${amount}`),
    };
  },

  // Deliberately neutral: a denial is an adverse action under ECOA/Reg B
  // (§1002.9) and FCRA §615, and the compliant notice — specific reasons,
  // bureau contact information, dispute rights — is generated by
  // creditService and delivered inside the account. This email must never
  // state, soften, or characterize the credit decision itself.
  applicationDenied(borrowerName: string): EmailOptions {
    return {
      to: "",
      subject: "An Update on Your Application",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Application Update</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          There's an update on your mortgage application. Please log into your
          Homiquity account to review the details and any notices that require
          your attention.
        </p>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          If you have questions, use the secure Messages section of your account
          and we'll be glad to help.
        </p>
      `, "There's an update on your application"),
    };
  },

  // Secure-message notification: deliberately carries NO message content —
  // loan communications stay behind login (PII never travels over email).
  messageReceived(recipientName: string, senderName: string): EmailOptions {
    return {
      to: "",
      subject: `New message from ${senderName}`,
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">You have a new message</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${recipientName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          ${senderName} sent you a secure message about your mortgage. For your privacy,
          the message is only viewable inside your account.
        </p>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          Log into your Homiquity account and open <strong>Messages</strong> to read and reply.
        </p>
      `, `${senderName} sent you a secure message`),
    };
  },

  // Missing-document reminder (lifecycle sweep, roadmap A8). Factual list of
  // what's still outstanding + where to upload — no approval, eligibility, or
  // decision language (Reg N; the complianceInvariants suite greps this file).
  // Titles are engine literals today, but escape anyway: nothing enforces
  // that a future free-text condition (e.g. lender-transcribed) can't gain
  // requiredDocumentTypes and start flowing into this template.
  missingDocumentsReminder(borrowerName: string, items: string[]): EmailOptions {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const safeName = esc(borrowerName);
    const listRows = items
      .map(
        (item) =>
          `<p style="margin:0 0 8px;color:#0f1729;font-size:15px;font-weight:600">• ${esc(item)}</p>`,
      )
      .join("");
    return {
      to: "",
      subject: "Reminder: your mortgage application is waiting on documents",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">A few documents are still needed</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${safeName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Your application still has ${items.length > 1 ? "items" : "an item"} waiting on an upload:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin:16px 0">
          <tr>
            <td style="padding:16px">
              ${listRows}
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          Log into your Homiquity account and open <strong>Documents</strong> to upload
          ${items.length > 1 ? "them" : "it"} — that keeps your file moving with no extra steps.
        </p>
      `, "A few documents are still needed on your application"),
    };
  },

  documentRequested(borrowerName: string, documentName: string): EmailOptions {
    return {
      to: "",
      subject: `Document Needed: ${documentName}`,
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Document Request</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          To continue processing your mortgage application, we need the following document:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin:16px 0">
          <tr>
            <td style="padding:16px">
              <p style="margin:0;color:#0f1729;font-size:16px;font-weight:600">${documentName}</p>
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          Please log into your Homiquity account and upload this document at your earliest convenience.
        </p>
      `, `Please upload: ${documentName}`),
    };
  },

  // Document review notifications: deliberately content-free — the outcome
  // details and any rejection reason stay behind login (staff-typed reasons
  // can carry borrower PII, and nothing here may read as a loan decision —
  // Reg N). documentName is a document-TYPE label ("bank statement"), never
  // the uploaded file name.
  documentAccepted(borrowerName: string, documentName: string): EmailOptions {
    return {
      to: "",
      subject: "A document on your file has been reviewed",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Document reviewed</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Your ${documentName} has been reviewed and accepted for your file.
          No further action is needed on this document.
        </p>
        <p style="color:#94a3b8;line-height:1.5;margin:16px 0 0;font-size:12px">
          A document review is not a loan decision. Your loan team will let you
          know if anything else is needed.
        </p>
      `, "A document on your file has been reviewed"),
    };
  },

  documentActionNeeded(borrowerName: string, documentName: string): EmailOptions {
    return {
      to: "",
      subject: "Action needed on a document",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Action needed</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          We couldn't accept your ${documentName} as submitted. For your privacy,
          the details are only viewable inside your account.
        </p>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          Log into your Homiquity account and open <strong>Documents</strong> to
          see what's needed and upload a new copy.
        </p>
      `, "Action needed on a document in your file"),
    };
  },

  documentUploaded(staffName: string, borrowerName: string, documentName: string, applicationId: string): EmailOptions {
    return {
      to: "",
      subject: `New Document Uploaded: ${documentName}`,
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Document Uploaded</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${staffName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          A new document has been uploaded for review:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin:16px 0">
          <tr>
            <td style="padding:12px 16px">
              <p style="margin:0;color:#94a3b8;font-size:12px">BORROWER</p>
              <p style="margin:2px 0 0;color:#0f1729;font-size:14px">${borrowerName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 16px;border-top:1px solid #e2e8f0">
              <p style="margin:0;color:#94a3b8;font-size:12px">DOCUMENT</p>
              <p style="margin:2px 0 0;color:#0f1729;font-size:14px">${documentName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 16px;border-top:1px solid #e2e8f0">
              <p style="margin:0;color:#94a3b8;font-size:12px">APPLICATION</p>
              <p style="margin:2px 0 0;color:#0f1729;font-size:14px">${applicationId.substring(0, 8).toUpperCase()}</p>
            </td>
          </tr>
        </table>
      `, `${borrowerName} uploaded ${documentName}`),
    };
  },

  passwordReset(borrowerName: string, resetUrl: string, expiresMinutes: number): EmailOptions {
    return {
      to: "",
      subject: "Reset Your Homiquity Password",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Reset your password</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          We received a request to reset the password for your Homiquity account. Click the button below to choose a new one.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
          <tr>
            <td align="center">
              <a href="${resetUrl}" style="display:inline-block;background:#0f1729;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600">Reset Password</a>
            </td>
          </tr>
        </table>
        <p style="color:#94a3b8;line-height:1.6;margin:16px 0 0;font-size:13px">
          This link expires in ${expiresMinutes} minutes and can be used once. If you didn't request a reset, you can safely ignore this email — your password won't change.
        </p>
        <p style="color:#94a3b8;line-height:1.6;margin:12px 0 0;font-size:12px;word-break:break-all">
          If the button doesn't work, paste this link into your browser:<br>${resetUrl}
        </p>
      `, "Reset your Homiquity password"),
    };
  },

  verifyEmail(borrowerName: string, verifyUrl: string): EmailOptions {
    return {
      to: "",
      subject: "Confirm Your Email Address",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Confirm your email</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Welcome to Homiquity. Please confirm this is your email address so we can keep your account secure and send you important updates about your mortgage.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
          <tr>
            <td align="center">
              <a href="${verifyUrl}" style="display:inline-block;background:#0f1729;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600">Confirm Email</a>
            </td>
          </tr>
        </table>
        <p style="color:#94a3b8;line-height:1.6;margin:16px 0 0;font-size:12px;word-break:break-all">
          If the button doesn't work, paste this link into your browser:<br>${verifyUrl}
        </p>
      `, "Confirm your email address to finish setting up your account"),
    };
  },

  inviteCode(recipientEmail: string, role: string, code: string, inviterName: string): EmailOptions {
    return {
      to: recipientEmail,
      subject: "You've Been Invited to Join Homiquity",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Team Invitation</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          ${inviterName} has invited you to join Homiquity as a <strong>${role}</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin:16px 0">
          <tr>
            <td style="padding:20px" align="center">
              <p style="margin:0;color:#1e40af;font-size:13px;text-transform:uppercase;letter-spacing:1px">Your Invite Code</p>
              <p style="margin:8px 0 0;color:#1d4ed8;font-size:28px;font-weight:700;font-family:monospace;letter-spacing:2px">${code}</p>
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          Visit Homiquity and use this code to activate your account. This code expires in 7 days.
        </p>
      `, `You've been invited to join Homiquity as a ${role}`),
    };
  },

  preApprovalLetterReady(borrowerName: string, amount: string, letterNumber: string): EmailOptions {
    return {
      to: "",
      subject: "Your Pre-Approval Letter Is Ready",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Pre-Approval Letter Ready</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Your pre-approval letter has been generated and is ready for download.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin:16px 0">
          <tr>
            <td style="padding:16px">
              <p style="margin:0;color:#94a3b8;font-size:12px">LETTER #</p>
              <p style="margin:2px 0 0;color:#166534;font-size:14px;font-weight:600">${letterNumber}</p>
            </td>
            <td style="padding:16px" align="right">
              <p style="margin:0;color:#94a3b8;font-size:12px">AMOUNT</p>
              <p style="margin:2px 0 0;color:#166534;font-size:14px;font-weight:600">$${amount}</p>
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          Log into your dashboard to download the letter. You can share it with your real estate agent or seller.
        </p>
      `, `Your pre-approval letter #${letterNumber} is ready to download`),
    };
  },
  statusUpdate(borrowerName: string, statusLabel: string, applicationId: string): EmailOptions {
    return {
      to: "",
      subject: `Application Update: ${statusLabel}`,
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">Application Status Update</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${borrowerName},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Your mortgage application status has been updated.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:6px;margin:16px 0">
          <tr>
            <td style="padding:8px 16px">
              <p style="margin:0;color:#94a3b8;font-size:12px">APPLICATION</p>
              <p style="margin:4px 0 0;color:#0f1729;font-size:14px;font-weight:600">${applicationId.substring(0, 8).toUpperCase()}</p>
            </td>
            <td style="padding:8px 16px" align="right">
              ${statusBadge(statusLabel, "#3b82f6")}
            </td>
          </tr>
        </table>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          Log into your Homiquity dashboard for full details and next steps.
        </p>
      `, `Your application status is now: ${statusLabel}`),
    };
  },

  /**
   * Partner-waitlist → PartnerHub activation invite (PH-1). B2B recruitment
   * mail to a professional who asked to hear from us — same compliance rails
   * as leadReceived: NO rate/payment/APR figures (Reg Z trigger terms) and NO
   * approval/eligibility language (Reg N). It invites them to create a partner
   * account, nothing more.
   */
  partnerWaitlistInvite(name: string, joinUrl: string): EmailOptions {
    return {
      to: "",
      subject: "Your Homiquity partner invitation",
      html: baseTemplate(`
        <h2 style="margin:0 0 16px;color:#0f1729;font-size:20px">You're invited to PartnerHub</h2>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Hi ${name},
        </p>
        <p style="color:#475569;line-height:1.6;margin:0 0 16px">
          Thanks for joining the Homiquity partner waitlist. Partner onboarding is
          now open: create your account to get your personal referral link and a
          dashboard that shows where each client you refer stands — without you
          ever having to chase an update.
        </p>
        <p style="margin:24px 0">
          <a href="${joinUrl}" style="background:#047857;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;display:inline-block">
            Create your partner account
          </a>
        </p>
        <p style="color:#475569;line-height:1.6;margin:16px 0 0;font-size:14px">
          If you didn't request this, you can ignore this email — no account will
          be created and no one will contact you about it.
        </p>
      `, "Partner onboarding is open — create your Homiquity partner account"),
    };
  },
};

export type NotificationType =
  | "application_submitted"
  | "application_preliminary_plan"
  | "application_under_review"
  | "application_pre_approved"
  | "application_denied"
  | "message_received"
  | "document_requested"
  | "missing_docs_reminder"
  | "document_uploaded"
  | "document_verified"
  | "document_rejected"
  | "invite_sent"
  | "pre_approval_letter_ready"
  | "status_update"
  | "general";

interface NotificationEmailMapping {
  type: NotificationType;
  recipientEmail: string;
  data: Record<string, any>;
}

export function sendNotificationEmail(mapping: NotificationEmailMapping): void {
  const { type, recipientEmail, data } = mapping;
  if (!recipientEmail) return;

  let email: EmailOptions | null = null;

  switch (type) {
    case "application_submitted":
      email = emailTemplates.applicationSubmitted(data.borrowerName, data.applicationId);
      break;
    case "application_preliminary_plan":
      email = emailTemplates.applicationPreliminaryPlan(data.borrowerName, data.applicationId);
      break;
    case "application_under_review":
      email = emailTemplates.applicationUnderReview(data.borrowerName, data.applicationId);
      break;
    case "application_pre_approved":
      email = emailTemplates.applicationPreApproved(data.borrowerName, data.amount, data.applicationId);
      break;
    case "application_denied":
      email = emailTemplates.applicationDenied(data.borrowerName);
      break;
    case "message_received":
      email = emailTemplates.messageReceived(data.recipientName, data.senderName);
      break;
    case "document_requested":
      email = emailTemplates.documentRequested(data.borrowerName, data.documentName);
      break;
    case "missing_docs_reminder":
      email = emailTemplates.missingDocumentsReminder(data.borrowerName, data.items ?? []);
      break;
    case "document_uploaded":
      email = emailTemplates.documentUploaded(data.staffName, data.borrowerName, data.documentName, data.applicationId);
      break;
    // Review outcomes intentionally take ONLY name + document-type label —
    // the rejection reason must never travel over email.
    case "document_verified":
      email = emailTemplates.documentAccepted(data.borrowerName, data.documentName);
      break;
    case "document_rejected":
      email = emailTemplates.documentActionNeeded(data.borrowerName, data.documentName);
      break;
    case "invite_sent":
      email = emailTemplates.inviteCode(recipientEmail, data.role, data.code, data.inviterName);
      break;
    case "pre_approval_letter_ready":
      email = emailTemplates.preApprovalLetterReady(data.borrowerName, data.amount, data.letterNumber);
      break;
    case "status_update":
      email = emailTemplates.statusUpdate(data.borrowerName, data.statusLabel, data.applicationId);
      break;
    default:
      return;
  }

  if (email) {
    email.to = recipientEmail;
    // Fire-and-forget by design: a notification must never fail the operation
    // that triggered it. That makes this the one call path where a `false` has
    // no caller to react to it, so the failure is recorded here — with the
    // notification type, which sendEmail() cannot know — or it is recorded
    // nowhere at all.
    sendEmail(email)
      .then((sent) => {
        if (!sent) console.error(`[Email] Notification not delivered: type=${type}`);
      })
      .catch((err) => {
        console.error(`[Email] Fire-and-forget error for ${type}:`, err);
      });
  }
}
