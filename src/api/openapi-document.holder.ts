import { Injectable } from '@nestjs/common';

/**
 * Holds the OpenAPI document built at bootstrap so it can be served by a
 * controller (and exported to disk) without re-deriving it per request.
 */
@Injectable()
export class OpenApiDocumentHolder {
  private document: Record<string, unknown> | undefined;

  set(document: Record<string, unknown> | { [key: string]: unknown }): void {
    this.document = document;
  }

  get(): Record<string, unknown> {
    if (!this.document) {
      throw new Error('OpenAPI document has not been built');
    }
    return this.document;
  }
}
