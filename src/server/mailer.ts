const RESEND_API = "https://api.resend.com/emails";

function getFrom() {
  return process.env.EMAIL_FROM ?? "anonovox <noreply@anonovox.com>";
}

function getAppUrl() {
  return process.env.BETTER_AUTH_URL ?? "https://anonovox.com";
}

async function send(to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[mailer] RESEND_API_KEY not set — skipping email to ${to}: ${subject}`);
    return;
  }
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: getFrom(), to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapEmail(body: string): string {
  const appUrl = getAppUrl();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
</head>
<body style="margin:0;padding:0;background-color:#faf5f0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf5f0;">
  <tr>
    <td align="center" style="padding:40px 20px 48px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background-color:#2c3e7a;border-radius:12px 12px 0 0;padding:20px 32px;">
            <span style="font-size:20px;color:#ffffff;font-weight:400;letter-spacing:-0.01em;">anono<strong style="font-weight:700;">vox</strong></span>
          </td>
        </tr>
        <tr>
          <td style="background-color:#ffffff;padding:32px 32px 24px;border:1px solid #e6e0d8;border-top:none;">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="background-color:#f5ede6;border-radius:0 0 12px 12px;border:1px solid #e6e0d8;border-top:none;padding:16px 32px;">
            <p style="font-size:12px;color:#8b8480;margin:0;line-height:1.7;">
              You are receiving this because you are a member of an organization on
              <a href="${appUrl}" style="color:#2c3e7a;text-decoration:none;">anonovox</a>.
              Manage preferences in <a href="${appUrl}/settings" style="color:#2c3e7a;text-decoration:none;">Settings</a>.
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

// ── Batch digest ──────────────────────────────────────────────────────────────

export interface BatchDigestParams {
  orgName: string;
  feedbackCount: number;
  insights: {
    themes: string[];
    sentiment: { positive: number; neutral: number; negative: number };
    key_quotes: string[];
    overall_summary: string;
  } | null;
}

export async function sendBatchDigest(to: string, params: BatchDigestParams): Promise<void> {
  const { orgName, feedbackCount, insights } = params;
  const appUrl = getAppUrl();
  const dateLabel = new Date().toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  let insightsHtml = "";
  if (insights) {
    const { themes, sentiment, key_quotes, overall_summary } = insights;

    const themeChips = themes
      .map((t) => `<span style="display:inline-block;padding:3px 10px;background:#e8eaf6;color:#2c3e7a;border-radius:9999px;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;margin:0 5px 6px 0;">${esc(t)}</span>`)
      .join("");

    // Sentiment bar using table cells for email-client compatibility
    const sentBar = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:4px;overflow:hidden;margin-bottom:8px;">
        <tr>
          <td width="${sentiment.positive}%" style="height:8px;background-color:#2d7a4a;"></td>
          <td width="${sentiment.neutral}%" style="height:8px;background-color:#b0b0b8;"></td>
          <td width="${sentiment.negative}%" style="height:8px;background-color:#c41e3a;"></td>
        </tr>
      </table>
      <p style="font-size:11px;color:#8b8480;margin:0 0 22px;">
        <span style="color:#2d7a4a;font-weight:600;">&#9679; Positive ${sentiment.positive}%</span>&nbsp;&nbsp;
        <span style="color:#8b8480;font-weight:600;">&#9679; Neutral ${sentiment.neutral}%</span>&nbsp;&nbsp;
        <span style="color:#c41e3a;font-weight:600;">&#9679; Negative ${sentiment.negative}%</span>
      </p>`;

    const quotesHtml = key_quotes
      .map((q) => `<p style="margin:0 0 10px;padding:10px 16px;border-left:3px solid #e8eaf6;background:#faf5f0;font-size:13px;color:#5a5450;line-height:1.65;font-style:italic;">&ldquo;${esc(q)}&rdquo;</p>`)
      .join("");

    insightsHtml = `
      <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 10px;">Themes</p>
      <div style="margin-bottom:22px;">${themeChips}</div>

      <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 8px;">Sentiment</p>
      ${sentBar}

      <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 10px;">What people are saying</p>
      <div style="margin-bottom:22px;">${quotesHtml}</div>

      <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 8px;">Summary</p>
      <p style="font-size:14px;color:#1a1410;line-height:1.7;margin:0 0 24px;">${esc(overall_summary)}</p>`;
  }

  const body = `
    <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 6px;">Feedback Digest</p>
    <h1 style="font-size:22px;font-weight:600;color:#1a1410;margin:0 0 4px;letter-spacing:-0.02em;">${esc(orgName)}</h1>
    <p style="font-size:13px;color:#8b8480;margin:0 0 24px;">${dateLabel}</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5ede6;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:14px 18px;">
          <span style="font-size:28px;font-weight:700;color:#2c3e7a;">${feedbackCount}</span>
          <span style="font-size:13px;color:#5a5450;margin-left:8px;">new submission${feedbackCount !== 1 ? "s" : ""} since last digest</span>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      <tr><td style="height:1px;background-color:#e6e0d8;"></td></tr>
    </table>

    ${insightsHtml}

    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding:4px 0 8px;">
          <a href="${appUrl}/dashboard" style="display:inline-block;background-color:#2c3e7a;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.02em;">View full dashboard &rarr;</a>
        </td>
      </tr>
    </table>`;

  await send(
    to,
    `Feedback digest — ${orgName} (${feedbackCount} new)`,
    wrapEmail(body),
  );
}

