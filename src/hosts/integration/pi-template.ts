import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createPiExtension } from './pi-extension-runtime.js';

/** Typechecked native-template shape; renderHostTemplate emits the same surface. */
export default function (pi: ExtensionAPI): void {
  createPiExtension(pi);
}
