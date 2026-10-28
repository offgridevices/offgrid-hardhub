// Sending sign-in links. Development returns the link to the caller instead.
// Production sends it through Resend (a US email API) when RESEND_API_KEY and
// MAIL_FROM are set; without them sign-in is refused with a clear message.
import type { Env } from "./env";

export interface Mailer {
  sendSignInLink(email: string, link: string): Promise<void>;
}

class UnconfiguredMailer implements Mailer {
  async sendSignInLink(): Promise<void> {
    throw new Error("no email sender is configured: set RESEND_API_KEY and MAIL_FROM (./hardhub deploy asks for them)");
  }
}

class ResendMailer implements Mailer {
  constructor(
    private readonly key: string,
    private readonly from: string,
  ) {}

  async sendSignInLink(email: string, link: string): Promise<void> {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [email],
        subject: "Your HardHub sign-in link",
        text: `Sign in to HardHub:\n\n${link}\n\nThe link works once, for 15 minutes. If you did not ask for it, ignore this email.`,
      }),
    });
    if (!r.ok) throw new Error(`email not sent: Resend answered ${r.status}`);
  }
}

export function mailer(env: Env): Mailer {
  return env.RESEND_API_KEY && env.MAIL_FROM ? new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM) : new UnconfiguredMailer();
}
