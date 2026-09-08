import { All, Controller, NotFoundException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

/**
 * Catch-all so every unmatched route becomes an RFC 9457 problem-details
 * document (code `not-found`) instead of the platform's HTML error page.
 */
@ApiExcludeController()
@Controller()
export class NotFoundController {
  @All('{*path}')
  notFound(): never {
    throw new NotFoundException('Route not found');
  }
}
