import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { JobsService } from '../jobs/jobs.service';
import { TelegramService, TelegramJobMessage } from '../notifications/telegram.service';
import { FileNotificationService } from '../notifications/file-notification.service';
import { EmailService } from '../notifications/email.service';
import { JobFilterService } from './job-filter.service';
import { SentJobsDatabase } from '../db/sent-jobs.database';
import { ScraperInputDto, DescriptionFormat, JobPostDto, mapStringToSite } from '@sherlock/models';
import { RuntimeConfigService, RuntimeSchedulerConfig } from './runtime-config.service';
import { TOP_INDIAN_COMPANY_CAREER_DOMAINS } from './india-top-company-domains';
import { SubagentMemoryService, SubagentDailyMetric } from './subagent-memory.service';
import { ActivityLogService } from './activity-log.service';
import { SourceDailyMetric, SourceReliabilityService } from './source-reliability.service';

interface AiSubagentSearchResult {
  jobs: JobPostDto[];
  metrics: Array<{ query: string; rawFound: number; uniqueKeys: string[] }>;
  queryOrder: string[];
}

@Injectable()
export class JobSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobSchedulerService.name);
  private lastExecutionSlotUtc?: string;
  private lastSuccessfulRunUtc?: string;
  private isRunning = false;

  private readonly aiSubagentQueries: string[] = [
    'fresher internship software engineer india remote bengaluru hyderabad pune chennai noida gurugram mumbai',
    'entry level frontend react javascript internship india remote bengaluru hyderabad pune chennai',
    'entry level backend nodejs java python internship india remote noida gurugram pune hyderabad',
    'graduate data analyst data engineer sql python internship india remote bengaluru mumbai hyderabad pune',
    'fresher qa test automation sdet internship india remote chennai noida pune bengaluru',
    'junior cloud devops support engineer trainee india remote hyderabad pune gurugram bengaluru',
  ];

  private readonly indiaPrimarySiteNames: string[] = [
    'naukri',
    'internshala',
    'linkedin',
    'indeed',
    'wellfound',
    'himalayas',
    'jobicy',
    'remoteok',
    'remotive',
    'weworkremotely',
    'workingnomads',
    'startupjobs',
    'google',
    'exa',
    'greenhouse',
    'lever',
    'ashby',
    'recruitee',
    'teamtailor',
    'workday',
    'smartrecruiters',
    'workable',
  ];

  constructor(
    private jobsService: JobsService,
    private telegramService: TelegramService,
    private fileNotificationService: FileNotificationService,
    private emailService: EmailService,
    private filterService: JobFilterService,
    private sentJobsDb: SentJobsDatabase,
    private runtimeConfigService: RuntimeConfigService,
    private configService: ConfigService,
    private subagentMemoryService: SubagentMemoryService,
    private activityLogService: ActivityLogService,
    private sourceReliabilityService: SourceReliabilityService,
  ) {}

  onModuleInit() {
    const config = this.runtimeConfigService.getConfig();
    this.lastExecutionSlotUtc = config.lastExecutionSlotUtc;
    this.lastSuccessfulRunUtc = config.lastSuccessfulRunUtc;
    if (config.enabled) {
      this.logger.log(`Job Scheduler initialized (runs daily at ${config.time} UTC)`);
    } else {
      this.logger.log('Job Scheduler is disabled');
    }
  }

  onModuleDestroy() {
    this.logger.log('Job Scheduler destroyed');
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick() {
    const config = this.runtimeConfigService.getConfig();
    this.lastExecutionSlotUtc = config.lastExecutionSlotUtc;
    this.lastSuccessfulRunUtc = config.lastSuccessfulRunUtc;
    if (!config.enabled) {
      return;
    }

    const now = new Date();
    const currentTimeUtc = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const currentDateUtc = now.toISOString().slice(0, 10);
    const currentSlotUtc = `${currentDateUtc}|${config.time}`;
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [scheduledHour, scheduledMinute] = config.time.split(':').map((v) => Number(v));
    const scheduledMinutes = scheduledHour * 60 + scheduledMinute;

    // Debug logging
    if (currentTimeUtc === config.time || (now.getUTCMinutes() === 0 && now.getUTCHours() === 9)) {
      this.logger.log(`[SCHEDULER TICK] Current UTC: ${currentTimeUtc} | Config Time: ${config.time} | Date: ${currentDateUtc} | Last Exec Slot: ${this.lastExecutionSlotUtc} | Recipients: ${config.recipients.join(',')}`);
    }

    // If service was sleeping/restarting, run once when time has passed.
    if (currentMinutes < scheduledMinutes) {
      return;
    }

    if (this.lastExecutionSlotUtc === currentSlotUtc) {
      this.logger.log(`[SCHEDULER SKIP] Already executed this slot (${currentSlotUtc})`);
      return;
    }

    this.lastExecutionSlotUtc = currentSlotUtc;
    this.runtimeConfigService.setLastExecutionSlot(currentSlotUtc);
    this.logger.log(`[SCHEDULER TRIGGER] Starting daily execution at ${currentTimeUtc} UTC`);
    await this.executeDaily();
  }

  async executeDaily() {
    const config = this.runtimeConfigService.getConfig();
    if (!config.enabled) return;

    if (this.isRunning) {
      this.logger.log('Scheduler run skipped: previous run still in progress');
      this.activityLogService.warn('Run request ignored: scheduler already in progress');
      return;
    }

    this.isRunning = true;
    this.activityLogService.info('Scheduler run started');

    this.logger.log('Starting daily job search...');
    const startTime = Date.now();

    try {
      // 1. Search for jobs using 6 source-agnostic AI subagent query plans
      this.logger.log('Searching with 6 AI subagents across all supported sources...');
      this.activityLogService.info('Step 1/6: Starting AI subagent search plans');
      const runDate = new Date().toISOString().slice(0, 10);
      const aiSearch = await this.searchWithAISubagents(runDate);
      const baseJobs = aiSearch.jobs;
      const searchTerm = 'software engineer developer internship fresher entry level india remote';
      this.activityLogService.info(`AI subagents completed: ${baseJobs.length} candidates`);

      this.activityLogService.info('Step 2/6: Starting domain discovery search');
      const discoveryJobs = await this.searchCompanyDomainMetaJobs(searchTerm);
      const allJobs = [...baseJobs, ...discoveryJobs];
      this.activityLogService.info(`Domain discovery completed: ${discoveryJobs.length} candidates`);
      this.logger.log(
        `Found ${allJobs.length} total jobs (base=${baseJobs.length}, discovery=${discoveryJobs.length})`,
      );
      this.activityLogService.info(`Total candidates aggregated: ${allJobs.length}`);

      // 2. Filter & rank using AI
      this.logger.log('Filtering with AI for fresher-friendly jobs...');
      this.activityLogService.info('Step 3/6: Applying filter and ranking pipeline');
      let filteredJobs = await this.filterService.filterJobs(allJobs);
      let usedFallbackOutsideCriteria = false;

      // If strict criteria is empty, pick top 20 outside strict criteria.
      if (filteredJobs.length === 0) {
        filteredJobs = this.filterService.fallbackOutsideCriteria(allJobs, 20);
        usedFallbackOutsideCriteria = filteredJobs.length > 0;
        if (usedFallbackOutsideCriteria) {
          this.activityLogService.warn(`Strict filter returned 0; fallback selected ${filteredJobs.length}`);
        }
      }

      // 3. Remove already-sent jobs
      this.logger.log('Removing duplicates (already sent)...');
      this.activityLogService.info('Step 4/6: Removing already sent jobs');
      const dedupeInputCount = filteredJobs.length;
      const newJobs = filteredJobs.filter(
        (job) =>
          !this.sentJobsDb.isJobSent(
            job.title,
            job.companyName || 'unknown',
            job.site || '',
            job.jobUrl || '',
          ),
      );
      this.activityLogService.info(
        `Dedupe kept ${newJobs.length}/${dedupeInputCount} jobs (cooldown-aware matching)`,
      );
      const filteredKeys = new Set(filteredJobs.map((job) => this.buildJobKey(job)));
      const newKeys = new Set(newJobs.map((job) => this.buildJobKey(job)));
      const dailySubagentMetrics = this.buildSubagentOutcomeMetrics(aiSearch.metrics, filteredKeys, newKeys);
      const dailySourceMetrics = this.buildSourceOutcomeMetrics(allJobs, filteredKeys, newKeys);
      const prioritizedNewJobs = this.filterService.prioritizeCompanyCareerJobs(newJobs);

      if (newJobs.length === 0) {
        this.logger.log(
          'No new jobs found (all recent results already sent)',
        );
        this.activityLogService.warn('No new jobs found after dedupe');
        await this.telegramService.sendStatus(
          'No new computer jobs found matching your criteria today.',
        );
        const recipientEmail = config.recipients.join(',');
        if (recipientEmail) {
          this.logger.log(`Sending no-jobs status email to ${config.recipients.length} recipient(s): ${recipientEmail}`);
          const statusSent = await this.emailService.sendStatusEmail(
            'Daily Job Search - No New Jobs',
            'No new computer jobs found matching your criteria today.',
            recipientEmail,
          );
          if (!statusSent) {
            this.logger.warn('No-jobs status email failed for all recipients');
            this.activityLogService.error('No-jobs status email failed for all recipients');
          } else {
            this.activityLogService.info('No-jobs status email sent successfully');
          }
        }
        this.subagentMemoryService.recordDailyOutcome(
          dailySubagentMetrics,
          runDate,
          true,
          true,
        );
        this.sourceReliabilityService.recordDailyOutcome(
          dailySourceMetrics,
          runDate,
          true,
          true,
        );
        this.lastSuccessfulRunUtc = new Date().toISOString();
        this.runtimeConfigService.setLastSuccessfulRun(this.lastSuccessfulRunUtc);
        this.activityLogService.info('Scheduler run completed (no new jobs)');
        return;
      }

      // 4. Prepare Telegram messages
      this.logger.log(`Preparing ${prioritizedNewJobs.length} jobs for Telegram...`);
      this.activityLogService.info(`Step 5/6: Preparing ${prioritizedNewJobs.length} notification items`);
      const telegramMessages: TelegramJobMessage[] = [];
      const preparedJobs: Array<{ title: string; company: string; source: string; url: string }> = [];

      for (const job of prioritizedNewJobs) {
        try {
          const skills = await this.filterService.extractJobSkills(job);

          const locationStr = job.location
            ? `${job.location.city || ''} ${job.location.state || ''} ${job.location.country || ''}`.trim()
            : 'Not specified';
          const salaryStr = job.compensation
            ? `${job.compensation.minAmount || ''}${job.compensation.minAmount && job.compensation.maxAmount ? '-' : ''}${job.compensation.maxAmount || ''} ${job.compensation.currency || 'USD'}`.trim()
            : undefined;

          const message: TelegramJobMessage = {
            jobTitle: job.title,
            company: job.companyName || 'Unknown Company',
            location: locationStr,
            jobType: Array.isArray(job.jobType) ? job.jobType.join(', ') : job.jobType || 'Unknown',
            link: job.jobUrl || '#',
            salary: salaryStr,
            keywords: skills,
            source: job.site || 'Unknown',
          };

          telegramMessages.push(message);
          preparedJobs.push({
            title: job.title,
            company: job.companyName || 'unknown',
            source: job.site || 'unknown',
            url: job.jobUrl || '',
          });
        } catch (error: any) {
          this.logger.warn(
            `Error processing job ${job.title}: ${error.message}`,
          );
          this.activityLogService.warn(`Job formatting warning: ${error.message}`);
        }
      }

      // 5. Send to Telegram and Email
      this.logger.log('Sending job notifications...');
      this.activityLogService.info('Step 6/6: Sending notifications to Telegram and Email');
      let sentCount = 0;
      let emailSent = false;
      let fileSavedCount = 0;
      
      // Try Telegram first
      try {
        sentCount = await this.telegramService.sendBatch(telegramMessages);
        this.activityLogService.info(`Telegram send completed: ${sentCount}/${telegramMessages.length}`);
      } catch (error: any) {
        this.logger.warn(`Telegram failed (${error.message}), trying other methods...`);
        this.activityLogService.error(`Telegram send failed: ${error.message}`);
      }

      // Send via Email
      const recipientEmail = config.recipients.join(',');
      if (recipientEmail && telegramMessages.length > 0) {
        try {
          emailSent = await this.emailService.sendJobsEmail(telegramMessages, recipientEmail);
          if (emailSent) {
            this.logger.log(`✓ Email sent to ${recipientEmail} with ${telegramMessages.length} jobs`);
            sentCount = Math.max(sentCount, telegramMessages.length);
            this.activityLogService.info(`Email send completed for ${config.recipients.length} recipient(s)`);
          }
        } catch (error: any) {
          this.logger.warn(`Email failed (${error.message})`);
          this.activityLogService.error(`Email send failed: ${error.message}`);
        }
      }

      // Fallback: Always save to file as well
      if (telegramMessages.length > 0) {
        fileSavedCount = await this.fileNotificationService.saveBatch(telegramMessages);
        if (sentCount === 0 && fileSavedCount > 0) {
          this.logger.log(`✓ Jobs saved to file (all services unavailable): ${fileSavedCount} jobs`);
          await this.fileNotificationService.sendStatus(
            `Found ${newJobs.length} new jobs - saved to data/jobs-found.json`
          );
        }
        sentCount = Math.max(sentCount, fileSavedCount);
        this.activityLogService.info(`File notification fallback saved: ${fileSavedCount}`);
      }

      const fullBatchDelivered =
        emailSent ||
        sentCount >= telegramMessages.length ||
        fileSavedCount >= telegramMessages.length;

      if (fullBatchDelivered) {
        for (const job of preparedJobs) {
          await this.sentJobsDb.markJobSent(
            job.title,
            job.company,
            job.source,
            job.url,
          );
        }
      } else {
        this.logger.warn('Notifications were not fully delivered; skipping sent-job marking to allow retry on next run');
        this.activityLogService.warn('Notifications were partially delivered; skipped sent-job marking');
      }

      this.subagentMemoryService.recordDailyOutcome(
        dailySubagentMetrics,
        runDate,
        fullBatchDelivered,
        false,
      );
      this.sourceReliabilityService.recordDailyOutcome(
        dailySourceMetrics,
        runDate,
        fullBatchDelivered,
        false,
      );

      // 6. Cleanup old sent jobs (keep last 30 days)
      const cleaned = await this.sentJobsDb.cleanupOldJobs(30);

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      this.logger.log(`
    Daily job search completed.
    • Searched: ${allJobs.length} jobs
   • Filtered: ${filteredJobs.length} relevant jobs
    • Fallback mode: ${usedFallbackOutsideCriteria ? 'ON (outside strict criteria)' : 'OFF'}
   • New: ${newJobs.length} jobs
   • Sent: ${sentCount} Telegram messages
   • Cleaned: ${cleaned} old records
   • Duration: ${duration}s
      `);

      this.lastSuccessfulRunUtc = new Date().toISOString();
      this.runtimeConfigService.setLastSuccessfulRun(this.lastSuccessfulRunUtc);
      this.activityLogService.info(`Scheduler run completed successfully in ${duration}s`);
    } catch (error: any) {
      this.logger.error(`Daily job search failed: ${error.message}`, error.stack);
      this.activityLogService.error(`Scheduler run failed: ${error.message}`);
      await this.telegramService.sendStatus(
        `<b>Daily Job Search Failed</b>\nError: ${error.message}`,
      );
      const recipientEmail = config.recipients.join(',');
      if (recipientEmail) {
        await this.emailService.sendStatusEmail(
          'Daily Job Search Failed',
          `Error: ${error.message}`,
          recipientEmail,
        );
      }
    } finally {
      this.isRunning = false;
      this.activityLogService.info('Scheduler run finished (idle)');
    }
  }

  /**
   * Search company career domains and major job portals through meta sources
   * (Google/Exa) so we can cover sites that do not yet have native plugins.
   */
  private async searchCompanyDomainMetaJobs(baseSearchTerm: string): Promise<JobPostDto[]> {
    const enabled = this.configService.get<boolean>('discovery.enabled', true);
    if (!enabled) {
      return [];
    }

    const companyDomains = this.configService.get<string[]>(
      'priority.companyCareerDomains',
      [],
    );
    const portalDomains = this.configService.get<string[]>(
      'discovery.portalDomains',
      [],
    );
    const querySources = this.configService
      .get<string[]>('discovery.querySources', ['google', 'exa'])
      .map((site) => mapStringToSite(site))
      .filter(Boolean);

    const metaSources = querySources.filter((site) => {
      const name = String(site).toLowerCase();
      return name === 'google' || name === 'exa';
    });
    const directSources = querySources.filter((site) => {
      const name = String(site).toLowerCase();
      return name !== 'google' && name !== 'exa';
    });

    if (querySources.length === 0) {
      this.logger.warn('Discovery sources are empty; skipping meta discovery');
      this.activityLogService.warn('Discovery skipped: no query sources configured');
      return [];
    }

    const allTargets = this.normalizeDiscoveryDomains([
      ...companyDomains,
      ...TOP_INDIAN_COMPANY_CAREER_DOMAINS,
      ...portalDomains,
    ]);

    if (allTargets.length === 0) {
      return [];
    }

    const domainsPerRun = Math.max(
      20,
      this.configService.get<number>('discovery.domainsPerRun', 180),
    );
    const domainsPerQuery = Math.max(
      2,
      this.configService.get<number>('discovery.domainsPerQuery', 6),
    );
    const maxParallelQueries = Math.max(
      1,
      this.configService.get<number>('discovery.maxParallelQueries', 4),
    );

    // Deterministic rotation ensures all domains are covered over time.
    const dayIndex = Math.floor(Date.now() / 86400000);
    const start = (dayIndex * domainsPerRun) % allTargets.length;
    const selected: string[] = [];
    for (let i = 0; i < Math.min(domainsPerRun, allTargets.length); i++) {
      selected.push(allTargets[(start + i) % allTargets.length]);
    }

    const chunks: string[][] = [];
    for (let i = 0; i < selected.length; i += domainsPerQuery) {
      chunks.push(selected.slice(i, i + domainsPerQuery));
    }

    this.logger.log(
      `Discovery query over ${selected.length}/${allTargets.length} domains using ${chunks.length} batches`,
    );
    this.activityLogService.info(
      `Discovery scanning ${selected.length} domains across ${chunks.length} batches via meta[${metaSources.join(', ')}] + direct[${directSources.join(', ')}]`,
    );

    const runChunk = async (chunk: string[]) => {
      this.activityLogService.info(`Discovery batch searching domains: ${chunk.join(', ')}`);
      const collected: JobPostDto[] = [];

      if (metaSources.length > 0) {
        const siteFilters = chunk.map((d) => `site:${d}`).join(' OR ');
        const metaQuery = `${baseSearchTerm} (${siteFilters}) (careers OR jobs OR internship OR fresher OR entry level OR graduate OR trainee) (india OR remote OR bengaluru OR hyderabad OR pune OR chennai OR noida OR gurugram OR mumbai)`;
        const metaInput = new ScraperInputDto({
          searchTerm: metaQuery,
          googleSearchTerm: metaQuery,
          resultsWanted: 30,
          descriptionFormat: DescriptionFormat.MARKDOWN,
          siteType: metaSources,
        });
        const metaJobs = await this.jobsService.searchJobs(metaInput);
        collected.push(...metaJobs);
      }

      if (directSources.length > 0) {
        const chunkSignals = chunk
          .map((domain) => domain.split('.')[0])
          .filter(Boolean)
          .slice(0, 4)
          .join(' ');
        const directQuery = `${baseSearchTerm} ${chunkSignals} careers jobs internship fresher trainee india remote`;
        const directInput = new ScraperInputDto({
          searchTerm: directQuery,
          resultsWanted: 40,
          descriptionFormat: DescriptionFormat.MARKDOWN,
          siteType: directSources,
        });
        const directJobs = await this.jobsService.searchJobs(directInput);
        collected.push(...directJobs);
      }

      return collected;
    };

    const results: JobPostDto[] = [];
    for (let i = 0; i < chunks.length; i += maxParallelQueries) {
      const window = chunks.slice(i, i + maxParallelQueries);
      const settled = await Promise.allSettled(window.map((chunk) => runChunk(chunk)));
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          results.push(...s.value);
        }
      }
    }

    this.logger.log(`Discovery found ${results.length} candidate jobs`);
    this.activityLogService.info(`Discovery completed with ${results.length} candidate jobs`);
    return results;
  }

  /**
   * Source-agnostic search plans: 6 independent query agents run daily.
   * Each agent broadens discovery for fresher/internship IT roles in India + remote.
   */
  private async searchWithAISubagents(runDate: string): Promise<AiSubagentSearchResult> {
    const queryOrder = this.subagentMemoryService.getRankedQueries(this.aiSubagentQueries, runDate);
    const sourcePlan = this.sourceReliabilityService.getSourcePlan(this.indiaPrimarySiteNames, runDate);

    const primarySites = sourcePlan.primary
      .map((site) => mapStringToSite(site))
      .filter((site): site is NonNullable<ReturnType<typeof mapStringToSite>> => Boolean(site));
    const recrawlSites = sourcePlan.recrawl
      .map((site) => mapStringToSite(site))
      .filter((site): site is NonNullable<ReturnType<typeof mapStringToSite>> => Boolean(site));

    this.activityLogService.info(`Subagent primary sources: ${sourcePlan.primary.join(', ')}`);
    if (sourcePlan.recrawl.length > 0) {
      this.activityLogService.info(`Subagent recrawl sources: ${sourcePlan.recrawl.join(', ')}`);
    }

    const runSubagentSearch = async (
      query: string,
      sourceSet: Array<NonNullable<ReturnType<typeof mapStringToSite>>>,
      resultsWanted: number,
    ) => {
      const input = new ScraperInputDto({
        searchTerm: query,
        resultsWanted,
        descriptionFormat: DescriptionFormat.MARKDOWN,
        siteType: sourceSet.length > 0 ? sourceSet : undefined,
      });
      return this.jobsService.searchJobs(input);
    };

    const metricMap = new Map<
      string,
      { query: string; rawFound: number; uniqueKeys: Set<string> }
    >();
    for (const query of queryOrder) {
      metricMap.set(query, { query, rawFound: 0, uniqueKeys: new Set<string>() });
    }

    const merged: JobPostDto[] = [];

    const absorbResults = (query: string, jobs: JobPostDto[]) => {
      const metric = metricMap.get(query);
      if (!metric) {
        return;
      }

      metric.rawFound += jobs.length;
      for (const job of jobs) {
        metric.uniqueKeys.add(this.buildJobKey(job));
      }
      merged.push(...jobs);
    };

    const settled = await Promise.allSettled(
      queryOrder.map((query) => runSubagentSearch(query, primarySites, 80)),
    );

    for (let i = 0; i < settled.length; i += 1) {
      const result = settled[i];
      const query = queryOrder[i] || 'unknown';
      if (result.status === 'fulfilled') {
        absorbResults(query, result.value);
        this.activityLogService.info(`Subagent query completed: "${query}" -> ${result.value.length} jobs`);
      } else {
        this.activityLogService.warn(`Subagent query failed: "${query}"`);
      }
    }

    const primaryUniqueCount = new Set(merged.map((job) => this.buildJobKey(job))).size;
    const recrawlMinUnique = Math.max(30, Number(process.env.SOURCE_RECRAWL_MIN_UNIQUE || '120'));
    if (primaryUniqueCount < recrawlMinUnique && recrawlSites.length > 0) {
      this.activityLogService.warn(
        `Primary source lane produced ${primaryUniqueCount} unique candidates (< ${recrawlMinUnique}); running recrawl lane`,
      );

      const recrawlQueries = queryOrder.slice(0, Math.min(4, queryOrder.length));
      const recrawlSettled = await Promise.allSettled(
        recrawlQueries.map((query) => runSubagentSearch(query, recrawlSites, 50)),
      );

      for (let i = 0; i < recrawlSettled.length; i += 1) {
        const result = recrawlSettled[i];
        const query = recrawlQueries[i] || 'unknown';
        if (result.status === 'fulfilled') {
          absorbResults(query, result.value);
          this.activityLogService.info(
            `Recrawl query completed: "${query}" -> ${result.value.length} jobs`,
          );
        } else {
          this.activityLogService.warn(`Recrawl query failed: "${query}"`);
        }
      }
    }

    // Deduplicate by URL first, then by title+company when URL is missing.
    const seen = new Set<string>();
    const unique: JobPostDto[] = [];
    for (const job of merged) {
      const url = String(job.jobUrl || '').trim().toLowerCase();
      const fallback = `${String(job.title || '').trim().toLowerCase()}|${String(job.companyName || '').trim().toLowerCase()}`;
      const key = url || fallback;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(job);
      }
    }

    const metrics: Array<{ query: string; rawFound: number; uniqueKeys: string[] }> = queryOrder.map(
      (query) => {
        const metric = metricMap.get(query)!;
        return {
          query,
          rawFound: metric.rawFound,
          uniqueKeys: [...metric.uniqueKeys],
        };
      },
    );

    this.logger.log(`AI subagents found ${unique.length} candidate jobs`);
    this.activityLogService.info(`Subagent aggregation completed: ${unique.length} unique candidates`);
    return { jobs: unique, metrics, queryOrder };
  }

  private buildJobKey(job: JobPostDto): string {
    const url = String(job.jobUrl || '').trim().toLowerCase();
    if (url) {
      return url;
    }

    return `${String(job.title || '').trim().toLowerCase()}|${String(job.companyName || '').trim().toLowerCase()}`;
  }

  private buildSubagentOutcomeMetrics(
    metrics: Array<{ query: string; rawFound: number; uniqueKeys: string[] }>,
    filteredKeys: Set<string>,
    newKeys: Set<string>,
  ): SubagentDailyMetric[] {
    return metrics.map((metric) => ({
      query: metric.query,
      rawFound: metric.rawFound,
      qualifiedFound: metric.uniqueKeys.filter((key) => filteredKeys.has(key)).length,
      newFound: metric.uniqueKeys.filter((key) => newKeys.has(key)).length,
    }));
  }

  private buildSourceOutcomeMetrics(
    allJobs: JobPostDto[],
    filteredKeys: Set<string>,
    newKeys: Set<string>,
  ): SourceDailyMetric[] {
    const sourceMap = new Map<string, SourceDailyMetric>();

    for (const job of allJobs) {
      const source = String(job.site || 'unknown').trim().toLowerCase() || 'unknown';
      const key = this.buildJobKey(job);
      const metric = sourceMap.get(source) || {
        source,
        rawFound: 0,
        qualifiedFound: 0,
        newFound: 0,
      };

      metric.rawFound += 1;
      if (filteredKeys.has(key)) {
        metric.qualifiedFound += 1;
      }
      if (newKeys.has(key)) {
        metric.newFound += 1;
      }

      sourceMap.set(source, metric);
    }

    return [...sourceMap.values()];
  }

  private normalizeDiscoveryDomains(domains: string[]): string[] {
    const domainRegex = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
    return [...new Set(domains.map((d) => String(d || '').trim().toLowerCase()))].filter(
      (d) => domainRegex.test(d),
    );
  }

  /**
   * Manually trigger the job search (for testing)
   * Call this via REST API: POST /scheduler/trigger
   */
  async manualTrigger(): Promise<{
    status: string;
    message: string;
    timestamp: string;
  }> {
    this.logger.log('Manual trigger requested');

    if (this.isRunning) {
      this.activityLogService.warn('Manual trigger requested while scheduler is already running');
      return {
        status: 'busy',
        message: 'A scheduler run is already in progress',
        timestamp: new Date().toISOString(),
      };
    }

    // Run in background so API responds immediately and UI does not timeout.
    setTimeout(() => {
      this.executeDaily().catch((error: any) => {
        this.logger.error(`Manual trigger background run failed: ${error.message}`, error.stack);
      });
    }, 0);

    return {
      status: 'success',
      message: 'Manual trigger accepted and started',
      timestamp: new Date().toISOString(),
    };
  }

  getActivities() {
    return {
      isRunning: this.isRunning,
      lastExecution: this.lastExecutionSlotUtc,
      lastSuccessfulRunUtc: this.lastSuccessfulRunUtc,
      entries: this.activityLogService.getRecent(200),
    };
  }

  getRuntimeConfig() {
    return this.runtimeConfigService.getConfig();
  }

  updateTime(time: string) {
    return this.runtimeConfigService.updateTime(time);
  }

  setRecipients(recipients: string[]) {
    return this.runtimeConfigService.replaceRecipients(recipients);
  }

  addRecipient(email: string) {
    return this.runtimeConfigService.addRecipient(email);
  }

  removeRecipient(email: string) {
    return this.runtimeConfigService.removeRecipient(email);
  }

  getSubagentMemory() {
    return this.subagentMemoryService.getSnapshot();
  }

  getSourceMemory() {
    return this.sourceReliabilityService.getSnapshot();
  }

  updateEnabled(enabled: boolean): RuntimeSchedulerConfig {
    return this.runtimeConfigService.updateEnabled(enabled);
  }

  setAutomationStatus(enabled: boolean): {
    enabled: boolean;
    isRunning: boolean;
    message: string;
    statusMessage: string;
    config: RuntimeSchedulerConfig;
  } {
    const config = this.runtimeConfigService.updateEnabled(enabled);

    if (enabled) {
      this.logger.log('Sherlock Automation enabled by master control');
      this.activityLogService.info('Sherlock Automation switched ON: Scheduled triggers and background jobs active');
      const message = 'Automation ON (scheduled runs active)';
      return {
        enabled: true,
        isRunning: this.isRunning,
        message,
        statusMessage: message,
        config,
      };
    } else {
      this.logger.log('Sherlock Automation disabled by master control');
      const message = this.isRunning
        ? 'Automation OFF (active task completing safely; scheduled runs paused)'
        : 'Automation OFF (scheduled runs paused)';
      this.activityLogService.warn(
        this.isRunning
          ? 'Sherlock Automation switched OFF: In-progress run will complete safely; future scheduled runs paused'
          : 'Sherlock Automation switched OFF: All automated runs paused',
      );
      return {
        enabled: false,
        isRunning: this.isRunning,
        message,
        statusMessage: message,
        config,
      };
    }
  }

  /**
   * Get scheduler status and stats
   */
  getStatus(): {
    enabled: boolean;
    scheduledTime: string;
    totalJobsSent: number;
    lastExecution?: string;
    lastSuccessfulRunUtc?: string;
    isRunning: boolean;
    statusMessage: string;
    message: string;
  } {
    const config = this.runtimeConfigService.getConfig();
    const statusMessage = !config.enabled
      ? (this.isRunning ? 'Automation OFF (active task completing safely)' : 'Automation OFF (scheduled runs paused)')
      : (this.isRunning ? 'Automation ON (execution in progress)' : 'Automation ON (scheduled runs active)');

    return {
      enabled: config.enabled,
      scheduledTime: config.time,
      totalJobsSent: this.sentJobsDb.getCount(),
      lastExecution: this.lastExecutionSlotUtc,
      lastSuccessfulRunUtc: this.lastSuccessfulRunUtc,
      isRunning: this.isRunning,
      statusMessage,
      message: statusMessage,
    };
  }
}