// ── Welcome email ─────────────────────────────────────────────────────────────

export async function sendWelcome(to: string, name: string): Promise<void> {
  const appUrl = getAppUrl();
  const firstName = name.split(" ")[0] || name;

  const body = `
    <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 6px;">Welcome</p>
    <h1 style="font-size:22px;font-weight:600;color:#1a1410;margin:0 0 16px;letter-spacing:-0.02em;">You're in, ${esc(firstName)}.</h1>
    <p style="font-size:14px;color:#5a5450;line-height:1.7;margin:0 0 16px;">
      anonovox gives your team a safe, anonymous channel to share honest feedback with leadership — no names, no tracking, just signal.
    </p>
    <p style="font-size:14px;color:#5a5450;line-height:1.7;margin:0 0 24px;">
      Your email domain identifies your organization. Leadership sees aggregated insights and themes, never individual responses.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      <tr><td style="height:1px;background-color:#e6e0d8;"></td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center">
          <a href="${appUrl}/feedback" style="display:inline-block;background-color:#2c3e7a;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.02em;">Submit your first piece of feedback &rarr;</a>
        </td>
      </tr>
    </table>`;

  await send(to, "Welcome to anonovox", wrapEmail(body));
}

// ── Transactional (kept for Better Auth hooks) ────────────────────────────────

export async function sendVerificationEmail(to: string, url: string): Promise<void> {
  const body = `
    <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 6px;">Email verification</p>
    <h1 style="font-size:22px;font-weight:600;color:#1a1410;margin:0 0 16px;letter-spacing:-0.02em;">Verify your email.</h1>
    <p style="font-size:14px;color:#5a5450;line-height:1.7;margin:0 0 24px;">
      Click the button below to verify your email address and complete your sign-up.
      This link expires in 1 hour.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center">
          <a href="${esc(url)}" style="display:inline-block;background-color:#2c3e7a;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.02em;">Verify email &rarr;</a>
        </td>
      </tr>
    </table>`;

  await send(to, "Verify your email — anonovox", wrapEmail(body));
}

export async function sendInvitationEmail(
  to: string,
  inviterName: string,
  orgName: string,
  acceptUrl: string,
): Promise<void> {
  const body = `
    <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 6px;">Invitation</p>
    <h1 style="font-size:22px;font-weight:600;color:#1a1410;margin:0 0 16px;letter-spacing:-0.02em;">You've been invited.</h1>
    <p style="font-size:14px;color:#5a5450;line-height:1.7;margin:0 0 24px;">
      <strong>${esc(inviterName)}</strong> has invited you to join <strong>${esc(orgName)}</strong> on anonovox.
      Accept to start submitting anonymous feedback to your leadership team.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center">
          <a href="${esc(acceptUrl)}" style="display:inline-block;background-color:#2c3e7a;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.02em;">Accept invitation &rarr;</a>
        </td>
      </tr>
    </table>
    <p style="font-size:12px;color:#8b8480;text-align:center;margin:16px 0 0;">This invitation expires in 48 hours.</p>`;

  await send(
    to,
    `${inviterName} invited you to ${orgName} on anonovox`,
    wrapEmail(body),
  );
}

export interface RequestAccessEmailParams {
  companyName: string;
  website: string;
  emailDomain: string | null;
  contactName: string;
  contactEmail: string;
}

export async function sendRequestAccessEmail(params: RequestAccessEmailParams): Promise<void> {
  const { companyName, website, emailDomain, contactName, contactEmail } = params;

  const body = `
    <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8b8480;margin:0 0 6px;">Request access</p>
    <h1 style="font-size:22px;font-weight:600;color:#1a1410;margin:0 0 20px;letter-spacing:-0.02em;">A new organization requested access.</h1>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#5a5450;width:170px;"><strong style="color:#1a1410;">Company</strong></td>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#1a1410;">${esc(companyName)}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#5a5450;"><strong style="color:#1a1410;">Website</strong></td>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#1a1410;"><a href="${esc(website)}" style="color:#2c3e7a;text-decoration:none;">${esc(website)}</a></td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#5a5450;"><strong style="color:#1a1410;">Email domain</strong></td>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#1a1410;">${esc(emailDomain ?? "Use website domain")}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#5a5450;"><strong style="color:#1a1410;">Contact name</strong></td>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#1a1410;">${esc(contactName)}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#5a5450;"><strong style="color:#1a1410;">Contact email</strong></td>
        <td style="padding:10px 0;border-bottom:1px solid #e6e0d8;font-size:14px;color:#1a1410;"><a href="mailto:${esc(contactEmail)}" style="color:#2c3e7a;text-decoration:none;">${esc(contactEmail)}</a></td>
      </tr>
    </table>
    <p style="font-size:13px;color:#8b8480;line-height:1.7;margin:0;">
      Reply to <a href="mailto:${esc(contactEmail)}" style="color:#2c3e7a;text-decoration:none;">${esc(contactEmail)}</a> to continue the conversation.
    </p>`;

  await send("steven@recursesystems.com", `Request access — ${companyName}`, wrapEmail(body));
}
