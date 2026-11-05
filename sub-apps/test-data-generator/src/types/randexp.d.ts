declare module 'randexp' {
  interface RandExpOptions {
    defaultRange?: number
  }
  class RandExp {
    constructor(pattern: RegExp | string, flags?: string)
    gen(): string
  }
  export default RandExp
}
