import nodemailer from 'nodemailer';
import type { ActivityLog } from '../observability/activity.js';
import { logger } from '../logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Sends real email over SMTP -- any provider works (Gmail, Office365, SendGrid/Postmark/SES SMTP, a private relay). */
export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly config: {
      host: string;
      port: number;
      user: string;
      password: string;
      from: string;
    },
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const transport = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.port === 465,
      auth: { user: this.config.user, pass: this.config.password },
    });
    await transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/**
 * Stand-in used until SMTP credentials are configured. Makes the alerting pipeline fully
 * exercisable (trigger conditions, digesting, recipient) without requiring a real mail
 * account first -- logs what *would* have been sent instead of silently doing nothing.
 */
export class LoggingEmailSender implements EmailSender {
  constructor(private readonly activity?: ActivityLog) {}

  async send(message: EmailMessage): Promise<void> {
    logger.info({ to: message.to, subject: message.subject }, 'email alert not sent -- SMTP not configured');
    this.activity?.record({
      kind: 'info',
      message: `Email alert ready but not sent (SMTP not configured): "${message.subject}" -> ${message.to}`,
    });
  }
}
