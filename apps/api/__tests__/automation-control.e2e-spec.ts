/**
 * E2E tests for Sherlock Automation Master Control (ON/OFF).
 *
 * Verifies:
 * 1. Master toggle endpoints (PUT /scheduler/automation/status and PUT /scheduler/config/automation)
 * 2. Request payload validation (rejection of non-boolean values)
 * 3. Idempotent repeated state transitions
 * 4. State synchronization across /scheduler/status and /scheduler/config
 * 5. Scheduler execution prevention when automation is OFF
 * 6. Persistence in RuntimeConfigService
 * 7. Safe reporting when execution is in progress
 */
import { INestApplication } from '@nestjs/common';
import { createTestApp } from './helpers/create-app';
import { JobSchedulerService } from '../src/scheduler/job-scheduler.service';
import { RuntimeConfigService } from '../src/scheduler/runtime-config.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

describe('Sherlock Automation Master Control (E2E)', () => {
  let app: INestApplication;
  let schedulerService: JobSchedulerService;
  let runtimeConfigService: RuntimeConfigService;

  beforeAll(async () => {
    app = await createTestApp();
    schedulerService = app.get(JobSchedulerService);
    runtimeConfigService = app.get(RuntimeConfigService);
  });

  afterAll(async () => {
    // Restore default enabled state
    schedulerService.setAutomationStatus(true);
    await app.close();
  });

  describe('Validation & Error Handling', () => {
    it('should reject non-boolean enabled parameter with 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .put('/scheduler/automation/status')
        .send({ enabled: 'invalid-string' })
        .expect(400);

      const errorMessage = res.body.detail || res.body.message || res.body.error;
      expect(errorMessage).toContain('Field "enabled" must be a boolean');
    });

    it('should reject empty body with 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .put('/scheduler/automation/status')
        .send({})
        .expect(400);

      const errorMessage = res.body.detail || res.body.message || res.body.error;
      expect(errorMessage).toContain('Field "enabled" must be a boolean');
    });
  });

  describe('Turning Automation OFF', () => {
    it('should switch automation to OFF via PUT /scheduler/automation/status', async () => {
      const res = await request(app.getHttpServer())
        .put('/scheduler/automation/status')
        .send({ enabled: false })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.enabled).toBe(false);
      expect(res.body.message).toContain('Automation OFF');
      expect(res.body.config.enabled).toBe(false);

      // Verify persisted state in RuntimeConfigService
      expect(runtimeConfigService.getConfig().enabled).toBe(false);
    });

    it('should reflect disabled state in GET /scheduler/status', async () => {
      const res = await request(app.getHttpServer())
        .get('/scheduler/status')
        .expect(200);

      expect(res.body.enabled).toBe(false);
      expect(res.body.statusMessage).toContain('Automation OFF');
    });

    it('should reflect disabled state in GET /scheduler/config', async () => {
      const res = await request(app.getHttpServer())
        .get('/scheduler/config')
        .expect(200);

      expect(res.body.enabled).toBe(false);
      expect(res.body.statusMessage).toContain('Automation OFF');
    });

    it('should be idempotent when called repeatedly with false', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer())
          .put('/scheduler/automation/status')
          .send({ enabled: false })
          .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.enabled).toBe(false);
      }
    });

    it('should prevent scheduled execution when automation is OFF', async () => {
      const executeDailySpy = jest.spyOn(schedulerService, 'executeDaily').mockResolvedValue(undefined as any);

      await schedulerService.handleTick();

      expect(executeDailySpy).not.toHaveBeenCalled();
      executeDailySpy.mockRestore();
    });
  });

  describe('Turning Automation ON', () => {
    it('should switch automation to ON via alias PUT /scheduler/config/automation', async () => {
      const res = await request(app.getHttpServer())
        .put('/scheduler/config/automation')
        .send({ enabled: true })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.enabled).toBe(true);
      expect(res.body.message).toContain('Automation ON');
      expect(res.body.config.enabled).toBe(true);

      // Verify persisted state in RuntimeConfigService
      expect(runtimeConfigService.getConfig().enabled).toBe(true);
    });

    it('should reflect enabled state in GET /scheduler/status', async () => {
      const res = await request(app.getHttpServer())
        .get('/scheduler/status')
        .expect(200);

      expect(res.body.enabled).toBe(true);
      expect(res.body.statusMessage).toContain('Automation ON');
    });

    it('should reflect enabled state in GET /scheduler/config', async () => {
      const res = await request(app.getHttpServer())
        .get('/scheduler/config')
        .expect(200);

      expect(res.body.enabled).toBe(true);
      expect(res.body.statusMessage).toContain('Automation ON');
    });

    it('should be idempotent when called repeatedly with true', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer())
          .put('/scheduler/automation/status')
          .send({ enabled: true })
          .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.enabled).toBe(true);
      }
    });
  });

  describe('Safe handling of in-progress tasks', () => {
    it('should accurately report status when a job is currently running', async () => {
      // Simulate running state
      (schedulerService as any).isRunning = true;

      // Turning OFF while job is in progress
      const res = await request(app.getHttpServer())
        .put('/scheduler/automation/status')
        .send({ enabled: false })
        .expect(200);

      expect(res.body.enabled).toBe(false);
      expect(res.body.isRunning).toBe(true);
      expect(res.body.message).toContain('completing safely');

      const statusRes = await request(app.getHttpServer())
        .get('/scheduler/status')
        .expect(200);

      expect(statusRes.body.statusMessage).toContain('completing safely');

      // Reset simulated running flag
      (schedulerService as any).isRunning = false;
      schedulerService.setAutomationStatus(true);
    });
  });
});
