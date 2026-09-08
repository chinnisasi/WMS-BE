import type { ModuleMetadata } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './problem-details/problem-details.filter';

export type { ModuleMetadata };

/**
 * Shared primitives (AD-9): ids, time, money, quantity, GST basis points,
 * cursor pagination, problem-details, idempotency/event/outbox seams. Every
 * spine module imports this module; nothing outside shared/ re-implements them.
 */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
  exports: [],
})
export class SharedModule {}