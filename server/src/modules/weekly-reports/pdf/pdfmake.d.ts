/**
 * Minimal ambient declaration for `pdfmake` 0.3.11.
 *
 * The package ships no TypeScript types and there is no maintained
 * `@types/pdfmake` for the 0.3 Node entry point. Rather than adding a
 * third-party type package whose shape may not match the installed version,
 * this file declares exactly the surface this module uses (interface
 * segregation): a virtual file system, font registration, resource access
 * policies and PDF creation. Anything outside that surface stays untyped on
 * purpose so it cannot be reached accidentally.
 */
declare module 'pdfmake' {
  export interface PdfMakeVirtualFileSystem {
    writeFileSync(fileName: string, content: Buffer): void;
    existsSync(fileName: string): boolean;
    readFileSync(fileName: string): Buffer;
  }

  export interface PdfMakeFontStyleDescriptors {
    normal: string;
    bold?: string;
    italics?: string;
    bolditalics?: string;
  }

  export type PdfMakeFontDescriptors = Record<string, PdfMakeFontStyleDescriptors>;

  export interface PdfMakeDocumentDefinition {
    content: unknown;
    info?: Record<string, unknown>;
    pageSize?: string;
    pageOrientation?: string;
    pageMargins?: number | [number, number, number, number];
    defaultStyle?: Record<string, unknown>;
    styles?: Record<string, unknown>;
    header?: unknown;
    footer?: unknown;
  }

  export interface PdfMakeCreatedDocument {
    getBuffer(): Promise<Buffer>;
  }

  export interface PdfMakeInstance {
    readonly virtualfs: PdfMakeVirtualFileSystem;
    setFonts(fonts: PdfMakeFontDescriptors): void;
    setUrlAccessPolicy(policy: (url: string) => boolean): void;
    setLocalAccessPolicy(policy: (path: string) => boolean): void;
    createPdf(documentDefinition: PdfMakeDocumentDefinition): PdfMakeCreatedDocument;
  }

  const pdfMake: PdfMakeInstance;
  export default pdfMake;
}
