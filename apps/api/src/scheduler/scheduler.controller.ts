import { Controller, Post, Get, Logger, Put, Body, Delete, Param, BadRequestException } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JobSchedulerService } from '../scheduler/job-scheduler.service';
import { FileNotificationService } from '../notifications/file-notification.service';

@Controller('scheduler')
export class SchedulerController {
  private readonly logger = new Logger(SchedulerController.name);

  constructor(
    private schedulerService: JobSchedulerService,
    private fileNotificationService: FileNotificationService,
  ) {}

  /**
   * GET /scheduler/config
   * Dashboard bootstrap config (time + recipients from env)
   */
  @Get('config')
  @ApiOperation({
    summary: 'Get scheduler dashboard config',
    description: 'Returns normalized scheduler time, recipient list, and automation status',
  })
  @ApiResponse({ status: 200, description: 'Scheduler config retrieved' })
  getConfig() {
    const status = this.schedulerService.getStatus();
    const runtimeConfig = this.schedulerService.getRuntimeConfig();

    return {
      enabled: status.enabled,
      isRunning: status.isRunning,
      statusMessage: status.statusMessage,
      time: runtimeConfig.time,
      rawSchedule: runtimeConfig.time,
      recipients: runtimeConfig.recipients,
      lastSuccessfulRunUtc: status.lastSuccessfulRunUtc ?? null,
    };
  }

  /**
   * PUT /scheduler/automation/status
   * Sherlock Master Automation Toggle (ON/OFF)
   */
  @Put('automation/status')
  @ApiOperation({
    summary: 'Update Sherlock Automation master status',
    description: 'Enables or disables Sherlock automated execution with persistence and safe handling of running jobs',
  })
  @ApiResponse({ status: 200, description: 'Automation status updated successfully' })
  updateAutomationStatus(@Body() body: { enabled?: boolean }) {
    if (typeof body?.enabled !== 'boolean') {
      throw new BadRequestException('Field "enabled" must be a boolean (true or false)');
    }

    const result = this.schedulerService.setAutomationStatus(body.enabled);
    return {
      success: true,
      ...result,
    };
  }

  /**
   * PUT /scheduler/config/automation
   * Alias for master automation control
   */
  @Put('config/automation')
  @ApiOperation({
    summary: 'Update Sherlock Automation master status (config alias)',
    description: 'Enables or disables Sherlock automated execution',
  })
  @ApiResponse({ status: 200, description: 'Automation status updated successfully' })
  updateConfigAutomation(@Body() body: { enabled?: boolean }) {
    return this.updateAutomationStatus(body);
  }

  @Put('config/time')
  @ApiOperation({
    summary: 'Update scheduler time',
    description: 'Sets daily UTC run time in HH:mm format',
  })
  @ApiResponse({ status: 200, description: 'Scheduler time updated' })
  updateTime(@Body() body: { time?: string }) {
    if (!body?.time || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.time)) {
      throw new BadRequestException('Invalid time. Expected HH:mm (UTC) with hours 00-23 and minutes 00-59.');
    }

