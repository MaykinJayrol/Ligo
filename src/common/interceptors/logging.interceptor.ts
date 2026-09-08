import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const started = Date.now();
    const correlationId = req.correlationId ?? '-';
    const method = req.method;
    const path = req.originalUrl;

    return next.handle().pipe(
      tap({
        next: () => {
          const status = http.getResponse().statusCode;
          // Structured log for observability (trace/correlation)
          console.log(
            JSON.stringify({
              level: 'info',
              msg: 'request_completed',
              correlationId,
              method,
              path,
              status,
              durationMs: Date.now() - started,
            }),
          );
        },
        error: (err: Error & { status?: number }) => {
          console.log(
            JSON.stringify({
              level: 'error',
              msg: 'request_failed',
              correlationId,
              method,
              path,
              status: err.status ?? 500,
              durationMs: Date.now() - started,
              error: err.message,
            }),
          );
        },
      }),
    );
  }
}
