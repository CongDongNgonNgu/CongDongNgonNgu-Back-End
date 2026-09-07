import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiFailure } from "./api-response";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = this.readMessage(exception, status);
    const body: ApiFailure = {
      success: false,
      error: {
        code: this.readCode(exception, status),
        message,
      },
    };
    response.status(status).json(body);
  }

  private readMessage(exception: unknown, status: number): string {
    if (!(exception instanceof HttpException)) return "Internal server error";
    const detail = exception.getResponse();
    if (typeof detail === "string") return detail;
    if (typeof detail === "object" && detail !== null && "message" in detail) {
      const message = (detail as { message?: unknown }).message;
      if (Array.isArray(message)) return "Request validation failed";
      if (typeof message === "string") return message;
    }
    return status >= 500 ? "Internal server error" : "Request failed";
  }

  private readCode(exception: unknown, status: number): string {
    if (exception instanceof HttpException) {
      const detail = exception.getResponse();
      if (typeof detail === "object" && detail !== null && "code" in detail) {
        const code = (detail as { code?: unknown }).code;
        if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
      }
    }
    return status >= 500 ? "INTERNAL_SERVER_ERROR" : `HTTP_${status}`;
  }
}