    const config = this.schedulerService.updateTime(body.time);
    return {
      success: true,
      config,
    };
  }

  @Put('config/recipients')
  @ApiOperation({
    summary: 'Replace recipients list',
    description: 'Replaces all recipient emails used by backend notifications',
  })
  @ApiResponse({ status: 200, description: 'Recipients updated' })
  setRecipients(@Body() body: { recipients?: string[] }) {
    if (!Array.isArray(body?.recipients)) {
      throw new BadRequestException('Recipients must be an array of strings');
    }
    const config = this.schedulerService.setRecipients(body.recipients);
    return {
      success: true,
      config,
    };
  }

  @Post('config/recipients')
  @ApiOperation({
    summary: 'Add recipient',
    description: 'Adds one recipient email for backend notifications',
  })
  @ApiResponse({ status: 200, description: 'Recipient added' })
  addRecipient(@Body() body: { email?: string }) {
    if (!body?.email) {
      throw new BadRequestException('Email is required');
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.email.trim())) {
      throw new BadRequestException('Invalid email format');
    }

    const config = this.schedulerService.addRecipient(body.email);
    return {
      success: true,
      config,
    };
  }

  @Delete('config/recipients/:email')
  @ApiOperation({
    summary: 'Remove recipient',
    description: 'Removes one recipient email for backend notifications',
  })
  @ApiResponse({ status: 200, description: 'Recipient removed' })
  removeRecipient(@Param('email') email: string) {
    const decoded = decodeURIComponent(email);
    const config = this.schedulerService.removeRecipient(decoded);
    return {
      success: true,
      config,
    };
  }

  /**
   * GET /scheduler/status
   * Get scheduler status and statistics
   */
  @Get('status')
  @ApiOperation({
    summary: 'Get scheduler status',
    description: 'Returns scheduler status, scheduled time, and statistics',
  })
  @ApiResponse({ status: 200, description: 'Scheduler status retrieved' })
  getStatus() {
    return this.schedulerService.getStatus();
  }

  /**
   * POST /scheduler/trigger
   * Manually trigger the daily job search (for testing)
   */
  @Post('trigger')
  @ApiOperation({
    summary: 'Manually trigger job search',
    description:
      'Immediately run the daily job search and send results to Telegram (useful for testing)',
  })
  @ApiResponse({ status: 200, description: 'Job search executed' })
  async triggerManually() {
    this.logger.log('Manual scheduler trigger requested');
    return await this.schedulerService.manualTrigger();
  }

  /**
   * GET /scheduler/debug
   * Comprehensive debug info for troubleshooting
   */
  @Get('debug')
  @ApiOperation({
    summary: 'Scheduler debug info',
    description: 'Returns current UTC time, scheduler config, and status for troubleshooting',
  })
  @ApiResponse({ status: 200, description: 'Debug info retrieved' })
  getDebugInfo() {
    const now = new Date();
    const runtimeConfig = this.schedulerService.getRuntimeConfig();
    const status = this.schedulerService.getStatus();
    
    return {
      currentUTC: {
        isoString: now.toISOString(),
        time: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
        hour: now.getUTCHours(),
        minute: now.getUTCMinutes(),
        date: now.toISOString().slice(0, 10),
      },
      runtimeConfig,
      status,
      matches: {
        timeMatches: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}` === runtimeConfig.time,
        schedulerEnabled: runtimeConfig.enabled,
      },
      advice: this.generateDebugAdvice(runtimeConfig, status),
    };
  }

  @Get('subagents/memory')
  @ApiOperation({
    summary: 'Get subagent memory',
    description: 'Returns adaptive query-agent performance history used for daily ranking',
  })
  @ApiResponse({ status: 200, description: 'Subagent memory retrieved' })
  getSubagentMemory() {
    return this.schedulerService.getSubagentMemory();
  }

  @Get('sources/memory')
  @ApiOperation({
    summary: 'Get source reliability memory',
    description: 'Returns source-level performance and reliability stats used for lane planning',
  })
  @ApiResponse({ status: 200, description: 'Source reliability memory retrieved' })
  getSourceMemory() {
    return this.schedulerService.getSourceMemory();
  }

  @Get('activities')
  @ApiOperation({
    summary: 'Get scheduler activities',
    description: 'Returns live scheduler activity logs, running status, and latest timestamps',
  })
  @ApiResponse({ status: 200, description: 'Scheduler activities retrieved' })
  getActivities() {
    return this.schedulerService.getActivities();
  }

  /**
   * GET /scheduler/jobs/today
   * Returns the jobs that are still within the 24-hour retention window.
   */
  @Get('jobs/today')
  @ApiOperation({
    summary: 'Get recently found jobs',
    description: 'Returns jobs stored in the frontend dashboard list and removes expired entries older than 24 hours.',
  })
  @ApiResponse({ status: 200, description: 'Recent jobs retrieved' })
  async getTodayJobs() {
    const jobs = await this.fileNotificationService.getJobsFoundToday();
    const now = Date.now();

    return {
      retentionHours: 24,
      count: jobs.length,
      jobs: jobs.map((job) => {
        const savedAtMs = Date.parse(job.savedAt);
        const expiresAtMs = savedAtMs + 24 * 60 * 60 * 1000;
        const hoursRemaining = Math.max(0, (expiresAtMs - now) / (60 * 60 * 1000));

        return {
          ...job,
          hoursRemaining: Number(hoursRemaining.toFixed(1)),
        };
      }),
    };
  }

  private generateDebugAdvice(config: any, status: any): string[] {
    const advice = [];

    if (!config.enabled) {
      advice.push('❌ Scheduler is DISABLED. Enable it via PUT /scheduler/config/time');
    }

    if (!config.recipients || config.recipients.length === 0) {
      advice.push('❌ No email recipients configured. Add recipients via POST /scheduler/config/recipients');
    }

    if (config.recipients) {
      advice.push(`✓ Email recipients: ${config.recipients.join(', ')}`);
    }

    advice.push(`✓ Scheduled time (UTC): ${config.time}`);
    advice.push(`ℹ️  Manual test: POST /scheduler/trigger`);

    return advice;
  }
}
