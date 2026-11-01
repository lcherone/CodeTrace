declare module "php-parser" {
  export default class Engine {
    constructor(options?: Record<string, unknown>);
    parseCode(code: string | Buffer, filename?: string): any;
    tokenGetAll(code: string): Array<string | [string, string, number]>;
  }
}
