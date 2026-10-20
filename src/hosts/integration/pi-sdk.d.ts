/**
 * Minimal Pi 1.3.0 extension declaration fixture for typechecking the generated
 * extension surface. Provenance: Pi 1.3.0 extension documentation.
 * This is deliberately limited
 * to the registration methods the adapter uses; it is not a full SDK copy.
 */
declare module '@earendil-works/pi-coding-agent' {
  export interface ExtensionAPI {
    on(
      event: string,
      handler: (event: unknown, context: unknown) => Promise<void> | void,
    ): void;
    registerCommand(
      name: string,
      options: {
        readonly description: string;
        readonly handler: (
          args: string,
          context: unknown,
        ) => Promise<void> | void;
      },
    ): void;
  }
}
