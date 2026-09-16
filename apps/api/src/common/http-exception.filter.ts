import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from './app-error';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = (response.req.headers['x-request-id'] as string | undefined) ?? 'unknown';

    if (exception instanceof AppError) {
      response.status(exception.status).json({
        code: exception.code,
        message: exception.message,
        requestId,
        fields: exception.fields,
      });
      return;
    }
    if (typeof exception === 'object' && exception && 'issues' in exception) {
      const issues = (exception as { issues: Array<{ path: Array<string | number> }> }).issues;
      response.status(400).json({
        code: 'VALIDATION_ERROR',
        message: '请求无效',
        requestId,
        fields: Object.fromEntries(issues.map((issue) => [issue.path.join('.') || 'body', 'invalid'])),
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({
        code: status === 429 ? 'RATE_LIMITED' : 'VALIDATION_ERROR',
        message: '请求无法完成',
        requestId,
      });
      return;
    }
    if (process.env.APP_ENV === 'test' || process.env.APP_ENV === 'local') {
      const message = exception instanceof Error ? exception.stack ?? exception.message : String(exception);
      process.stderr.write(`${message}\n`);
    }
    response.status(500).json({
      code: 'VALIDATION_ERROR',
      message: '服务暂时不可用',
      requestId,
    });
  }
}
