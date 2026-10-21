import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface RuntimeSchedulerConfig {
  enabled: boolean;
  time: string; // HH:mm (UTC)
  recipients: string[];
  lastExecutionSlotUtc?: string;
  lastSuccessfulRunUtc?: string;
}

@Injectable()
export class RuntimeConfigService {
  private readonly logger = new Logger(RuntimeConfigService.name);
  private readonly configPath: string;
  private config: RuntimeSchedulerConfig;

  constructor(private readonly configService: ConfigService) {
    const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
    this.configPath = join(dataDir, 'runtime-config.json');
    this.config = this.loadOrCreateConfig();
  }

  getConfig(): RuntimeSchedulerConfig {
    return {
      enabled: this.config.enabled,
      time: this.config.time,
      recipients: [...this.config.recipients],
      lastExecutionSlotUtc: this.config.lastExecutionSlotUtc,
      lastSuccessfulRunUtc: this.config.lastSuccessfulRunUtc,
    };
  }

  setLastExecutionSlot(slot: string): RuntimeSchedulerConfig {
    this.config.lastExecutionSlotUtc = slot;
    this.persist();
    return this.getConfig();
  }

  setLastSuccessfulRun(isoTimestamp: string): RuntimeSchedulerConfig {
    this.config.lastSuccessfulRunUtc = isoTimestamp;
    this.persist();
    return this.getConfig();
  }

  updateTime(time: string): RuntimeSchedulerConfig {
    this.config.time = this.normalizeTime(time);
    this.persist();
    return this.getConfig();
  }

  updateEnabled(enabled: boolean): RuntimeSchedulerConfig {
    this.config.enabled = Boolean(enabled);
    this.persist();
    return this.getConfig();
  }

  replaceRecipients(recipients: string[]): RuntimeSchedulerConfig {
    this.config.recipients = this.normalizeRecipients(recipients);
    this.persist();
    return this.getConfig();
  }

  addRecipient(email: string): RuntimeSchedulerConfig {
    const normalized = this.normalizeRecipients([email]);
    if (normalized.length === 0) {
      return this.getConfig();
    }

    const merged = new Set([...this.config.recipients, ...normalized]);
    this.config.recipients = [...merged];
    this.persist();
    return this.getConfig();
  }

  removeRecipient(email: string): RuntimeSchedulerConfig {
    const target = email.trim().toLowerCase();
    this.config.recipients = this.config.recipients.filter((e) => e !== target);
    this.persist();
    return this.getConfig();
  }

  private loadOrCreateConfig(): RuntimeSchedulerConfig {
    const fileDir = dirname(this.configPath);
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }

    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const config = this.normalizeConfig(parsed);
        this.logger.log(`Loaded runtime config from ${this.configPath}`);
        return config;
      } catch (error: any) {
        this.logger.warn(`Failed to parse runtime config, recreating: ${error.message}`);
      }
    }

    const fromEnv: RuntimeSchedulerConfig = {
      enabled: this.configService.get<boolean>('scheduler.enabled', true),
      time: this.normalizeTime(this.configService.get<string>('scheduler.time', '09:00')),
      recipients: this.normalizeRecipients(
        this.configService.get<string>('email.recipientEmail', '').split(','),
      ),
    };

    this.config = fromEnv;
    this.persist();
    this.logger.log(`Created runtime config at ${this.configPath}`);
    return fromEnv;
  }

  private persist(): void {
    const fileDir = dirname(this.configPath);
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }

    writeFileSync(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, 'utf-8');
  }

  private normalizeConfig(value: any): RuntimeSchedulerConfig {
    const envRecipients = this.normalizeRecipients(
      this.configService.get<string>('email.recipientEmail', '').split(','),
    );
    const fileRecipients = this.normalizeRecipients(
      Array.isArray(value?.recipients) ? value.recipients : [],
    );

    return {
      enabled:
        typeof value?.enabled === 'boolean'
          ? value.enabled
          : this.configService.get<boolean>('scheduler.enabled', true),
      time: this.normalizeTime(String(value?.time ?? '09:00')),
      recipients: Array.isArray(value?.recipients) ? fileRecipients : envRecipients,
      lastExecutionSlotUtc: typeof value?.lastExecutionSlotUtc === 'string' ? value.lastExecutionSlotUtc : undefined,
      lastSuccessfulRunUtc: typeof value?.lastSuccessfulRunUtc === 'string' ? value.lastSuccessfulRunUtc : undefined,
    };
  }

  private normalizeRecipients(recipients: string[]): string[] {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalized = recipients
      .map((email) => String(email).trim().toLowerCase())
      .filter((email) => emailRegex.test(email));

    return [...new Set(normalized)];
  }

  private normalizeTime(value: string): string {
    if (/^\d{1,2}:\d{2}$/.test(value)) {
      const [h, m] = value.split(':').map((part) => Number(part));
      if (!Number.isNaN(h) && !Number.isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
    }

    // Support cron style input: "m h * * *"
    const parts = value.trim().split(/\s+/);
    if (parts.length >= 2) {
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      if (!Number.isNaN(hour) && !Number.isNaN(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      }
    }

    return '09:00';
  }
}
