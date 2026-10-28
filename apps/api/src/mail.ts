// Sending sign-in links. Development returns the link to the caller instead;
// production needs a real sender, which is not chosen yet.
import type { Env } from "./env";

export interface Mailer {
  sendSignInLink(email: string, link: string): Promise<void>;
}

class UnconfiguredMailer implements Mailer {
  async sendSignInLink(): Promise<void> {
    // TODO(owner): pick an email provider (Cloudflare Email Service, Resend,
    // Postmark) and implement this. Until then production sign-in cannot work.
    throw new Error("no email sender is configured");
  }
}

export function mailer(_env: Env): Mailer {
  return new UnconfiguredMailer();
}
