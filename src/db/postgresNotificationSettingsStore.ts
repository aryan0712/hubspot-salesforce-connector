import type { PostgresDatabase } from './postgres.js';
import type { SecretCipher } from './security.js';

export interface NotificationSettings {
  enabled: boolean;
  alertEmail?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface NotificationSettingsStatus {
  enabled: boolean;
  alertEmail?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpFrom?: string;
  smtpConfigured: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

interface Row {
  enabled: boolean;
  alert_email: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_password_ciphertext: string | null;
  smtp_from: string | null;
  updated_at: Date;
  updated_by: string | null;
}

export class PostgresNotificationSettingsStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly cipher: SecretCipher,
    private readonly tenantId: string,
  ) {}

  /** Full settings including the decrypted SMTP password -- used by the sender, never by the API. */
  async get(): Promise<NotificationSettings> {
    const row = await this.row();
    if (!row) return { enabled: false };
    return {
      enabled: row.enabled,
      alertEmail: row.alert_email ?? undefined,
      smtpHost: row.smtp_host ?? undefined,
      smtpPort: row.smtp_port ?? undefined,
      smtpUser: row.smtp_user ?? undefined,
      smtpPassword: row.smtp_password_ciphertext
        ? this.cipher.decrypt(row.smtp_password_ciphertext, `${this.tenantId}:notifications:smtp-password`)
        : undefined,
      smtpFrom: row.smtp_from ?? undefined,
      updatedAt: row.updated_at.toISOString(),
      updatedBy: row.updated_by ?? undefined,
    };
  }

  /** Safe-to-return-to-the-client status -- never includes the SMTP password. */
  async status(): Promise<NotificationSettingsStatus> {
    const row = await this.row();
    if (!row) return { enabled: false, smtpConfigured: false };
    return {
      enabled: row.enabled,
      alertEmail: row.alert_email ?? undefined,
      smtpHost: row.smtp_host ?? undefined,
      smtpPort: row.smtp_port ?? undefined,
      smtpUser: row.smtp_user ?? undefined,
      smtpFrom: row.smtp_from ?? undefined,
      smtpConfigured: Boolean(row.smtp_host && row.smtp_user && row.smtp_password_ciphertext),
      updatedAt: row.updated_at.toISOString(),
      updatedBy: row.updated_by ?? undefined,
    };
  }

  async set(
    input: {
      enabled: boolean;
      alertEmail?: string;
      smtpHost?: string;
      smtpPort?: number;
      smtpUser?: string;
      smtpPassword?: string;
      smtpFrom?: string;
    },
    updatedBy?: string,
  ): Promise<NotificationSettingsStatus> {
    // A blank password means "keep the existing one" -- mirrors how the AI credential form
    // never re-displays a saved secret, so there's nothing for the client to resubmit.
    const existing = input.smtpPassword === undefined ? await this.row() : undefined;
    const passwordCiphertext =
      input.smtpPassword !== undefined
        ? this.cipher.encrypt(input.smtpPassword, `${this.tenantId}:notifications:smtp-password`)
        : (existing?.smtp_password_ciphertext ?? null);
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO notification_settings(
           tenant_id, enabled, alert_email, smtp_host, smtp_port, smtp_user,
           smtp_password_ciphertext, smtp_from, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           alert_email = EXCLUDED.alert_email,
           smtp_host = EXCLUDED.smtp_host,
           smtp_port = EXCLUDED.smtp_port,
           smtp_user = EXCLUDED.smtp_user,
           smtp_password_ciphertext = EXCLUDED.smtp_password_ciphertext,
           smtp_from = EXCLUDED.smtp_from,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [
          this.tenantId,
          input.enabled,
          input.alertEmail ?? null,
          input.smtpHost ?? null,
          input.smtpPort ?? null,
          input.smtpUser ?? null,
          passwordCiphertext,
          input.smtpFrom ?? null,
          updatedBy ?? null,
        ],
      );
    });
    return this.status();
  }

  private async row(): Promise<Row | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<Row>(
        `SELECT enabled, alert_email, smtp_host, smtp_port, smtp_user,
                smtp_password_ciphertext, smtp_from, updated_at, updated_by
         FROM notification_settings WHERE tenant_id = $1`,
        [this.tenantId],
      );
      return result.rows[0];
    });
  }
}
