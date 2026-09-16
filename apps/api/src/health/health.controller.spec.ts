import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns a static health payload without environment secrets', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    const controller = moduleRef.get(HealthController);
    const payload = controller.check();

    expect(payload).toEqual({
      status: 'ok',
      service: 'studysteps-api',
    });
    expect(JSON.stringify(payload)).not.toMatch(/DATABASE_URL|SECRET|TOKEN|PASSWORD/i);
  });

  it('serves GET /health over HTTP', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'studysteps-api',
    });

    await app.close();
  });
});
